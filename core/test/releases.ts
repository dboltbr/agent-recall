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
  state: "queued" | "running" | "success" | "failure" | "cancelled" | "skipped",
  ago: [number, number?] | null = null,
  extra: Partial<GitHubJob> = {},
): GitHubJob {
  const completed = state !== "queued" && state !== "running";
  return {
    id: nextJob++,
    name,
    status: completed ? "completed" : state === "running" ? "in_progress" : "queued",
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
  job("trigger", "success", [36, 35.8]),
  job("verify-production / qlty", "success", [35.5, 35]),
  job("verify-production / opengrep", "success", [34, 33.5]),
  job("verify-production / secrets", "success", [30, 29]),
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

/** Every step through the watch, which ends with `watch`. */
export function finished(watch: "success" | "failure" | "cancelled"): GitHubJob[] {
  return [
    ...VERIFY_DONE,
    job("images-command / build-push-api", "success", [11, 7]),
    job("images-rtpengine / build-push", "success", [11, 5]),
    job("wall / meta", "success", [4.5, 4.4], { labels: ["blacksmith-2vcpu-ubuntu-2404"] }),
    job("console / deploy", "success", [4, 2], { labels: ["blacksmith-2vcpu-ubuntu-2404"] }),
    job("infrastructure / check", "success", [4, 3]),
    job("release-tag", "success", [2, 1.9]),
    job("summary", "success", [1.9, 1.8]),
    job("watch", watch, [1.8, 0.5], { labels: ["self-hosted", "linux", "amd64", "solid-srv-light"] }),
  ];
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
