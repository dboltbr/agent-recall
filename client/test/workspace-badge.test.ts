import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMergeQueue } from "../../shared/queue-status.ts";
import { deployChips, popoverSteps, runnerAlert, watchTone, visibleSteps } from "../../shared/release-copy.ts";
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
    label: "r702 · img 3/9",
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
    label: "r699 · inconclusivo",
    tone: "muted",
  });
  assert.equal(selectWorkspaceRowBadge(view, "wks-open", "feat/open-only", NOW), null);
});

test("visibleSteps oculta verify mesmo com release ativa quando não há verify-production, e badge mostra PR", () => {
  const activeNoVerify = buildRelease({
    run: run({ run_number: 712, head_commit: null }),
    jobs: [
      job("plan", "success", [5, 4.9]),
      job("images / shard 1", "success", [4.9, 3]),
      job("images / shard 2", "running", [4.9]),
    ],
    prs: [{ number: 275, branch: "eng-1017-ksm-deleting", url: "https://gh/pr/275" }],
    note: null,
    commits: [commit("c1", "feat: ksm", "paseo/srv_X/agent-275")],
    now: NOW,
  });
  assert.deepEqual(
    visibleSteps(activeNoVerify).map((step) => step.id),
    ["images", "deploy", "tag", "watch"],
    "verify não aparece vazia enquanto a release corre",
  );
  const snapshot = buildSnapshot({
    repository: "dboltbr/dbolt",
    workflow: "release",
    releases: [activeNoVerify],
    runners: RUNNERS,
    now: NOW,
  });
  const view: ReleaseView = {
    host: HOST,
    snapshot,
    agents: [{ id: "agent-275", title: "KSM", workspaceId: "wks-275", openCodeSession: null }],
  };
  assert.deepEqual(selectWorkspaceRowBadge(view, "wks-275", "eng-1017-ksm-deleting", NOW), {
    icon: "Rocket",
    label: "PR #275 · img 1/2",
    tone: "info",
  });
});

test("popoverSteps, deployChips e runnerAlert: só 3 etapas humanas, alvo travado em destaque e runners ociosos ocultos", () => {
  const stuckDeploy = buildRelease({
    run: run({ run_number: 712, head_commit: null }),
    jobs: [
      job("previous-investigation", "success", [36, 35.5]),
      job("images / shard 0", "success", [36, 35]),
      job("pins", "success", [35, 34.8]),
      job("marketing / deploy", "success", [35, 34]),
      job("console / build", "success", [35, 33]),
      job("console / deploy", "running", [33]),
    ],
    prs: [{ number: 274, branch: "fix-review-recheck-batches" }],
    note: null,
    commits: null,
    now: NOW,
  });
  assert.deepEqual(
    popoverSteps(stuckDeploy).map((step) => step.id),
    ["images", "deploy", "watch"],
    "popover omite verify fantasma e tag interno",
  );
  assert.deepEqual(deployChips(stuckDeploy), [
    { name: "pins", state: "success" },
    { name: "marketing", state: "success" },
    { name: "console", state: "running" },
  ]);

  const healthySnap = buildSnapshot({
    repository: "dboltbr/dbolt",
    workflow: "release",
    releases: [stuckDeploy],
    runners: RUNNERS.map((runner) => ({ ...runner, status: "online", busy: false })),
    now: NOW,
  });
  assert.equal(runnerAlert(healthySnap), null, "runners online e ociosos não poluem o popover");

  const offlineSnap = buildSnapshot({
    repository: "dboltbr/dbolt",
    workflow: "release",
    releases: [stuckDeploy],
    runners: RUNNERS.map((runner, idx) => ({ ...runner, status: idx === 0 ? "offline" : "online", busy: false })),
    now: NOW,
  });
  assert.deepEqual(runnerAlert(offlineSnap), { tone: "bad", text: `Runner ${offlineSnap.runners.find((r) => !r.online)!.name} offline` });
});
