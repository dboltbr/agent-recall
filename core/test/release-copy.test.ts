import assert from "node:assert/strict";
import { test } from "node:test";
import {
  freshness,
  imageChips,
  imageLanes,
  pipeMeta,
  pusherLine,
  queueHint,
  releaseBadge,
  revertRows,
  runnerRows,
  stepDetail,
  stepDurationMs,
  verdictBanner,
  verdictRows,
  verdictSignals,
  waitingLabel,
} from "../release-copy.ts";
import { buildRelease, buildSnapshot, stepOf, type Release } from "../release-status.ts";
import type { Note } from "../types.ts";
import { NOW } from "./fakes.ts";
import { finished, job, midImages, minutesAgo, run, RUNNERS, VERIFY_DONE } from "./releases.ts";

function active(): Release {
  return buildRelease({ run: run({ run_number: 172 }), jobs: midImages(), note: null, commits: null, now: NOW });
}

function done(number: number, jobs = finished("success"), note: Note | null = null, conclusion = "success"): Release {
  return buildRelease({
    run: run({ run_number: number, status: "completed", conclusion, updated_at: minutesAgo(0.5) }),
    jobs,
    note,
    commits: null,
    now: NOW,
  });
}

const snapshotOf = (...releases: Release[]) =>
  buildSnapshot({ repository: "dboltbr/dbolt", workflow: "release", releases, runners: RUNNERS, now: NOW });

const reverted = (number: number) =>
  done(number, finished("failure"), {
    release: `release-${number}`,
    state: "reverted",
    updatedAt: minutesAgo(1),
    revert: { commits: ["a", "b", "c"], commit: "d" },
    verdict: { sources: { errors5xx: { outcome: "red", reason: "errors5xx-ratio" }, sentry: { outcome: "green" } } },
  } as Note);

test("releaseBadge: em andamento, verde, revertido, falhou", () => {
  assert.deepEqual(releaseBadge(active()), { label: "em andamento", tone: "run" });
  assert.deepEqual(releaseBadge(done(171)), { label: "verde", tone: "ok" });
  assert.deepEqual(releaseBadge(reverted(170)), { label: "revertido", tone: "warn" });
  const failed = done(
    4818,
    [job("verify-production / check", "failure", [20, 1])],
    null,
    "failure",
  );
  assert.deepEqual(releaseBadge(failed), { label: "falhou", tone: "bad" });
});

test("pusherLine: agente Paseo com título, sessão OpenCode pelo host", () => {
  const release = active();
  assert.equal(pusherLine(release, null, NOW), "push da sessão OpenCode · archdev · há 36 min");
  const paseo = { ...release, pusher: { harness: "paseo" as const, host: "srv", id: "a1b2c3d4e5" } };
  assert.equal(pusherLine(paseo, "Aviso ao morador: push", NOW), "push do agente Paseo “Aviso ao morador: push” · há 36 min");
  assert.equal(pusherLine(paseo, null, NOW), "push do agente Paseo a1b2c3d4 · há 36 min");
  assert.equal(pusherLine({ ...release, pusher: null }, null, NOW), null);
});

test("stepDetail e pipeMeta: as linhas do mock p1b/p4a", () => {
  const release = active();
  assert.equal(stepDetail(release, stepOf(release, "verify")), "qlty · opengrep · secrets · check");
  assert.equal(stepDetail(release, stepOf(release, "deploy")), "staging → produção");
  assert.equal(stepDetail(release, stepOf(release, "tag")), "release-172");
  assert.equal(stepDetail(release, stepOf(release, "watch")), "janela de 10 min · sinais do blast radius → veredito");
  assert.equal(pipeMeta(release, stepOf(release, "verify"), NOW), "23m 30s");
  assert.equal(pipeMeta(release, stepOf(release, "images"), NOW), "3/9 · 11m");
  assert.equal(pipeMeta(release, stepOf(release, "deploy"), NOW), "");
  assert.equal(pipeMeta(release, stepOf(release, "tag"), NOW), "release-172");
  assert.equal(pipeMeta(release, stepOf(release, "watch"), NOW), "10 min");
  const green = done(171);
  assert.equal(pipeMeta(green, stepOf(green, "watch"), NOW), "verde");
  assert.equal(pipeMeta(green, stepOf(green, "tag"), NOW), "release-171");
});

test("pipeMeta: run que falhou marca a etapa e apaga as seguintes", () => {
  const failed = done(4818, [...VERIFY_DONE.slice(0, 4), job("verify-production / check", "failure", [20, 1])], null, "failure");
  assert.equal(pipeMeta(failed, stepOf(failed, "verify"), NOW), "check falhou");
  assert.equal(pipeMeta(failed, stepOf(failed, "images"), NOW), "—");
  assert.equal(pipeMeta(failed, stepOf(failed, "watch"), NOW), "—");
  assert.deepEqual(verdictBanner(failed), { tone: "bad", text: "verify-production / check falhou", link: "log" });
});

test("stepDurationMs: etapa em andamento conta do início até agora", () => {
  const release = active();
  const images = stepOf(release, "images");
  const later = new Date(NOW.getTime() + 60_000);
  assert.equal(stepDurationMs(images, later), images.durationMs! + 60_000);
  assert.equal(stepDurationMs(stepOf(release, "verify"), later), stepOf(release, "verify").durationMs);
  assert.equal(stepDurationMs(stepOf(release, "deploy"), later), null);
});

test("imageChips: publicadas e em build, depois a contagem da fila", () => {
  const { chips, hidden, queued } = imageChips(active(), 3);
  assert.deepEqual(
    chips.map((chip) => `${chip.name}:${chip.state}`),
    ["rtpengine:success", "fs-bridge:success", "vms-client-gateway:running"],
  );
  assert.equal(hidden, 1);
  assert.equal(queued, 5);
});

test("imageLanes: barras no eixo do tempo das imagens; fila tracejada", () => {
  const lanes = imageLanes(active(), NOW);
  assert.equal(lanes.length, 9);
  assert.equal(lanes[0]!.name, "api");
  assert.equal(lanes[0]!.left, 0);
  assert.equal(lanes[0]!.label, "4m 24s");
  const queued = lanes.filter((lane) => lane.state === "queued");
  assert.equal(queued.length, 5);
  assert.ok(queued.every((lane) => lane.label === "na fila" && lane.width === 12));
  assert.ok(lanes.every((lane) => lane.left >= 0 && lane.left + lane.width <= 100.0001));
});

test("imageLanes: imagens concluídas não esticam o eixo até agora", () => {
  const release = done(171);
  const lanes = imageLanes(release, new Date(NOW.getTime() + 60 * 60 * 1000));
  assert.ok(lanes.length > 0);
  assert.ok(lanes.every((lane) => lane.state === "success"));
  assert.ok(Math.max(...lanes.map((lane) => lane.left + lane.width)) > 99);
});

test("fila de runners: linhas, contagem e a dica do label", () => {
  const snapshot = snapshotOf(active());
  assert.deepEqual(
    runnerRows(snapshot.runners).map((row) => [row.name, row.detail, row.status]),
    [
      ["solid-srv", "build-push (vms-client-gateway, vms/client-gateway/Dockerfile, 48b64c18…)", "ocupado"],
      ["solid-srv-light", "", "ocioso"],
      ["unraid-amd64-dboltbr", "", "ocioso"],
    ],
  );
  assert.equal(waitingLabel(snapshot), "5 jobs aguardando");
  assert.equal(queueHint(snapshot), "Os 5 jobs restantes exigem o label solid-srv; os runners ociosos não pegam esses jobs.");
  assert.equal(queueHint(snapshotOf(done(171))), null);
});

test("vereditos e reversões: só runs terminados com palavra do vigia", () => {
  const cancelled = done(180, [job("trigger", "success", [3, 2])], null, "cancelled");
  const snapshot = snapshotOf(active(), done(171), reverted(170), cancelled);
  assert.deepEqual(
    verdictRows(snapshot).map((release) => release.number),
    [171, 170],
  );
  assert.deepEqual(
    revertRows(snapshot).map((release) => release.number),
    [170],
  );
  assert.deepEqual(verdictBanner(reverted(170)), {
    tone: "warn",
    text: "vigia reverteu 3 commits · agente avisado",
    link: "signals",
  });
  assert.equal(verdictBanner(active()), null);
});

test("freshness: idade do snapshot e a falha do GitHub", () => {
  const snapshot = snapshotOf(active());
  assert.deepEqual(freshness(snapshot, NOW), { text: "atualizado agora", stale: false });
  const later = new Date(NOW.getTime() + 15 * 60_000);
  assert.equal(freshness(snapshot, later).stale, true);
  assert.deepEqual(freshness({ ...snapshot, error: "tempo esgotado" }, later), {
    text: "GitHub indisponível (tempo esgotado) · dados de há 15 min",
    stale: true,
  });
});

test("verdictSignals: a célula de sinais da tabela de vereditos", () => {
  assert.deepEqual(verdictSignals(reverted(170)), { text: "vigia reverteu 3 commits · agente avisado", tone: "warn" });
  assert.deepEqual(verdictSignals(done(171)), { text: "sem regressão", tone: "muted" });
  const failed = done(4818, [job("verify-production / check", "failure", [20, 1])], null, "failure");
  assert.deepEqual(verdictSignals(failed), { text: "verify-production / check falhou", tone: "bad" });
  assert.deepEqual(verdictSignals({ ...reverted(170), verdict: "red" }), { text: "5xx · errors5xx-ratio", tone: "bad" });
  assert.deepEqual(verdictSignals({ ...reverted(170), verdict: "green" }), { text: "1/2 sinais ok", tone: "muted" });
});
