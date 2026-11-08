import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { fakeExec, fixedClock, quietLog, tempState } from '../../core/test/fakes.ts';
import { createClaudeDelivery, createClaudeWatcher, pickRequest, recordSession, type ClaudeDeps } from '../watch.ts';

test('Claude: inbox enfileirado não é entregue; picked existente confirma sem fallback de incidente', async () => {
  const stateDir = await tempState();
  const clock = fixedClock();
  let confirmed = 0;
  const deps: ClaudeDeps = {
    stateDir, claudePid: 999991, pid: process.pid, sha: 'proof', clock,
    loadConfig: async () => ({ instance: 'host', repository: 'dboltbr/dbolt', notesRef: 'refs/notes/release-watch', blockedRef: 'refs/notes/release-blocked', factoryApiUrl: 'https://factory.test/releases/recall', factoryToken: 'test-only' }),
    fetch: async (url, init) => {
      if (url.endsWith('/confirm')) { confirmed++; return Response.json({ receipt: JSON.parse(String(init?.body)).receipt }); }
      if (url.endsWith('/verification/recall')) return Response.json({ candidates: [] });
      if (url.endsWith('/releases/recall')) return Response.json({ releases: [] });
      return new Response(null, { status: 404 });
    }, exec: fakeExec(() => ({})).exec, log: quietLog, alive: () => true, projectsDir: stateDir, claude: '/not-used',
  };
  const delivery = createClaudeDelivery(deps);
  const watcher = createClaudeWatcher(deps);
  try {
    await recordSession(stateDir, deps.claudePid, { sessionId: 'session-proof', event: 'SessionStart', transcriptPath: null, cwd: null }, clock);
    assert.ok(delivery.promptCandidate);
    assert.equal(await delivery.promptCandidate({ harness: 'claude', host: 'host', id: 'session-proof' }, 'candidato recusado com evidência', 'candidate:proof'), null);
    assert.equal(confirmed, 0);
    const picked = await pickRequest(stateDir, 'session-proof', clock.now());
    assert.equal(picked?.kind, 'candidate-result');
    await watcher.step();
    await watcher.idle();
    assert.equal(confirmed, 1);
    assert.equal(await pickRequest(stateDir, 'session-proof', clock.now()), null);
  } finally { await watcher.release(); await rm(stateDir, { recursive: true, force: true }); }
});
