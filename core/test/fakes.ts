import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery } from "../deliver.ts";
import type { ReleaseTracker } from "../release-fetch.ts";
import { buildSnapshot, type Release } from "../release-status.ts";
import type { BlockedNote, Exec, ExecResult, Fetch, HostConfig, Logger, Note, SessionRef } from "../types.ts";

export const NOW = new Date("2026-10-27T15:00:00.000Z");

export function hoursAgo(hours: number, from = NOW): string {
  return new Date(from.getTime() - hours * 3_600_000).toISOString();
}

export function fixedClock(at = NOW): { now(): Date; set(next: Date): void } {
  let current = at;
  return { now: () => current, set: (next) => (current = next) };
}

const tempDirs: string[] = [];

/** A fresh temp directory, removed after the file's tests (or earlier by `removeTempDirs`). */
export async function tempState(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-recall-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Removes every temp directory made so far (scripts/test.mjs fails the run on leftovers). */
export async function removeTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

after(removeTempDirs);

export const config: HostConfig = {
  instance: "archdev",
  repository: "dboltbr/dbolt",
  notesRef: "refs/notes/release-watch",
  blockedRef: "refs/notes/release-blocked",
};

/** A red note as `release-incident-note.py respond` leaves it: pin reverted and applied, no owner. */
export function note(partial: Partial<Note> & Pick<Note, "release">): Note {
  return {
    verdict: {
      verdict: "red",
      sources: { errors5xx: { outcome: "red", reason: "errors5xx-ratio" }, sentry: { outcome: "green" } },
      at: hoursAgo(0.2),
    },
    range: { from: "aaaaaaa", to: "bbbbbbb" },
    owner: null,
    notified: [],
    rollback: { outcome: "reverted", target: "dbolt-deploy", commit: "d3p10y0000000000", applied: true, at: hoursAgo(0.1) },
    updatedAt: hoursAgo(0.1),
    ...partial,
  };
}

export function session(harness: SessionRef["harness"], host: string, id: string, commits: string[] = []) {
  return { harness, host, id, commits };
}

export type RefReply = { status: number; etag?: string; sha?: string };

/**
 * GitHub fake: answers the incident ref endpoint with `refs` in order, and the blocked ref with
 * `blocked` (404 by default: no blocked release); the last reply of each list repeats.
 */
export function fakeGitHub(refs: RefReply[], blocked: RefReply[] = [{ status: 404 }]) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const index = { incident: 0, blocked: 0 };
  const fetch: Fetch = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ url, headers, body: typeof init?.body === "string" ? init.body : undefined });
    const kind = url.includes("/release-blocked") ? "blocked" : "incident";
    const list = kind === "blocked" ? blocked : refs;
    const reply = list[Math.min(index[kind]++, list.length - 1)]!;
    if (reply.status !== 200) return new Response(null, { status: reply.status });
    return new Response(JSON.stringify({ object: { sha: reply.sha ?? "abc" } }), {
      status: 200,
      headers: reply.etag ? { etag: reply.etag } : {},
    });
  };
  const api = () => calls.filter((call) => call.url.startsWith("https://api.github.com"));
  return {
    fetch,
    calls,
    refCalls: () => api().filter((call) => !call.url.includes("/release-blocked")),
    blockedCalls: () => api().filter((call) => call.url.includes("/release-blocked")),
  };
}

/**
 * git/gh fake serving `notes` (key → body) on the incident ref and `behaviour.blocked` on any
 * `release-blocked` ref, through `notes list`, `notes show` and `cat-file --batch`. `notes add` +
 * `push` record what the plugin wrote (and on which ref); `push: "reject"` loses every CAS.
 * `applyBlocked`: a blocked write replaces the note `blocked()` serves (the map must be mutable).
 * `blockedRemote`: what the CAS read (`notes show`) of a blocked note sees, when another host already
 * changed it after this one fetched.
 */
export function fakeExec(
  notes: () => Record<string, Note | string>,
  behaviour: {
    push?: "ok" | "reject";
    blocked?: () => Record<string, BlockedNote | string>;
    applyBlocked?: boolean;
    blockedRemote?: () => Record<string, BlockedNote | string>;
  } = {},
) {
  const calls: string[][] = [];
  const written: Array<{ key: string; ref: string; body: Record<string, unknown> }> = [];
  let staged: { key: string; ref: string; body: Record<string, unknown> } | null = null;
  const all = () => {
    const entries = (ref: "incident" | "blocked", source: Record<string, Note | BlockedNote | string>) =>
      Object.entries(source).map(([key, body], i) => ({
        ref,
        key,
        blob: `${ref === "blocked" ? "c" : "b"}${String(i).padStart(39, "0")}`,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }));
    return [...entries("incident", notes()), ...entries("blocked", behaviour.blocked?.() ?? {})];
  };
  const exec: Exec = async (command, args, options): Promise<ExecResult> => {
    calls.push([command, ...args]);
    const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    if (command === "gh") return ok("gho_test\n");
    const sub = args[2];
    if (args[0] === "init") {
      await mkdir(args[3]!, { recursive: true });
      return ok();
    }
    // `--git-dir <dir> notes --ref <ref> …`: the ref picks which notes answer.
    const ref = args[3] === "--ref" && args[4]?.includes("release-blocked") ? "blocked" : "incident";
    const blobs = all();
    const entries = blobs.filter((entry) => entry.ref === ref);
    if (sub === "fetch") return ok();
    if (sub === "notes" && args[5] === "show") {
      const remote = ref === "blocked" ? behaviour.blockedRemote?.() : undefined;
      if (remote) {
        const body = remote[args[6]!];
        return body === undefined ? { code: 1, stdout: "", stderr: "no note found" } : ok(typeof body === "string" ? body : JSON.stringify(body));
      }
      const entry = entries.find((e) => e.key === args[6]);
      return entry ? ok(entry.body) : { code: 1, stdout: "", stderr: "no note found" };
    }
    if (sub === "notes" && args[5] === "add") {
      staged = { key: args[args.length - 1]!, ref: args[4]!, body: JSON.parse(options.input ?? "{}") as Record<string, unknown> };
      return ok();
    }
    if (sub === "notes") return ok(entries.map((e) => `${e.blob} ${e.key}`).join("\n"));
    if (sub === "push") {
      if (behaviour.push === "reject") return { code: 1, stdout: "", stderr: " ! [rejected] (fetch first)" };
      if (staged) {
        written.push(staged);
        if (behaviour.applyBlocked && staged.ref.includes("release-blocked")) behaviour.blocked!()[staged.key] = staged.body as unknown as BlockedNote;
      }
      return ok();
    }
    if (sub === "cat-file") {
      const wanted = (options.input ?? "").split("\n").filter(Boolean);
      return ok(
        wanted
          .map((blob) => blobs.find((e) => e.blob === blob)!)
          .map((e) => `${e.blob} blob ${Buffer.byteLength(e.body)}\n${e.body}\n`)
          .join(""),
      );
    }
    return { code: 1, stdout: "", stderr: `fake exec: ${command} ${args.join(" ")}` };
  };
  return { exec, calls, written, gitCalls: (sub: string) => calls.filter((c) => c[0] === "git" && c[3] === sub) };
}

export interface Recorded {
  prompts: Array<{ target: SessionRef; text: string }>;
  fallbacks: Array<{ target: SessionRef; text: string }>;
  opened: Array<{ directory: string; text: string; title: string }>;
  asked: string[];
}

/**
 * `roots`: lane id → parent id (gives the delivery `resolveRoot`). `working`: gives `isWorking`
 * (session ids that work). `open`: gives `open`, which answers `ses_incident` or refuses.
 */
export function fakeDelivery(
  behaviour: {
    prompt?: "ok" | "refuse";
    fallback?: "ok" | "refuse";
    roots?: Record<string, string>;
    working?: readonly string[];
    open?: "ok" | "refuse";
  } = {},
) {
  const recorded: Recorded = { prompts: [], fallbacks: [], opened: [], asked: [] };
  const extra: Partial<Delivery> = {};
  const roots = behaviour.roots;
  if (roots) {
    extra.resolveRoot = async (target) => {
      let id = target.id;
      while (roots[id]) id = roots[id]!;
      return { ...target, id };
    };
  }
  const working = behaviour.working;
  if (working) {
    extra.isWorking = async (target) => {
      recorded.asked.push(target.id);
      return working.includes(target.id);
    };
  }
  const open = behaviour.open;
  if (open) {
    extra.open = async (directory, text, title) => {
      recorded.opened.push({ directory, text, title });
      if (open === "refuse") throw new Error("abrir recusado");
      return "ses_incident";
    };
  }
  const delivery: Delivery = {
    ...extra,
    async prompt(target, text) {
      recorded.prompts.push({ target, text });
      if (behaviour.prompt === "refuse") throw new Error("prompt recusado");
    },
    async fallback(target, text) {
      recorded.fallbacks.push({ target, text });
      if (behaviour.fallback === "refuse") throw new Error("fork recusado");
      return "ses_fork";
    },
  };
  return { delivery, recorded };
}

export const quietLog: Logger = { info() {}, warn() {}, error() {} };

/**
 * A release tracker that only hands back a fixed history (null: not loaded yet). `fail` makes the
 * last refresh a failure that kept the older history (the snapshot carries `error`).
 */
export function fixedReleases(releases: Release[] | null): ReleaseTracker & { set(next: Release[] | null): void; fail(error: string | null): void } {
  let current = releases;
  let error: string | null = null;
  return {
    tick: async () => {},
    refresh: async () => false,
    current: () =>
      current ? buildSnapshot({ repository: "dboltbr/dbolt", workflow: "release", releases: current, runners: [], now: NOW, error }) : null,
    set: (next) => (current = next),
    fail: (next) => (error = next),
  };
}

/** A logger that keeps every line, by level. */
export function recordingLog(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    error: (message) => lines.push(`error ${message}`),
  };
}

export async function writeConfig(dir: string, value: HostConfig = config): Promise<string> {
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

export interface ApiReply {
  readonly status?: number;
  readonly body?: unknown;
  readonly etag?: string;
}

/**
 * GitHub REST fake keyed by path (no host, query kept). A route answering with an `etag` replies
 * 304 when the request carries that ETag. Unknown paths are 404.
 */
export function fakeApi(routes: Record<string, ApiReply | (() => ApiReply)>) {
  const calls: Array<{ path: string; ifNoneMatch: string | null; status: number }> = [];
  const fetch: Fetch = async (url, init) => {
    const path = url.replace("https://api.github.com/", "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ifNoneMatch = headers["If-None-Match"] ?? null;
    const route = routes[path];
    const reply = typeof route === "function" ? route() : route;
    let status = reply ? (reply.status ?? 200) : 404;
    if (reply?.etag && ifNoneMatch === reply.etag && status === 200) status = 304;
    calls.push({ path, ifNoneMatch, status });
    if (status !== 200) return new Response(null, { status });
    return new Response(JSON.stringify(reply!.body), { status, headers: reply!.etag ? { etag: reply!.etag } : {} });
  };
  return { fetch, calls, paths: () => calls.map((call) => call.path), fresh: () => calls.filter((call) => call.status === 200) };
}
