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
