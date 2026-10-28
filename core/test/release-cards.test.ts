import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardFingerprint,
  cardFor,
  cardTargets,
  createCardPublisher,
  RELEASE_CARD_KIND,
  ReleaseCardSchema,
  type CardItem,
  type CardStore,
} from "../release-cards.ts";
import { buildRelease, buildSnapshot, type Release } from "../release-status.ts";
import { NOW, quietLog } from "./fakes.ts";
import { finished, midImages, minutesAgo, run, RUNNERS } from "./releases.ts";

const HOST = "srv_host";
const PUSHED = (agent: string) => `test(api): teste do push\n\nAgent-Session: paseo/${HOST}/${agent}\n`;

// Fixture jobs get fresh ids per call: one job list per release number keeps rebuilds identical.
const MID = new Map<number, ReturnType<typeof midImages>>();
const FINISHED = new Map<number, ReturnType<typeof finished>>();
const once = <T>(cache: Map<number, T>, number: number, make: () => T): T => {
  if (!cache.has(number)) cache.set(number, make());
  return cache.get(number)!;
};

function active(number: number, agent = "agent-a", now = NOW): Release {
  return buildRelease({
    run: run({ run_number: number, head_commit: { message: PUSHED(agent) } }),
    jobs: once(MID, number, midImages),
    note: null,
    commits: null,
    now,
  });
}

function done(number: number, completedMinutesAgo: number, agent = "agent-a"): Release {
  return buildRelease({
    run: run({
      run_number: number,
      status: "completed",
      conclusion: "success",
      updated_at: minutesAgo(completedMinutesAgo),
      head_commit: { message: PUSHED(agent) },
    }),
    jobs: once(FINISHED, number, () => finished("success")),
    note: null,
    commits: null,
    now: NOW,
  });
}

function snapshot(...releases: Release[]) {
  return buildSnapshot({ repository: "dboltbr/dbolt", workflow: "release", releases, runners: RUNNERS, now: NOW });
}

function memoryStore(initial: Record<string, string> = {}) {
  const saved: Array<Record<string, string>> = [];
  const store: CardStore = {
    load: async () => ({ ...initial }),
    save: async (value) => void saved.push({ ...value }),
  };
  return { store, saved };
}

function recorder(fail = false) {
  const appended: Array<{ agentId: string; item: CardItem }> = [];
  return {
    appended,
    append: async (agentId: string, item: CardItem) => {
      if (fail) throw new Error("agent not found");
      appended.push({ agentId, item });
    },
  };
}

test("cardTargets: só releases do pusher Paseo deste host, ativos ou recém-terminados", () => {
  const other = buildRelease({
    run: run({ run_number: 190 }),
    jobs: midImages(),
    note: null,
    commits: null,
    now: NOW,
  });
  const targets = cardTargets(snapshot(active(191), other, done(189, 30), done(188, 180)), "paseo", HOST, NOW);
  assert.deepEqual(
    targets.map((release) => release.number),
    [191, 189],
  );
  assert.deepEqual(cardTargets(snapshot(active(191)), "paseo", "srv_other", NOW), []);
});

test("cardFor: corta os jobs fora das etapas e leva a fila enquanto ativo", () => {
  const snap = snapshot(active(191));
  const card = cardFor(snap.releases[0]!, snap, "Aviso ao morador: push");
  assert.ok(card.release.jobs.every((job) => job.step !== null && job.state !== "skipped"));
  assert.ok(!card.release.jobs.some((job) => job.name === "trigger"));
  assert.equal(card.queue, "5 na fila — runner solid-srv ocupado");
  assert.equal(card.pusherTitle, "Aviso ao morador: push");
  assert.ok(ReleaseCardSchema.safeParse(card).success);
  assert.ok(JSON.stringify(card).length < 64 * 1024);
  const finishedSnap = snapshot(done(189, 5));
  assert.equal(cardFor(finishedSnap.releases[0]!, finishedSnap, null).queue, null);
});

test("cardFingerprint: ignora updatedAt e a duração das etapas em andamento", () => {
  const snapA = snapshot(active(191));
  const later = new Date(NOW.getTime() + 20_000);
  const snapB = snapshot({ ...active(191, "agent-a", later), updatedAt: later.toISOString() });
  const a = cardFingerprint(cardFor(snapA.releases[0]!, snapA, null));
  const b = cardFingerprint(cardFor(snapB.releases[0]!, snapB, null));
  assert.equal(a, b);
  const moved = snapshot(done(191, 1));
  assert.notEqual(a, cardFingerprint(cardFor(moved.releases[0]!, moved, null)));
});

test("publisher: anexa ao pusher, não repete sem mudança e espera a API do daemon", async () => {
  const { store, saved } = memoryStore();
  const publisher = createCardPublisher({ harness: "paseo", host: HOST, store, log: quietLog, now: () => NOW });
  const rec = recorder();
  const snap = snapshot(active(191, "agent-a"), done(189, 30, "agent-b"));

  assert.equal(await publisher.publish(snap, null), 0);
  assert.equal(saved.length, 0);

  assert.equal(await publisher.publish(snap, rec.append), 2);
  assert.deepEqual(
    rec.appended.map(({ agentId, item }) => [agentId, item.id, item.kind, item.version]),
    [
      ["agent-a", "release-191", RELEASE_CARD_KIND, 1],
      ["agent-b", "release-189", RELEASE_CARD_KIND, 1],
    ],
  );
  assert.equal(await publisher.publish(snap, rec.append), 0);

  const next = snapshot(done(191, 0.5, "agent-a"), done(189, 30, "agent-b"));
  assert.equal(await publisher.publish(next, rec.append), 1);
  assert.equal(rec.appended.at(-1)!.item.id, "release-191");
  assert.equal(rec.appended.at(-1)!.item.data.release.verdict, "green");
  assert.deepEqual(Object.keys(saved.at(-1)!).sort(), ["release-189", "release-191"]);
});

test("publisher: o estado persistido evita re-anexar depois de recarregar o plugin", async () => {
  const snap = snapshot(active(191));
  const first = memoryStore();
  await createCardPublisher({ harness: "paseo", host: HOST, store: first.store, log: quietLog, now: () => NOW }).publish(
    snap,
    recorder().append,
  );
  const reloaded = memoryStore(first.saved.at(-1)!);
  const rec = recorder();
  const publisher = createCardPublisher({ harness: "paseo", host: HOST, store: reloaded.store, log: quietLog, now: () => NOW });
  assert.equal(await publisher.publish(snap, rec.append), 0);
  assert.equal(rec.appended.length, 0);
});

test("publisher: append que falha não repete até o cartão mudar", async () => {
  const { store } = memoryStore();
  const warnings: string[] = [];
  const log = { ...quietLog, warn: (message: string) => void warnings.push(message) };
  const publisher = createCardPublisher({ harness: "paseo", host: HOST, store, log, now: () => NOW });
  const failing = recorder(true);
  const snap = snapshot(active(191));
  assert.equal(await publisher.publish(snap, failing.append), 0);
  assert.equal(await publisher.publish(snap, failing.append), 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /release-191 → agent-a: agent not found/);
});

test("publisher: o título do agente entra no cartão", async () => {
  const { store } = memoryStore();
  const rec = recorder();
  const publisher = createCardPublisher({
    harness: "paseo",
    host: HOST,
    store,
    log: quietLog,
    now: () => NOW,
    title: async (id) => (id === "agent-a" ? "Aviso ao morador: push" : null),
  });
  await publisher.publish(snapshot(active(191)), rec.append);
  assert.equal(rec.appended[0]!.item.data.pusherTitle, "Aviso ao morador: push");
});
