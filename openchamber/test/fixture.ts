// Snapshot shaped like the approved mocks, built through core's own builders from GitHub-shaped
// JSON (`core/test/releases.ts`): release-172 building images 3/9 behind a busy solid-srv, then
// green, reverted, failed and inconclusive history.
import { buildRelease, buildSnapshot, type Release, type ReleaseSnapshot } from "../../core/release-status.ts";
import type { Note } from "../../core/types.ts";
import { NOW } from "../../core/test/fakes.ts";
import { commit, finished, job, midImages, minutesAgo, run, RUNNERS, VERIFY_DONE } from "../../core/test/releases.ts";

export const FIXTURE_NOW = NOW;

function shifted(minutes: number, partial: Parameters<typeof run>[0]) {
  return run({
    status: "completed",
    conclusion: "success",
    created_at: minutesAgo(minutes + 40),
    run_started_at: minutesAgo(minutes + 40),
    updated_at: minutesAgo(minutes),
    ...partial,
  });
}

function revertNote(): Note {
  return {
    release: "release-170",
    state: "reverted",
    updatedAt: minutesAgo(200),
    sessions: [{ harness: "opencode", host: "archdev", id: "ses_culprit", commits: ["41d0c8e5b"] }],
    revert: { commits: ["41d0c8e5b", "a19f2c3d4", "77b0e1f2a"], commit: "e9c4d2a1b0f3e5d7c9b1a3f5e7d9c1b3a5f7e9d1", reason: "reverted" },
    verdict: {
      verdict: "red",
      missing: [],
      at: minutesAgo(205),
      sources: {
        deployment: { outcome: "green", reason: "deployment-converged" },
        errors5xx: { outcome: "red", reason: "errors5xx-ratio" },
        sentry: { outcome: "green", reason: "sentry-quiet" },
      },
    },
  } as Note;
}

export const running: Release = buildRelease({
  run: run({ run_number: 172 }),
  jobs: midImages(),
  note: null,
  commits: [commit("c576d1c29", "test(api): teste do push do aviso ao morador", "opencode/archdev/ses_pusher")],
  now: NOW,
});

/** A newer run waiting on the concurrency group behind 172 (GitHub status `pending`). */
export const waiting: Release = buildRelease({
  run: run({ run_number: 173, status: "pending", created_at: minutesAgo(5), run_started_at: minutesAgo(5) }),
  jobs: [],
  note: null,
  commits: null,
  now: NOW,
});

export const green: Release = buildRelease({
  run: shifted(80, { run_number: 171, head_commit: { message: "feat(vms): relay WHEP com fallback de origem" } }),
  jobs: finished("success"),
  note: null,
  commits: null,
  tagged: true,
  now: NOW,
});

export const reverted: Release = buildRelease({
  run: shifted(220, { run_number: 170, head_commit: { message: "fix(uplink): reconexão do site-agent após 30 s" } }),
  jobs: finished("success"),
  note: revertNote(),
  commits: null,
  tagged: true,
  now: NOW,
});

export const failed: Release = buildRelease({
  run: shifted(294, { run_number: 169, conclusion: "failure", head_commit: { message: "chore(infra): kustomize do flux para dbolt-obs" } }),
  jobs: [...VERIFY_DONE.slice(0, 4), job("verify-production / check", "failure", [300, 294])],
  note: null,
  commits: null,
  now: NOW,
});

export const inconclusive: Release = buildRelease({
  run: shifted(900, { run_number: 167, head_commit: { message: "feat(sip): diretório com cache de ramais" } }),
  jobs: finished("failure"),
  note: null,
  commits: null,
  tagged: true,
  now: NOW,
});

export function fixtureSnapshot(releases: Release[] = [running, green, reverted, failed, inconclusive]): ReleaseSnapshot {
  return buildSnapshot({ repository: "dboltbr/dbolt", workflow: "release", releases, runners: RUNNERS, now: NOW });
}
