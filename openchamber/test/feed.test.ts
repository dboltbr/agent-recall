import assert from "node:assert/strict";
import { test } from "node:test";
import { describeServiceError, fetchCurrent, fetchRelease, startFeed, type Envelope, type FeedState, type ServiceCall } from "../src/ui/feed.ts";
import { resolveChip } from "../src/ui/resolve.ts";
import { FIXTURE_NOW, fixtureSnapshot, green, running } from "./fixture.ts";
import { settle } from "./timers.ts";

const snapshot = fixtureSnapshot();

function envelope(seq: number, partial: Partial<Envelope> = {}): Envelope {
  return { seq, snapshot, fetchedAt: snapshot.fetchedAt, error: null, refreshing: false, ...partial };
}

/** Service stand-in: answers queued replies in order, then blocks like an idle long-poll. */
function fakeService(replies: Array<{ status: number; body: unknown } | Error>) {
  const requests: Array<{ method: string; path: string; query?: Record<string, string> }> = [];
  const call: ServiceCall = (request) => {
    requests.push(request);
    const reply = replies.shift();
    if (!reply) return new Promise(() => {});
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { call, requests };
}

const noSleep = async () => {};

test("feed: primeiro pedido sem espera, depois long-poll a partir do seq recebido", async () => {
  const { call, requests } = fakeService([
    { status: 200, body: envelope(1) },
    { status: 200, body: JSON.stringify(envelope(2)) },
  ]);
  const states: FeedState[] = [];
  const feed = startFeed({ call, onState: (state) => states.push(state), sleep: noSleep, waitMs: 15_000 });
  await settle();
  feed.stop();
  assert.deepEqual(
    requests.map((request) => request.query),
    [
      { after: "-1", wait: "0" },
      { after: "1", wait: "15000" },
      { after: "2", wait: "15000" },
    ],
  );
  assert.deepEqual(
    states.map((state) => state.envelope?.seq),
    [1, 2],
  );
});

test("feed: serviço indisponível vira mensagem pt-BR e recupera com backoff", async () => {
  const sleeps: number[] = [];
  const failure = Object.assign(new Error("x"), { code: "NO_SERVICE" });
  const { call } = fakeService([failure, failure, { status: 200, body: envelope(1) }]);
  const states: FeedState[] = [];
  const feed = startFeed({ call, onState: (state) => states.push(state), sleep: async (ms) => void sleeps.push(ms) });
  await settle();
  feed.stop();
  assert.match(states[0]?.unavailable ?? "", /Configurações → Extensões/);
  assert.deepEqual(sleeps, [2_000, 4_000]);
  assert.equal(states.at(-1)?.unavailable, null);
  assert.equal(states.at(-1)?.envelope?.seq, 1);
});

test("feed: corpo fora do contrato é rejeitado", async () => {
  const { call } = fakeService([{ status: 200, body: { seq: 1, snapshot: { releases: "nope" } } }]);
  const states: FeedState[] = [];
  const feed = startFeed({ call, onState: (state) => states.push(state), sleep: noSleep });
  await settle();
  feed.stop();
  assert.equal(states[0]?.unavailable, "Resposta inesperada do serviço local.");
  assert.equal(states[0]?.envelope, null);
});

test("fetchCurrent: serviço frio espera a primeira carga", async () => {
  const { call, requests } = fakeService([
    { status: 200, body: envelope(0, { snapshot: null, fetchedAt: null }) },
    { status: 200, body: envelope(1) },
  ]);
  assert.equal((await fetchCurrent(call, 9_000)).seq, 1);
  assert.deepEqual(requests[1]?.query, { after: "0", wait: "9000" });
});

test("fetchRelease: 404 é null, outro erro propaga a mensagem do serviço", async () => {
  assert.equal(await fetchRelease(fakeService([{ status: 404, body: {} }]).call, 9), null);
  await assert.rejects(fetchRelease(fakeService([{ status: 502, body: { error: "gh falhou" } }]).call, 9), /gh falhou/);
  assert.equal((await fetchRelease(fakeService([{ status: 200, body: green }]).call, 171))?.runId, green.runId);
});

test("describeServiceError: códigos do host em pt-BR", () => {
  assert.match(describeServiceError({ code: "DISABLED" }), /pausada/);
  assert.match(describeServiceError({ code: "HOST_TIMEOUT" }), /não respondeu/);
  assert.equal(describeServiceError(new Error("boom")), "boom");
});

test("resolveChip: sem argumento usa o release atual; com número busca no snapshot ou no serviço", async () => {
  const deps = {
    current: async () => envelope(1),
    release: async (number: number) => (number === 140 ? { ...green, number: 140, runId: 1 } : null),
    now: () => FIXTURE_NOW,
  };
  const current = await resolveChip("", deps);
  assert.equal(current.id, "release-172");
  assert.deepEqual(current.data, { number: 172, runId: running.runId });
  assert.equal((await resolveChip("release-171", deps)).data.number, 171);
  assert.equal((await resolveChip("140", deps)).data.number, 140);
  await assert.rejects(resolveChip("99", deps), /release-99 não encontrada/);
  await assert.rejects(resolveChip("abc", deps), /\/release 172/);
  await assert.rejects(
    resolveChip("", { ...deps, current: async () => envelope(0, { snapshot: null, error: "GitHub fora" }) }),
    /GitHub fora/,
  );
});
