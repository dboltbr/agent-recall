// Ownership of a blocked release (change blocked-release-ownership): the lease, its heartbeat and
// expiry, lanes giving way to their root, and the incident host for a note nobody can take.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, readHandoffs } from "../host.ts";
import { updateNote } from "../notes.ts";
import { buildRelease, type Release } from "../release-status.ts";
import {
  blockedCandidates,
  blockedConfirmation,
  blockedLease,
  blockedLock,
  blockedTarget,
  expireLease,
  HEARTBEAT_MS,
  isBlockedRecent,
  LEASE_MS,
} from "../route.ts";
import type { BlockedNote, HostConfig, SessionRef } from "../types.ts";
import { createWatcher } from "../watcher.ts";
import {
  config,
  fakeDelivery,
  fakeExec,
  fakeGitHub,
  fixedClock,
  fixedReleases,
  hoursAgo,
  NOW,
  quietLog,
  session,
  tempState,
  writeConfig,
  type RefReply,
} from "./fakes.ts";
import { job, minutesAgo, run } from "./releases.ts";

const HEAD = "0292aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ago = (minutes: number) => hoursAgo(minutes / 60);
const ref = (harness: SessionRef["harness"], host: string, id: string): SessionRef => ({ harness, host, id });

/** Two sessions of archdev: `ses_a` owns the head commit, `ses_b` an older one. */
function blockedNote(partial: Partial<BlockedNote> = {}): BlockedNote {
  return {
    release: "release-292",
    state: "red",
    range: { from: "0290bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", to: "aaaaaaa1" },
    sessions: [session("opencode", "archdev", "ses_b", ["bbbbbbb2"]), session("opencode", "archdev", "ses_a", ["aaaaaaa1"])],
    run: { id: 40_000_000_292, url: "https://github.com/dboltbr/dbolt/actions/runs/40000000292", failedJob: "verify-production / check" },
    createdAt: ago(5),
    updatedAt: ago(5),
    ...partial,
  };
}

const expired = (...sessions: string[]) => sessions.map((name) => ({ session: name, at: ago(1), reason: "x" }));

function release(number: number, outcome: "failed" | "shipped"): Release {
  return buildRelease({
    run: run({ run_number: number, status: "completed", conclusion: outcome === "shipped" ? "success" : "failure", updated_at: minutesAgo(5) }),
    jobs: outcome === "shipped" ? [] : [job("verify-production / check", "failure", [15, 5]), job("release-tag", "skipped", [5, 5])],
    tagged: outcome === "shipped",
    note: null,
    commits: null,
    now: NOW,
  });
}

// --- pure rules ---

test("blockedCandidates/blockedTarget: a cabeça primeiro, depois a ordem da nota, fora de expired", () => {
  const note = blockedNote();
  assert.deepEqual(blockedCandidates(note).map((entry) => entry.id), ["ses_a", "ses_b"]);
  assert.equal(blockedTarget(note)?.id, "ses_a");
  assert.equal(blockedTarget(blockedNote({ expired: expired("opencode/archdev/ses_a") }))?.id, "ses_b");
  assert.equal(blockedTarget(blockedNote({ expired: expired("opencode/archdev/ses_a", "opencode/archdev/ses_b") })), null);
  const headless = blockedNote({ range: { from: null, to: "9a9a9a9a" } });
  assert.equal(blockedTarget(headless)?.id, "ses_b", "cabeça sem trailer: a primeira da nota");
});

test("blockedLock: cada sessão expirada é uma nova geração do chamado", () => {
  const target = ref("opencode", "archdev", "ses_b");
  assert.equal(blockedLock("blocked", target, blockedNote()), "ses_b.blocked");
  assert.equal(blockedLock("fix", target, blockedNote({ expired: expired("opencode/archdev/ses_a") })), "ses_b.blocked-fix-1");
});

test("blockedLease: red não assumido em 20 min expira o alvo; antes disso nada", () => {
  assert.deepEqual(blockedLease(blockedNote(), NOW), { kind: "none" });
  const late = blockedLease(blockedNote({ updatedAt: ago(21) }), NOW);
  assert.equal(late.kind, "expire");
  assert.deepEqual(late.kind === "expire" && late.who, ["opencode/archdev/ses_a"]);
  assert.match(late.kind === "expire" ? late.reason : "", /chamado não assumido em 21 min/);
  for (const state of ["shipped", "unrelated", "escalated", "duplicate"]) {
    assert.deepEqual(blockedLease(blockedNote({ state, updatedAt: hoursAgo(3) }), NOW), { kind: "none" }, state);
  }
  assert.deepEqual(blockedLease(blockedNote({ sessions: [], updatedAt: hoursAgo(1) }), NOW), { kind: "none" }, "faixa sem sessão");
});

test("blockedLease: investigating fica com o owner; heartbeat devido aos 10 min, expira aos 20", () => {
  const owner = "opencode/archdev/ses_a";
  const held = blockedLease(blockedNote({ state: "investigating", owner, updatedAt: ago(5) }), NOW);
  assert.deepEqual(held, { kind: "held", holder: ref("opencode", "archdev", "ses_a"), heartbeatDue: false });
  const due = blockedLease(blockedNote({ state: "investigating", owner, updatedAt: ago(HEARTBEAT_MS / 60_000) }), NOW);
  assert.equal(due.kind === "held" && due.heartbeatDue, true);
  const beating = blockedLease(blockedNote({ state: "investigating", owner, updatedAt: ago(60), heartbeatAt: ago(3) }), NOW);
  assert.equal(beating.kind === "held" && !beating.heartbeatDue, true, "o heartbeat recente segura a posse");
  const gone = blockedLease(blockedNote({ state: "investigating", owner, updatedAt: ago(60), heartbeatAt: ago(LEASE_MS / 60_000 + 1) }), NOW);
  assert.deepEqual(gone.kind === "expire" && gone.who, [owner]);
  const ownerless = blockedLease(blockedNote({ state: "investigating", updatedAt: ago(30) }), NOW);
  assert.deepEqual(ownerless.kind === "expire" && ownerless.who, []);
});

test("blockedLease: fix-pending é de fix.session; sem ela, expira os culpados chamados (ou o owner)", () => {
  const assessment = { suspects: [{ commit: "bbbbbbb2" }] };
  const fix = blockedLease(blockedNote({ state: "fix-pending", owner: "opencode/archdev/ses_a", assessment, fix: { session: "opencode/archdev/ses_b" }, updatedAt: ago(5) }), NOW);
  assert.equal(fix.kind === "held" && fix.holder.id, "ses_b");
  const untaken = blockedLease(blockedNote({ state: "fix-pending", owner: "opencode/archdev/ses_a", assessment, updatedAt: ago(25) }), NOW);
  assert.deepEqual(untaken.kind === "expire" && untaken.who, ["opencode/archdev/ses_b"]);
  const ownerIsCulprit = blockedLease(blockedNote({ state: "fix-pending", owner: "opencode/archdev/ses_b", assessment, updatedAt: ago(25) }), NOW);
  assert.deepEqual(ownerIsCulprit.kind === "expire" && ownerIsCulprit.who, ["opencode/archdev/ses_b"]);
  assert.deepEqual(blockedLease(blockedNote({ state: "fix-pending", owner: "opencode/archdev/ses_a", assessment, updatedAt: ago(5) }), NOW), { kind: "none" });
});

test("blockedLease: red com toda sessão expirada é órfã; velha sem resposta do host de incidente", () => {
  const all = expired("opencode/archdev/ses_a", "opencode/archdev/ses_b");
  assert.deepEqual(blockedLease(blockedNote({ expired: all, updatedAt: ago(1) }), NOW), { kind: "orphan", stale: false });
  assert.deepEqual(blockedLease(blockedNote({ expired: all, updatedAt: ago(21) }), NOW), { kind: "orphan", stale: true });
  const claimed = blockedNote({ expired: all, updatedAt: ago(30), incident: { by: "paseo/srv", at: ago(5) } });
  assert.deepEqual(blockedLease(claimed, NOW), { kind: "orphan", stale: false }, "o agente de incidente tem 20 min");
  const agentExpired = blockedNote({
    expired: [...all, ...expired("paseo/srv/agent-incident")],
    updatedAt: ago(1),
    incident: { by: "paseo/srv", at: ago(2), session: "paseo/srv/agent-incident" },
  });
  assert.deepEqual(blockedLease(agentExpired, NOW), { kind: "orphan", stale: true });
});

test("expireLease: volta a red sem owner, fix nem heartbeat; o resto fica", () => {
  const body = { state: "fix-pending", owner: "o", fix: { session: "f" }, heartbeatAt: ago(30), assessment: { suspects: [] }, expired: expired("x"), updatedAt: ago(30) };
  const next = expireLease(body, ["f"], "motivo", NOW);
  assert.deepEqual(next, {
    state: "red",
    assessment: { suspects: [] },
    expired: [...expired("x"), { session: "f", at: NOW.toISOString(), reason: "motivo" }],
    updatedAt: NOW.toISOString(),
  });
});

test("isBlockedRecent: heartbeat recente mantém viva uma nota velha", () => {
  assert.equal(isBlockedRecent(blockedNote({ updatedAt: hoursAgo(9) }), NOW), false);
  assert.equal(isBlockedRecent(blockedNote({ updatedAt: hoursAgo(9), heartbeatAt: ago(5) }), NOW), true);
});

test("blockedConfirmation: candidato expirado ou alvo trocado encerram; a raiz assume pela lane", () => {
  const lane = ref("paseo", "srv", "agent-lane");
  const root = ref("paseo", "srv", "agent-root");
  const note = blockedNote({ sessions: [session("paseo", "srv", "agent-lane", ["aaaaaaa1"])], updatedAt: ago(1) });
  assert.equal(blockedConfirmation("blocked", root, note, false, NOW, lane), "open");
  assert.equal(blockedConfirmation("blocked", root, { ...note, state: "investigating", owner: "paseo/srv/agent-root" }, false, NOW, lane), "taken");
  assert.equal(blockedConfirmation("blocked", root, { ...note, expired: expired("paseo/srv/agent-lane") }, false, NOW, lane), "moot");
  assert.equal(blockedConfirmation("blocked", root, { ...note, expired: expired("paseo/srv/agent-root") }, false, NOW, lane), "moot");
  const moved = blockedNote({ expired: expired("opencode/archdev/ses_a"), updatedAt: ago(1) });
  assert.equal(blockedConfirmation("blocked", ref("opencode", "archdev", "ses_a"), moved, false, NOW), "moot", "a nota já chama outra");
});

// --- the watcher ---

async function setup(options: {
  blocked: Record<string, BlockedNote>;
  blockedRefs?: RefReply[];
  config?: Partial<HostConfig>;
  delivery?: ReturnType<typeof fakeDelivery>;
  harness?: "opencode" | "paseo";
}) {
  const stateDir = await tempState();
  const configFile = await writeConfig(await tempState(), { ...config, ...options.config });
  const git = fakeExec(() => ({}), { blocked: () => options.blocked, applyBlocked: true });
  // Every fetch sees the ref move: the watcher reads what the last tick wrote.
  const github = fakeGitHub([{ status: 404 }], options.blockedRefs ?? [1, 2, 3, 4, 5, 6].map((n) => ({ status: 200, etag: `"b${n}"` })));
  const delivery = options.delivery ?? fakeDelivery();
  const clock = fixedClock();
  const watcher = createWatcher({
    harness: options.harness ?? "opencode",
    host: (c) => (options.harness === "paseo" ? "srv" : c.instance),
    loadConfig: () => loadConfig(configFile),
    stateDir,
    sha: "1234567890abcdef",
    pid: process.pid,
    clock,
    fetch: github.fetch,
    exec: git.exec,
    delivery: delivery.delivery,
    log: quietLog,
    release: fixedReleases([release(292, "failed"), release(291, "shipped")]),
  });
  const later = (ms: number) => clock.set(new Date(clock.now().getTime() + ms));
  return { watcher, delivery, git, later, stateDir };
}

test("watcher: alvo que não assumiu em 20 min expira e a próxima sessão é chamada, numa nova geração", async () => {
  const notes = { [HEAD]: blockedNote({ updatedAt: ago(21) }) };
  const { watcher, delivery, git, stateDir } = await setup({ blocked: notes });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0, "a volta que grava não chama");
  assert.equal(git.written.length, 1);
  const body = git.written[0]!.body;
  assert.equal(body["state"], "red");
  assert.deepEqual((body["expired"] as Array<{ session: string }>).map((entry) => entry.session), ["opencode/archdev/ses_a"]);
  await watcher.tick();
  assert.deepEqual(delivery.recorded.prompts.map((prompt) => prompt.target.id), ["ses_b"]);
  assert.ok(existsSync(join(stateDir, "release-292", "ses_b.blocked-1")));
});

test("watcher: dona que trabalha grava heartbeatAt; parada não grava; dona de outro host nem é consultada", async () => {
  const owned = (owner: string) => blockedNote({ state: "investigating", owner, updatedAt: ago(15) });
  const working = await setup({ blocked: { [HEAD]: owned("opencode/archdev/ses_a") }, delivery: fakeDelivery({ working: ["ses_a"] }) });
  await working.watcher.tick();
  assert.equal(working.git.written.length, 1);
  assert.equal(working.git.written[0]!.body["heartbeatAt"], NOW.toISOString());
  assert.equal(working.git.written[0]!.body["updatedAt"], ago(15), "o heartbeat não move updatedAt");
  await working.watcher.tick();
  assert.equal(working.git.written.length, 1, "heartbeat em dia: nada a gravar");

  const idle = await setup({ blocked: { [HEAD]: owned("opencode/archdev/ses_a") }, delivery: fakeDelivery({ working: [] }) });
  await idle.watcher.tick();
  assert.deepEqual(idle.delivery.recorded.asked, ["ses_a"]);
  assert.equal(idle.git.written.length, 0);
  idle.later(6 * 60_000);
  await idle.watcher.tick();
  assert.equal(idle.git.written.length, 1, "sem sinal por 20 min: expira");
  assert.equal(idle.git.written[0]!.body["state"], "red");
  assert.equal(idle.git.written[0]!.body["owner"], undefined);

  const elsewhere = await setup({ blocked: { [HEAD]: owned("opencode/outro/ses_x") }, delivery: fakeDelivery({ working: ["ses_x"] }) });
  await elsewhere.watcher.tick();
  assert.deepEqual(elsewhere.delivery.recorded.asked, []);
  assert.equal(elsewhere.git.written.length, 0);
});

test("watcher: lane dá lugar à raiz, que ocupa o lugar dela na ordem", async () => {
  const note = blockedNote({ sessions: [session("paseo", "srv", "agent-lane", ["aaaaaaa1"]), session("paseo", "srv", "agent-b", ["bbbbbbb2"])] });
  const { watcher, delivery, stateDir } = await setup({
    blocked: { [HEAD]: note },
    harness: "paseo",
    delivery: fakeDelivery({ roots: { "agent-lane": "agent-mid", "agent-mid": "agent-root" } }),
  });
  await watcher.tick();
  assert.deepEqual(delivery.recorded.prompts.map((prompt) => prompt.target.id), ["agent-root"]);
  assert.ok(existsSync(join(stateDir, "release-292", "agent-root.blocked")));
  assert.deepEqual((await readHandoffs(stateDir, "release-292")).map((handoff) => handoff.session.id), ["agent-root"]);
});

test("watcher: raiz já expirada → a lane entra em expired e a próxima sessão é chamada", async () => {
  const notes = {
    [HEAD]: blockedNote({
      sessions: [session("paseo", "srv", "agent-lane", ["aaaaaaa1"]), session("paseo", "srv", "agent-b", ["bbbbbbb2"])],
      expired: expired("paseo/srv/agent-root"),
    }),
  };
  const { watcher, delivery, git } = await setup({ blocked: notes, harness: "paseo", delivery: fakeDelivery({ roots: { "agent-lane": "agent-root" } }) });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0);
  assert.deepEqual(
    (git.written[0]!.body["expired"] as Array<{ session: string; reason: string }>).map((entry) => [entry.session, entry.reason]),
    [
      ["paseo/srv/agent-root", "x"],
      ["paseo/srv/agent-lane", "raiz paseo/srv/agent-root expirada"],
    ],
  );
  await watcher.tick();
  assert.deepEqual(delivery.recorded.prompts.map((prompt) => prompt.target.id), ["agent-b"]);
});

test("watcher: chamado de correção cuja raiz é a dona não sai", async () => {
  const note = blockedNote({
    state: "fix-pending",
    owner: "paseo/srv/agent-root",
    sessions: [session("paseo", "srv", "agent-lane", ["aaaaaaa1"])],
    assessment: { suspects: [{ commit: "aaaaaaa1" }] },
    updatedAt: ago(1),
  });
  const { watcher, delivery } = await setup({ blocked: { [HEAD]: note }, harness: "paseo", delivery: fakeDelivery({ roots: { "agent-lane": "agent-root" } }) });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0);
});

const orphanNote = (partial: Partial<BlockedNote> = {}) =>
  blockedNote({ expired: expired("opencode/archdev/ses_a", "opencode/archdev/ses_b"), updatedAt: ago(1), ...partial });

test("watcher: órfã no host de incidente → reivindica, abre um agente no checkout e grava a sessão dele", async () => {
  const notes = { [HEAD]: orphanNote() };
  const { watcher, delivery, git, stateDir } = await setup({
    blocked: notes,
    config: { incidentHost: true, incidentCheckout: "/srv/dbolt" },
    delivery: fakeDelivery({ open: "ok" }),
  });
  const report = await watcher.tick();
  assert.deepEqual(report.handled.map((handled) => [handled.outcome, handled.session]), [["incident", "ses_incident"]]);
  assert.equal(delivery.recorded.opened.length, 1);
  assert.equal(delivery.recorded.opened[0]!.directory, "/srv/dbolt");
  assert.match(delivery.recorded.opened[0]!.title, /^Release barrada release-292 \[incidente\]/);
  assert.match(delivery.recorded.opened[0]!.text, /^Release barrada release-292: carregue a skill dbolt-release-incident\. Papel: blocked\./);
  assert.deepEqual(git.written.map((write) => write.body["incident"]), [
    { by: "opencode/archdev", at: NOW.toISOString() },
    { by: "opencode/archdev", at: NOW.toISOString(), session: "opencode/archdev/ses_incident" },
  ]);
  assert.deepEqual((await readHandoffs(stateDir, "release-292")).map((handoff) => handoff.session.id), ["ses_incident"]);
  await watcher.tick();
  assert.equal(delivery.recorded.opened.length, 1, "um agente por nota");
});

test("watcher: órfã sem host de incidente → nada antes de 20 min; depois `recall` abandonado, uma vez", async () => {
  const fresh = await setup({ blocked: { [HEAD]: orphanNote() }, delivery: fakeDelivery({ open: "ok" }) });
  await fresh.watcher.tick();
  assert.equal(fresh.git.written.length, 0);
  assert.equal(fresh.delivery.recorded.opened.length, 0, "não é host de incidente");

  const stale = await setup({ blocked: { [HEAD]: orphanNote({ updatedAt: ago(21) }) } });
  await stale.watcher.tick();
  assert.equal(stale.git.written.length, 1);
  const recall = stale.git.written[0]!.body["recall"] as Record<string, unknown>;
  assert.equal(recall["abandoned"], true);
  assert.match(String(recall["reason"]), /nenhum host de incidente assumiu/);
  await stale.watcher.tick();
  assert.equal(stale.git.written.length, 1, "o abandono é gravado uma vez");
});

test("watcher: host de incidente que não consegue abrir o agente grava o abandono", async () => {
  const { watcher, git } = await setup({
    blocked: { [HEAD]: orphanNote() },
    config: { incidentHost: true, incidentCheckout: "/srv/dbolt" },
    delivery: fakeDelivery({ open: "refuse" }),
  });
  await watcher.tick();
  assert.equal(git.written.length, 2);
  const recall = git.written[1]!.body["recall"] as Record<string, unknown>;
  assert.equal(recall["abandoned"], true);
  assert.match(String(recall["reason"]), /host de incidente opencode\/archdev: abrir recusado/);
});

test("config: incidentHost só vale com incidentCheckout", async () => {
  const without = await loadConfig(await writeConfig(await tempState(), { ...config, incidentHost: true }));
  assert.equal(without.incidentHost, undefined);
  const withCheckout = await loadConfig(await writeConfig(await tempState(), { ...config, incidentHost: true, incidentCheckout: "/srv/dbolt" }));
  assert.equal(withCheckout.incidentHost, true);
  assert.equal(withCheckout.incidentCheckout, "/srv/dbolt");
});

test("updateNote: edição que recusa, nota ausente e corrida perdida", async () => {
  const notes: Record<string, BlockedNote> = { [HEAD]: blockedNote() };
  const input = { gitDir: join(await tempState(), "g.git"), repository: "dboltbr/dbolt", notesRef: "refs/notes/release-blocked", token: "t" };
  const ok = fakeExec(() => ({}), { blocked: () => notes, applyBlocked: true });
  assert.equal(await updateNote({ ...input, exec: ok.exec, key: HEAD, edit: () => null }), "unchanged");
  assert.equal(await updateNote({ ...input, exec: ok.exec, key: "nada", edit: (body) => body }), "gone");
  assert.equal(await updateNote({ ...input, exec: ok.exec, key: HEAD, edit: (body) => ({ ...body, x: 1 }) }), "written");
  assert.equal((notes[HEAD] as unknown as Record<string, unknown>)["x"], 1);
  const lost = fakeExec(() => ({}), { blocked: () => notes, push: "reject" });
  let edits = 0;
  assert.equal(await updateNote({ ...input, exec: lost.exec, key: HEAD, edit: (body) => (edits++, body) }), "lost");
  assert.equal(edits, 3, "cada corrida perdida decide de novo");
});
