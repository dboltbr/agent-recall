import assert from "node:assert/strict";
import { test } from "node:test";
import { pollFactory, factoryPrompt } from "../factory-api.ts";
import { createWatcher } from "../watcher.ts";
import { fakeDelivery, fakeExec, fixedClock, fixedReleases, note, quietLog, session, tempState } from "./fakes.ts";

test("factory: ETag, autenticação e corpo preservam dono, notificados e rollback", async () => {
  const record = { ...note({ release: "release-90", owner: session("opencode", "archdev", "ses_culprit"), rollback: { outcome: "blocked", reason: "Banco incompatível" } }), key: "release-90", frozen: false, state: "completed" };
  const result = await pollFactory({ url: "https://factory.test/releases/recall", token: "segredo", etag: '"anterior"', fetch: async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>)["If-None-Match"], '"anterior"');
    assert.equal((init?.headers as Record<string, string>)["Authorization"], "Bearer segredo");
    assert.equal(init?.redirect, "error");
    return Response.json({ releases: [record] }, { headers: { etag: '"nova"' } });
  } });
  assert.equal(result.kind, "changed");
  if (result.kind !== "changed") throw new Error("Esperava alteração");
  assert.equal(result.etag, '"nova"');
  assert.equal(result.releases[0]?.owner?.id, "ses_culprit");
  assert.match(factoryPrompt("owner", result.releases[0]!, "https://factory.test/releases/recall"), /Main congelada: não/);
  await assert.rejects(pollFactory({ url: "https://factory.test", token: "segredo", etag: null, fetch: async () => new Response(null, { status: 401 }) }), /HTTP 401/);
});
test("factory: watcher chama uma vez via API; 304 não busca git notes", async () => {
  const stateDir = await tempState();
  const git = fakeExec(() => ({}));
  const delivery = fakeDelivery();
  let polls = 0;
  const record = { ...note({ release: "release-90", owner: session("opencode", "archdev", "ses_culprit"), verdict: { verdict: "red" }, rollback: { outcome: "none" } }), key: "release-90", frozen: false, state: "completed" };
  const watcher = createWatcher({ harness: "opencode", host: (config) => config.instance, loadConfig: async () => ({ instance: "archdev", repository: "dboltbr/dbolt", notesRef: "refs/notes/release-watch", blockedRef: "refs/notes/release-blocked", factoryApiUrl: "https://factory.test/releases/recall", factoryToken: "segredo" }), stateDir, sha: "teste", pid: process.pid, clock: fixedClock(), fetch: async (url) => { assert.equal(url, "https://factory.test/releases/recall"); return polls++ === 0 ? Response.json({ releases: [record] }, { headers: { etag: '"e1"' } }) : new Response(null, { status: 304 }); }, exec: git.exec, delivery: delivery.delivery, log: quietLog, release: fixedReleases([]) });
  await watcher.tick();
  assert.equal((await watcher.tick()).poll, "unchanged");
  assert.equal(delivery.recorded.prompts.length, 1);
  assert.equal(git.gitCalls("fetch").length, 0);
});

test("factory: ativação da API preserva o recall de release barrada e seu follow-up", async () => {
  const { fakeGitHub, NOW } = await import("./fakes.ts");
  const { buildRelease } = await import("../release-status.ts");
  const { run } = await import("./releases.ts");
  const blocked = { release: "release-292", state: "red", range: { from: null, to: "a".repeat(40) }, sessions: [session("opencode", "archdev", "ses_barrada", ["a".repeat(40)])], updatedAt: NOW.toISOString() };
  const git = fakeExec(() => ({}), { blocked: () => ({ cabeca: blocked }) });
  const github = fakeGitHub([], [{ status: 200, etag: '"b1"' }, { status: 304 }]);
  const delivery = fakeDelivery();
  const stateDir = await tempState();
  const failed = buildRelease({ run: run({ run_number: 292, status: "completed", conclusion: "failure" }), jobs: [], tagged: false, note: null, commits: null, now: NOW });
  let polls = 0;
  const watcher = createWatcher({ harness: "opencode", host: (config) => config.instance, loadConfig: async () => ({ instance: "archdev", repository: "dboltbr/dbolt", notesRef: "refs/notes/release-watch", blockedRef: "refs/notes/release-blocked", factoryApiUrl: "https://factory.test/releases/recall", factoryToken: "segredo" }), stateDir, sha: "teste", pid: process.pid, clock: fixedClock(), fetch: async (url, init) => url.startsWith("https://factory.test") ? polls++ === 0 ? Response.json({ releases: [] }, { headers: { etag: '"e1"' } }) : new Response(null, { status: 503 }) : github.fetch(url, init), exec: git.exec, delivery: delivery.delivery, log: quietLog, release: fixedReleases([failed]) });
  const first = await watcher.tick();
  assert.equal(first.blockedFetched, true);
  assert.equal(delivery.recorded.prompts.length, 1);
  assert.match(delivery.recorded.prompts[0]!.text, /Release barrada release-292/);
  const second = await watcher.tick();
  assert.equal(second.poll, "error");
  assert.equal(second.blocked, "unchanged");
  assert.equal(github.refCalls().length, 0, "incidentes publicados não leem git notes");
  assert.equal(github.blockedCalls().length, 2);
});
