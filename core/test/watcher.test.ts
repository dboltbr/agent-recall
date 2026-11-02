import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, readHandoffs, writeHandoff } from "../host.ts";
import type { ReleaseTracker, TrackerTickInput } from "../release-fetch.ts";
import type { HostConfig, Note } from "../types.ts";
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
  note,
  quietLog,
  recordingLog,
  session,
  tempState,
  writeConfig,
} from "./fakes.ts";

async function setup(options: {
  notes: Record<string, Note>;
  refs: Array<{ status: number; etag?: string; sha?: string }>;
  config?: HostConfig;
  stateDir?: string;
  delivery?: ReturnType<typeof fakeDelivery>;
  harness?: "paseo" | "opencode";
  push?: "ok" | "reject";
  release?: ReleaseTracker;
  log?: ReturnType<typeof recordingLog>;
}) {
  const stateDir = options.stateDir ?? (await tempState());
  const configFile = await writeConfig(await tempState(), options.config ?? config);
  const github = fakeGitHub(options.refs);
  const git = fakeExec(() => options.notes, { push: options.push });
  const delivery = options.delivery ?? fakeDelivery();
  const clock = fixedClock();
  const watcher = createWatcher({
    harness: options.harness ?? "opencode",
    host: (c) => c.instance,
    loadConfig: () => loadConfig(configFile),
    stateDir,
    sha: "1234567890abcdef",
    pid: process.pid,
    clock,
    fetch: github.fetch,
    exec: git.exec,
    delivery: delivery.delivery,
    log: options.log ?? quietLog,
    release: options.release ?? fixedReleases([]),
  });
  return { watcher, github, git, delivery, clock, stateDir };
}

const mineRed = note({
  release: "release-90",
  updatedAt: hoursAgo(3),
  owner: session("opencode", "archdev", "ses_culprit", ["c0ffee1"]),
});

test("304: heartbeat atualizado, nenhuma busca de notas, nenhum chamado", async () => {
  const { watcher, github, git, delivery, stateDir, clock } = await setup({
    notes: { tagcommit: mineRed },
    refs: [{ status: 200, etag: 'W/"e1"', sha: "n1" }, { status: 304 }],
  });
  await watcher.tick();
  const fetchesAfterFirst = git.gitCalls("fetch").length;
  const promptsAfterFirst = delivery.recorded.prompts.length;
  clock.set(new Date(NOW.getTime() + 30_000));
  const report = await watcher.tick();
  assert.equal(report.poll, "unchanged");
  assert.equal(report.fetched, false);
  assert.equal(git.gitCalls("fetch").length, fetchesAfterFirst);
  assert.equal(delivery.recorded.prompts.length, promptsAfterFirst);
  const beat = JSON.parse(await readFile(join(stateDir, "opencode.alive"), "utf8"));
  assert.deepEqual(beat, { pid: process.pid, polledAt: "2026-10-27T15:00:30.000Z", sha: "1234567890abcdef" });
});

test("200 com ETag: busca as notas e manda If-None-Match na consulta seguinte", async () => {
  const { watcher, github, git } = await setup({
    notes: {},
    refs: [{ status: 200, etag: 'W/"e1"', sha: "n1" }, { status: 304 }],
  });
  const first = await watcher.tick();
  assert.equal(first.poll, "changed");
  assert.equal(first.fetched, true);
  assert.equal(git.gitCalls("fetch").length, 1);
  await watcher.tick();
  const [a, b] = github.refCalls();
  assert.equal(a!.url, "https://api.github.com/repos/dboltbr/dbolt/git/ref/notes/release-watch");
  assert.equal(a!.headers["If-None-Match"], undefined);
  assert.equal(b!.headers["If-None-Match"], 'W/"e1"');
  assert.equal(a!.headers["Authorization"], "Bearer gho_test");
});

test("recuperação na partida: incidente de 3 h é tratado uma vez, o de 9 h é ignorado", async () => {
  const old = note({
    release: "release-80",
    updatedAt: hoursAgo(9),
    owner: session("opencode", "archdev", "ses_old"),
  });
  const { watcher, delivery } = await setup({
    notes: { tag90: mineRed, tag80: old },
    refs: [{ status: 200, etag: '"e1"' }, { status: 200, etag: '"e2"' }],
  });
  const report = await watcher.tick();
  assert.deepEqual(
    report.handled.map((h) => [h.action.release, h.outcome]),
    [["release-90", "prompt"]],
  );
  assert.equal(delivery.recorded.prompts.length, 1);
  const [call] = delivery.recorded.prompts;
  assert.equal(call!.target.id, "ses_culprit");
  assert.ok(call!.text.startsWith("Incidente release-90: carregue a skill dbolt-release-incident. Papel: owner. "));
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 1, "ref mudou mas a nota é a mesma: sem segundo chamado");
});

test("chamado entregue fica registrado no diretório da trava; ensaio não", async () => {
  const { watcher, stateDir } = await setup({ notes: { tag90: mineRed }, refs: [{ status: 200, etag: '"e1"' }] });
  const report = await watcher.tick();
  assert.equal(report.handled[0]!.session, "ses_culprit");
  assert.deepEqual(await readHandoffs(stateDir, "release-90"), [
    { role: "owner", session: { harness: "opencode", host: "archdev", id: "ses_culprit" }, at: NOW.toISOString() },
  ]);
  const forked = await setup({
    notes: { tag90: mineRed },
    refs: [{ status: 200, etag: '"e1"' }],
    delivery: fakeDelivery({ prompt: "refuse" }),
  });
  const fallback = await forked.watcher.tick();
  const [record] = await readHandoffs(forked.stateDir, "release-90");
  assert.equal(record?.session.id, fallback.handled[0]!.session, "o fallback registra a sessão nova");
  const drill = await setup({
    notes: { tag90: { ...mineRed, drill: true } as Note },
    refs: [{ status: 200, etag: '"e1"' }],
  });
  await drill.watcher.tick();
  assert.equal(drill.delivery.recorded.prompts.length, 1);
  assert.deepEqual(await readHandoffs(drill.stateDir, "release-90"), []);
});

test("readHandoffs ignora registro corrompido ou estranho", async () => {
  const stateDir = await tempState();
  const good = { role: "owner", session: { harness: "paseo", host: "srv", id: "agent-1" }, at: NOW.toISOString() } as const;
  await writeHandoff(stateDir, "release-7", "agent-1.owner", good);
  await writeHandoff(stateDir, "release-7", "other", { ...good, role: "nope" } as never);
  await writeFile(join(stateDir, "release-7", "loose-file"), "x");
  assert.deepEqual(await readHandoffs(stateDir, "release-7"), [good]);
  assert.deepEqual(await readHandoffs(stateDir, "release-404"), []);
});

test("trava: dois processos no mesmo host chamam a sessão uma vez só", async () => {
  const stateDir = await tempState();
  const shared = fakeDelivery();
  const one = await setup({ notes: { tag90: mineRed }, refs: [{ status: 200, etag: '"e1"' }], stateDir, delivery: shared });
  const two = await setup({ notes: { tag90: mineRed }, refs: [{ status: 200, etag: '"e1"' }], stateDir, delivery: shared });
  await Promise.all([one.watcher.tick(), two.watcher.tick()]);
  assert.equal(shared.recorded.prompts.length, 1);
});

test("faixa com duas sessões: o dono recebe o pedido de ação, a avisada só o aviso com o nome dele", async () => {
  const many = note({
    release: "release-91",
    owner: session("opencode", "archdev", "ses_b", ["bbbbbbb"]),
    notified: [session("opencode", "archdev", "ses_a", ["aaaaaaa"]), session("paseo", "srv_x", "agent-c")],
  });
  const { watcher, delivery, stateDir } = await setup({ notes: { t: many }, refs: [{ status: 200, etag: '"e"' }, { status: 304 }] });
  const report = await watcher.tick();
  assert.deepEqual(
    report.handled.map((h) => [h.action.kind === "recall" ? h.action.role : h.action.kind, h.session]),
    [
      ["owner", "ses_b"],
      ["notified", "ses_a"],
    ],
  );
  const [owner, notified] = delivery.recorded.prompts;
  assert.match(owner!.text, /Papel: owner\. A sua sessão é a dona da release-91/);
  assert.match(notified!.text, /Papel: notified\. Aviso, sem pedido de ação: .* Quem age é a dona, opencode\/archdev\/ses_b;/);
  assert.deepEqual(
    (await readHandoffs(stateDir, "release-91")).map((h) => [h.role, h.session.id]).sort(),
    [
      ["notified", "ses_a"],
      ["owner", "ses_b"],
    ],
  );
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 2, "tick seguinte não chama de novo");
});

test("nota sem dono não chama ninguém, nem as avisadas", async () => {
  const orphan = note({ release: "release-91", owner: null, notified: [session("opencode", "archdev", "ses_a")] });
  const { watcher, delivery } = await setup({ notes: { t: orphan }, refs: [{ status: 200, etag: '"e"' }] });
  assert.deepEqual((await watcher.tick()).handled, []);
  assert.equal(delivery.recorded.prompts.length, 0);
});

test("sessão de outro harness ou host não é chamada", async () => {
  const other = note({ release: "release-92", owner: session("paseo", "srv_x", "agent-b") });
  const { watcher, delivery } = await setup({ notes: { t: other }, refs: [{ status: 200, etag: '"e"' }] });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0);
});

test("fallback: prompt recusado → fork; fork recusado → falha gravada na nota (CAS)", async () => {
  const forked = await setup({
    notes: { t: mineRed },
    refs: [{ status: 200, etag: '"e"' }],
    delivery: fakeDelivery({ prompt: "refuse" }),
  });
  const first = await forked.watcher.tick();
  assert.equal(first.handled[0]!.outcome, "fallback");
  assert.equal(forked.delivery.recorded.fallbacks[0]!.text, forked.delivery.recorded.prompts[0]!.text);
  const recorded = await setup({
    notes: { t: mineRed },
    refs: [{ status: 200, etag: '"e"' }],
    delivery: fakeDelivery({ prompt: "refuse", fallback: "refuse" }),
  });
  const second = await recorded.watcher.tick();
  assert.equal(second.handled[0]!.outcome, "recorded");
  assert.equal(recorded.git.written.length, 1);
  const { key, body } = recorded.git.written[0]!;
  assert.equal(key, "t");
  assert.deepEqual(body["rollback"], mineRed.rollback, "o resto da nota fica como estava");
  assert.equal(body["updatedAt"], NOW.toISOString());
  assert.deepEqual(
    { ...(body["recall"] as Record<string, unknown>), reason: undefined },
    { failedAt: NOW.toISOString(), by: "opencode/archdev", role: "owner", target: "opencode/archdev/ses_culprit", rollback: "reverted", reason: undefined },
  );
  assert.match((body["recall"] as { reason: string }).reason, /prompt: prompt recusado; fallback: fork recusado/);
  const lost = await setup({
    notes: { t: mineRed },
    refs: [{ status: 200, etag: '"e"' }],
    push: "reject",
    delivery: fakeDelivery({ prompt: "refuse", fallback: "refuse" }),
  });
  assert.equal((await lost.watcher.tick()).handled[0]!.outcome, "failed");
  assert.equal(lost.git.gitCalls("push").length, 3);
});

test("rollback pendente: a avisada vai na hora, o dono quando o vigia grava o desfecho", async () => {
  const pending = note({
    release: "release-94",
    owner: session("opencode", "archdev", "ses_owner", ["aaaaaaa1"]),
    notified: [session("opencode", "archdev", "ses_other")],
    rollback: { outcome: "pending" },
    verdict: { verdict: "red", sources: { sentry: { outcome: "red", reason: "new-issue" } }, at: hoursAgo(0.05) },
  });
  // fakeExec reads `notes` on every call: replacing the entry is the watch updating the note.
  const notes: Record<string, Note> = { t: pending };
  const { watcher, delivery, clock } = await setup({
    notes,
    refs: [{ status: 200, etag: '"e1"' }, { status: 304 }, { status: 200, etag: '"e2"' }],
  });
  await watcher.tick();
  assert.deepEqual(delivery.recorded.prompts.map((p) => p.target.id), ["ses_other"]);
  clock.set(new Date(NOW.getTime() + 30_000));
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 1, "pendente há 3,5 min: o dono ainda espera");
  notes["t"] = { ...pending, rollback: { outcome: "blocked", target: "dbolt-deploy", reason: "unsafe-migration", findings: [{}] } };
  clock.set(new Date(NOW.getTime() + 60_000));
  await watcher.tick();
  assert.deepEqual(delivery.recorded.prompts.map((p) => p.target.id), ["ses_other", "ses_owner"]);
  assert.match(delivery.recorded.prompts[1]!.text, /Motivo: Sentry: new-issue\. Rollback: impedido: a imagem anterior não aguenta o banco/);
});

test("rollback que fica pendente (vigia morreu): o dono é chamado aos 10 min, sem a nota mudar", async () => {
  const stuck = note({
    release: "release-95",
    owner: session("opencode", "archdev", "ses_owner"),
    rollback: { outcome: "pending" },
    verdict: { verdict: "red", sources: {}, at: hoursAgo(0.1) },
  });
  const { watcher, delivery, clock } = await setup({ notes: { t: stuck }, refs: [{ status: 200, etag: '"e1"' }, { status: 304 }] });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0, "6 min: ainda espera o desfecho");
  clock.set(new Date(NOW.getTime() + 4 * 60_000));
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 1);
  assert.match(delivery.recorded.prompts[0]!.text, /Rollback: pendente: o vigia não gravou o desfecho do rollback/);
});

test("nota removida antes do desfecho sai do cache: o dono não é chamado aos 10 min", async () => {
  const stuck = note({
    release: "release-96",
    owner: session("opencode", "archdev", "ses_owner"),
    rollback: { outcome: "pending" },
    verdict: { verdict: "red", sources: {}, at: hoursAgo(0.1) },
  });
  const notes: Record<string, Note> = { t: stuck };
  const { watcher, delivery, clock } = await setup({ notes, refs: [{ status: 200, etag: '"e1"' }, { status: 200, etag: '"e2"' }] });
  await watcher.tick();
  delete notes["t"];
  clock.set(new Date(NOW.getTime() + 4 * 60_000));
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0);
});

test("credencial recusada (401) não grava heartbeat", async () => {
  const { watcher, stateDir } = await setup({ notes: {}, refs: [{ status: 401 }] });
  const report = await watcher.tick();
  assert.equal(report.poll, "error");
  await assert.rejects(readFile(join(stateDir, "opencode.alive"), "utf8"));
});

test("release: o rastreador anda com o token, as notas e o sinal de mudança do poller", async () => {
  const ticks: TrackerTickInput[] = [];
  const release: ReleaseTracker = {
    async tick(input) {
      ticks.push(input);
      throw new Error("GitHub fora");
    },
    refresh: async () => false,
    current: () => null,
  };
  const { watcher } = await setup({
    notes: { tagcommit: mineRed },
    refs: [{ status: 200, etag: 'W/"e1"', sha: "n1" }, { status: 304 }],
    release,
  });
  await watcher.tick();
  const report = await watcher.tick();
  assert.equal(report.poll, "unchanged", "falha do rastreador não derruba o tick");
  assert.deepEqual(
    ticks.map((tick) => [tick.token, tick.notesChanged, [...tick.notes.keys()]]),
    [
      ["gho_test", true, ["tagcommit"]],
      ["gho_test", false, ["tagcommit"]],
    ],
  );
});

test("trava que lança numa sessão não pula as outras; a volta seguinte tenta de novo", async () => {
  // A session id longer than a file name: its lock mkdir throws ENAMETOOLONG.
  const long = "s".repeat(300);
  const red = note({
    release: "release-95",
    owner: session("opencode", "archdev", long, ["aaaaaaa1"]),
    notified: [session("opencode", "archdev", "ses_b", ["bbbbbbb2"])],
  });
  const log = recordingLog();
  const { watcher, delivery } = await setup({ notes: { t: red }, refs: [{ status: 200, etag: '"e1"' }, { status: 304 }], log });
  await watcher.tick();
  assert.deepEqual(delivery.recorded.prompts.map((prompt) => prompt.target.id), ["ses_b"]);
  const failures = () => log.lines.filter((line) => line.startsWith("error") && line.includes(long.slice(0, 20))).length;
  assert.equal(failures(), 1);
  await watcher.tick();
  assert.equal(failures(), 2);
  assert.equal(delivery.recorded.prompts.length, 1, "a trava segura o que já foi");
});
