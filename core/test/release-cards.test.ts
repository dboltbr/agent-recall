import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cardFingerprint,
  cardFor,
  cardTargets,
  createCardPublisher,
  foldSuperseded,
  pusherAgent,
  RELEASE_CARD_KIND,
  ReleaseCardSchema,
  type CardItem,
  type CardStore,
} from "../release-cards.ts";
import { buildRelease, buildSnapshot, type Release } from "../release-status.ts";
import { NOW, quietLog } from "./fakes.ts";
import { finished, job, midImages, minutesAgo, run, RUNNERS } from "./releases.ts";

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

test("cardTargets: releases com pusher, ativos ou recém-terminados", () => {
  const other = buildRelease({
    run: run({ run_number: 190 }),
    jobs: midImages(),
    note: null,
    commits: null,
    now: NOW,
  });
  const targets = cardTargets(snapshot(active(191), other, done(189, 30), done(188, 180)), NOW);
  assert.deepEqual(
    targets.map((release) => release.number),
    [191, 190, 189],
  );
  const anonymous = buildRelease({ run: run({ run_number: 192, head_commit: { message: "fix: sem trailer\n" } }), jobs: midImages(), note: null, commits: null, now: NOW });
  assert.deepEqual(cardTargets(snapshot(anonymous), NOW), []);
});

test("pusherAgent: agente Paseo deste host direto, OpenCode pelo resolve", async () => {
  const resolve = async (session: { id: string }) => (session.id === "ses_local" ? "agent-oc" : null);
  assert.equal(await pusherAgent({ harness: "paseo", host: HOST, id: "agent-a" }, "paseo", HOST, resolve), "agent-a");
  assert.equal(await pusherAgent({ harness: "paseo", host: "srv_other", id: "agent-a" }, "paseo", HOST, resolve), null);
  assert.equal(await pusherAgent({ harness: "opencode", host: "felipe-win", id: "ses_local" }, "paseo", HOST, resolve), "agent-oc");
  assert.equal(await pusherAgent({ harness: "opencode", host: "felipe-win", id: "ses_alheia" }, "paseo", HOST, resolve), null);
  assert.equal(await pusherAgent({ harness: "opencode", host: "felipe-win", id: "ses_local" }, "paseo", HOST), null);
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

test("publisher: push de agente Paseo no provider OpenCode (trailer opencode/…) ganha o cartão", async () => {
  // release-238: `Agent-Session: opencode/felipe-win/ses_e873…`, a sessão do agente Paseo e6e3c45c.
  const { store } = memoryStore();
  const rec = recorder();
  const publisher = createCardPublisher({
    harness: "paseo",
    host: HOST,
    store,
    log: quietLog,
    now: () => NOW,
    resolve: async (session) => (session.harness === "opencode" && session.id === "ses_e873" ? "agent-oc" : null),
    title: async (id) => (id === "agent-oc" ? "Kysely com RLS" : null),
  });
  const release = buildRelease({
    run: run({ run_number: 238, head_commit: { message: "fix(deploy): x\n\nAgent-Session: opencode/felipe-win/ses_e873\n" } }),
    jobs: once(MID, 238, midImages),
    note: null,
    commits: null,
    now: NOW,
  });
  assert.equal(await publisher.publish(snapshot(release), rec.append), 1);
  assert.deepEqual(
    rec.appended.map(({ agentId, item }) => [agentId, item.id, item.data.pusherTitle]),
    [["agent-oc", "release-238", "Kysely com RLS"]],
  );
});

/** Cancelled by a newer push (`conclusion: cancelled`) or a flux-only no-op (only `trigger` ran). */
function superseded(number: number, kind: "cancelled" | "none", completedMinutesAgo = 2, agent = "agent-a"): Release {
  return buildRelease({
    run: run({
      run_number: number,
      status: "completed",
      conclusion: kind === "cancelled" ? "cancelled" : "success",
      updated_at: minutesAgo(completedMinutesAgo),
      head_commit: { message: "chore(flux): atualiza imagens\n" },
    }),
    jobs: kind === "cancelled" ? once(MID, number, midImages) : [job("trigger", "success", [3, 2.9])],
    note: null,
    // The pusher comes from the commit range (the flux head commit has no trailer).
    commits: [{ sha: "c".repeat(40), commit: { message: PUSHED(agent) } }],
    now: NOW,
  });
}

test("foldSuperseded: sequência de cancelados/no-op dobra no mais novo; ativo ou publicado quebra", () => {
  const folds = foldSuperseded([
    done(244, 60),
    superseded(245, "cancelled"),
    superseded(246, "none"),
    superseded(247, "cancelled"),
    done(248, 5),
    superseded(249, "cancelled"),
    active(250),
    superseded(251, "cancelled"),
    superseded(252, "none"),
  ]);
  assert.deepEqual(folds.get(247)?.folded?.map((release) => release.number), [245, 246]);
  assert.equal(folds.get(245)?.foldedInto, 247);
  assert.equal(folds.get(246)?.foldedInto, 247);
  assert.equal(folds.get(249), undefined, "cancelado sozinho fica com cartão próprio");
  assert.equal(folds.get(250), undefined);
  assert.deepEqual(folds.get(252)?.folded?.map((release) => release.number), [251]);
  assert.equal(folds.get(244), undefined);
  assert.equal(folds.get(248), undefined);
});

test("cardFor: o grupo leva os dobrados sem jobs e cabe no limite da linha", () => {
  const older = Array.from({ length: 14 }, (_, index) => superseded(230 + index, "cancelled"));
  const head = superseded(244, "cancelled");
  const snap = snapshot(head, ...older);
  const card = cardFor(head, snap, null, { folded: older });
  assert.equal(card.folded?.length, 14);
  assert.ok(card.folded!.every((release) => release.jobs.length === 0));
  assert.ok(ReleaseCardSchema.safeParse(card).success);
  assert.ok(JSON.stringify(card).length < 64 * 1024);
  const hidden = cardFor(older[0]!, snap, null, { foldedInto: 244 });
  assert.equal(hidden.foldedInto, 244);
  assert.ok(ReleaseCardSchema.safeParse(hidden).success);
  assert.ok(ReleaseCardSchema.safeParse({ release: head, pusherTitle: null, queue: null }).success, "cartão antigo sem campos novos continua válido");
});

test("publisher: rajada de pushes cancelados vira um cartão só na timeline do agente", async () => {
  const { store } = memoryStore();
  let now = NOW;
  const publisher = createCardPublisher({ harness: "paseo", host: HOST, store, log: quietLog, now: () => now });
  const rec = recorder();
  const ids = () => rec.appended.map(({ item }) => item.id);
  const burst = () => snapshot(superseded(246, "cancelled", 100), superseded(247, "cancelled", 1), active(248));

  // 246 já cancelado, 247 ainda rodando: dois cartões.
  await publisher.publish(snapshot(superseded(246, "cancelled", 100), active(247)), rec.append);
  assert.deepEqual(ids().sort(), ["release-246", "release-247"]);

  // 247 cancelado por 248: 246 some dentro do grupo de 247 (mesmo id, substituído no lugar).
  rec.appended.length = 0;
  await publisher.publish(burst(), rec.append);
  const byId = new Map(rec.appended.map(({ item }) => [item.id, item.data]));
  assert.equal(byId.get("release-246")?.foldedInto, 247);
  assert.deepEqual(byId.get("release-247")?.folded?.map((release) => release.number), [246]);
  assert.ok(byId.has("release-248"));

  // 246 sai da janela de 2 h: o grupo de 247 não encolhe nem é re-anexado.
  rec.appended.length = 0;
  now = new Date(NOW.getTime() + 30 * 60_000);
  await publisher.publish(burst(), rec.append);
  assert.deepEqual(ids(), []);

  // Dobrado que nunca teve cartão não ganha linha vazia.
  const fresh = createCardPublisher({ harness: "paseo", host: HOST, store: memoryStore().store, log: quietLog, now: () => NOW });
  const other = recorder();
  await fresh.publish(snapshot(superseded(250, "none"), superseded(251, "none"), superseded(252, "cancelled")), other.append);
  assert.deepEqual(
    other.appended.map(({ item }) => [item.id, item.data.folded?.map((release) => release.number)]),
    [["release-252", [250, 251]]],
  );
});

test("publisher: sequências são por agente; cancelado de outro agente não entra no grupo", async () => {
  const publisher = createCardPublisher({ harness: "paseo", host: HOST, store: memoryStore().store, log: quietLog, now: () => NOW });
  const rec = recorder();
  await publisher.publish(
    snapshot(superseded(246, "cancelled", 5, "agent-a"), superseded(247, "cancelled", 4, "agent-b"), superseded(248, "cancelled", 3, "agent-a")),
    rec.append,
  );
  assert.deepEqual(
    rec.appended.map(({ agentId, item }) => [agentId, item.id, item.data.folded?.map((release) => release.number) ?? null]).sort(),
    [
      ["agent-a", "release-248", [246]],
      ["agent-b", "release-247", null],
    ],
  );
});
