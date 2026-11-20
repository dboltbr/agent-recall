import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMergeQueue,
  hasActiveQueueWork,
  MergeQueueSnapshotSchema,
  parseBatchName,
  parseBatchPrNumbers,
  prForBranch,
  prPillLabel,
  prRowBadge,
  queuedPrs,
  queueFooterLabel,
  type GitHubCiJob,
  type GitHubCiRun,
  type GitHubPullRequest,
} from "../queue-status.ts";

function pr(partial: Partial<GitHubPullRequest> & { number: number; ref: string }): GitHubPullRequest {
  return {
    number: partial.number,
    title: partial.title ?? `PR ${partial.number}`,
    html_url: partial.html_url ?? `https://github.com/dboltbr/dbolt/pull/${partial.number}`,
    draft: partial.draft ?? false,
    created_at: partial.created_at ?? "2026-11-20T19:00:00Z",
    updated_at: partial.updated_at ?? "2026-11-20T19:10:00Z",
    body: partial.body ?? null,
    head: partial.head ?? { ref: partial.ref, sha: `sha${partial.number}` },
    labels: partial.labels ?? [],
  };
}

test("parseBatchPrNumbers e parseBatchName leem o PR draft do Mergify", () => {
  assert.deepEqual(parseBatchPrNumbers("merge queue: checking #228, #226 on main (4c05022)"), [228, 226]);
  assert.deepEqual(
    parseBatchPrNumbers("merge queue draft", "Mergify opened it for batch **red-brie-kmu38t** of the `default` queue, to test [#228](/dboltbr/dbolt/pull/228).\n\nOther #999"),
    [228],
  );
  assert.equal(parseBatchName("Mergify opened it for batch **red-brie-kmu38t** of the `default` queue"), "red-brie-kmu38t");
});

test("buildMergeQueue: batch em ci-queue, fila ordenada, ejetado, aguardando e PR aberto", () => {
  const pulls: GitHubPullRequest[] = [
    pr({
      number: 229,
      ref: "mergify/merge-queue/d3f8842323",
      draft: true,
      title: "merge queue: checking #228 on main (4c05022)",
      body: "Mergify opened it for batch **red-brie-kmu38t** of the `default` queue",
    }),
    pr({ number: 228, ref: "mvp/c-historico-handoff", labels: [{ name: "queue" }, { name: "queued" }], updated_at: "2026-11-20T19:05:00Z" }),
    pr({ number: 226, ref: "chore/deps-infra-upgrades", labels: [{ name: "queue" }, { name: "queued" }], updated_at: "2026-11-20T19:08:00Z" }),
    pr({ number: 177, ref: "fix/eng-743-icone", labels: [{ name: "queue" }] }),
    pr({ number: 145, ref: "fix/eng-659", labels: [{ name: "queue" }, { name: "dequeued" }] }),
    pr({ number: 231, ref: "feat/eng-650-falar-portaria", draft: true }),
  ];
  const ciRuns: GitHubCiRun[] = [
    { id: 100, head_branch: "mergify/merge-queue/d3f8842323", head_sha: "sha229", status: "in_progress", conclusion: null, html_url: "https://gh/run/100", created_at: "2026-11-20T19:10:00Z" },
    { id: 101, head_branch: "chore/deps-infra-upgrades", head_sha: "sha226", status: "completed", conclusion: "success", html_url: "https://gh/run/101", created_at: "2026-11-20T19:09:00Z" },
    { id: 102, head_branch: "fix/eng-743-icone", head_sha: "sha177", status: "completed", conclusion: "failure", html_url: "https://gh/run/102", created_at: "2026-11-20T19:02:00Z" },
    { id: 103, head_branch: "feat/eng-650-falar-portaria", head_sha: "sha231", status: "in_progress", conclusion: null, html_url: "https://gh/run/103", created_at: "2026-11-20T19:12:00Z" },
  ];
  const jobsByRunId = new Map<number, GitHubCiJob[]>([
    [
      100,
      [
        { name: "changes", status: "completed", conclusion: "success" },
        { name: "windows (desktop)", status: "completed", conclusion: "success" },
        { name: "tests", status: "in_progress", conclusion: null },
        { name: "ci-pr", status: "completed", conclusion: "skipped" },
      ],
    ],
  ]);

  const queue = buildMergeQueue({ pulls, ciRuns, jobsByRunId });
  assert.deepEqual(MergeQueueSnapshotSchema.parse(JSON.parse(JSON.stringify(queue))), queue);
  assert.equal(queue.batches.length, 1);
  assert.equal(queue.batches[0]!.batchName, "red-brie-kmu38t");
  assert.equal(hasActiveQueueWork(queue), true);

  const checking = prForBranch(queue, "mvp/c-historico-handoff")!;
  assert.equal(checking.stage, "checking");
  assert.equal(checking.position, 1);
  assert.equal(checking.done, 2);
  assert.equal(checking.total, 3);
  assert.deepEqual(checking.runningJobs, ["tests"]);
  assert.deepEqual(prRowBadge(checking), { icon: "GitMerge", label: "queue 2/3", tone: "info" });
  assert.equal(prPillLabel(checking), "PR #228 · queue 2/3");

  const queued = prForBranch(queue, "chore/deps-infra-upgrades")!;
  assert.equal(queued.stage, "queued");
  assert.equal(queued.position, 2);
  assert.deepEqual(prRowBadge(queued), { icon: "Clock", label: "fila #2", tone: "info" });
  assert.equal(prPillLabel(queued), "PR #226 · fila #2");

  const waiting = prForBranch(queue, "fix/eng-743-icone")!;
  assert.equal(waiting.stage, "waiting");
  assert.deepEqual(prRowBadge(waiting), { icon: "CircleX", label: "fila · ci falhou", tone: "danger" });

  const dequeued = prForBranch(queue, "fix/eng-659")!;
  assert.equal(dequeued.stage, "dequeued");
  assert.deepEqual(prRowBadge(dequeued), { icon: "CircleAlert", label: "ejetado", tone: "danger" });

  const open = prForBranch(queue, "feat/eng-650-falar-portaria")!;
  assert.equal(open.stage, "open");
  assert.equal(prRowBadge(open), null, "PR fora da fila não duplica os checks nativos da sidebar");
  assert.equal(prPillLabel(open), "PR #231 · ci rodando");

  assert.deepEqual(
    queuedPrs(queue).map((item) => item.number),
    [228, 226, 177, 145],
  );
  assert.equal(queueFooterLabel(queue), "Fila · #228 2/3 +3");
});
