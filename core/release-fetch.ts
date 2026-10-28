// Release status fetcher: workflow runs, jobs, self-hosted runners, release tags and the commit
// range of each run, from the GitHub REST API with ETag caching, folded into the pure model of
// `release-status.ts`. Runs daemon/service-side only; clients read the snapshot it builds.
import { releaseName } from "./notes.ts";
import { describe } from "./poll.ts";
import {
  buildRelease,
  buildSnapshot,
  isActive,
  RELEASE_HISTORY,
  RELEASE_REPOSITORY,
  RELEASE_WORKFLOW,
  RUNNER_ORG,
  releaseNameOf,
  type GitHubCommit,
  type GitHubJob,
  type GitHubRun,
  type GitHubRunner,
  type Handoff,
  type Release,
  type ReleaseSnapshot,
} from "./release-status.ts";
import type { Clock, Fetch, Logger, Note } from "./types.ts";

export const GITHUB_TIMEOUT_MS = 25_000;
/**
 * Tracker cadence: a full load every watcher tick (30 s) while a run is active, every 10th tick
 * (5 min) when idle. Idle ticks in between still probe the runs list (a free 304) so a new push
 * shows up within one tick.
 */
export const IDLE_EVERY_TICKS = 10;
/** A forced refresh (the screen's "Atualizar") at most this often. */
export const FORCE_THROTTLE_MS = 10_000;
const PARALLEL = 4;
/** GitHub's default runner group: the org's self-hosted runners. */
const DEFAULT_RUNNER_GROUP = 1;

export class GitHubError extends Error {
  readonly status: number | null;
  constructor(status: number | null, message: string) {
    super(message);
    this.status = status;
  }
}

interface Cached {
  readonly etag: string | null;
  readonly body: unknown;
}

/** GET with `If-None-Match`; a 304 answers from the cache (and costs no rate limit). */
export function createGitHubClient(fetch: Fetch) {
  const cache = new Map<string, Cached>();
  return async function get<T>(path: string, token: string): Promise<T> {
    const url = path.startsWith("https://") ? path : `https://api.github.com/${path}`;
    const cached = cache.get(url);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "agent-recall",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    } catch (error) {
      throw new GitHubError(null, `GitHub ${path.split("?")[0]}: ${describe(error)}`);
    }
    if (response.status === 304 && cached) return cached.body as T;
    if (response.status !== 200) throw new GitHubError(response.status, `GitHub respondeu ${response.status} em ${path.split("?")[0]}`);
    const body = (await response.json()) as unknown;
    cache.set(url, { etag: response.headers.get("etag"), body });
    return body as T;
  };
}

async function pool<T, R>(items: readonly T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

/** Release numbers that have a tag, ascending. */
export function tagNumbers(refs: readonly { ref?: string }[]): number[] {
  return refs
    .map((entry) => /^refs\/tags\/release-(\d+)$/.exec(entry.ref ?? "")?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Highest tagged release below `number`. */
export function previousTag(tags: readonly number[], number: number): string | null {
  let found: number | null = null;
  for (const tag of tags) if (tag < number) found = tag;
  return found === null ? null : releaseNameOf(found);
}

/** Notes by release name (`release-90`). */
export function notesByRelease(notes: ReadonlyMap<string, Note>): Map<string, Note> {
  const byName = new Map<string, Note>();
  for (const note of notes.values()) {
    if (!note.drill) byName.set(releaseName(note), note);
  }
  return byName;
}

export interface ReleaseSourceOptions {
  readonly fetch: Fetch;
  readonly clock: Clock;
  readonly log: Logger;
  readonly repository?: string;
  readonly workflow?: string;
  readonly org?: string;
  /** Calls this host delivered for a release's incident (`readHandoffs` on the state dir). */
  readonly handoffs?: (release: string) => Promise<readonly Handoff[]>;
}

export interface ReleaseLoadInput {
  readonly token: string;
  /** release-watch notes keyed by the tag commit (the watcher's map, or `fetchNotes`). */
  readonly notes: ReadonlyMap<string, Note>;
}

export interface ReleaseSource {
  /** Fresh snapshot. Never rejects: a failure keeps the last good data with `error` set. */
  load(input: ReleaseLoadInput): Promise<ReleaseSnapshot>;
  /** One release by run number, from the snapshot or the run history. */
  lookup(input: ReleaseLoadInput & { readonly number: number }): Promise<Release | null>;
  /** One conditional GET of the runs list: true when it moved since the last load (304 = false). */
  probe(token: string): Promise<boolean>;
  current(): ReleaseSnapshot | null;
}

interface RunsPage {
  readonly total_count: number;
  readonly workflow_runs: readonly GitHubRun[];
}

interface JobsPage {
  readonly total_count: number;
  readonly jobs: readonly GitHubJob[];
}

export function createReleaseSource(options: ReleaseSourceOptions): ReleaseSource {
  const repository = options.repository ?? RELEASE_REPOSITORY;
  const workflow = options.workflow ?? RELEASE_WORKFLOW;
  const org = options.org ?? RUNNER_ORG;
  const get = createGitHubClient(options.fetch);
  /** Jobs of completed runs never change: keyed `<run id>:<attempt>`. */
  const finishedJobs = new Map<string, readonly GitHubJob[]>();
  /** Compare ranges are immutable: keyed `<base>...<head>`. */
  const ranges = new Map<string, readonly GitHubCommit[]>();
  let snapshot: ReleaseSnapshot | null = null;
  let runners: readonly GitHubRunner[] = [];
  let loadedRuns: unknown = null;

  const runsPath = (perPage: number, page = 1) =>
    `repos/${repository}/actions/workflows/${workflow}.yml/runs?per_page=${perPage}&page=${page}`;

  async function jobsOf(run: GitHubRun, token: string): Promise<readonly GitHubJob[]> {
    const key = `${run.id}:${run.run_attempt ?? 1}`;
    const done = finishedJobs.get(key);
    if (done) return done;
    const jobs: GitHubJob[] = [];
    for (let page = 1; page <= 5; page++) {
      const body = await get<JobsPage>(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`, token);
      jobs.push(...body.jobs);
      if (jobs.length >= body.total_count || body.jobs.length === 0) break;
    }
    if (run.status === "completed") finishedJobs.set(key, jobs);
    return jobs;
  }

  async function commitsOf(run: GitHubRun, tags: readonly number[], token: string): Promise<readonly GitHubCommit[] | null> {
    const base = previousTag(tags, run.run_number);
    if (!base) return null;
    const key = `${base}...${run.head_sha}`;
    const known = ranges.get(key);
    if (known) return known;
    const body = await get<{ commits?: readonly GitHubCommit[] }>(`repos/${repository}/compare/${key}?per_page=250`, token);
    const commits = body.commits ?? [];
    ranges.set(key, commits);
    return commits;
  }

  async function tagList(token: string): Promise<number[]> {
    return tagNumbers(await get<{ ref?: string }[]>(`repos/${repository}/git/matching-refs/tags/release-`, token));
  }

  async function build(run: GitHubRun, tags: readonly number[], notes: Map<string, Note>, token: string): Promise<Release> {
    const [jobs, commits] = await Promise.all([
      jobsOf(run, token),
      commitsOf(run, tags, token).catch((error) => {
        options.log.warn(`faixa de ${releaseNameOf(run.run_number)}: ${describe(error)}`);
        return null;
      }),
    ]);
    const name = releaseNameOf(run.run_number);
    const note = notes.get(name) ?? null;
    const handoffs = note && options.handoffs ? await options.handoffs(name).catch(() => []) : [];
    return buildRelease({
      run,
      jobs,
      note,
      commits,
      tagged: tags.includes(run.run_number),
      handoffs,
      now: options.clock.now(),
    });
  }

  async function load(input: ReleaseLoadInput): Promise<ReleaseSnapshot> {
    const now = options.clock.now();
    const notes = notesByRelease(input.notes);
    try {
      const [page, tags] = await Promise.all([get<RunsPage>(runsPath(RELEASE_HISTORY), input.token), tagList(input.token)]);
      loadedRuns = page;
      const previous = new Map((snapshot?.releases ?? []).map((release) => [release.runId, release]));
      const releases = await pool(page.workflow_runs, (run) =>
        build(run, tags, notes, input.token).catch((error) => {
          const kept = previous.get(run.id);
          if (!kept) throw error;
          options.log.warn(`${releaseNameOf(run.run_number)}: ${describe(error)}`);
          return kept;
        }),
      );
      runners = await get<{ runners: readonly GitHubRunner[] }>(
        `orgs/${org}/actions/runner-groups/${DEFAULT_RUNNER_GROUP}/runners?per_page=100`,
        input.token,
      )
        .then((body) => body.runners)
        .catch((error) => {
          options.log.warn(`runners: ${describe(error)}`);
          return runners;
        });
      snapshot = buildSnapshot({ repository, workflow, releases, runners, now });
    } catch (error) {
      const message = describe(error);
      snapshot = snapshot
        ? { ...snapshot, error: message }
        : buildSnapshot({ repository, workflow, releases: [], runners: [], now, error: message });
    }
    return snapshot;
  }

  async function lookup(input: ReleaseLoadInput & { readonly number: number }): Promise<Release | null> {
    const known = snapshot?.releases.find((release) => release.number === input.number);
    if (known) return known;
    const latest = snapshot?.releases[0]?.number ?? (await get<RunsPage>(runsPath(1), input.token)).workflow_runs[0]?.run_number;
    if (latest === undefined || input.number > latest || input.number < 1) return null;
    // Runs list newest first, one per number: the page is predictable, ±1 for gaps.
    const guess = Math.floor((latest - input.number) / 100) + 1;
    for (const page of [guess, guess + 1, guess - 1].filter((value) => value >= 1)) {
      const body = await get<RunsPage>(runsPath(100, page), input.token);
      const run = body.workflow_runs.find((candidate) => candidate.run_number === input.number);
      if (run) return build(run, await tagList(input.token), notesByRelease(input.notes), input.token);
    }
    return null;
  }

  async function probe(token: string): Promise<boolean> {
    // A 304 hands back the cached body itself, so identity means "unchanged".
    return (await get<RunsPage>(runsPath(RELEASE_HISTORY), token)) !== loadedRuns;
  }

  return { load, lookup, probe, current: () => snapshot };
}

export interface TrackerTickInput {
  readonly token: string;
  readonly notes: ReadonlyMap<string, Note>;
  /** The notes ref moved this tick: verdicts may have changed. */
  readonly notesChanged: boolean;
}

export interface ReleaseTracker {
  /** Called by the watcher every tick; refreshes on the release cadence. */
  tick(input: TrackerTickInput): Promise<void>;
  /** Forced refresh (throttled); false when throttled or no tick has run yet. */
  refresh(): Promise<boolean>;
  current(): ReleaseSnapshot | null;
}

export interface TrackerOptions {
  readonly source: ReleaseSource;
  readonly clock: Clock;
  readonly log: Logger;
  /** After every load: the new snapshot and the one before it. */
  readonly onSnapshot?: (next: ReleaseSnapshot, previous: ReleaseSnapshot | null) => void | Promise<void>;
}

export function createReleaseTracker(options: TrackerOptions): ReleaseTracker {
  let ticks = 0;
  let last: TrackerTickInput | null = null;
  let lastForced = -Infinity;
  let running: Promise<void> | null = null;

  function run(input: TrackerTickInput): Promise<void> {
    if (running) return running;
    running = (async () => {
      const previous = options.source.current();
      const next = await options.source.load(input);
      try {
        await options.onSnapshot?.(next, previous);
      } catch (error) {
        options.log.warn(`release: ${describe(error)}`);
      }
    })().finally(() => (running = null));
    return running;
  }

  return {
    async tick(input) {
      last = input;
      const current = options.source.current();
      const scheduled =
        ticks++ % IDLE_EVERY_TICKS === 0 || current === null || current.releases.some(isActive) || input.notesChanged;
      const due =
        scheduled ||
        (await options.source.probe(input.token).catch((error) => {
          options.log.warn(`release: ${describe(error)}`);
          return false;
        }));
      if (due) await run(input);
    },
    async refresh() {
      const now = options.clock.now().getTime();
      if (!last || now - lastForced < FORCE_THROTTLE_MS) return false;
      lastForced = now;
      await run(last);
      return true;
    },
    current: () => options.source.current(),
  };
}
