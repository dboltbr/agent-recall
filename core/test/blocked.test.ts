import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, readHandoffs } from "../host.ts";
import { buildRelease, type Release } from "../release-status.ts";
import { createReleaseSource, createReleaseTracker, type ReleaseTracker } from "../release-fetch.ts";
import { ACK_TIMEOUT_MS, blockedConfirmation, blockedCulprits, routeBlocked, shippedSince } from "../route.ts";
import type { BlockedNote, HostConfig, Me } from "../types.ts";
import { createWatcher } from "../watcher.ts";
import {
  config,
  fakeApi,
  fakeDelivery,
  fakeExec,
  fakeGitHub,
  fixedClock,
  fixedReleases,
  hoursAgo,
  NOW,
  quietLog,
  recordingLog,
  session,
  tempState,
  writeConfig,
  type RefReply,
} from "./fakes.ts";
import { job, minutesAgo, run } from "./releases.ts";

const me: Me = { harness: "opencode", host: "archdev" };
const HEAD = "0292aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** The note the dbolt `blocked-note` job writes on the run's head commit. */
function blockedNote(partial: Partial<BlockedNote> = {}): BlockedNote {
  return {
    release: "release-292",
    state: "red",
    range: { from: "0290bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", to: HEAD },
    // The GitHub merge `9a9a9a9` has no Agent-Session: it is simply not in `sessions`.
    sessions: [session("opencode", "archdev", "ses_pusher", ["c0ffee1", "c0ffee2"])],
    owner: undefined,
    run: { id: 40_000_000_292, url: "https://github.com/dboltbr/dbolt/actions/runs/40000000292", failedJob: "verify-production / check" },
    createdAt: hoursAgo(0.2),
    updatedAt: hoursAgo(0.2),
    ...partial,
  };
}

/** Two sessions on different hosts: the Paseo agent on archdev and a Claude Code session on the Mac. */
const twoSessions = blockedNote({
  release: "release-352",
  sessions: [session("paseo", "srv_archdev", "agent-a", ["aaaaaaa1"]), session("claude", "mac", "ses-mac", ["bbbbbbb2"])],
});

/** A run that failed before the tag, or one that shipped (its tag exists). */
function release(number: number, outcome: "failed" | "shipped"): Release {
  return buildRelease({
    run: run({
      run_number: number,
      status: "completed",
      conclusion: outcome === "shipped" ? "success" : "failure",
      updated_at: minutesAgo(5),
    }),
    jobs: outcome === "shipped" ? [] : [job("verify-production / check", "failure", [15, 5]), job("release-tag", "skipped", [5, 5])],
    tagged: outcome === "shipped",
    note: null,
    commits: null,
    now: NOW,
  });
}

test("routeBlocked: uma sessão identificada, mesmo com merge sem trailer → ela, com papel blocked", () => {
  assert.deepEqual(routeBlocked(blockedNote(), me), [
    { kind: "blocked", release: "release-292", role: "blocked", target: { harness: "opencode", host: "archdev", id: "ses_pusher" }, lock: "ses_pusher.blocked" },
  ]);
  assert.deepEqual(routeBlocked(blockedNote(), { ...me, host: "outro" }), [], "a sessão é de outro host");
});

test("routeBlocked: várias sessões → a do commit da cabeça, senão a primeira da nota; nenhuma → ninguém", () => {
  const paseo: Me = { harness: "paseo", host: "srv_archdev" };
  const mac: Me = { harness: "claude", host: "mac" };
  // `range.to` is the Mac session's commit: it is the one called, the Paseo agent is not.
  const headIsMac: BlockedNote = { ...twoSessions, range: { from: null, to: "bbbbbbb2ffffffffffffffffffffffffffffffff" } };
  assert.deepEqual(routeBlocked(headIsMac, mac), [
    { kind: "blocked", release: "release-352", role: "blocked", target: { harness: "claude", host: "mac", id: "ses-mac" }, lock: "ses-mac.blocked" },
  ]);
  assert.deepEqual(routeBlocked(headIsMac, paseo), []);
  // The head is a GitHub merge without Agent-Session: the first in note order (the CI lists them
  // by their newest commit, newest first) is the one nearest the head.
  const headless: BlockedNote = { ...twoSessions, range: { from: null, to: "9a9a9a9a" } };
  assert.deepEqual(routeBlocked(headless, mac), []);
  assert.deepEqual(routeBlocked(headless, paseo), [
    { kind: "blocked", release: "release-352", role: "blocked", target: { harness: "paseo", host: "srv_archdev", id: "agent-a" }, lock: "agent-a.blocked" },
  ]);
  assert.deepEqual(routeBlocked(blockedNote({ sessions: [] }), me), [], "só commits humanos ou merges");
});
test("routeBlocked: fix-pending chama a sessão de cada culpado no host dela, salvo o owner", () => {
  const decided: BlockedNote = {
    ...twoSessions,
    state: "fix-pending",
    owner: "paseo/srv_archdev/agent-investigator",
    assessment: { suspects: [{ commit: "bbbbbbb2", evidence: "teste do commit quebra" }] },
  };
  assert.deepEqual(routeBlocked(decided, { harness: "claude", host: "mac" }), [
    { kind: "blocked", release: "release-352", role: "fix", target: { harness: "claude", host: "mac", id: "ses-mac" }, lock: "ses-mac.blocked-fix" },
  ]);
  assert.deepEqual(routeBlocked(decided, { harness: "paseo", host: "srv_archdev" }), []);
  const ownerIsCulprit = { ...decided, owner: "claude/mac/ses-mac" };
  assert.deepEqual(routeBlocked(ownerIsCulprit, { harness: "claude", host: "mac" }), []);
});

test("routeBlocked: investigating, duplicate, terminais e red com owner não chamam ninguém", () => {
  for (const state of ["investigating", "duplicate", "shipped", "unrelated", "escalated"]) {
    assert.deepEqual(routeBlocked(blockedNote({ state }), me), [], state);
  }
  const duplicate = blockedNote({ state: "duplicate", inheritedFrom: "release-290", owner: "paseo/srv_x/agent-1" });
  assert.deepEqual(routeBlocked(duplicate, me), []);
  assert.deepEqual(routeBlocked(blockedNote({ owner: "paseo/srv_x/agent-1" }), me), []);
});

test("shippedSince: release com tag igual ou posterior encerra; sem histórico ninguém sabe", () => {
  const note = blockedNote();
  assert.equal(shippedSince(note, [release(294, "shipped"), release(292, "failed")]), true);
  assert.equal(shippedSince(note, [release(292, "shipped")]), true, "re-run da mesma release com tag");
  assert.equal(shippedSince(note, [release(293, "failed"), release(292, "failed"), release(291, "shipped")]), false);
  assert.equal(shippedSince(note, null), null);
  assert.equal(shippedSince(note, []), null);
});

async function setup(options: {
  blocked: Record<string, BlockedNote>;
  blockedRefs?: RefReply[];
  releases?: Release[] | null;
  /** A real tracker instead of the fixed history. */
  tracker?: ReleaseTracker;
  config?: Partial<HostConfig>;
  delivery?: ReturnType<typeof fakeDelivery>;
  harness?: "opencode" | "paseo";
  stateDir?: string;
  log?: ReturnType<typeof recordingLog>;
  /** Blocked writes land on `blocked` (the next fetch reads them). */
  apply?: boolean;
}) {
  const stateDir = options.stateDir ?? (await tempState());
  const configFile = await writeConfig(await tempState(), { ...config, ...options.config });
  const git = fakeExec(() => ({}), { blocked: () => options.blocked, applyBlocked: options.apply });
  const github = fakeGitHub([{ status: 404 }], options.blockedRefs ?? [{ status: 200, etag: '"b1"' }, { status: 304 }]);
  const delivery = options.delivery ?? fakeDelivery();
  const clock = fixedClock();
  const releases = fixedReleases(options.releases === undefined ? [release(292, "failed"), release(291, "shipped")] : options.releases);
  const watcher = createWatcher({
    harness: options.harness ?? "opencode",
    host: (c) => (options.harness === "paseo" ? "srv_archdev" : c.instance),
    loadConfig: () => loadConfig(configFile),
    stateDir,
    sha: "1234567890abcdef",
    pid: process.pid,
    clock,
    fetch: github.fetch,
    exec: git.exec,
    delivery: delivery.delivery,
    log: options.log ?? quietLog,
    release: options.tracker ?? releases,
  });
  const later = (ms: number) => clock.set(new Date(clock.now().getTime() + ms));
  return { watcher, delivery, git, github, clock, later, releases, stateDir };
}

test("watcher: uma sessão com merge sem trailer na faixa → um prompt `Release barrada`, uma vez", async () => {
  const { watcher, delivery, stateDir, github } = await setup({ blocked: { [HEAD]: blockedNote() } });
  const report = await watcher.tick();
  assert.equal(github.blockedCalls()[0]!.url, "https://api.github.com/repos/dboltbr/dbolt/git/ref/notes/release-blocked");
  assert.deepEqual(
    report.handled.map((handled) => [handled.action.kind, handled.action.release, handled.outcome]),
    [["blocked", "release-292", "prompt"]],
  );
  const [call] = delivery.recorded.prompts;
  assert.equal(call!.target.id, "ses_pusher");
  assert.equal(
    call!.text,
    "Release barrada release-292: carregue a skill dbolt-release-incident. Papel: blocked. Release: " +
      JSON.stringify({
        number: 292,
        url: "https://github.com/dboltbr/dbolt/actions/runs/40000000292",
        headSha: HEAD,
        failedJob: "verify-production / check",
        state: "red",
      }),
  );
  assert.deepEqual(
    (await readHandoffs(stateDir, "release-292")).map((handoff) => [handoff.role, handoff.session.id]),
    [["blocked", "ses_pusher"]],
  );
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 1, "segundo tick: a mesma nota não chama de novo");
});

test("watcher: duas sessões em hosts diferentes → só a do commit da cabeça é chamada, no host dela", async () => {
  const headIsPaseo: BlockedNote = { ...twoSessions, range: { from: null, to: "aaaaaaa1" } };
  const releases = [release(352, "failed"), release(351, "shipped")];
  const paseo = await setup({ blocked: { [HEAD]: headIsPaseo }, releases, harness: "paseo" });
  const report = await paseo.watcher.tick();
  assert.deepEqual(report.handled.map((handled) => [handled.action.kind, handled.outcome]), [["blocked", "prompt"]]);
  assert.deepEqual(paseo.delivery.recorded.prompts.map((prompt) => prompt.target.id), ["agent-a"]);
  assert.match(paseo.delivery.recorded.prompts[0]!.text, /^Release barrada release-352: carregue a skill dbolt-release-incident\. Papel: blocked\./);
  assert.ok(existsSync(join(paseo.stateDir, "release-352", "agent-a.blocked")));
  const elsewhere = await setup({ blocked: { [HEAD]: { ...headIsPaseo, range: { from: null, to: "bbbbbbb2" } } }, releases, harness: "paseo" });
  await elsewhere.watcher.tick();
  assert.equal(elsewhere.delivery.recorded.prompts.length, 0, "a cabeça é da sessão do Mac");
});

test("watcher: faixa sem nenhum Agent-Session → ninguém é chamado", async () => {
  const { watcher, delivery } = await setup({ blocked: { [HEAD]: blockedNote({ sessions: [] }) } });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0);
});
test("watcher: o investigador aponta o culpado em outro host → esse host chama a sessão com a trava de correção", async () => {
  const decided: BlockedNote = {
    ...twoSessions,
    sessions: [session("paseo", "srv_x", "agent-a", ["aaaaaaa1"]), session("opencode", "archdev", "ses_b", ["bbbbbbb2"])],
    state: "fix-pending",
    owner: "paseo/srv_x/agent-investigator",
    assessment: { suspects: [{ commit: "bbbbbbb2", evidence: "o teste do próprio commit" }] },
    updatedAt: hoursAgo(0.05),
  };
  const { watcher, delivery, stateDir } = await setup({ blocked: { [HEAD]: decided }, releases: [release(352, "failed")] });
  await watcher.tick();
  assert.deepEqual(
    delivery.recorded.prompts.map((prompt) => [prompt.target.id, prompt.text.split(" Release: ")[0]]),
    [["ses_b", "Release barrada release-352: carregue a skill dbolt-release-incident. Papel: blocked."]],
  );
  assert.match(delivery.recorded.prompts[0]!.text, /"state":"fix-pending"/);
  assert.ok(existsSync(join(stateDir, "release-352", "ses_b.blocked-fix")));
  // The handoff role of every blocked call is `blocked` (the release surfaces' label).
  assert.deepEqual((await readHandoffs(stateDir, "release-352")).map((handoff) => handoff.role), ["blocked"]);
});

test("watcher: sessão que recebeu e não gravou owner em 2 min → cópia de reserva com o mesmo pedido", async () => {
  const { watcher, delivery, later, stateDir } = await setup({ blocked: { [HEAD]: blockedNote() } });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 1);
  later(ACK_TIMEOUT_MS - 1_000);
  await watcher.tick();
  assert.equal(delivery.recorded.fallbacks.length, 0, "ainda no prazo");
  later(1_000);
  const report = await watcher.tick();
  assert.deepEqual(delivery.recorded.fallbacks, [{ target: delivery.recorded.prompts[0]!.target, text: delivery.recorded.prompts[0]!.text }]);
  assert.deepEqual(report.handled.map((handled) => [handled.action.kind, handled.outcome, handled.session]), [["blocked", "fallback", "ses_fork"]]);
  assert.deepEqual((await readHandoffs(stateDir, "release-292")).map((handoff) => handoff.session.id), ["ses_fork"]);
  later(ACK_TIMEOUT_MS);
  await watcher.tick();
  assert.equal(delivery.recorded.fallbacks.length, 1, "uma cópia só");
});

test("watcher: owner gravado dentro do prazo confirma; nenhuma cópia", async () => {
  const notes: Record<string, BlockedNote> = { [HEAD]: blockedNote() };
  const { watcher, delivery, later } = await setup({
    blocked: notes,
    blockedRefs: [{ status: 200, etag: '"b1"' }, { status: 200, etag: '"b2"' }, { status: 304 }],
  });
  await watcher.tick();
  notes[HEAD] = blockedNote({ state: "investigating", owner: "opencode/archdev/ses_pusher", updatedAt: NOW.toISOString() });
  later(60_000);
  await watcher.tick();
  later(ACK_TIMEOUT_MS);
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 1);
  assert.equal(delivery.recorded.fallbacks.length, 0);
});

test("watcher: notas barradas que não vieram nesta volta não viram cópia", async () => {
  const { watcher, delivery, later } = await setup({
    blocked: { [HEAD]: blockedNote() },
    blockedRefs: [{ status: 200, etag: '"b1"' }, { status: 502 }],
  });
  await watcher.tick();
  later(ACK_TIMEOUT_MS + 30_000);
  await watcher.tick();
  assert.equal(delivery.recorded.fallbacks.length, 0, "a confirmação pode estar no remoto");
});

test("watcher: cópia de reserva que falha grava `recall` na nota barrada", async () => {
  const { watcher, git, later } = await setup({
    blocked: { [HEAD]: blockedNote() },
    delivery: fakeDelivery({ fallback: "refuse" }),
  });
  await watcher.tick();
  later(ACK_TIMEOUT_MS);
  const report = await watcher.tick();
  assert.deepEqual(report.handled.map((handled) => handled.outcome), ["recorded"]);
  assert.equal(git.written.length, 1);
  const { key, ref, body } = git.written[0]!;
  assert.equal(key, HEAD);
  assert.equal(ref, "refs/notes/release-blocked");
  assert.deepEqual(
    { ...(body["recall"] as Record<string, unknown>), reason: undefined },
    { failedAt: new Date(NOW.getTime() + ACK_TIMEOUT_MS).toISOString(), by: "opencode/archdev", role: "blocked", target: "opencode/archdev/ses_pusher", state: "red", reason: undefined },
  );
  assert.match(String((body["recall"] as { reason: string }).reason), /sem confirmação; fallback: fork recusado/);
});

test("watcher: prompt e cópia recusados de cara → `recall` na nota barrada", async () => {
  const { watcher, git } = await setup({
    blocked: { [HEAD]: blockedNote() },
    delivery: fakeDelivery({ prompt: "refuse", fallback: "refuse" }),
  });
  const report = await watcher.tick();
  assert.deepEqual(report.handled.map((handled) => handled.outcome), ["recorded"]);
  assert.equal(git.written[0]!.ref, "refs/notes/release-blocked");
});

test("watcher: release posterior com tag → ninguém é chamado", async () => {
  const { watcher, delivery } = await setup({
    blocked: { [HEAD]: blockedNote() },
    releases: [release(294, "shipped"), release(293, "failed"), release(292, "failed")],
  });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0);
});

test("watcher: release com tag depois do chamado encerra a espera sem cópia", async () => {
  const { watcher, delivery, later, releases } = await setup({ blocked: { [HEAD]: blockedNote() } });
  await watcher.tick();
  releases.set([release(293, "shipped"), release(292, "failed")]);
  later(ACK_TIMEOUT_MS + 1_000);
  await watcher.tick();
  assert.equal(delivery.recorded.fallbacks.length, 0);
});

test("watcher: nota barrada de mais de 8 h → ninguém é chamado", async () => {
  const { watcher, delivery } = await setup({ blocked: { [HEAD]: blockedNote({ updatedAt: hoursAgo(9) }) } });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0);
});

test("watcher: nota `duplicate` com sessões na faixa → ninguém é chamado", async () => {
  const duplicate = blockedNote({ state: "duplicate", inheritedFrom: "release-290", owner: "paseo/srv_x/agent-1" });
  const { watcher, delivery } = await setup({ blocked: { [HEAD]: duplicate } });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0);
});

test("watcher: sem histórico de releases a nota espera; com ele, chama", async () => {
  const { watcher, delivery, releases } = await setup({ blocked: { [HEAD]: blockedNote() }, releases: null });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0, "não dá para saber se uma release posterior já foi");
  releases.set([release(292, "failed")]);
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 1);
});

test("watcher: ref barrada ausente no remoto → nenhuma release barrada", async () => {
  const { watcher, delivery, git } = await setup({ blocked: { [HEAD]: blockedNote() }, blockedRefs: [{ status: 404 }] });
  const report = await watcher.tick();
  assert.equal(report.blocked, "missing");
  assert.equal(delivery.recorded.prompts.length, 0);
  assert.equal(git.gitCalls("fetch").length, 0);
});

test("config: ensaio lê a ref barrada de ensaio; a chave explícita vale", async () => {
  const { blockedRef: _drop, ...plain } = config;
  const drill = await loadConfig(await writeConfig(await tempState(), { ...plain, notesRef: "refs/notes/release-watch-drill" } as HostConfig));
  assert.equal(drill.blockedRef, "refs/notes/release-blocked-drill");
  assert.equal((await loadConfig(await writeConfig(await tempState(), plain as HostConfig))).blockedRef, "refs/notes/release-blocked");
  const named = await loadConfig(await writeConfig(await tempState(), { ...config, blockedRef: "refs/notes/x" }));
  assert.equal(named.blockedRef, "refs/notes/x");
});

test("watcher: história de releases que não carrega na espera adia a cópia, sem encerrar", async () => {
  const { watcher, delivery, later, releases } = await setup({ blocked: { [HEAD]: blockedNote() } });
  await watcher.tick();
  releases.fail("GitHub fora");
  later(ACK_TIMEOUT_MS + 1_000);
  await watcher.tick();
  assert.equal(delivery.recorded.fallbacks.length, 0, "uma release posterior pode ter ido");
  releases.fail(null);
  later(30_000);
  await watcher.tick();
  assert.equal(delivery.recorded.fallbacks.length, 1, "com a história de volta, a espera segue");
});

test("watcher: nota em cache depois de uma busca barrada que falhou não é roteada", async () => {
  const notes: Record<string, BlockedNote> = { [HEAD]: blockedNote() };
  const { watcher, delivery, releases } = await setup({
    blocked: notes,
    releases: null,
    blockedRefs: [{ status: 200, etag: '"b1"' }, { status: 502 }, { status: 200, etag: '"b2"' }],
  });
  await watcher.tick();
  // On the remote someone took it meanwhile; this host only has the stale `red` copy.
  notes[HEAD] = blockedNote({ state: "investigating", owner: "paseo/srv_x/agent-1", updatedAt: NOW.toISOString() });
  releases.set([release(292, "failed")]);
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0, "a busca desta volta falhou");
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0, "a nota em dia já tem dono");
});

test("watcher: história de releases que falhou ao atualizar adia a nota; a antiga não basta", async () => {
  const { watcher, delivery, releases } = await setup({ blocked: { [HEAD]: blockedNote() } });
  releases.fail("GitHub fora");
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0, "a release-294 com tag pode não estar na história antiga");
  releases.set([release(294, "shipped"), release(292, "failed")]);
  releases.fail(null);
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0, "a história em dia encerra o chamado");
});

test("watcher: trava que lança num culpado não pula os outros nem dá a nota por vista", async () => {
  // A session id longer than a file name: its lock mkdir throws ENAMETOOLONG.
  const long = "s".repeat(300);
  const decided: BlockedNote = {
    ...twoSessions,
    sessions: [session("opencode", "archdev", long, ["aaaaaaa1"]), session("opencode", "archdev", "ses_b", ["bbbbbbb2"])],
    state: "fix-pending",
    owner: "paseo/srv_x/agent-investigator",
    assessment: { suspects: [{ commit: "aaaaaaa1" }, { commit: "bbbbbbb2" }] },
  };
  const log = recordingLog();
  const { watcher, delivery } = await setup({ blocked: { [HEAD]: decided }, releases: [release(352, "failed")], log });
  await watcher.tick();
  assert.deepEqual(delivery.recorded.prompts.map((prompt) => prompt.target.id), ["ses_b"]);
  const failures = () => log.lines.filter((line) => line.startsWith("error") && line.includes(long.slice(0, 20))).length;
  assert.equal(failures(), 1);
  await watcher.tick();
  assert.equal(failures(), 2, "a nota não ficou vista: a volta seguinte tenta de novo");
  assert.deepEqual(delivery.recorded.prompts.map((prompt) => prompt.target.id), ["ses_b"], "a trava segura o que já foi");
});

test("routeBlocked: coleções malformadas da nota contam como vazias, sem lançar", () => {
  const bad = (partial: Record<string, unknown>) => blockedNote(partial as Partial<BlockedNote>);
  assert.deepEqual(routeBlocked(bad({ sessions: {} }), me), []);
  assert.deepEqual(routeBlocked(bad({ sessions: [null, "x", { harness: "opencode", host: "archdev", id: "ses_c", commits: "abc" }] }), me), [
    { kind: "blocked", release: "release-292", role: "blocked", target: { harness: "opencode", host: "archdev", id: "ses_c" }, lock: "ses_c.blocked" },
  ]);
  const fixPending = bad({ state: "fix-pending", assessment: { suspects: {} } });
  assert.deepEqual(blockedCulprits(fixPending), []);
  assert.deepEqual(routeBlocked(fixPending, me), []);
  assert.deepEqual(blockedCulprits(bad({ state: "fix-pending", assessment: { suspects: [null, 7, { commit: 9 }, { commit: "c0ffee1" }] } })), [
    { harness: "opencode", host: "archdev", id: "ses_pusher" },
  ]);
  assert.deepEqual(routeBlocked(bad({ state: "fix-pending", owner: { not: "a string" }, assessment: { suspects: [{ commit: "c0ffee1" }] } }), me).length, 1);
});

test("watcher: nota malformada não derruba a volta das outras", async () => {
  const bad = (partial: Record<string, unknown>) => blockedNote(partial as Partial<BlockedNote>);
  const { watcher, delivery } = await setup({
    blocked: {
      a: bad({ sessions: {} }),
      b: bad({ sessions: [{ harness: "opencode", host: "archdev", id: "ses_b", commits: "abc" }] }),
      c: bad({ state: "fix-pending", assessment: { suspects: {} } }),
      d: blockedNote({ sessions: [session("opencode", "archdev", "ses_d", ["d0d0d0d"])] }),
    },
  });
  await watcher.tick();
  assert.deepEqual(delivery.recorded.prompts.map((prompt) => prompt.target.id).sort(), ["ses_b", "ses_d"]);
});

test("blockedConfirmation: chamado de correção cujo culpado saiu da avaliação é encerrado", () => {
  const target = { harness: "opencode", host: "archdev", id: "ses_b" } as const;
  const base: BlockedNote = {
    ...twoSessions,
    sessions: [session("paseo", "srv_x", "agent-a", ["aaaaaaa1"]), session("opencode", "archdev", "ses_b", ["bbbbbbb2"])],
    state: "fix-pending",
    owner: "paseo/srv_x/agent-investigator",
    assessment: { suspects: [{ commit: "bbbbbbb2" }] },
    updatedAt: NOW.toISOString(),
  };
  assert.equal(blockedConfirmation("fix", target, base, false, NOW), "open");
  assert.equal(blockedConfirmation("fix", target, { ...base, assessment: { suspects: [{ commit: "aaaaaaa1" }] } }, false, NOW), "moot");
});

test("watcher: avaliação que troca de culpado encerra a espera do chamado de correção", async () => {
  const decided: BlockedNote = {
    ...twoSessions,
    sessions: [session("paseo", "srv_x", "agent-a", ["aaaaaaa1"]), session("opencode", "archdev", "ses_b", ["bbbbbbb2"])],
    state: "fix-pending",
    owner: "paseo/srv_x/agent-investigator",
    assessment: { suspects: [{ commit: "bbbbbbb2" }] },
  };
  const notes: Record<string, BlockedNote> = { [HEAD]: decided };
  const { watcher, delivery, later } = await setup({
    blocked: notes,
    releases: [release(352, "failed")],
    blockedRefs: [{ status: 200, etag: '"b1"' }, { status: 200, etag: '"b2"' }, { status: 304 }],
  });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 1);
  notes[HEAD] = { ...decided, assessment: { suspects: [{ commit: "aaaaaaa1" }] }, updatedAt: NOW.toISOString() };
  later(60_000);
  await watcher.tick();
  later(ACK_TIMEOUT_MS);
  await watcher.tick();
  assert.equal(delivery.recorded.fallbacks.length, 0, "ses_b não é mais culpada");
});

test("shippedSince: release mais velha que a história guardada, sem tag depois dela → ninguém sabe", () => {
  const recent = [release(300, "failed"), release(299, "failed")];
  assert.equal(shippedSince(blockedNote(), recent), null, "a release-292 é anterior à run mais velha guardada");
  assert.equal(shippedSince(blockedNote(), [release(300, "shipped"), release(299, "failed")]), true);
  assert.equal(shippedSince(blockedNote({ release: "release-299" }), recent), false);
});

test("watcher: release barrada mais velha que a história guardada → ninguém é chamado", async () => {
  const { watcher, delivery } = await setup({ blocked: { [HEAD]: blockedNote() }, releases: [release(300, "failed"), release(299, "failed")] });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0);
});

test("watcher: sonda ociosa do rastreador que falha adia a cópia nessa volta", async () => {
  const runs = [
    run({ run_number: 292, status: "completed", conclusion: "failure", updated_at: minutesAgo(5) }),
    run({ run_number: 291, status: "completed", conclusion: "success", updated_at: minutesAgo(30) }),
  ];
  const probe = { fail: false };
  const api = fakeApi({
    "repos/dboltbr/dbolt/actions/workflows/release.yml/runs?per_page=15&page=1": () =>
      probe.fail ? { status: 502 } : { body: { total_count: runs.length, workflow_runs: runs }, etag: '"r1"' },
    "repos/dboltbr/dbolt/git/matching-refs/tags/release-": { body: [{ ref: "refs/tags/release-291" }] },
    "repos/dboltbr/dbolt/actions/runs/40000000292/jobs?per_page=100&page=1": { body: { total_count: 0, jobs: [] } },
    "repos/dboltbr/dbolt/actions/runs/40000000291/jobs?per_page=100&page=1": { body: { total_count: 0, jobs: [] } },
  });
  const clock = fixedClock();
  const tracker = createReleaseTracker({ source: createReleaseSource({ fetch: api.fetch, clock, log: quietLog }), clock, log: quietLog });
  const { watcher, delivery, later } = await setup({ blocked: { [HEAD]: blockedNote() }, tracker });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 1, "história carregada: chamada");
  probe.fail = true;
  later(ACK_TIMEOUT_MS + 1_000);
  await watcher.tick();
  assert.equal(tracker.current()?.error !== null, true, "a sonda falhou nesta volta");
  assert.equal(delivery.recorded.fallbacks.length, 0, "sem saber se uma release posterior foi, ninguém é copiado");
  probe.fail = false;
  later(30_000);
  await watcher.tick();
  assert.equal(delivery.recorded.fallbacks.length, 1, "sonda em dia: a espera segue");
});
