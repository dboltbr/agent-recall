import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMergeQueue } from "../../core/queue-status.ts";
import { buildRelease, buildSnapshot } from "../../core/release-status.ts";
import { NOW } from "../../core/test/fakes.ts";
import { commit, job, minutesAgo, run, RUNNERS } from "../../core/test/releases.ts";
import { formatClaudeFullStatus, formatClaudeStatusLine } from "../status-format.ts";

test("formatClaudeStatusLine e formatClaudeFullStatus: paridade com Paseo (PR, chips de deploy, fila, alerta de runner)", () => {
  const active = buildRelease({
    run: run({ run_number: 713, head_commit: null }),
    jobs: [
      job("images / shard 0", "success", [10, 8]),
      job("pins", "success", [8, 7.5]),
      job("marketing / deploy", "success", [8, 7]),
      job("console / deploy", "running", [7]),
    ],
    prs: [
      { number: 273, branch: "fix/release-711-blocked", title: "fix(deploy): serialize command rollout", url: "https://gh/pr/273" },
      { number: 274, branch: "fix-review-recheck-batches", title: "fix review recheck", url: "https://gh/pr/274" },
    ],
    note: null,
    commits: [commit("c1", "fix(deploy): serialize command rollout", "paseo/srv_X/agent-273")],
    now: NOW,
  });

  const queue = buildMergeQueue({
    pulls: [
      {
        number: 264,
        title: "fix(ci): lock timeout",
        html_url: "https://gh/pr/264",
        draft: false,
        created_at: minutesAgo(10),
        updated_at: minutesAgo(1),
        head: { ref: "fix/account-activation-migration-db", sha: "sha264" },
        labels: [{ name: "queue" }, { name: "queued" }],
      },
    ],
    ciRuns: [],
    jobsByRunId: new Map(),
  });

  const healthySnap = buildSnapshot({
    repository: "dboltbr/dbolt",
    workflow: "release",
    releases: [active],
    runners: RUNNERS.map((runner) => ({ ...runner, status: "online", busy: false })),
    queue,
    now: NOW,
  });

  assert.equal(
    formatClaudeStatusLine(healthySnap, { branch: "main", now: NOW }),
    "🚀 PR #273 +1 · deploy [✓pins ✓marketing ⟳console]",
  );
  assert.equal(
    formatClaudeStatusLine(healthySnap, { branch: "fix/account-activation-migration-db", now: NOW }),
    "🔀 PR #264 · fila #1",
  );

  const full = formatClaudeFullStatus(healthySnap, { branch: "fix/account-activation-migration-db", now: NOW });
  assert.match(full, /### 🚀 PR #273 \+1 — \*\*em andamento\*\*/);
  assert.match(full, /✓ pins · ✓ marketing · ⟳ console/);
  assert.doesNotMatch(full, /Runners:/, "runners ociosos não poluem o status");
  assert.doesNotMatch(full, /push do agente/, "sem frase verbosa 'push do agente'");
  assert.match(full, /PR #264 · fila #1/);

  const offlineSnap = buildSnapshot({
    repository: "dboltbr/dbolt",
    workflow: "release",
    releases: [active],
    runners: RUNNERS.map((runner, idx) => ({ ...runner, status: idx === 0 ? "offline" : "online", busy: false })),
    queue,
    now: NOW,
  });
  assert.match(formatClaudeStatusLine(offlineSnap, { branch: "main", now: NOW }), /⚠ Runner .* offline/);
  assert.match(formatClaudeFullStatus(offlineSnap, { branch: "main", now: NOW }), /Runners:/);
});
