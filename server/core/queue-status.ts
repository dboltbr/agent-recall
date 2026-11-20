// Pull requests, Mergify merge queue batches and `ci.yml` runs for the repository.
// Pure: built from raw GitHub REST API JSON; synced to `server/core/` and `shared/`.
import { z } from "zod";

export const CI_WORKFLOW = "ci";
export const MERGIFY_BRANCH_PREFIX = "mergify/merge-queue/";

export const PrCiStateSchema = z.enum(["queued", "running", "success", "failure", "cancelled", "none"]);
export type PrCiState = z.infer<typeof PrCiStateSchema>;

export const QueueStageSchema = z.enum(["checking", "queued", "waiting", "dequeued", "open"]);
export type QueueStage = z.infer<typeof QueueStageSchema>;

export const CiJobStateSchema = z.enum(["queued", "running", "success", "failure", "cancelled", "skipped"]);
export type CiJobState = z.infer<typeof CiJobStateSchema>;

export const CiJobSchema = z.object({
  name: z.string(),
  state: CiJobStateSchema,
  url: z.string().nullable(),
});
export type CiJob = z.infer<typeof CiJobSchema>;

export const QueueBatchSchema = z.object({
  prNumber: z.number(),
  title: z.string(),
  branch: z.string(),
  headSha: z.string(),
  url: z.string(),
  prNumbers: z.array(z.number()),
  batchName: z.string().nullable(),
  ciState: PrCiStateSchema,
  runUrl: z.string().nullable(),
  done: z.number(),
  total: z.number(),
  runningJobs: z.array(z.string()),
  failedJob: z.string().nullable(),
  jobs: z.array(CiJobSchema),
});
export type QueueBatch = z.infer<typeof QueueBatchSchema>;

export const PullRequestStatusSchema = z.object({
  number: z.number(),
  title: z.string(),
  branch: z.string(),
  headSha: z.string(),
  url: z.string(),
  draft: z.boolean(),
  labels: z.array(z.string()),
  stage: QueueStageSchema,
  position: z.number().nullable(),
  batchPrNumber: z.number().nullable(),
  ciState: PrCiStateSchema,
  runUrl: z.string().nullable(),
  done: z.number(),
  total: z.number(),
  runningJobs: z.array(z.string()),
  failedJob: z.string().nullable(),
  jobs: z.array(CiJobSchema),
  updatedAt: z.string(),
});
export type PullRequestStatus = z.infer<typeof PullRequestStatusSchema>;

export const MergeQueueSnapshotSchema = z.object({
  batches: z.array(QueueBatchSchema),
  prs: z.array(PullRequestStatusSchema),
});
export type MergeQueueSnapshot = z.infer<typeof MergeQueueSnapshotSchema>;

export const EMPTY_MERGE_QUEUE: MergeQueueSnapshot = { batches: [], prs: [] };

// ── Raw GitHub shapes ────────────────────────────────────────────────────────────────────────

export interface GitHubPullRequest {
  readonly number: number;
  readonly title: string;
  readonly html_url: string;
  readonly draft?: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  readonly body?: string | null;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base?: { readonly ref?: string };
  readonly labels?: readonly { readonly name?: string }[];
}

export interface GitHubCiRun {
  readonly id: number;
  readonly head_branch: string | null;
  readonly head_sha: string;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly created_at: string;
}

export interface GitHubCiJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url?: string | null;
}

// ── Parsing & building ───────────────────────────────────────────────────────────────────────

export function isMergifyBatchBranch(branch: string): boolean {
  return branch.startsWith(MERGIFY_BRANCH_PREFIX);
}

/** Extracts `#228`, `#226` from a Mergify batch PR title (or body fallback), preserving order. */
export function parseBatchPrNumbers(title: string, body?: string | null): number[] {
  const numbers: number[] = [];
  const add = (text: string) => {
    for (const match of text.matchAll(/#(\d+)/g)) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value > 0 && !numbers.includes(value)) numbers.push(value);
    }
  };
  add(title);
  if (numbers.length === 0 && body) {
    // Only scan the opening note paragraph so unrelated PR links in commit bodies are ignored.
    const head = body.split("\n\n")[0] ?? body;
    add(head);
  }
  return numbers;
}

/** Extracts `red-brie-kmu38t` from `for batch **red-brie-kmu38t**`. */
export function parseBatchName(body?: string | null): string | null {
  if (!body) return null;
  return /for batch \*\*([^*]+)\*\*/i.exec(body)?.[1]?.trim() ?? null;
}

export function ciRunState(run: Pick<GitHubCiRun, "status" | "conclusion"> | null | undefined): PrCiState {
  if (!run) return "none";
  if (run.status === "in_progress") return "running";
  if (run.status !== "completed") return "queued";
  if (run.conclusion === "success" || run.conclusion === "neutral" || run.conclusion === "skipped") return "success";
  if (run.conclusion === "cancelled") return "cancelled";
  return "failure";
}

function toCiJobState(job: Pick<GitHubCiJob, "status" | "conclusion">): CiJobState {
  if (job.status === "in_progress") return "running";
  if (job.status !== "completed") return "queued";
  if (job.conclusion === "success" || job.conclusion === "neutral") return "success";
  if (job.conclusion === "skipped") return "skipped";
  if (job.conclusion === "cancelled") return "cancelled";
  return "failure";
}

function summarizeJobs(rawJobs: readonly GitHubCiJob[] | undefined): {
  done: number;
  total: number;
  runningJobs: string[];
  failedJob: string | null;
  jobs: CiJob[];
} {
  if (!rawJobs?.length) return { done: 0, total: 0, runningJobs: [], failedJob: null, jobs: [] };
  const jobs: CiJob[] = [];
  for (const job of rawJobs) {
    const state = toCiJobState(job);
    if (state === "skipped") continue;
    jobs.push({ name: job.name, state, url: job.html_url ?? null });
  }
  const done = jobs.filter((job) => job.state === "success").length;
  const runningJobs = jobs.filter((job) => job.state === "running").map((job) => job.name);
  const failedJob = jobs.find((job) => job.state === "failure")?.name ?? null;
  return { done, total: jobs.length, runningJobs, failedJob, jobs };
}

/** Finds the newest `ci.yml` run matching `branch` + `headSha` (or `branch` fallback for Mergify). */
export function matchCiRun(runs: readonly GitHubCiRun[], branch: string, headSha: string, allowBranchFallback = false): GitHubCiRun | null {
  const exact = runs.find((run) => run.head_branch === branch && run.head_sha === headSha);
  if (exact) return exact;
  return allowBranchFallback ? (runs.find((run) => run.head_branch === branch) ?? null) : null;
}

export interface BuildMergeQueueInput {
  readonly pulls: readonly GitHubPullRequest[];
  readonly ciRuns: readonly GitHubCiRun[];
  readonly jobsByRunId?: ReadonlyMap<number, readonly GitHubCiJob[]>;
}

export function buildMergeQueue(input: BuildMergeQueueInput): MergeQueueSnapshot {
  const runs = [...input.ciRuns].sort((a, b) => b.id - a.id);
  const jobsByRunId = input.jobsByRunId ?? new Map<number, readonly GitHubCiJob[]>();
  const rawBatches: GitHubPullRequest[] = [];
  const rawPrs: GitHubPullRequest[] = [];
  for (const pr of input.pulls) {
    if (isMergifyBatchBranch(pr.head.ref)) rawBatches.push(pr);
    else rawPrs.push(pr);
  }
  rawBatches.sort((a, b) => a.number - b.number);
  const batches: QueueBatch[] = rawBatches.map((pr) => {
    const run = matchCiRun(runs, pr.head.ref, pr.head.sha, true);
    const summary = summarizeJobs(run ? jobsByRunId.get(run.id) : undefined);
    return {
      prNumber: pr.number,
      title: pr.title,
      branch: pr.head.ref,
      headSha: pr.head.sha,
      url: pr.html_url,
      prNumbers: parseBatchPrNumbers(pr.title, pr.body),
      batchName: parseBatchName(pr.body),
      ciState: ciRunState(run),
      runUrl: run?.html_url ?? null,
      ...summary,
    };
  });

  const batchByPr = new Map<number, QueueBatch>();
  for (const batch of batches) {
    for (const num of batch.prNumbers) {
      if (!batchByPr.has(num)) batchByPr.set(num, batch);
    }
  }

  // Assign queue positions: active batch PRs take the front, then `queued` PRs oldest-updated first.
  const queuedOrder = rawPrs
    .filter((pr) => !batchByPr.has(pr.number) && (pr.labels ?? []).some((label) => label.name === "queued"))
    .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.number - b.number);
  const queuedPositions = new Map<number, number>();
  const offset = batches.length > 0 ? batches.length : 0;
  queuedOrder.forEach((pr, index) => queuedPositions.set(pr.number, offset + index + 1));

  const prs: PullRequestStatus[] = rawPrs.map((pr) => {
    const labels = (pr.labels ?? []).map((label) => label.name ?? "").filter(Boolean);
    const batch = batchByPr.get(pr.number) ?? null;
    if (batch) {
      return {
        number: pr.number,
        title: pr.title,
        branch: pr.head.ref,
        headSha: pr.head.sha,
        url: pr.html_url,
        draft: pr.draft === true,
        labels,
        stage: "checking",
        position: 1,
        batchPrNumber: batch.prNumber,
        ciState: batch.ciState,
        runUrl: batch.runUrl,
        done: batch.done,
        total: batch.total,
        runningJobs: batch.runningJobs,
        failedJob: batch.failedJob,
        jobs: batch.jobs,
        updatedAt: pr.updated_at,
      };
    }
    const run = matchCiRun(runs, pr.head.ref, pr.head.sha);
    const summary = summarizeJobs(run ? jobsByRunId.get(run.id) : undefined);
    const hasQueue = labels.includes("queue");
    const hasQueued = labels.includes("queued");
    const hasDequeued = labels.includes("dequeued");
    const stage: QueueStage = hasDequeued ? "dequeued" : hasQueued ? "queued" : hasQueue ? "waiting" : "open";
    return {
      number: pr.number,
      title: pr.title,
      branch: pr.head.ref,
      headSha: pr.head.sha,
      url: pr.html_url,
      draft: pr.draft === true,
      labels,
      stage,
      position: queuedPositions.get(pr.number) ?? null,
      batchPrNumber: null,
      ciState: ciRunState(run),
      runUrl: run?.html_url ?? null,
      ...summary,
      updatedAt: pr.updated_at,
    };
  });

  return { batches, prs };
}

// ── Selectors & pt-BR copy ───────────────────────────────────────────────────────────────────

export function prForBranch(queue: MergeQueueSnapshot | null | undefined, branch: string | null | undefined): PullRequestStatus | null {
  if (!queue || !branch) return null;
  return queue.prs.find((pr) => pr.branch === branch) ?? null;
}

/** PRs currently in or waiting for the merge queue (checking, queued, waiting, dequeued). */
export function queuedPrs(queue: MergeQueueSnapshot | null | undefined): PullRequestStatus[] {
  if (!queue) return [];
  const rank: Record<QueueStage, number> = { checking: 0, queued: 1, waiting: 2, dequeued: 3, open: 4 };
  return queue.prs
    .filter((pr) => pr.stage !== "open")
    .sort((a, b) => rank[a.stage] - rank[b.stage] || (a.position ?? 999) - (b.position ?? 999) || a.number - b.number);
}

/** True while any merge queue batch is checking, any PR is queued, or any PR CI run is active. */
export function hasActiveQueueWork(queue: MergeQueueSnapshot | null | undefined): boolean {
  if (!queue) return false;
  if (queue.batches.length > 0) return true;
  return queue.prs.some(
    (pr) => pr.stage === "checking" || pr.stage === "queued" || pr.ciState === "running" || pr.ciState === "queued",
  );
}

export type BadgeTone = "muted" | "success" | "warning" | "danger" | "info";

export interface RowBadgeDescriptor {
  readonly icon: string;
  readonly label: string;
  readonly tone: BadgeTone;
}

/** Compact badge for Paseo's sidebar workspace meta row (`WorkspaceRowBadge`). Only merge-queue states. */
export function prRowBadge(pr: PullRequestStatus): RowBadgeDescriptor | null {
  switch (pr.stage) {
    case "checking":
      if (pr.ciState === "failure") return { icon: "CircleX", label: "queue falhou", tone: "danger" };
      if (pr.ciState === "success") return { icon: "GitMerge", label: "queue ok", tone: "success" };
      if (pr.total > 0) return { icon: "GitMerge", label: `queue ${pr.done}/${pr.total}`, tone: "info" };
      return { icon: "GitMerge", label: "ci-queue", tone: "info" };
    case "queued":
      return { icon: "Clock", label: pr.position ? `fila #${pr.position}` : "na fila", tone: "info" };
    case "dequeued":
      return { icon: "CircleAlert", label: "ejetado", tone: "danger" };
    case "waiting":
      if (pr.ciState === "failure") return { icon: "CircleX", label: "fila · ci falhou", tone: "danger" };
      if (pr.ciState === "running") return { icon: "Clock", label: "fila · ci-pr", tone: "warning" };
      return { icon: "Clock", label: "aguardando fila", tone: "warning" };
    case "open":
      return null;
  }
}

/** Composer pill / header button label for a PR. */
export function prPillLabel(pr: PullRequestStatus): string {
  switch (pr.stage) {
    case "checking":
      if (pr.ciState === "failure") return `PR #${pr.number} · queue falhou`;
      if (pr.ciState === "success") return `PR #${pr.number} · queue ok`;
      if (pr.total > 0) return `PR #${pr.number} · queue ${pr.done}/${pr.total}`;
      return `PR #${pr.number} · ci-queue`;
    case "queued":
      return pr.position ? `PR #${pr.number} · fila #${pr.position}` : `PR #${pr.number} · na fila`;
    case "dequeued":
      return `PR #${pr.number} · ejetado`;
    case "waiting":
      if (pr.ciState === "failure") return `PR #${pr.number} · ci-pr falhou`;
      if (pr.ciState === "running") return `PR #${pr.number} · ci-pr`;
      return `PR #${pr.number} · aguardando fila`;
    case "open":
      if (pr.ciState === "failure") return `PR #${pr.number} · ci falhou`;
      if (pr.ciState === "running") return `PR #${pr.number} · ci rodando`;
      if (pr.ciState === "queued") return `PR #${pr.number} · ci na fila`;
      if (pr.ciState === "success") return `PR #${pr.number} · ci ok`;
      return `PR #${pr.number}`;
  }
}

export function prStageBadge(pr: PullRequestStatus): { label: string; tone: "ok" | "bad" | "warn" | "run" | "muted" } {
  switch (pr.stage) {
    case "checking":
      if (pr.ciState === "failure") return { label: "queue falhou", tone: "bad" };
      if (pr.ciState === "success") return { label: "queue verde", tone: "ok" };
      return { label: "verificando na fila", tone: "run" };
    case "queued":
      return { label: pr.position ? `fila #${pr.position}` : "na fila", tone: "run" };
    case "dequeued":
      return { label: "ejetado da fila", tone: "bad" };
    case "waiting":
      if (pr.ciState === "failure") return { label: "ci-pr falhou", tone: "bad" };
      return { label: "aguardando fila", tone: "warn" };
    case "open":
      if (pr.ciState === "failure") return { label: "ci falhou", tone: "bad" };
      if (pr.ciState === "running" || pr.ciState === "queued") return { label: "ci em andamento", tone: "run" };
      if (pr.ciState === "success") return { label: "ci verde", tone: "ok" };
      return { label: pr.draft ? "rascunho" : "aberto", tone: "muted" };
  }
}

/** Short footer summary when there is no release in focus, e.g. `Fila · #228 verificando +1`. */
export function queueFooterLabel(queue: MergeQueueSnapshot | null | undefined): string | null {
  const active = queuedPrs(queue);
  if (!active.length) return null;
  const head = active[0]!;
  const extra = active.length > 1 ? ` +${active.length - 1}` : "";
  if (head.stage === "checking") {
    const prog = head.total > 0 ? ` ${head.done}/${head.total}` : "";
    return `Fila · #${head.number}${prog}${extra}`;
  }
  if (head.stage === "dequeued") return `Fila · #${head.number} ejetado${extra}`;
  return `Fila · #${head.number}${extra}`;
}
