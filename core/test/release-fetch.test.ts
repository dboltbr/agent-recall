import assert from "node:assert/strict";
import { test } from "node:test";
import { createReleaseSource, createReleaseTracker, FORCE_THROTTLE_MS, IDLE_EVERY_TICKS, previousTag, tagNumbers } from "../release-fetch.ts";
import type { GitHubJob, GitHubRun } from "../release-status.ts";
import type { Note } from "../types.ts";
import { fakeApi, fixedClock, NOW, quietLog, type ApiReply } from "./fakes.ts";
import { commit, finished, midImages, run, RUNNERS } from "./releases.ts";

const RUNS = "repos/dboltbr/dbolt/actions/workflows/release.yml/runs?per_page=15&page=1";
const TAGS = "repos/dboltbr/dbolt/git/matching-refs/tags/release-";
const RUNNERS_PATH = "orgs/dboltbr/actions/runner-groups/1/runners?per_page=100";
const jobsPath = (r: GitHubRun) => `repos/dboltbr/dbolt/actions/runs/${r.id}/jobs?per_page=100&page=1`;

function api(state: { runs: GitHubRun[]; jobs: Map<number, GitHubJob[]>; runsEtag?: string; runsStatus?: number }) {
  const routes: Record<string, ApiReply | (() => ApiReply)> = {
    [RUNS]: () => ({ status: state.runsStatus ?? 200, body: { total_count: state.runs.length, workflow_runs: state.runs }, etag: state.runsEtag ?? '"runs-1"' }),
    [TAGS]: { body: [{ ref: "refs/tags/release-170" }, { ref: "refs/tags/release-171" }], etag: '"tags"' },
    [RUNNERS_PATH]: { body: { total_count: 3, runners: RUNNERS }, etag: '"runners"' },
  };
  for (const r of state.runs) {
    routes[jobsPath(r)] = () => {
      const jobs = state.jobs.get(r.run_number) ?? [];
      return { body: { total_count: jobs.length, jobs }, etag: `"jobs-${r.run_number}-${jobs.length}"` };
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
    jobs: new Map<number, GitHubJob[]>([
      [171, finished("success")],
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
    ["tagcommit", { release: 172, state: "reverted", updatedAt: NOW.toISOString(), revert: { commits: ["a"] } } as Note],
  ]);
  const snapshot = await source.load({ token: "t", notes });
  assert.equal(snapshot.releases[0]!.verdict, "reverted");
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
  state.jobs.set(172, finished("success"));
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
    [jobsPath(old)]: { body: { total_count: 1, jobs: finished("success") } },
  });
  const fetch: typeof github.fetch = (url, init) =>
    url.includes("per_page=100&page=2") || url.includes(`/runs/${old.id}/`) ? routes.fetch(url, init) : github.fetch(url, init);
  const source = createReleaseSource({ fetch, clock: fixedClock(), log: quietLog });
  await source.load({ token: "t", notes: NOTES });
  assert.equal((await source.lookup({ token: "t", notes: NOTES, number: 171 }))?.verdict, "green");
  assert.equal((await source.lookup({ token: "t", notes: NOTES, number: 60 }))?.number, 60);
  assert.equal(await source.lookup({ token: "t", notes: NOTES, number: 999 }), null);
});
