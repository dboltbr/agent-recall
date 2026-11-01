// Release status: the one job→step mapping, verdict reading and snapshot contract for the
// `release` workflow of dboltbr/dbolt. Pure: built from raw GitHub API JSON plus the
// release-watch notes. The Paseo UI (via `shared/release-status.ts`, a sync copy) and the
// OpenChamber extension import it; `core/release-fetch.ts` is the fetcher that feeds it.
import { z } from "zod";
import { parseAgentSession, sameSession, toSessionRef } from "./trailer.ts";
import type { Note, SessionRef } from "./types.ts";

export const RELEASE_REPOSITORY = "dboltbr/dbolt";
export const RELEASE_WORKFLOW = "release";
export const RUNNER_ORG = "dboltbr";
/** How many workflow runs the snapshot keeps (active and completed, newest first). */
export const RELEASE_HISTORY = 15;
/** The sidebar keeps the last verdict this long after a release ends. */
export const RECENT_VERDICT_MS = 2 * 60 * 60 * 1000;

// ── Contract ────────────────────────────────────────────────────────────────────────────────

export const STEP_IDS = ["verify", "images", "deploy", "tag", "watch"] as const;
export const StepIdSchema = z.enum(STEP_IDS);
export type StepId = z.infer<typeof StepIdSchema>;

export const StepStateSchema = z.enum(["pending", "running", "done", "failed", "cancelled", "skipped"]);
export type StepState = z.infer<typeof StepStateSchema>;

/** `waiting`: held by a concurrency group (GitHub `pending`), not by a runner. */
export const JobStateSchema = z.enum(["queued", "waiting", "running", "success", "failure", "cancelled", "skipped"]);
export type JobState = z.infer<typeof JobStateSchema>;

/** The watch's (vigia) word on a finished release, or why there is none. */
export const VerdictSchema = z.enum(["green", "reverted", "red", "inconclusive", "failed", "cancelled", "none"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const SessionSchema = z.object({
  harness: z.enum(["paseo", "opencode"]),
  host: z.string(),
  id: z.string(),
});
export type Session = z.infer<typeof SessionSchema>;

export const JobSchema = z.object({
  id: z.number(),
  name: z.string(),
  step: StepIdSchema.nullable(),
  /** Image a build-push job publishes (`vms-api`, `api`, `fs-bridge`). */
  image: z.string().nullable(),
  state: JobStateSchema,
  runner: z.string().nullable(),
  labels: z.array(z.string()),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  url: z.string().nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const StepSchema = z.object({
  id: StepIdSchema,
  state: StepStateSchema,
  /** Images only: published / to publish (skipped builds excluded). */
  done: z.number().nullable(),
  total: z.number().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  /** Name of the first failed job of the step. */
  failedJob: z.string().nullable(),
});
export type Step = z.infer<typeof StepSchema>;

/** One health source of the watch verdict (`errors5xx`, `sentry`, `deployment`, …). */
export const SignalSchema = z.object({
  source: z.string(),
  label: z.string(),
  outcome: z.string(),
  reason: z.string().nullable(),
});
export type Signal = z.infer<typeof SignalSchema>;

export const HANDOFF_ROLES = ["owner", "notified", "blocked"] as const;
export const HandoffRoleSchema = z.enum(HANDOFF_ROLES);
export type HandoffRole = z.infer<typeof HandoffRoleSchema>;

/** A session the incident of a red release went to. */
export const HandoffSchema = z.object({
  role: HandoffRoleSchema,
  session: SessionSchema,
  /** When this host delivered the call; null for what only the note says (owner, notified). */
  at: z.string().nullable(),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export const ReleaseSchema = z.object({
  number: z.number(),
  /** `release-<run number>`: the tag the run creates. */
  name: z.string(),
  runId: z.number(),
  attempt: z.number(),
  url: z.string(),
  status: z.enum(["queued", "running", "completed"]),
  conclusion: z.string().nullable(),
  event: z.string(),
  headSha: z.string(),
  /** First line of the head commit message. */
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  steps: z.array(StepSchema),
  current: StepIdSchema.nullable(),
  /** Null while the run is in flight and no incident note exists yet. */
  verdict: VerdictSchema.nullable(),
  /** The tag, once `release-tag` succeeded. */
  tag: z.string().nullable(),
  failedJob: z.object({ name: z.string(), url: z.string().nullable() }).nullable(),
  revert: z.object({ commits: z.array(z.string()), commit: z.string().nullable() }).nullable(),
  signals: z.array(SignalSchema),
  /**
   * The watch's rollback from the incident note (red releases only): `outcome` (`pending`,
   * `reverted`, `blocked`, `failed`, `none`), `target` (`dbolt-deploy` or `main`) and whether the
   * note freezes main (not resolved, not a drill). Defaults so older timeline cards still render.
   */
  rollback: z
    .object({ outcome: z.string(), target: z.string().nullable(), frozen: z.boolean() })
    .nullable()
    .default(null),
  /** The note carries a `recall` failure: no agent could be told. */
  recallFailed: z.boolean(),
  /** Session that pushed the head commit (newest trailer of the range as fallback). */
  pusher: SessionSchema.nullable(),
  /** Every `Agent-Session` trailer of the range since the previous release tag. */
  sessions: z.array(SessionSchema),
  /**
   * Where the incident went: the calls this host's harnesses delivered (local record), then the
   * note's owner and notified sessions. Empty without an incident. Defaults so timeline cards written
   * before the field still render.
   */
  handoffs: z.array(HandoffSchema).default([]),
  jobs: z.array(JobSchema),
});
export type Release = z.infer<typeof ReleaseSchema>;

export const RunnerSchema = z.object({
  id: z.number(),
  name: z.string(),
  online: z.boolean(),
  busy: z.boolean(),
  labels: z.array(z.string()),
  /** The release job it runs right now, when busy with one. */
  job: z.string().nullable(),
});
export type Runner = z.infer<typeof RunnerSchema>;

export const QueuedJobSchema = z.object({
  name: z.string(),
  runNumber: z.number(),
  labels: z.array(z.string()),
});
export type QueuedJob = z.infer<typeof QueuedJobSchema>;

export const ReleaseSnapshotSchema = z.object({
  version: z.literal(1),
  repository: z.string(),
  workflow: z.string(),
  fetchedAt: z.string(),
  /** Newest first; active runs and the last completed ones. */
  releases: z.array(ReleaseSchema),
  /** Self-hosted runners of the org. */
  runners: z.array(RunnerSchema),
  queued: z.array(QueuedJobSchema),
  /** pt-BR reason the last refresh failed; the rest is the last good data. */
  error: z.string().nullable(),
});
export type ReleaseSnapshot = z.infer<typeof ReleaseSnapshotSchema>;

// ── Raw GitHub shapes (only the fields read) ────────────────────────────────────────────────

export interface GitHubRun {
  readonly id: number;
  readonly run_number: number;
  readonly run_attempt?: number;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly head_sha: string;
  readonly display_title?: string;
  readonly event: string;
  readonly html_url: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly run_started_at?: string | null;
  readonly head_commit?: { readonly message?: string } | null;
  readonly name?: string;
}

export interface GitHubJob {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly labels?: readonly string[];
  readonly runner_name?: string | null;
  readonly html_url?: string | null;
}

export interface GitHubRunner {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly busy: boolean;
  readonly labels?: readonly { readonly name: string }[];
}

export interface GitHubCommit {
  readonly sha: string;
  readonly commit: { readonly message: string };
}

// ── pt-BR copy ──────────────────────────────────────────────────────────────────────────────

export const STEP_LABELS: Record<StepId, string> = {
  verify: "verificação",
  images: "imagens",
  deploy: "deploy",
  tag: "tag",
  watch: "vigia",
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  green: "verde",
  reverted: "revertido",
  red: "vermelho",
  inconclusive: "inconclusivo",
  failed: "falhou",
  cancelled: "cancelado",
  none: "sem publicação",
};

export const HANDOFF_LABELS: Record<HandoffRole, string> = {
  owner: "dona",
  notified: "avisada",
  blocked: "release barrada",
};

export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  errors5xx: "5xx",
  sentry: "Sentry",
  deployment: "implantação",
  watch: "vigia",
};

// ── Job → step ──────────────────────────────────────────────────────────────────────────────

const DEPLOY_TIERS = new Set(["wall", "console", "desktop", "marketing", "infrastructure", "mobile"]);

/**
 * Which step a job of the release run belongs to; null for `plan`, `summary` and the images'
 * bookkeeping jobs. `previous-watch` holds the publication (deploy); the run's `watch` job only
 * dispatches release-watch.yml, so it closes the tag step. The watch step is the job of the
 * separate `watch release-<n>` run (`toJob(job, "watch")`).
 */
export function classifyJob(name: string): StepId | null {
  const [prefix, rest] = splitJobName(name);
  if (prefix === "verify-production") return "verify";
  if (prefix.startsWith("images-")) return rest !== null && /^build-push/.test(rest) ? "images" : null;
  if (DEPLOY_TIERS.has(prefix) || name === "flags" || name === PREVIOUS_WATCH) return "deploy";
  if (name === "release-tag" || name === WATCH_DISPATCH) return "tag";
  return null;
}

/** The release run's job that waits for the previous release's watch (concurrency release-watch). */
export const PREVIOUS_WATCH = "previous-watch";
/** The release run's job that dispatches the watch run. */
export const WATCH_DISPATCH = "watch";
/** The watch workflow's run name: `watch release-<n>`. */
export const WATCH_WORKFLOW = "release-watch";

/** `watch release-349` → 349. */
export function watchRunNumber(run: Pick<GitHubRun, "display_title"> & { readonly name?: string }): number | null {
  const match = /^watch release-(\d+)$/.exec((run.display_title ?? run.name ?? "").trim());
  return match ? Number(match[1]) : null;
}

/** `images-vms / build-push (vms-api, …)` → `vms-api`; `build-push-api` → `api`; else the workflow. */
export function imageName(name: string): string | null {
  const [prefix, rest] = splitJobName(name);
  if (!prefix.startsWith("images-") || rest === null || !/^build-push/.test(rest)) return null;
  const argument = /\(([^,)]+)/.exec(rest)?.[1]?.trim();
  if (argument) return argument;
  const suffix = /^build-push-([\w.-]+)/.exec(rest)?.[1];
  return suffix ?? prefix.slice("images-".length);
}

function splitJobName(name: string): [string, string | null] {
  const at = name.indexOf(" / ");
  return at < 0 ? [name.trim(), null] : [name.slice(0, at).trim(), name.slice(at + 3).trim()];
}

export function jobState(job: Pick<GitHubJob, "status" | "conclusion">): JobState {
  if (job.status === "in_progress") return "running";
  if (job.status === "pending" || job.status === "waiting") return "waiting";
  if (job.status !== "completed") return "queued";
  if (job.conclusion === "success" || job.conclusion === "neutral") return "success";
  if (job.conclusion === "skipped") return "skipped";
  if (job.conclusion === "cancelled") return "cancelled";
  return "failure";
}

/** A job of the release run, or of its watch run (every job there is the watch step). */
export function toJob(job: GitHubJob, run: "release" | "watch" = "release"): Job {
  return {
    id: job.id,
    name: job.name,
    step: run === "watch" ? "watch" : classifyJob(job.name),
    image: imageName(job.name),
    state: jobState(job),
    runner: job.runner_name || null,
    labels: [...(job.labels ?? [])],
    startedAt: job.started_at,
    completedAt: job.completed_at,
    url: job.html_url ?? null,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function time(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** The later of two timestamps (`a` when `b` is missing or unreadable). */
function latest(a: string, b: string | null): string {
  const later = time(b);
  return later !== null && later > (time(a) ?? -Infinity) ? b! : a;
}

/** One step from its jobs. `runDone`: a step with no job left to appear is skipped, not pending. */
export function buildStep(id: StepId, jobs: readonly Job[], runDone: boolean, now: Date, attemptStart: string | null = null): Step {
  const live = jobs.filter((job) => job.step === id && job.state !== "skipped");
  const failed = live.find((job) => job.state === "failure");
  // GitHub retains successful jobs from earlier attempts when rerunning failures.
  const attemptMs = time(attemptStart);
  const current = attemptMs === null ? live : live.filter((job) => {
    const start = time(job.startedAt);
    return start !== null && start >= attemptMs;
  });
  const timed = current.length ? current : live;
  // A queued or waiting job's `started_at` is when it was queued: only jobs that ran start the step.
  const starts = timed
    .filter((job) => job.state !== "queued" && job.state !== "waiting")
    .map((job) => time(job.startedAt))
    .filter((ms): ms is number => ms !== null);
  const startedMs = starts.length ? Math.min(...starts) : null;
  let state: StepState;
  if (live.length === 0) state = runDone ? "skipped" : "pending";
  else if (failed) state = "failed";
  else if (live.every((job) => job.state === "success")) state = "done";
  else if (live.some((job) => job.state === "running") || (live.some((job) => job.state === "success") && !runDone))
    state = "running";
  else if (live.some((job) => job.state === "cancelled")) state = "cancelled";
  else state = runDone ? "cancelled" : "pending";
  const finished = state === "done" || state === "failed" || state === "cancelled";
  const ends = timed.map((job) => time(job.completedAt)).filter((ms): ms is number => ms !== null);
  const completedMs = finished && ends.length ? Math.max(...ends) : null;
  const images = id === "images";
  return {
    id,
    state,
    done: images ? live.filter((job) => job.state === "success").length : null,
    total: images ? live.length : null,
    startedAt: startedMs === null ? null : iso(startedMs),
    completedAt: completedMs === null ? null : iso(completedMs),
    durationMs: startedMs === null ? null : Math.max(0, (completedMs ?? now.getTime()) - startedMs),
    failedJob: failed?.name ?? null,
  };
}

// ── Verdict ─────────────────────────────────────────────────────────────────────────────────

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The watch's revert (`rollback.outcome: reverted`), or null when it did not revert. */
export function noteRevert(note: Note): Release["revert"] {
  const rollback = record(note.rollback);
  if (rollback?.["outcome"] !== "reverted") return null;
  return {
    commits: strings(rollback["commits"]),
    commit: typeof rollback["commit"] === "string" ? (rollback["commit"] as string) : null,
  };
}

/** The note's rollback for the UI; `frozen` follows `scripts/release_freeze.py` (`is_frozen`). */
export function noteRollback(note: Note): Release["rollback"] {
  const rollback = record(note.rollback);
  if (!rollback) return null;
  return {
    outcome: typeof rollback["outcome"] === "string" ? (rollback["outcome"] as string) : "pending",
    target: typeof rollback["target"] === "string" ? (rollback["target"] as string) : null,
    frozen: !note.resolvedBy && note.drill !== true,
  };
}

/** Health sources of the note's verdict (`verdict.sources`), red first. */
export function noteSignals(note: Note): Signal[] {
  const sources = record(record(note.verdict)?.["sources"]);
  if (!sources) return [];
  const rank = (outcome: string) => (outcome === "red" ? 0 : outcome === "green" || outcome === "not-applicable" ? 2 : 1);
  return Object.entries(sources)
    .map(([source, value]) => {
      const fields = record(value) ?? {};
      return {
        source,
        label: SOURCE_LABELS[source] ?? source,
        outcome: typeof fields["outcome"] === "string" ? (fields["outcome"] as string) : "unknown",
        reason: typeof fields["reason"] === "string" ? (fields["reason"] as string) : null,
      };
    })
    .sort((a, b) => rank(a.outcome) - rank(b.outcome) || a.source.localeCompare(b.source));
}

export interface VerdictInput {
  readonly completed: boolean;
  readonly conclusion: string | null;
  readonly steps: readonly Step[];
  readonly jobs: readonly Job[];
  readonly note: Note | null;
}

/**
 * The vigia mapping. An incident note exists only on red: `rollback.outcome` reverted → reverted,
 * any other → red. Without a note: an earlier step failed → failed; the watch passed → green; the
 * watch ended otherwise (failed or cancelled) → inconclusive; a cancelled run → cancelled; only
 * `plan` ran → none.
 */
export function watchVerdict(input: VerdictInput): Verdict | null {
  if (input.note) return noteRevert(input.note) ? "reverted" : "red";
  if (!input.completed) return null;
  if (input.steps.some((step) => step.id !== "watch" && step.state === "failed")) return "failed";
  const watch = input.jobs.find((job) => job.step === "watch" && job.state !== "skipped");
  if (watch?.state === "success") return "green";
  // Published but not judged: a failed watch without a note, or a cancelled one.
  if (watch?.state === "failure" || watch?.state === "cancelled") return "inconclusive";
  if (input.conclusion === "cancelled") return "cancelled";
  if (!input.jobs.some((job) => job.step !== null && job.state !== "skipped")) return "none";
  return input.conclusion === "success" ? "none" : watch ? "inconclusive" : "failed";
}

// ── Release ─────────────────────────────────────────────────────────────────────────────────

export function releaseNameOf(runNumber: number): string {
  return `release-${runNumber}`;
}

function firstLine(message: string | undefined): string {
  return (message ?? "").split("\n")[0]!.trim();
}

function toSession(ref: SessionRef): Session {
  return { harness: ref.harness, host: ref.host, id: ref.id };
}

export interface ReleaseInput {
  readonly run: GitHubRun;
  readonly jobs: readonly GitHubJob[];
  /** The release-watch note of `release-<run number>`, if any. */
  readonly note: Note | null;
  /** Commits since the previous release tag, oldest first (`compare`); null when unknown. */
  readonly commits: readonly GitHubCommit[] | null;
  /** Tag `release-<run number>` exists (the jobs may be older than the tag listing). */
  readonly tagged?: boolean;
  /** Calls this host delivered for the release's incident (`readHandoffs`), any order. */
  readonly handoffs?: readonly Handoff[];
  /** The `watch release-<n>` run of release-watch.yml and its jobs, once dispatched and listed. */
  readonly watch?: { readonly run: GitHubRun; readonly jobs: readonly GitHubJob[] } | null;
  readonly now: Date;
}

/** A dispatched watch may take this long to show up in the runs list before the release ends without it. */
export const WATCH_DISPATCH_GRACE_MS = 10 * 60 * 1000;

const NOT_STARTED = new Set<JobState>(["queued", "waiting"]);

/**
 * Delivered calls oldest first, then the note's owner and notified sessions; one entry per session.
 * Without an incident note only the `blocked` call of a run that failed before the tag (a drill's
 * calls stay out: they write no handoff).
 */
export function releaseHandoffs(note: Note | null, delivered: readonly Handoff[]): Handoff[] {
  if (!note) return delivered.filter((handoff) => handoff.role === "blocked");
  const out: Handoff[] = [];
  const add = (role: HandoffRole, ref: SessionRef | null, at: string | null) => {
    if (ref && !out.some((known) => sameSession(known.session, ref))) out.push({ role, session: toSession(ref), at });
  };
  const ordered = [...delivered].sort((a, b) => (time(a.at) ?? 0) - (time(b.at) ?? 0));
  for (const handoff of ordered) add(handoff.role, handoff.session, handoff.at);
  add("owner", toSessionRef(note.owner), null);
  for (const entry of note.notified ?? []) add("notified", toSessionRef(entry), null);
  return out;
}

export function buildRelease(input: ReleaseInput): Release {
  const { run, note, now } = input;
  const watchRun = input.watch?.run ?? null;
  const jobs = [...input.jobs.map((job) => toJob(job)), ...(input.watch?.jobs ?? []).map((job) => toJob(job, "watch"))];
  // The release run ends at the dispatch; the release goes on until its watch run ends.
  const dispatch = jobs.find((job) => job.name === WATCH_DISPATCH && job.step === "tag");
  const dispatchedAt = time(dispatch?.state === "success" ? dispatch.completedAt : null);
  const watchOpen = watchRun
    ? watchRun.status !== "completed"
    : dispatchedAt !== null && now.getTime() - dispatchedAt < WATCH_DISPATCH_GRACE_MS;
  const completed = run.status === "completed" && !watchOpen;
  const started = run.status === "in_progress" || watchOpen || jobs.some((job) => !NOT_STARTED.has(job.state));
  const steps = STEP_IDS.map((id) => buildStep(id, jobs, completed, now, (run.run_attempt ?? 1) > 1 ? run.run_started_at ?? null : null));
  const verdict = watchVerdict({ completed, conclusion: run.conclusion, steps, jobs, note });
  const failed = jobs.find((job) => job.step !== null && job.step !== "watch" && job.state === "failure");
  const tagged = input.tagged === true || jobs.some((job) => job.step === "tag" && job.state === "success");
  const sessions: Session[] = [];
  const add = (ref: SessionRef | null) => {
    if (ref && !sessions.some((known) => sameSession(known, ref))) sessions.push(toSession(ref));
  };
  const trailers = (input.commits ?? []).map((commit) => parseAgentSession(commit.commit.message));
  for (const ref of trailers) add(ref);
  const head = run.head_commit?.message ?? "";
  const pusher = parseAgentSession(head) ?? [...trailers].reverse().find((ref) => ref !== null) ?? null;
  add(pusher);
  const current =
    completed ? null : (steps.find((step) => step.state === "running") ?? steps.find((step) => step.state === "pending"))?.id ?? null;
  return {
    number: run.run_number,
    name: releaseNameOf(run.run_number),
    runId: run.id,
    attempt: run.run_attempt ?? 1,
    url: run.html_url,
    status: completed ? "completed" : started ? "running" : "queued",
    conclusion: run.conclusion,
    event: run.event,
    headSha: run.head_sha,
    title: firstLine(head) || run.display_title || run.head_sha.slice(0, 9),
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    startedAt: run.run_started_at ?? null,
    completedAt: completed ? latest(run.updated_at, watchRun?.updated_at ?? null) : null,
    steps,
    current,
    verdict,
    tag: tagged ? releaseNameOf(run.run_number) : null,
    failedJob: failed ? { name: failed.name, url: failed.url } : null,
    revert: note ? noteRevert(note) : null,
    signals: note ? noteSignals(note) : [],
    rollback: note ? noteRollback(note) : null,
    recallFailed: note ? record(note.recall) !== null : false,
    pusher: pusher ? toSession(pusher) : null,
    sessions,
    handoffs: releaseHandoffs(note, input.handoffs ?? []),
    jobs,
  };
}

const GENERIC_LABELS = new Set(["self-hosted", "linux", "x64", "amd64", "arm64"]);

export function toRunner(runner: GitHubRunner, releases: readonly Release[]): Runner {
  const running = releases
    .flatMap((release) => release.jobs)
    .find((job) => job.state === "running" && job.runner === runner.name);
  return {
    id: runner.id,
    name: runner.name,
    online: runner.status === "online",
    busy: runner.busy,
    labels: (runner.labels ?? []).map((label) => label.name),
    job: running?.name ?? null,
  };
}

export interface SnapshotInput {
  readonly repository: string;
  readonly workflow: string;
  readonly releases: readonly Release[];
  readonly runners: readonly GitHubRunner[];
  readonly now: Date;
  readonly error?: string | null;
}

/** Self-hosted runners only: the hosted pools (Blacksmith) never queue release jobs here. */
export function buildSnapshot(input: SnapshotInput): ReleaseSnapshot {
  const releases = [...input.releases].sort((a, b) => b.number - a.number).slice(0, RELEASE_HISTORY);
  const active = releases.filter((release) => release.status !== "completed");
  return {
    version: 1,
    repository: input.repository,
    workflow: input.workflow,
    fetchedAt: input.now.toISOString(),
    releases,
    runners: input.runners
      .filter((runner) => (runner.labels ?? []).some((label) => label.name === "self-hosted"))
      .map((runner) => toRunner(runner, active))
      .sort((a, b) => a.name.localeCompare(b.name)),
    queued: active.flatMap((release) =>
      release.jobs
        .filter((job) => job.state === "queued")
        .map((job) => ({ name: job.name, runNumber: release.number, labels: job.labels })),
    ),
    error: input.error ?? null,
  };
}

// ── Selectors for the surfaces ──────────────────────────────────────────────────────────────

export function isActive(release: Release): boolean {
  return release.status !== "completed";
}

/** Where an active release is: moving through verify→tag, judged by its watch run, or queued. */
export type ReleasePhase = "pipeline" | "watch" | "queued";

export function releasePhase(release: Release): ReleasePhase {
  if (release.status === "queued") return "queued";
  return release.current === "watch" ? "watch" : "pipeline";
}

const PHASE_ORDER: Record<ReleasePhase, number> = { pipeline: 0, watch: 1, queued: 2 };

/**
 * Releases in flight, the one in focus first: the run moving through verify→tag (closest to
 * production), then the open watches, then the runs queued on release-production; oldest first
 * within each phase (it gets there first).
 */
export function activeReleases(snapshot: ReleaseSnapshot): Release[] {
  return snapshot.releases
    .filter(isActive)
    .sort((a, b) => PHASE_ORDER[releasePhase(a)] - PHASE_ORDER[releasePhase(b)] || a.number - b.number);
}

/** Other releases in flight besides `release`, in focus order. */
export function otherActive(snapshot: ReleaseSnapshot, release: Release): Release[] {
  return activeReleases(snapshot).filter((other) => other.runId !== release.runId);
}

/** The newest active release below `release` in `phase`. */
function ahead(snapshot: ReleaseSnapshot, release: Release, phase: ReleasePhase): Release | null {
  return (
    snapshot.releases
      .filter((other) => isActive(other) && other.number < release.number && releasePhase(other) === phase)
      .sort((a, b) => b.number - a.number)[0] ?? null
  );
}

/**
 * What holds an active release, pt-BR: the run ahead on release-production (`na fila · atrás de
 * #348`), or the previous release's watch holding the publication (`esperando o vigia de #347`).
 * Null when nothing holds it (a job waiting for a runner shows in the runner queue).
 */
export function waitingFor(snapshot: ReleaseSnapshot, release: Release): string | null {
  if (!isActive(release)) return null;
  if (releasePhase(release) === "queued") {
    const holder = ahead(snapshot, release, "pipeline");
    return holder ? `na fila · atrás de #${holder.number}` : "na fila";
  }
  if (release.jobs.some((job) => job.name === PREVIOUS_WATCH && job.step === "deploy" && job.state === "waiting")) {
    const watch = ahead(snapshot, release, "watch");
    return watch ? `esperando o vigia de #${watch.number}` : "esperando o vigia anterior";
  }
  return null;
}

/** One line for a release in the "também em andamento" list: `imagens 3/9`, `vigia aberto`, `na fila · atrás de #348`. */
export function activityLabel(snapshot: ReleaseSnapshot, release: Release): string {
  const phase = releasePhase(release);
  if (phase === "watch") return "vigia aberto";
  const step = release.current ? stepOf(release, release.current) : null;
  // A job running says more than the wait ahead (`verificação` before `esperando o vigia de #347`).
  const moving = phase === "pipeline" && release.jobs.some((job) => job.state === "running");
  const waiting = moving ? null : waitingFor(snapshot, release);
  return waiting ?? (step ? stepLabel(step) : "em andamento");
}

/** A finished run that published nothing: cancelled by a newer push, or a no-op (flux-only push). */
export function isSuperseded(release: Release): boolean {
  return !isActive(release) && (release.verdict === "cancelled" || release.verdict === "none");
}

/** Newest finished release that published or tried to (not cancelled, not a no-op). */
export function lastFinished(snapshot: ReleaseSnapshot): Release | null {
  return snapshot.releases.find((release) => !isActive(release) && !isSuperseded(release)) ?? null;
}

/** What the sidebar row shows: the release in focus (`activeReleases`), else the last verdict while still recent. */
export function footerRelease(snapshot: ReleaseSnapshot, now: Date): Release | null {
  const active = activeReleases(snapshot);
  if (active.length) return active[0]!;
  const last = lastFinished(snapshot);
  const ended = time(last?.completedAt ?? null);
  return last && ended !== null && now.getTime() - ended <= RECENT_VERDICT_MS ? last : null;
}

/** The release a session has a commit in: an active one, else the last finished one. */
export function releaseForSession(snapshot: ReleaseSnapshot, session: SessionRef): Release | null {
  const candidates = [...activeReleases(snapshot)];
  const last = lastFinished(snapshot);
  if (last) candidates.push(last);
  return candidates.find((release) => release.sessions.some((known) => sameSession(known, session))) ?? null;
}

export function findRelease(snapshot: ReleaseSnapshot, number: number): Release | null {
  return snapshot.releases.find((release) => release.number === number) ?? null;
}

/** Time zone of the release labels: the team's (Brazil has kept UTC−3 all year since 2019). */
export const RELEASE_TIME_ZONE = "America/Sao_Paulo";
const RELEASE_TIME_ZONE_OFFSET_MS = -3 * 60 * 60 * 1000;

let zoned: Intl.DateTimeFormat | null | undefined;

/** The zone formatter, or null where the runtime ignores `timeZone` (some mobile engines). */
function zonedFormat(): Intl.DateTimeFormat | null {
  if (zoned !== undefined) return zoned;
  try {
    const format = new Intl.DateTimeFormat("en-GB", {
      timeZone: RELEASE_TIME_ZONE,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    zoned = format.resolvedOptions().timeZone === RELEASE_TIME_ZONE && typeof format.formatToParts === "function" ? format : null;
  } catch {
    zoned = null;
  }
  return zoned;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `28/10 14:49` in America/Sao_Paulo, or "" for a missing or bad timestamp. */
export function releaseStamp(at: string | null): string {
  const ms = time(at);
  if (ms === null) return "";
  const format = zonedFormat();
  if (format) {
    const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
    if (parts["day"] && parts["month"] && parts["hour"] && parts["minute"]) {
      return `${parts["day"]}/${parts["month"]} ${parts["hour"]}:${parts["minute"]}`;
    }
  }
  const local = new Date(ms + RELEASE_TIME_ZONE_OFFSET_MS);
  return `${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/**
 * The one name every surface shows: `#190 28/10 14:49`, the run number (the N of tag
 * `release-N`) and when the run started. `#190` alone when the time is unknown. The tag step keeps
 * showing the tag itself (`release-190`).
 */
export function releaseLabel(release: Pick<Release, "number" | "startedAt" | "createdAt">): string {
  const stamp = releaseStamp(release.startedAt ?? release.createdAt);
  return stamp ? `#${release.number} ${stamp}` : `#${release.number}`;
}

/** 0..1 for the progress ring: finished steps plus the images fraction. */
export function progress(release: Release): number {
  if (!isActive(release)) return 1;
  let sum = 0;
  for (const step of release.steps) {
    if (step.state === "done" || step.state === "skipped") sum += 1;
    else if (step.state === "running") sum += step.total ? (step.done ?? 0) / step.total : 0.5;
  }
  return Math.min(1, sum / release.steps.length);
}

export function stepOf(release: Release, id: StepId): Step {
  return release.steps.find((step) => step.id === id)!;
}

/** `imagens 3/9`, `vigia`, … */
export function stepLabel(step: Step): string {
  const label = STEP_LABELS[step.id];
  return step.total !== null && step.total > 0 ? `${label} ${step.done ?? 0}/${step.total}` : label;
}

/** Composer pill text: `#172 27/10 11:24 · imagens 3/9` while active, `#172 27/10 11:24 · verde` after. */
export function pillLabel(release: Release): string {
  if (isActive(release)) {
    const step = release.current ? stepOf(release, release.current) : null;
    return step ? `${releaseLabel(release)} · ${stepLabel(step)}` : releaseLabel(release);
  }
  return release.verdict ? `${releaseLabel(release)} · ${VERDICT_LABELS[release.verdict]}` : releaseLabel(release);
}

/** Total run time: start → end, or → now while active. */
export function releaseDurationMs(release: Release, now: Date): number | null {
  const start = time(release.startedAt ?? release.createdAt);
  if (start === null) return null;
  return Math.max(0, (time(release.completedAt) ?? now.getTime()) - start);
}

/** `36s`, `24m 08s`, `1h 04m`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Short form for compact chips: `24m`, `1h 04m`, `36s`. */
export function formatShortDuration(ms: number | null): string {
  if (ms === null) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `há 36 min`, `há 2 h`, `há 3 d`. */
export function formatAgo(at: string | null, now: Date): string {
  const ms = time(at);
  if (ms === null) return "";
  const minutes = Math.max(0, Math.round((now.getTime() - ms) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} d`;
}

/** The runner label a job needs beyond the generic ones (`solid-srv`, `blacksmith-2vcpu-…`). */
export function runnerLabel(labels: readonly string[]): string | null {
  return labels.find((label) => !GENERIC_LABELS.has(label.toLowerCase())) ?? null;
}

export interface QueueGroup {
  readonly label: string;
  readonly count: number;
  /** Self-hosted runners carrying the label. */
  readonly runners: readonly Runner[];
}

/** Queued jobs grouped by the runner label they wait for, largest first. */
export function queueGroups(snapshot: ReleaseSnapshot): QueueGroup[] {
  const counts = new Map<string, number>();
  for (const job of snapshot.queued) {
    const label = runnerLabel(job.labels) ?? "?";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count, runners: snapshot.runners.filter((runner) => runner.labels.includes(label)) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** `6 na fila — runner solid-srv ocupado`, or null with nothing queued. */
export function queueSummary(snapshot: ReleaseSnapshot): string | null {
  const groups = queueGroups(snapshot);
  if (!groups.length) return null;
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const top = groups[0]!;
  const runner = top.runners[0];
  if (!runner) return `${total} na fila`;
  const why = !runner.online ? "offline" : runner.busy ? "ocupado" : "ocioso";
  return `${total} na fila — runner ${runner.name} ${why}`;
}

/** How the watch's rollback ended, in pt-BR (`vigia reverteu no dbolt-deploy`, `rollback impedido`). */
export function rollbackLabel(release: Release): string | null {
  const rollback = release.rollback;
  if (!rollback) return null;
  switch (rollback.outcome) {
    case "reverted":
      return rollback.target === "main" ? "vigia reverteu as flags na main" : "vigia reverteu no dbolt-deploy";
    case "blocked":
      return "rollback impedido";
    case "failed":
      return "rollback falhou";
    case "none":
      return "nada a reverter";
    default:
      return "rollback em andamento";
  }
}

/** `main congelada` while the note freezes main, else null. */
export function freezeLabel(release: Release): string | null {
  return release.rollback?.frozen ? "main congelada" : null;
}

/** Whether the incident's owner was told: `agente avisado`, `aviso ao agente falhou`, `sem dono`. */
function noticeLabel(release: Release): string {
  if (release.recallFailed) return "aviso ao agente falhou";
  return release.handoffs.some((handoff) => handoff.role === "owner") ? "agente avisado" : "sem dono";
}

/** `vigia reverteu no dbolt-deploy · main congelada · agente avisado` for reverted releases. */
export function revertSummary(release: Release): string | null {
  if (release.verdict !== "reverted") return null;
  return [rollbackLabel(release) ?? "vigia reverteu", freezeLabel(release), noticeLabel(release)].filter(Boolean).join(" · ");
}

/** Signals the watch tripped on (`5xx · errors5xx-ratio`). */
export function trippedSignals(release: Release): Signal[] {
  return release.signals.filter((signal) => signal.outcome === "red");
}

/** pt-BR detail line for a finished release (history table, banners). */
export function verdictDetail(release: Release): string {
  switch (release.verdict) {
    case "reverted":
      return revertSummary(release) ?? "";
    case "red": {
      const tripped = trippedSignals(release).map((signal) => signal.label);
      const head = tripped.length ? `vigia vermelho · ${tripped.join(", ")}` : "vigia vermelho";
      return [head, rollbackLabel(release), freezeLabel(release)].filter(Boolean).join(" · ");
    }
    case "failed":
      return release.failedJob ? `${release.failedJob.name} falhou` : "falhou";
    case "green":
      return "vigia sem regressão";
    case "inconclusive":
      return "vigia sem veredito";
    case "cancelled":
      return "cancelado (substituído por um push mais novo)";
    case "none":
      return "nada a publicar";
    default:
      return "";
  }
}

/** The image chips of the images step, in job order. */
export function imageJobs(release: Release): Job[] {
  return release.jobs.filter((job) => job.step === "images" && job.state !== "skipped");
}

/** Job names of a step, deduped (`check · scanners`); the watch's gate and dispatch are not tiers. */
export function stepJobNames(release: Release, id: StepId): string[] {
  const names = release.jobs
    .filter((job) => job.step === id && job.state !== "skipped" && (id === "watch" || (job.name !== PREVIOUS_WATCH && job.name !== WATCH_DISPATCH)))
    .map((job) => {
      const [prefix, rest] = splitJobName(job.name);
      if (id === "images") return job.image ?? job.name;
      return id === "deploy" ? prefix : (rest ?? job.name);
    });
  return [...new Set(names)];
}
