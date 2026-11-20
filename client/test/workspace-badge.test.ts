import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMergeQueue } from "../../shared/queue-status.ts";
import { watchTone, visibleSteps } from "../../shared/release-copy.ts";
import { buildRelease, buildSnapshot } from "../../shared/release-status.ts";
import type { ReleaseView } from "../../shared/rpc.ts";
import { NOW } from "../../core/test/fakes.ts";
import { commit, job, midImages, minutesAgo, run, RUNNERS } from "../../core/test/releases.ts";
import type { Note } from "../../shared/types.ts";
import { selectWorkspaceRowBadge } from "../workspace-badge-model.ts";

const HOST = "srv_X";

test("selectWorkspaceRowBadge: release ativa vence fila; fila vence release terminada; PR fora da fila não duplica", () => {
  const queue = buildMergeQueue({
    pulls: [
      {
        number: 229,
        title: "merge queue: checking #228 on main (4c05022)",
        html_url: "https://gh/pr/229",
        draft: true,
        created_at: minutesAgo(5),
        updated_at: minutesAgo(1),
        head: { ref: "mergify/merge-queue/abc", sha: "sha229" },
        labels: [],
      },
      {
        number: 228,
        title: "MVP C",
        html_url: "https://gh/pr/228",
        draft: false,
        created_at: minutesAgo(20),
        updated_at: minutesAgo(2),
        head: { ref: "mvp/c-historico-handoff", sha: "sha228" },
        labels: [{ name: "queue" }, { name: "queued" }],
      },
      {
        number: 226,
        title: "Deps",
        html_url: "https://gh/pr/226",
        draft: false,
        created_at: minutesAgo(15),
        updated_at: minutesAgo(1),
        head: { ref: "chore/deps-infra-upgrades", sha: "sha226" },
        labels: [{ name: "queue" }, { name: "queued" }],
      },
      {
        number: 231,
        title: "Open only",
        html_url: "https://gh/pr/231",
        draft: true,
        created_at: minutesAgo(5),
        updated_at: minutesAgo(1),
        head: { ref: "feat/open-only", sha: "sha231" },
        labels: [],
      },
    ],
    ciRuns: [
      { id: 1, head_branch: "mergify/merge-queue/abc", head_sha: "sha229", status: "in_progress", conclusion: null, html_url: "https://gh/run/1", created_at: minutesAgo(4) },
    ],
    jobsByRunId: new Map([
      [1, [{ name: "tests", status: "in_progress", conclusion: null }, { name: "windows", status: "completed", conclusion: "success" }]],
    ]),
  });

  const activeRelease = buildRelease({
    run: run({ run_number: 702, head_commit: null }),
    jobs: midImages(),
    note: null,
    commits: [commit("c1", "feat: live", "paseo/srv_X/agent-live")],
    now: NOW,
  });
  const inconclusiveNote = {
    release: "release-699",
    updatedAt: minutesAgo(10),
    verdict: { verdict: "inconclusive", sources: {}, at: minutesAgo(10) },
  } as unknown as Note;
  const inconclusiveRelease = buildRelease({
    run: run({ run_number: 699, status: "completed", conclusion: "success", head_commit: null, updated_at: minutesAgo(10) }),
    jobs: [
      job("images / shard 0", "success", [15, 12]),
      job("pins", "success", [12, 11]),
      job("release-tag", "success", [11, 10.5]),
    ],
    note: inconclusiveNote,
    commits: [commit("c2", "fix: ci", "paseo/srv_X/agent-699")],
    now: NOW,
  });

  assert.equal(watchTone(inconclusiveRelease), "muted", "vigia inconclusivo nunca pinta de verde");
  assert.deepEqual(
    visibleSteps(inconclusiveRelease).map((step) => step.id),
    ["images", "deploy", "tag", "watch"],
    "verify pulada fora do workflow atual some da barra",
  );

  const snapshot = buildSnapshot({
    repository: "dboltbr/dbolt",
    workflow: "release",
    releases: [activeRelease, inconclusiveRelease],
    runners: RUNNERS,
    queue,
    now: NOW,
  });

  const view: ReleaseView = {
    host: HOST,
    snapshot,
    agents: [
      { id: "agent-live", title: "Live", workspaceId: "wks-live", openCodeSession: null },
      { id: "agent-699", title: "699", workspaceId: "wks-699", openCodeSession: null },
    ],
  };

  assert.deepEqual(selectWorkspaceRowBadge(view, "wks-live", "chore/deps-infra-upgrades", NOW), {
    icon: "Rocket",
    label: "#702 · img 3/9",
    tone: "info",
  });
  assert.deepEqual(selectWorkspaceRowBadge(view, "wks-228", "mvp/c-historico-handoff", NOW), {
    icon: "GitMerge",
    label: "queue 1/2",
    tone: "info",
  });
  assert.deepEqual(selectWorkspaceRowBadge(view, "wks-226", "chore/deps-infra-upgrades", NOW), {
    icon: "Clock",
    label: "fila #2",
    tone: "info",
  });
  assert.deepEqual(selectWorkspaceRowBadge(view, "wks-699", "main", NOW), {
    icon: "Rocket",
    label: "#699 · inconclusivo",
    tone: "muted",
  });
  assert.equal(selectWorkspaceRowBadge(view, "wks-open", "feat/open-only", NOW), null);
});
