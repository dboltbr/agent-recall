// Release workflow fixtures: run and job JSON shaped like the GitHub API (names copied from run
// 40712153996, release #182, of dboltbr/dbolt).
import type { GitHubCommit, GitHubJob, GitHubRun, GitHubRunner } from "../release-status.ts";
import { NOW } from "./fakes.ts";

export function minutesAgo(minutes: number, from = NOW): string {
  return new Date(from.getTime() - minutes * 60_000).toISOString();
}

export function run(partial: Partial<GitHubRun> & Pick<GitHubRun, "run_number">): GitHubRun {
  return {
    id: 40_000_000_000 + partial.run_number,
    run_attempt: 1,
    status: "in_progress",
    conclusion: null,
    head_sha: `${String(partial.run_number).padStart(4, "0")}${"a".repeat(36)}`,
    display_title: "test(api): teste do push do aviso ao morador",
    event: "push",
    html_url: `https://github.com/dboltbr/dbolt/actions/runs/${40_000_000_000 + partial.run_number}`,
    created_at: minutesAgo(36),
    updated_at: minutesAgo(1),
    run_started_at: minutesAgo(36),
    head_commit: { message: "test(api): teste do push do aviso ao morador\n\nAgent-Session: opencode/archdev/ses_pusher\n" },
    ...partial,
  };
}

let nextJob = 1;
const SOLID = ["self-hosted", "linux", "amd64", "solid-srv"];

/** `ago` = [started minutes ago, completed minutes ago]; omitted for queued jobs. */
export function job(
  name: string,
  state: "queued" | "waiting" | "running" | "success" | "failure" | "cancelled" | "skipped",
  ago: [number, number?] | null = null,
  extra: Partial<GitHubJob> = {},
): GitHubJob {
  const completed = state !== "queued" && state !== "running" && state !== "waiting";
  return {
    id: nextJob++,
    name,
    status: completed ? "completed" : state === "running" ? "in_progress" : state === "waiting" ? "pending" : "queued",
    conclusion: completed ? state : null,
    started_at: ago ? minutesAgo(ago[0]) : null,
    completed_at: completed && ago ? minutesAgo(ago[1] ?? ago[0]) : null,
    labels: SOLID,
    runner_name: state === "running" ? "solid-srv" : completed && state !== "skipped" ? "solid-srv" : null,
    html_url: `https://github.com/dboltbr/dbolt/actions/runs/1/job/${nextJob}`,
    ...extra,
  };
}

export const VERIFY_DONE = [
  job("plan", "success", [36, 35.8]),
  job("verify-production / scanners", "success", [35.5, 29]),
  job("verify-production / check", "success", [33, 12]),
  job("flags", "skipped", [36, 36]),
];

/** Mid-images: 3 of 9 published, one building, five waiting for solid-srv. */
export function midImages(): GitHubJob[] {
  return [
    ...VERIFY_DONE,
    job("images-command / changes", "success", [11.8, 11.5]),
    job("images-vms / changes", "success", [11.8, 11.5]),
    job("images-command / build-push-api", "success", [11.4, 7]),
    job("images-rtpengine / build-push", "success", [11.4, 5]),
    job("images-fs-bridge / build-push", "success", [11.4, 4]),
    job("images-vms / build-push (vms-client-gateway, vms/client-gateway/Dockerfile, 48b64c18…)", "running", [2]),
    job("images-vms / build-push (vms-api, vms/api/Dockerfile, 9f99af52)", "queued"),
    job("images-command / build-push-supporting (command-worker, command/worker/Dockerfile, 2698d3ac…)", "queued"),
    job("images-command / build-push-supporting (command-sip-directory, command/sip-directory/Dockerfile)", "queued"),
    job("images-command / build-push-supporting (worker-netns-guard, deploy/worker-netns-guard/Dockerfile)", "queued"),
    job("images-command / build-push-supporting (command-device-uplink, command/device-uplink/Dockerfile)", "queued"),
    job("images-freeswitch / build-push", "skipped", [11, 11]),
    job("images-freeswitch / announcement", "skipped", [11, 11]),
  ];
}

/** The watch's outcome: its run judged (`success`/`failure`), or it was cancelled. */
export type WatchEnd = "success" | "failure" | "cancelled";

/** A release run and its watch run, as `buildRelease` takes them. */
export interface Released {
  readonly jobs: GitHubJob[];
  readonly watch: { readonly run: GitHubRun; readonly jobs: GitHubJob[] } | null;
}

const LIGHT = ["self-hosted", "linux", "amd64", "solid-srv-light"];

/** The `watch release-<n>` run of release-watch.yml: its one `watch` job, ended or still open. */
export function watchRun(number: number, end: WatchEnd | "running", ago: [number, number?] = [1.8, 0.5]): Released["watch"] {
  const open = end === "running";
  return {
    run: run({
      run_number: 900 + number,
      id: 41_000_000_000 + number,
      name: `watch release-${number}`,
      display_title: `watch release-${number}`,
      status: open ? "in_progress" : "completed",
      conclusion: open ? null : end,
      created_at: minutesAgo(ago[0]),
      run_started_at: minutesAgo(ago[0]),
      updated_at: minutesAgo(open ? 0.2 : (ago[1] ?? ago[0])),
      html_url: `https://github.com/dboltbr/dbolt/actions/runs/${41_000_000_000 + number}`,
    }),
    jobs: [job("watch", end, open ? [ago[0]] : ago, { labels: LIGHT })],
  };
}

/**
 * Every step through the tag; the run's `watch` job dispatches the watch run, which judges
 * (`end`). `cancelled`: the release run itself was cancelled at the dispatch (superseded), no watch.
 */
export function released(end: WatchEnd, number = 0, endedAgo = 0.5): Released {
  const jobs = [
    ...VERIFY_DONE,
    job("images-command / build-push-api", "success", [11, 7]),
    job("images-rtpengine / build-push", "success", [11, 5]),
    job("previous-watch", "success", [10, 9.9], { labels: LIGHT }),
    job("wall / meta", "success", [4.5, 4.4], { labels: ["blacksmith-2vcpu-ubuntu-2404"] }),
    job("console / deploy", "success", [4, 2], { labels: ["blacksmith-2vcpu-ubuntu-2404"] }),
    job("infrastructure / check", "success", [4, 3]),
    job("release-tag", "success", [2, 1.95]),
    job("watch", end === "cancelled" ? "cancelled" : "success", [1.95, 1.9], { labels: LIGHT }),
    job("summary", "success", [1.9, 1.85]),
  ];
  return { jobs, watch: end === "cancelled" ? null : watchRun(number, end, [endedAgo + 1.3, endedAgo]) };
}

/** `buildRelease`'s jobs and watch from either a bare job list (no watch run) or `released()`. */
export function jobsInput(jobs: GitHubJob[] | Released): Released {
  return Array.isArray(jobs) ? { jobs, watch: null } : jobs;
}

export function commit(sha: string, subject: string, session?: string): GitHubCommit {
  return { sha, commit: { message: session ? `${subject}\n\nAgent-Session: ${session}\n` : `${subject}\n` } };
}

export const RUNNERS: GitHubRunner[] = [
  { id: 13353, name: "solid-srv", status: "online", busy: true, labels: [{ name: "self-hosted" }, { name: "solid-srv" }] },
  { id: 13354, name: "unraid-amd64-dboltbr", status: "online", busy: false, labels: [{ name: "self-hosted" }, { name: "unraid-dboltbr" }] },
  { id: 26065, name: "solid-srv-light", status: "online", busy: false, labels: [{ name: "self-hosted" }, { name: "solid-srv-light" }] },
  { id: 26011, name: "blacksmith-01m5z2y2-2vcpu", status: "offline", busy: false, labels: [{ name: "blacksmith-2vcpu-ubuntu-2204" }] },
];
