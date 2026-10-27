import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../host.ts";
import type { HostConfig, Note } from "../types.ts";
import { createWatcher } from "../watcher.ts";
import {
  config,
  fakeDelivery,
  fakeExec,
  fakeGitHub,
  fixedClock,
  hoursAgo,
  NOW,
  note,
  quietLog,
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
    log: quietLog,
  });
  return { watcher, github, git, delivery, clock, stateDir };
}

const mineRed = note({
  release: "release-90",
  updatedAt: hoursAgo(3),
  sessions: [session("opencode", "archdev", "ses_culprit", ["c0ffee1"])],
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
    sessions: [session("opencode", "archdev", "ses_old")],
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
  assert.ok(call!.text.startsWith("Incidente release-90: carregue a skill dbolt-release-incident. Papel: investigate. Nota: {"));
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 1, "ref mudou mas a nota é a mesma: sem segundo chamado");
});

test("trava: dois processos no mesmo host chamam a sessão uma vez só", async () => {
  const stateDir = await tempState();
  const shared = fakeDelivery();
  const one = await setup({ notes: { tag90: mineRed }, refs: [{ status: 200, etag: '"e1"' }], stateDir, delivery: shared });
  const two = await setup({ notes: { tag90: mineRed }, refs: [{ status: 200, etag: '"e1"' }], stateDir, delivery: shared });
  await Promise.all([one.watcher.tick(), two.watcher.tick()]);
  assert.equal(shared.recorded.prompts.length, 1);
});

test("faixa com duas sessões: só o incident-host cria a sessão de investigação", async () => {
  const many = note({
    release: "release-91",
    sessions: [session("opencode", "archdev", "ses_a"), session("paseo", "srv_x", "agent-b")],
  });
  const regular = await setup({ notes: { t: many }, refs: [{ status: 200, etag: '"e"' }] });
  await regular.watcher.tick();
  assert.equal(regular.delivery.recorded.created.length, 0);
  assert.equal(regular.delivery.recorded.prompts.length, 0);
  const incident = await setup({
    notes: { t: many },
    refs: [{ status: 200, etag: '"e"' }],
    config: { ...config, incidentHost: true },
  });
  const report = await incident.watcher.tick();
  assert.equal(incident.delivery.recorded.created.length, 1);
  assert.equal(incident.delivery.recorded.prompts.length, 0);
  assert.equal(report.handled[0]!.outcome, "created");
});

test("sessão de outro harness ou host não é chamada", async () => {
  const other = note({ release: "release-92", sessions: [session("paseo", "srv_x", "agent-b")] });
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
  assert.equal(body["state"], "red");
  assert.equal(body["updatedAt"], NOW.toISOString());
  assert.deepEqual(
    { ...(body["recall"] as Record<string, unknown>), reason: undefined },
    { failedAt: NOW.toISOString(), by: "opencode/archdev", role: "investigate", target: "opencode/archdev/ses_culprit", state: "red", reason: undefined },
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

test("correção vai à sessão original do culpado; o owner não recebe fix", async () => {
  const decided = note({
    release: "release-93",
    state: "fix-pending",
    owner: "paseo/srv_x/agent-investigator",
    sessions: [session("opencode", "archdev", "ses_culprit", ["deadbeef1234"]), session("opencode", "archdev", "ses_clean", ["0123456789"])],
    assessment: { at: hoursAgo(0.1), suspects: [{ commit: "deadbeef1234" }] },
  });
  const { watcher, delivery } = await setup({ notes: { t: decided }, refs: [{ status: 200, etag: '"e"' }] });
  await watcher.tick();
  assert.deepEqual(
    delivery.recorded.prompts.map((p) => [p.target.id, p.text.split(". Nota:")[0]]),
    [["ses_culprit", "Incidente release-93: carregue a skill dbolt-release-incident. Papel: fix"]],
  );
});

test("aos 30 min de fix-forward sem fix.readyAt, o owner recebe um lembrete só", async () => {
  const pending = note({
    release: "release-94",
    state: "fix-pending",
    owner: "opencode/archdev/ses_owner",
    sessions: [session("opencode", "archdev", "ses_owner", ["aaaaaaa1"])],
    assessment: { at: hoursAgo(0.4), suspects: [{ commit: "aaaaaaa1" }] },
  });
  const { watcher, delivery, clock } = await setup({
    notes: { t: pending },
    refs: [{ status: 200, etag: '"e"' }, { status: 304 }],
  });
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 0, "24 min: ainda no prazo");
  clock.set(new Date(NOW.getTime() + 7 * 60_000));
  await watcher.tick();
  clock.set(new Date(NOW.getTime() + 8 * 60_000));
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 1);
  assert.match(delivery.recorded.prompts[0]!.text, /^Lembrete: o fix-forward da release-94 passou de 30 min/);
});

test("credencial recusada (401) não grava heartbeat", async () => {
  const { watcher, stateDir } = await setup({ notes: {}, refs: [{ status: 401 }] });
  const report = await watcher.tick();
  assert.equal(report.poll, "error");
  await assert.rejects(readFile(join(stateDir, "opencode.alive"), "utf8"));
});
