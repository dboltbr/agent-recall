import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRelease,
  buildSnapshot,
  classifyJob,
  displayName,
  footerRelease,
  formatAgo,
  formatDuration,
  imageName,
  pillLabel,
  progress,
  queueSummary,
  releaseForSession,
  ReleaseSnapshotSchema,
  revertSummary,
  stepJobNames,
  stepOf,
  trippedSignals,
  verdictDetail,
  type Release,
} from "../release-status.ts";
import type { Note } from "../types.ts";
import { NOW } from "./fakes.ts";
import { commit, finished, job, midImages, minutesAgo, run, RUNNERS, VERIFY_DONE } from "./releases.ts";

const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

function completed(number: number, jobs = finished("success"), note: Note | null = null, partial = {}): Release {
  return buildRelease({
    run: run({ run_number: number, status: "completed", conclusion: "success", updated_at: minutesAgo(0.5), ...partial }),
    jobs,
    note,
    commits: null,
    now: NOW,
  });
}

function redNote(partial: Record<string, unknown> = {}): Note {
  return {
    release: "release-172",
    state: "red",
    updatedAt: minutesAgo(1),
    sessions: [{ harness: "opencode", host: "archdev", id: "ses_culprit", commits: ["c0ffee1"] }],
    verdict: {
      verdict: "red",
      missing: [],
      at: minutesAgo(2),
      sources: {
        deployment: { outcome: "green", reason: "deployment-converged" },
        errors5xx: { outcome: "red", reason: "errors5xx-ratio", value: 0.042 },
        sentry: { outcome: "pending", reason: "sentry-window-open" },
      },
    },
    ...partial,
  } as Note;
}

test("classifyJob: o mapeamento job → etapa do workflow release", () => {
  const cases: Array<[string, string | null]> = [
    ["trigger", null],
    ["summary", null],
    ["verify-production / check", "verify"],
    ["verify-production / qlty", "verify"],
    ["images-command / changes", null],
    ["images-vms / announcement", null],
    ["images-fs-bridge / build-push", "images"],
    ["images-command / build-push-api", "images"],
    ["images-vms / build-push (vms-api, vms/api/Dockerfile, 9f99af52)", "images"],
    ["images-command / build-push-supporting (command-worker, command/worker/Dockerfile, 2698…", "images"],
    ["flags", "deploy"],
    ["wall / meta", "deploy"],
    ["console / deploy", "deploy"],
    ["desktop / package", "deploy"],
    ["marketing / announcement", "deploy"],
    ["infrastructure / check", "deploy"],
    ["mobile / android", "deploy"],
    ["release-tag", "tag"],
    ["watch", "watch"],
  ];
  for (const [name, step] of cases) assert.equal(classifyJob(name), step, name);
});

test("imageName: argumento entre parênteses, sufixo build-push-<x>, senão o workflow", () => {
  assert.equal(imageName("images-vms / build-push (vms-api, vms/api/Dockerfile, 9f99af52)"), "vms-api");
  assert.equal(imageName("images-command / build-push-supporting (worker-netns-guard, deploy/x/Dockerfile)"), "worker-netns-guard");
  assert.equal(imageName("images-command / build-push-api"), "api");
  assert.equal(imageName("images-rtpengine / build-push"), "rtpengine");
  assert.equal(imageName("images-rtpengine / changes"), null);
  assert.equal(imageName("console / build"), null);
});

test("release em andamento: verificação feita, imagens 3/9, resto pendente", () => {
  const release = buildRelease({ run: run({ run_number: 172 }), jobs: midImages(), note: null, commits: null, now: NOW });
  assert.equal(release.name, "release-172");
  assert.equal(release.status, "running");
  assert.equal(release.verdict, null);
  assert.equal(release.current, "images");
  assert.deepEqual(
    release.steps.map((step) => step.state),
    ["done", "running", "pending", "pending", "pending"],
  );
  const verify = stepOf(release, "verify");
  assert.equal(verify.durationMs, (35.5 - 12) * 60_000);
  const images = stepOf(release, "images");
  assert.equal(images.done, 3);
  assert.equal(images.total, 9, "a build pulada fica fora do total");
  assert.equal(images.durationMs, 11.4 * 60_000, "conta até agora");
  assert.equal(pillLabel(release), "release-172 · imagens 3/9");
  assert.equal(displayName(release), "release-172");
  assert.deepEqual(stepJobNames(release, "verify"), ["qlty", "opengrep", "secrets", "check"]);
  assert.deepEqual(stepJobNames(release, "images").slice(0, 4), ["api", "rtpengine", "fs-bridge", "vms-client-gateway"]);
  assert.ok(Math.abs(progress(release) - (1 + 3 / 9) / 5) < 1e-9);
});

test("veredito verde: o watch passou", () => {
  const release = completed(171);
  assert.equal(release.verdict, "green");
  assert.equal(release.tag, "release-171");
  assert.equal(release.current, null);
  assert.deepEqual(
    release.steps.map((step) => step.state),
    ["done", "done", "done", "done", "done"],
  );
  assert.equal(pillLabel(release), "release-171 · verde");
  assert.equal(progress(release), 1);
});

test("falhou: a etapa que falhou, as seguintes puladas, título `run N`", () => {
  const jobs = [
    job("trigger", "success", [24, 23.9]),
    job("verify-production / qlty", "success", [23, 22]),
    job("verify-production / check", "failure", [23, 1]),
  ];
  const release = completed(4818, jobs, null, { conclusion: "failure" });
  assert.equal(release.verdict, "failed");
  assert.equal(release.failedJob?.name, "verify-production / check");
  assert.equal(stepOf(release, "verify").failedJob, "verify-production / check");
  assert.deepEqual(
    release.steps.map((step) => step.state),
    ["failed", "skipped", "skipped", "skipped", "skipped"],
  );
  assert.equal(displayName(release), "run 4818");
  assert.equal(verdictDetail(release), "verify-production / check falhou");
});

test("revertido: nota `reverted` com os commits, sinais disparados primeiro", () => {
  const note = redNote({ state: "reverted", revert: { commits: ["a", "b", "c"], commit: "r3v", reason: "reverted" } });
  const release = completed(172, finished("failure"), note);
  assert.equal(release.verdict, "reverted");
  assert.deepEqual(release.revert, { commits: ["a", "b", "c"], commit: "r3v" });
  assert.equal(revertSummary(release), "vigia reverteu 3 commits · agente avisado");
  assert.deepEqual(
    release.signals.map((signal) => [signal.label, signal.outcome]),
    [
      ["5xx", "red"],
      ["Sentry", "pending"],
      ["implantação", "green"],
    ],
  );
  assert.deepEqual(
    trippedSignals(release).map((signal) => signal.reason),
    ["errors5xx-ratio"],
  );
  assert.ok(release.sessions.some((session) => session.id === "ses_culprit"), "as sessões da nota entram");
});

test("revertido também via escalada já revertida ou decisão `revert`; aviso que falhou aparece", () => {
  const escalated = completed(
    172,
    finished("failure"),
    redNote({ state: "escalated", revert: { reason: "already-reverted", commits: ["a"] }, recall: { reason: "x" } }),
  );
  assert.equal(escalated.verdict, "reverted");
  assert.equal(revertSummary(escalated), "vigia reverteu 1 commit · aviso ao agente falhou");
  const decided = completed(172, finished("failure"), redNote({ state: "shipped", decision: { action: "revert", commits: ["a", "b"] } }));
  assert.equal(decided.verdict, "reverted");
  assert.deepEqual(decided.revert?.commits, ["a", "b"]);
});

test("vermelho sem reversão; nota antes do fim da run já dá veredito", () => {
  const red = completed(172, finished("failure"), redNote({ state: "investigating" }));
  assert.equal(red.verdict, "red");
  assert.equal(verdictDetail(red), "vigia vermelho · 5xx");
  const live = buildRelease({ run: run({ run_number: 173 }), jobs: finished("success").slice(0, -1), note: redNote(), commits: null, now: NOW });
  assert.equal(live.status, "running");
  assert.equal(live.verdict, "red");
});

test("inconclusivo, cancelado e sem publicação", () => {
  assert.equal(completed(170, finished("failure"), null, { conclusion: "failure" }).verdict, "inconclusive");
  const cancelled = completed(188, midImages().map((j) => (j.status === "completed" ? j : { ...j, status: "completed", conclusion: "cancelled" })), null, {
    conclusion: "cancelled",
  });
  assert.equal(cancelled.verdict, "cancelled");
  assert.equal(displayName(cancelled), "run 188");
  const paused = completed(189, [job("trigger", "success", [3, 2.8]), job("flags", "skipped", [2.8, 2.8])]);
  assert.equal(paused.verdict, "none");
  assert.deepEqual(new Set(paused.steps.map((step) => step.state)), new Set(["skipped"]));
});

test("quem fez o push: trailer do head commit, senão o trailer mais novo da faixa", () => {
  const commits = [
    commit("c1", "feat(a): um", "paseo/srv_X/agent-old"),
    commit("c2", "fix(b): dois"),
    commit("c3", "test(c): três", "opencode/archdev/ses_pusher"),
  ];
  const withTrailer = buildRelease({ run: run({ run_number: 172 }), jobs: midImages(), note: null, commits, now: NOW });
  assert.deepEqual(withTrailer.pusher, { harness: "opencode", host: "archdev", id: "ses_pusher" });
  assert.deepEqual(
    withTrailer.sessions.map((session) => session.id),
    ["agent-old", "ses_pusher"],
  );
  const flux = buildRelease({
    run: run({ run_number: 172, head_commit: { message: "Update from image update automation" } }),
    jobs: midImages(),
    note: null,
    commits: commits.slice(0, 2),
    now: NOW,
  });
  assert.equal(flux.pusher?.id, "agent-old");
  assert.equal(flux.title, "Update from image update automation");
});

function snapshotOf(...releases: Release[]) {
  return buildSnapshot({ repository: "dboltbr/dbolt", workflow: "release", releases, runners: RUNNERS, now: NOW });
}

test("pílula: só a sessão com commit na release ativa ou na última concluída", () => {
  const commits = (session: string) => [commit("c", "x", session)];
  const old = buildRelease({
    run: run({ run_number: 170, status: "completed", conclusion: "success" }),
    jobs: finished("success"),
    note: null,
    commits: commits("paseo/srv_X/agent-170"),
    now: NOW,
  });
  const last = buildRelease({
    run: run({ run_number: 171, status: "completed", conclusion: "success", head_commit: null }),
    jobs: finished("success"),
    note: null,
    commits: commits("paseo/srv_X/agent-171"),
    now: NOW,
  });
  const cancelled = completed(173, [job("trigger", "cancelled", [1, 1])], null, { conclusion: "cancelled" });
  const active = buildRelease({ run: run({ run_number: 174, head_commit: null }), jobs: midImages(), note: null, commits: commits("paseo/srv_X/agent-174"), now: NOW });
  const snapshot = snapshotOf(old, last, cancelled, active);
  assert.equal(releaseForSession(snapshot, { harness: "paseo", host: "srv_X", id: "agent-174" })?.number, 174);
  assert.equal(releaseForSession(snapshot, { harness: "paseo", host: "srv_X", id: "agent-171" })?.number, 171);
  assert.equal(releaseForSession(snapshot, { harness: "paseo", host: "srv_X", id: "agent-170" }), null);
  assert.equal(releaseForSession(snapshot, { harness: "paseo", host: "srv_Y", id: "agent-174" }), null);
});

test("rodapé: a ativa; depois o último veredito por 2 h; depois nada", () => {
  const done = completed(171);
  assert.equal(footerRelease(snapshotOf(done), NOW)?.number, 171);
  assert.equal(footerRelease(snapshotOf(done), later(119))?.number, 171);
  assert.equal(footerRelease(snapshotOf(done), later(121)), null);
  const active = buildRelease({ run: run({ run_number: 172 }), jobs: midImages(), note: null, commits: null, now: NOW });
  assert.equal(footerRelease(snapshotOf(done, active), later(500))?.number, 172);
  const waiting = buildRelease({ run: run({ run_number: 173, status: "queued" }), jobs: [], note: null, commits: null, now: NOW });
  assert.equal(waiting.status, "queued");
  assert.equal(footerRelease(snapshotOf(done, active, waiting), NOW)?.number, 172);
  assert.equal(footerRelease(snapshotOf(done, waiting), NOW)?.number, 173);
});

test("snapshot: runners self-hosted com o job em execução, fila por label, contrato Zod", () => {
  const active = buildRelease({ run: run({ run_number: 172 }), jobs: midImages(), note: null, commits: null, now: NOW });
  const snapshot = snapshotOf(completed(171), active);
  assert.deepEqual(
    snapshot.releases.map((release) => release.number),
    [172, 171],
  );
  assert.deepEqual(
    snapshot.runners.map((runner) => runner.name),
    ["solid-srv", "solid-srv-light", "unraid-amd64-dboltbr"],
  );
  assert.match(snapshot.runners[0]!.job ?? "", /vms-client-gateway/);
  assert.equal(snapshot.queued.length, 5);
  assert.equal(queueSummary(snapshot), "5 na fila — runner solid-srv ocupado");
  assert.deepEqual(ReleaseSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot))), snapshot);
});

test("formatação pt-BR de durações e tempo relativo", () => {
  assert.equal(formatDuration(36_000), "36s");
  assert.equal(formatDuration((24 * 60 + 8) * 1000), "24m 08s");
  assert.equal(formatDuration(64 * 60_000), "1h 04m");
  assert.equal(formatDuration(null), "");
  assert.equal(formatAgo(minutesAgo(36), NOW), "há 36 min");
  assert.equal(formatAgo(minutesAgo(150), NOW), "há 2 h");
  assert.equal(VERIFY_DONE.length, 6);
});
