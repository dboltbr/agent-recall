// Releases in flight since the watch moved to its own run (release-watch.yml): a release is
// active until its `watch release-<n>` run ends, the next one waits on `previous-watch`, and a third
// queues on release-production. Shapes copied from releases #347–#349 of dboltbr/dbolt (01/11).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeReleases,
  activityLabel,
  buildRelease,
  buildSnapshot,
  footerRelease,
  otherActive,
  releasePhase,
  stepOf,
  WATCH_DISPATCH_GRACE_MS,
  waitingFor,
  type GitHubJob,
  type Release,
} from "../release-status.ts";
import { NOW } from "./fakes.ts";
import { job, minutesAgo, released, run, RUNNERS, VERIFY_DONE, watchRun, type Released } from "./releases.ts";

const at = (ms: number) => new Date(NOW.getTime() + ms);

function release(number: number, partial: Parameters<typeof run>[0] | object, input: Released, now = NOW): Release {
  return buildRelease({ run: run({ run_number: number, ...partial }), ...input, note: null, commits: null, now });
}

/** #347: published and tagged, its release run ended at the dispatch; the watch run still judging. */
function judging(now = NOW): Release {
  const { jobs } = released("success", 347);
  return release(347, { status: "completed", conclusion: "success", updated_at: minutesAgo(1.8) }, { jobs, watch: watchRun(347, "running") }, now);
}

/** #348: verifying, with `previous-watch` held by #347's watch (GitHub run and job `pending`). */
function verifying(): Release {
  const jobs: GitHubJob[] = [
    job("plan", "success", [3, 2.8]),
    job("verify-production / check", "running", [2.5]),
    job("verify-production / scanners", "success", [2.5, 1]),
    job("previous-watch", "waiting", [3], { runner_name: null }),
  ];
  return release(348, { status: "pending" as never, created_at: minutesAgo(3), run_started_at: minutesAgo(3) }, { jobs, watch: null });
}

/** #349: queued on release-production behind #348, no jobs yet. */
function queued(): Release {
  return release(349, { status: "queued", created_at: minutesAgo(1), run_started_at: minutesAgo(1) }, { jobs: [], watch: null });
}

const snapshotOf = (...releases: Release[]) =>
  buildSnapshot({ repository: "dboltbr/dbolt", workflow: "release", releases, runners: RUNNERS, now: NOW });

test("release aberta até o run do vigia acabar; fim é o mais tardio dos dois runs", () => {
  const open = judging();
  assert.equal(open.status, "running");
  assert.equal(open.current, "watch");
  assert.equal(open.completedAt, null);
  assert.equal(stepOf(open, "watch").state, "running");
  assert.equal(stepOf(open, "tag").state, "done", "o job `watch` do run da release só despacha: fecha a etapa tag");
  assert.equal(releasePhase(open), "watch");

  const { jobs, watch } = released("success", 347);
  const done = release(347, { status: "completed", conclusion: "success", updated_at: minutesAgo(1.8) }, { jobs, watch });
  assert.equal(done.status, "completed");
  assert.equal(done.verdict, "green");
  assert.equal(done.completedAt, watch!.run.updated_at);
});

test("vigia cancelado: publicada sem julgamento", () => {
  const { jobs } = released("success", 347);
  const done = release(347, { status: "completed", conclusion: "success" }, { jobs, watch: watchRun(347, "cancelled") });
  assert.equal(done.verdict, "inconclusive");
});

test("despachado e ainda fora da lista: aberta por até 10 min, depois termina sem vigia", () => {
  const { jobs } = released("success", 347);
  const input = { jobs, watch: null };
  const ended = { status: "completed", conclusion: "success", updated_at: minutesAgo(1.8) };
  const fresh = release(347, ended, input);
  assert.equal(fresh.status, "running");
  assert.equal(fresh.current, "watch");
  const late = release(347, ended, input, at(WATCH_DISPATCH_GRACE_MS));
  assert.equal(late.status, "completed");
  assert.equal(late.verdict, "inconclusive", "publicada e nunca julgada: não é release vazia");
});

test("só flags, vigia na fila: etapas sem job já acabaram com o run da release, a atual é o vigia", () => {
  const jobs: GitHubJob[] = [
    job("plan", "success", [6, 5.8]),
    job("verify-production / check", "success", [5.5, 3]),
    job("flags", "success", [3, 2.5]),
    job("release-tag", "success", [2.5, 2.4]),
    job("watch", "success", [2.4, 2.3]),
  ];
  const queuedWatch = watchRun(351, "running");
  const watch = { run: { ...queuedWatch!.run, status: "queued" }, jobs: [job("watch", "queued")] };
  const flags = release(351, { status: "completed", conclusion: "success" }, { jobs, watch });
  assert.equal(flags.status, "running");
  assert.equal(stepOf(flags, "images").state, "skipped");
  assert.equal(flags.current, "watch");
  assert.equal(releasePhase(flags), "watch");
});

test("run pendente com job andando está em andamento; sem job nenhum está na fila", () => {
  const moving = verifying();
  assert.equal(moving.status, "running", "status `pending` do GitHub vem do previous-watch, não da fila");
  assert.equal(moving.current, "verify");
  assert.equal(stepOf(moving, "deploy").state, "pending");
  assert.equal(queued().status, "queued");
  assert.equal(stepOf(queued(), "verify").state, "pending");
});

test("foco: a run no pipeline, depois o vigia aberto, depois a fila; o rodapé segue o foco", () => {
  const snapshot = snapshotOf(judging(), verifying(), queued());
  assert.deepEqual(
    activeReleases(snapshot).map((r) => r.number),
    [348, 347, 349],
  );
  assert.equal(footerRelease(snapshot, NOW)?.number, 348);
  assert.deepEqual(
    otherActive(snapshot, snapshot.releases.find((r) => r.number === 348)!).map((r) => r.number),
    [347, 349],
  );
  const twoQueued = snapshotOf(queued(), release(350, { status: "queued" }, { jobs: [], watch: null }));
  assert.deepEqual(
    activeReleases(twoQueued).map((r) => r.number),
    [349, 350],
    "na fila, a mais antiga sai primeiro",
  );
});

test("waitingFor e activityLabel: quem segura cada release", () => {
  const snapshot = snapshotOf(judging(), verifying(), queued());
  const byNumber = (n: number) => snapshot.releases.find((r) => r.number === n)!;
  assert.equal(waitingFor(snapshot, byNumber(349)), "na fila · atrás de #348");
  assert.equal(waitingFor(snapshot, byNumber(348)), "esperando o vigia de #347");
  assert.equal(waitingFor(snapshot, byNumber(347)), null);
  assert.equal(activityLabel(snapshot, byNumber(349)), "na fila · atrás de #348");
  assert.equal(activityLabel(snapshot, byNumber(348)), "verificação", "job rodando vale mais que a espera adiante");
  assert.equal(activityLabel(snapshot, byNumber(347)), "vigia aberto");

  // Verify and images done, only the gate left: now the wait is what there is to say.
  const gated = release(
    348,
    { status: "pending" as never },
    {
      jobs: [
        ...VERIFY_DONE,
        job("images-command / build-push-api", "success", [2, 1]),
        job("previous-watch", "waiting", [3], { runner_name: null }),
      ],
      watch: null,
    },
  );
  const held = snapshotOf(judging(), gated);
  assert.equal(activityLabel(held, gated), "esperando o vigia de #347");
  const alone = snapshotOf(gated);
  assert.equal(waitingFor(alone, gated), "esperando o vigia anterior", "vigia fora do histórico");
  assert.equal(waitingFor(snapshotOf(queued()), queued()), "na fila");
});
