import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { pollCandidates } from '../candidates.ts';
import { createWatcher } from '../watcher.ts';
import { fakeDelivery, fakeExec, fixedClock, fixedReleases, quietLog, tempState } from './fakes.ts';
import type { Fetch } from '../types.ts';

const event = { kind: 'candidate-result', key: 'candidate-proof', session: 'opencode/host/ses_proof', submittedSha: 'a'.repeat(40), result: { candidateId: 'candidate', revisionId: 'revision', outcome: 'rejected', baseSha: 'b'.repeat(40), candidateSha: 'c'.repeat(40), evidence: 'artifact://failure', finishedAt: '2026-11-08T07:00:00.000Z' } };

function factory() {
  let claimed = false;
  let receipt: string | null = null;
  const fetch: Fetch = async (url, init) => {
    assert.ok(init?.signal);
    if (url.endsWith('/claim')) { const owned = !claimed; claimed = true; return Response.json({ claimed: owned }); }
    if (url.endsWith('/confirm')) { receipt = JSON.parse(String(init?.body)).receipt; return Response.json({ receipt }); }
    if (url.endsWith('/queued')) return Response.json({ state: 'queued' });
    if (url.endsWith('/verification/recall')) return Response.json({ candidates: receipt ? [] : [event] });
    if (url.includes('api.github.com')) return new Response(null, { status: 404 });
    return Response.json({ releases: [] });
  };
  return { fetch, receipt: () => receipt };
}

test('watcher entrega candidato uma vez à sessão exata, sem prompt de incidente nem fallback', async () => {
  const stateDir = await tempState();
  const remote = factory();
  const delivery = fakeDelivery();
  const prompts: string[] = [];
  const watcher = createWatcher({ harness: 'opencode', host: () => 'host', loadConfig: async () => ({ instance: 'host', repository: 'dboltbr/dbolt', notesRef: 'refs/notes/release-watch', blockedRef: 'refs/notes/release-blocked', factoryApiUrl: 'https://factory.test/releases/recall', factoryToken: 'test-only' }), stateDir, sha: 'proof', pid: process.pid, clock: fixedClock(), fetch: remote.fetch, exec: fakeExec(() => ({})).exec, delivery: { ...delivery.delivery, promptCandidate: async (target, text) => { assert.equal(target.id, 'ses_proof'); prompts.push(text); return 'receipt:prompt' } }, log: quietLog, release: fixedReleases([]) });
  try {
    await watcher.tick();
    await watcher.tick();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? '', /SHA verificado c{40}; base b{40}/);
    assert.match(prompts[0] ?? '', /artifact:\/\/failure/);
    assert.equal(remote.receipt(), 'receipt:prompt');
    assert.equal(delivery.recorded.prompts.length, 0);
    assert.equal(delivery.recorded.fallbacks.length, 0);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test('prompt ambíguo não confirma nem repete; outro host não toma a entrega', async () => {
  const remote = factory();
  const base = { url: 'https://factory.test/releases/recall', token: 'test-only', me: { harness: 'opencode' as const, host: 'host' }, fetch: remote.fetch };
  let attempts = 0;
  const delivery = { ...fakeDelivery().delivery, promptCandidate: async () => { attempts++; throw new Error('Resposta perdida'); } };
  await pollCandidates({ ...base, me: { harness: 'opencode', host: 'another-host' }, delivery });
  assert.equal(attempts, 0);
  await assert.rejects(pollCandidates({ ...base, delivery }), /Resposta perdida/);
  await pollCandidates({ ...base, delivery });
  assert.equal(attempts, 1);
  assert.equal(remote.receipt(), null);
});

test('inbox assíncrono registra queued, nunca recibo de entrega', async () => {
  const remote = factory();
  let queued = 0;
  await pollCandidates({ url: 'https://factory.test/releases/recall', token: 'test-only', me: { harness: 'opencode', host: 'host' }, fetch: async (url, init) => { if (url.endsWith('/queued')) queued++; return remote.fetch(url, init); }, delivery: { ...fakeDelivery().delivery, promptCandidate: async () => null } });
  assert.equal(queued, 1);
  assert.equal(remote.receipt(), null);
});
