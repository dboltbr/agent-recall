import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createReleaseSource,
  createReleaseTracker,
  FORCE_THROTTLE_MS,
  IDLE_EVERY_TICKS,
  previousTag,
  tagNumbers,
  WATCH_CHECK,
  watchCheckRun,
} from "../release-fetch.ts";
import { WATCH_DISPATCH_GRACE_MS, type GitHubJob, type GitHubRun } from "../release-status.ts";
import type { Note } from "../types.ts";
import { fakeApi, fixedClock, NOW, quietLog, type ApiReply } from "./fakes.ts";
import { commit, jobsInput, released, midImages, run, RUNNERS, watchRun, type Released } from "./releases.ts";

const RUNS = "repos/dboltbr/dbolt/actions/workflows/release.yml/runs?per_page=15&page=1";
const WATCH_RUNS = (perPage: number) => `repos/dboltbr/dbolt/actions/workflows/release-watch.yml/runs?per_page=${perPage}&page=1`;
const TAGS = "repos/dboltbr/dbolt/git/matching-refs/tags/release-";
const RUNNERS_PATH = "orgs/dboltbr/actions/runner-groups/1/runners?per_page=100";
const jobsPath = (r: GitHubRun) => `repos/dboltbr/dbolt/actions/runs/${r.id}/jobs?per_page=100&page=1`;

type State = { runs: GitHubRun[]; jobs: Map<number, GitHubJob[] | Released>; runsEtag?: string; runsStatus?: number };

/** The watch runs of the releases in `state`: one per release whose jobs come with a watch run. */
function watchRuns(state: State): NonNullable<Released["watch"]>[] {
  return state.runs.flatMap((r) => {
    const watch = jobsInput(state.jobs.get(r.run_number) ?? []).watch;
    return watch ? [watch] : [];
  });
}

function api(state: State) {
  const watchList = (): ApiReply => {
    const runs = watchRuns(state).map((watch) => watch.run);
    return { body: { total_count: runs.length, workflow_runs: runs }, etag: `"watch-${runs.map((r) => `${r.id}${r.status}`).join()}"` };
  };
  const routes: Record<string, ApiReply | (() => ApiReply)> = {
    [WATCH_RUNS(30)]: watchList,
    [WATCH_RUNS(100)]: watchList,
    [RUNS]: () => ({ status: state.runsStatus ?? 200, body: { total_count: state.runs.length, workflow_runs: state.runs }, etag: state.runsEtag ?? '"runs-1"' }),
    [TAGS]: { body: [{ ref: "refs/tags/release-170" }, { ref: "refs/tags/release-171" }], etag: '"tags"' },
    [RUNNERS_PATH]: { body: { total_count: 3, runners: RUNNERS }, etag: '"runners"' },
  };
  for (const r of state.runs) {
    routes[jobsPath(r)] = () => {
      const { jobs } = jobsInput(state.jobs.get(r.run_number) ?? []);
      return { body: { total_count: jobs.length, jobs }, etag: `"jobs-${r.run_number}-${jobs.length}"` };
    };
    // The watch run's jobs (fixtures number watch runs by release: one route per possible watch).
    const watch = jobsInput(state.jobs.get(r.run_number) ?? []).watch ?? watchRun(r.run_number, "success");
    routes[jobsPath(watch!.run)] = () => {
      const current = jobsInput(state.jobs.get(r.run_number) ?? []).watch;
      const jobs = current?.jobs ?? [];
      return { body: { total_count: jobs.length, jobs }, etag: `"watch-jobs-${r.run_number}-${current?.run.status}"` };
    };
    routes[`repos/dboltbr/dbolt/compare/release-${r.run_number === 172 ? 171 : 170}...${r.head_sha}?per_page=250`] = {
      body: { commits: [commit("c1", "feat: x", "paseo/srv_KkHRlgUn9pdj/agent-1")] },
    };
  }
  return fakeApi(routes);
}

function fixture() {
  const done = run({ run_number: 171, status: "completed", conclusion: "success" });
  const active = run({ run_number: 172 });
  const state = {
    runs: [active, done],
    jobs: new Map<number, GitHubJob[] | Released>([
      [171, released("success", 171)],
      [172, midImages()],
    ]),
    runsEtag: '"runs-1"',
    runsStatus: 200,
  };
  return { state, done, active };
}

const NOTES = new Map<string, Note>();

test("tags e tag anterior", () => {
  const tags = tagNumbers([{ ref: "refs/tags/release-171" }, { ref: "refs/tags/release-51" }, { ref: "refs/tags/v1" }]);
  assert.deepEqual(tags, [51, 171]);
  assert.equal(previousTag(tags, 182), "release-171");
  assert.equal(previousTag(tags, 171), "release-51");
  assert.equal(previousTag(tags, 51), null);
});

test("runs do vigia fora do ar: o snapshot carrega o resto, sem vigia", async () => {
  const { state } = fixture();
  const github = api(state);
  const fetch: typeof github.fetch = async (url, init) =>
    url.includes("release-watch.yml/runs") ? new Response(null, { status: 502 }) : github.fetch(url, init);
  const clock = fixedClock();
  const source = createReleaseSource({ fetch, clock, log: quietLog });
  const snapshot = await source.load({ token: "t", notes: NOTES });
  assert.equal(snapshot.error, null);
  assert.deepEqual(
    snapshot.releases.map((release) => [release.number, release.status]),
    [
      [172, "running"],
      [171, "running"],
    ],
    "171 despachou o vigia há 2 min: segue aberta na folga",
  );
  clock.set(new Date(NOW.getTime() + WATCH_DISPATCH_GRACE_MS));
  const later = await source.load({ token: "t", notes: NOTES });
  assert.equal(later.releases[1]!.verdict, "inconclusive");
});

test("load: snapshot das runs, jobs, faixa e runners; depois só pergunta com ETag", async () => {
  const { state } = fixture();
  const github = api(state);
  const source = createReleaseSource({ fetch: github.fetch, clock: fixedClock(), log: quietLog });
  const first = await source.load({ token: "t", notes: NOTES });
  assert.equal(first.error, null);
  assert.deepEqual(
    first.releases.map((release) => [release.number, release.verdict]),
    [
      [172, null],
      [171, "green"],
    ],
  );
  assert.equal(first.releases[0]!.sessions[0]!.id, "agent-1");
  assert.equal(first.runners.length, 3);
  assert.equal(first.queued.length, 5);

  const before = github.calls.length;
  await source.load({ token: "t", notes: NOTES });
  const second = github.calls.slice(before);
  assert.ok(second.every((call) => call.status === 304), "tudo 304 sem mudança");
  assert.ok(!second.some((call) => call.path.includes(`/runs/${state.runs[1]!.id}/jobs`)), "jobs da run concluída ficam em cache");
  assert.ok(!second.some((call) => call.path.includes("/compare/")), "faixa imutável fica em cache");
  assert.ok(second.every((call) => call.ifNoneMatch !== null));
});

test("nota da release vira veredito sem esperar a run", async () => {
  const { state } = fixture();
  const github = api(state);
  const source = createReleaseSource({ fetch: github.fetch, clock: fixedClock(), log: quietLog });
  const notes = new Map<string, Note>([
    ["tagcommit", { release: 172, updatedAt: NOW.toISOString(), rollback: { outcome: "reverted", target: "dbolt-deploy", commits: ["a"] } }],
  ]);
  const snapshot = await source.load({ token: "t", notes });
  assert.equal(snapshot.releases[0]!.verdict, "reverted");
});

test("handoffs do host entram só na release com incidente; leitor que falha não derruba", async () => {
  const { state } = fixture();
  const asked: string[] = [];
  const source = createReleaseSource({
    fetch: api(state).fetch,
    clock: fixedClock(),
    log: quietLog,
    handoffs: async (release) => {
      asked.push(release);
      if (release !== "release-172") throw new Error("disco");
      return [{ role: "owner", session: { harness: "paseo", host: "srv_X", id: "agent-owner" }, at: NOW.toISOString() }];
    },
  });
  const notes = new Map<string, Note>([
    ["tagcommit", { release: 172, updatedAt: NOW.toISOString() }],
  ]);
  const snapshot = await source.load({ token: "t", notes });
  assert.deepEqual(asked, ["release-172"], "sem nota não há o que ler");
  assert.deepEqual(
    snapshot.releases[0]!.handoffs.map((handoff) => [handoff.role, handoff.session.id]),
    [["owner", "agent-owner"]],
  );
  assert.deepEqual(snapshot.releases[1]!.handoffs, []);
});

test("falha do GitHub mantém o último snapshot com o erro", async () => {
  const { state } = fixture();
  const github = api(state);
  const source = createReleaseSource({ fetch: github.fetch, clock: fixedClock(), log: quietLog });
  await source.load({ token: "t", notes: NOTES });
  state.runsStatus = 502;
  const failed = await source.load({ token: "t", notes: NOTES });
  assert.match(failed.error ?? "", /502/);
  assert.equal(failed.releases.length, 2);
  state.runsStatus = 200;
  assert.equal((await source.load({ token: "t", notes: NOTES })).error, null);
});

test("sem nenhum snapshot, a falha devolve um snapshot vazio com o erro", async () => {
  const source = createReleaseSource({ fetch: fakeApi({}).fetch, clock: fixedClock(), log: quietLog });
  const snapshot = await source.load({ token: "t", notes: NOTES });
  assert.deepEqual(snapshot.releases, []);
  assert.match(snapshot.error ?? "", /404/);
});

test("rastreador: a cada tick com run ativa; ocioso só sonda até mudar ou dar a 10ª", async () => {
  const { state, active } = fixture();
  const github = api(state);
  const clock = fixedClock();
  const source = createReleaseSource({ fetch: github.fetch, clock, log: quietLog });
  const seen: number[] = [];
  const tracker = createReleaseTracker({ source, clock, log: quietLog, onSnapshot: (next) => void seen.push(next.releases.length) });
  const tick = (notesChanged = false) => tracker.tick({ token: "t", notes: NOTES, notesChanged });
  await tick();
  await tick();
  assert.equal(seen.length, 2, "ativa: carrega todo tick");

  state.runs = [{ ...active, status: "completed", conclusion: "success" }, state.runs[1]!];
  state.jobs.set(172, released("success", 172));
  state.runsEtag = '"runs-2"';
  await tick();
  assert.equal(seen.length, 3);
  const runsCalls = () => github.calls.filter((call) => call.path === RUNS).length;
  const before = runsCalls();
  for (let i = 3; i < IDLE_EVERY_TICKS; i++) await tick();
  assert.equal(seen.length, 3, "ocioso sem mudança: nenhuma carga");
  assert.equal(runsCalls() - before, IDLE_EVERY_TICKS - 3, "uma sonda por tick");
  await tick();
  assert.equal(seen.length, 4, "10º tick carrega");
  await tick(true);
  assert.equal(seen.length, 5, "nota mudou: carrega");
  state.runsEtag = '"runs-3"';
  await tick();
  assert.equal(seen.length, 6, "a sonda viu run nova: carrega");
});

test("refresh forçado: limitado a um a cada 10 s e só depois do primeiro tick", async () => {
  const { state } = fixture();
  const clock = fixedClock();
  const source = createReleaseSource({ fetch: api(state).fetch, clock, log: quietLog });
  const tracker = createReleaseTracker({ source, clock, log: quietLog });
  assert.equal(await tracker.refresh(), false);
  await tracker.tick({ token: "t", notes: NOTES, notesChanged: false });
  assert.equal(await tracker.refresh(), true);
  assert.equal(await tracker.refresh(), false);
  clock.set(new Date(NOW.getTime() + FORCE_THROTTLE_MS));
  assert.equal(await tracker.refresh(), true);
});

test("lookup: release fora do snapshot pela página do histórico", async () => {
  const { state } = fixture();
  const old = run({ run_number: 60, status: "completed", conclusion: "success" });
  const github = api(state);
  const routes = fakeApi({
    "repos/dboltbr/dbolt/actions/workflows/release.yml/runs?per_page=100&page=2": {
      body: { total_count: 172, workflow_runs: [old] },
    },
    [jobsPath(old)]: { body: { total_count: 1, jobs: released("success").jobs } },
  });
  const fetch: typeof github.fetch = (url, init) =>
    url.includes("per_page=100&page=2") || url.includes(`/runs/${old.id}/`) ? routes.fetch(url, init) : github.fetch(url, init);
  const source = createReleaseSource({ fetch, clock: fixedClock(), log: quietLog });
  await source.load({ token: "t", notes: NOTES });
  assert.equal((await source.lookup({ token: "t", notes: NOTES, number: 171 }))?.verdict, "green");
  assert.equal((await source.lookup({ token: "t", notes: NOTES, number: 60 }))?.number, 60);
  assert.equal(await source.lookup({ token: "t", notes: NOTES, number: 999 }), null);
});

/** The check run `release-watch` as the watch publishes it, linked to its watch run. */
function checkRunOf(watch: GitHubRun, phase: string, verdict: string | null, id = 7) {
  const view = { schema: 1, phase, verdict, sources: [{ name: "deployment", outcome: phase === "deploying" ? "pending" : "green" }] };
  return { id, details_url: watch.html_url, output: { text: "```json\n" + JSON.stringify(view) + "\n```" } };
}

test("progresso do vigia: lido com o run aberto, uma última vez ao fechar, nunca de vigia que não vimos aberto", async () => {
  const { state, done } = fixture();
  const open = watchRun(171, "running")!;
  state.jobs.set(171, { jobs: released("success", 171).jobs, watch: open });
  // The check run lives on the release commit.
  const checks = `repos/dboltbr/dbolt/commits/${done.head_sha}/check-runs?check_name=${WATCH_CHECK}`;
  let check: { status?: number; body: unknown; etag: string } = {
    body: { check_runs: [checkRunOf(open.run, "observing", "pending")] },
    etag: '"check-1"',
  };
  const github = api(state);
  const fetch: typeof github.fetch = async (url, init) => {
    if (!url.endsWith(checks)) return github.fetch(url, init);
    const ifNoneMatch = ((init?.headers ?? {}) as Record<string, string>)["If-None-Match"];
    if (check.status) return new Response(null, { status: check.status });
    return ifNoneMatch === check.etag ? new Response(null, { status: 304 }) : new Response(JSON.stringify(check.body), { status: 200, headers: { etag: check.etag } });
  };
  let asked = 0;
  const counting: typeof fetch = async (url, init) => {
    if (url.endsWith(checks)) asked++;
    return fetch(url, init);
  };
  const source = createReleaseSource({ fetch: counting, clock: fixedClock(), log: quietLog });
  let snapshot = await source.load({ token: "t", notes: NOTES });
  assert.equal(snapshot.releases[1]!.progress?.phase, "observing");
  assert.deepEqual(snapshot.releases[0]!.progress, null, "172 ainda não tem vigia");

  // A failed read keeps what was seen.
  check = { ...check, status: 502 };
  snapshot = await source.load({ token: "t", notes: NOTES });
  assert.equal(snapshot.releases[1]!.progress?.phase, "observing");

  // The watch run closes: one last read brings the verdict, then nothing more.
  const closed = { ...open, run: { ...open.run, status: "completed", conclusion: "success" } };
  state.jobs.set(171, { jobs: released("success", 171).jobs, watch: closed });
  check = { body: { check_runs: [checkRunOf(open.run, "done", "green")] }, etag: '"check-2"' };
  assert.equal(asked, 2);
  // Never seen open by this source: a closed watch costs no read.
  await createReleaseSource({ fetch: counting, clock: fixedClock(), log: quietLog }).load({ token: "t", notes: NOTES });
  assert.equal(asked, 2);

  snapshot = await source.load({ token: "t", notes: NOTES });
  assert.equal(snapshot.releases[1]!.status, "completed");
  assert.deepEqual([snapshot.releases[1]!.progress?.phase, snapshot.releases[1]!.progress?.verdict], ["done", "green"]);
  assert.equal(asked, 3);
  snapshot = await source.load({ token: "t", notes: NOTES });
  assert.equal(asked, 3, "depois da última leitura, nada mais é pedido");
  assert.equal(snapshot.releases[1]!.progress?.verdict, "green");

  // A rerun keeps the run id: the new attempt is read while open and once more when it closes.
  const rerun = { ...open, run: { ...open.run, run_attempt: 2 } };
  state.jobs.set(171, { jobs: released("success", 171).jobs, watch: rerun });
  check = { body: { check_runs: [checkRunOf(open.run, "done", "green", 7), checkRunOf(open.run, "deploying", null, 8)] }, etag: '"check-3"' };
  snapshot = await source.load({ token: "t", notes: NOTES });
  assert.equal(asked, 4);
  assert.equal(snapshot.releases[1]!.progress?.phase, "deploying", "o check run mais novo do run");
  state.jobs.set(171, { jobs: released("success", 171).jobs, watch: { ...rerun, run: { ...rerun.run, status: "completed", conclusion: "success" } } });
  await source.load({ token: "t", notes: NOTES });
  await source.load({ token: "t", notes: NOTES });
  assert.equal(asked, 5);
});

test("watchCheckRun: o check run do próprio run do vigia; o de outro run nunca", () => {
  const own = watchRun(171, "running")!.run;
  const other = watchRun(170, "success")!.run;
  const mine = checkRunOf(own, "observing", null, 3);
  const newer = checkRunOf(other, "done", "green", 9);
  assert.equal(watchCheckRun([newer, mine], own.id), mine);
  assert.equal(watchCheckRun([mine, newer], 1), null);
  assert.equal(watchCheckRun([], own.id), null);
});
