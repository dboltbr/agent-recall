import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery } from "../deliver.ts";
import type { Exec, ExecResult, Fetch, HostConfig, Logger, Note, SessionRef } from "../types.ts";

export const NOW = new Date("2026-10-27T15:00:00.000Z");

export function hoursAgo(hours: number, from = NOW): string {
  return new Date(from.getTime() - hours * 3_600_000).toISOString();
}

export function fixedClock(at = NOW): { now(): Date; set(next: Date): void } {
  let current = at;
  return { now: () => current, set: (next) => (current = next) };
}

export async function tempState(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-recall-test-"));
}

export const config: HostConfig = {
  instance: "archdev",
  incidentHost: false,
  repository: "dboltbr/dbolt",
  notesRef: "refs/notes/release-watch",
};

export function note(partial: Partial<Note> & Pick<Note, "release">): Note {
  return { state: "red", updatedAt: hoursAgo(0.1), sessions: [], ...partial };
}

export function session(harness: SessionRef["harness"], host: string, id: string, commits: string[] = []) {
  return { harness, host, id, commits };
}

/** GitHub fake: answers the ref endpoint with `refs` in order (last one repeats). */
export function fakeGitHub(refs: Array<{ status: number; etag?: string; sha?: string }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  let index = 0;
  const fetch: Fetch = async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ url, headers, body: typeof init?.body === "string" ? init.body : undefined });
    const reply = refs[Math.min(index++, refs.length - 1)]!;
    if (reply.status !== 200) return new Response(null, { status: reply.status });
    return new Response(JSON.stringify({ ref: "refs/notes/release-watch", object: { sha: reply.sha ?? "abc" } }), {
      status: 200,
      headers: reply.etag ? { etag: reply.etag } : {},
    });
  };
  return { fetch, calls, refCalls: () => calls.filter((call) => call.url.startsWith("https://api.github.com")) };
}

/**
 * git/gh fake serving `notes` (key → body) through `notes list`, `notes show` and `cat-file
 * --batch`. `notes add` + `push` record what the plugin wrote; `push: "reject"` loses every CAS.
 */
export function fakeExec(notes: () => Record<string, Note | string>, behaviour: { push?: "ok" | "reject" } = {}) {
  const calls: string[][] = [];
  const written: Array<{ key: string; body: Record<string, unknown> }> = [];
  let staged: { key: string; body: Record<string, unknown> } | null = null;
  const exec: Exec = async (command, args, options): Promise<ExecResult> => {
    calls.push([command, ...args]);
    const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    if (command === "gh") return ok("gho_test\n");
    const sub = args[2];
    if (args[0] === "init") {
      await mkdir(args[3]!, { recursive: true });
      return ok();
    }
    const entries = Object.entries(notes()).map(([key, body], i) => ({
      key,
      blob: `b${String(i).padStart(39, "0")}`,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }));
    if (sub === "fetch") return ok();
    if (sub === "notes" && args[5] === "show") {
      const entry = entries.find((e) => e.key === args[6]);
      return entry ? ok(entry.body) : { code: 1, stdout: "", stderr: "no note found" };
    }
    if (sub === "notes" && args[5] === "add") {
      staged = { key: args[args.length - 1]!, body: JSON.parse(options.input ?? "{}") as Record<string, unknown> };
      return ok();
    }
    if (sub === "notes") return ok(entries.map((e) => `${e.blob} ${e.key}`).join("\n"));
    if (sub === "push") {
      if (behaviour.push === "reject") return { code: 1, stdout: "", stderr: " ! [rejected] (fetch first)" };
      if (staged) written.push(staged);
      return ok();
    }
    if (sub === "cat-file") {
      const wanted = (options.input ?? "").split("\n").filter(Boolean);
      return ok(
        wanted
          .map((blob) => entries.find((e) => e.blob === blob)!)
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
  created: string[];
}

export function fakeDelivery(behaviour: { prompt?: "ok" | "refuse"; fallback?: "ok" | "refuse"; create?: "ok" | "refuse" } = {}) {
  const recorded: Recorded = { prompts: [], fallbacks: [], created: [] };
  const delivery: Delivery = {
    async prompt(target, text) {
      recorded.prompts.push({ target, text });
      if (behaviour.prompt === "refuse") throw new Error("prompt recusado");
    },
    async fallback(target, text) {
      recorded.fallbacks.push({ target, text });
      if (behaviour.fallback === "refuse") throw new Error("fork recusado");
      return "ses_fork";
    },
    async create(text) {
      recorded.created.push(text);
      if (behaviour.create === "refuse") throw new Error("criação recusada");
      return "ses_new";
    },
  };
  return { delivery, recorded };
}

export const quietLog: Logger = { info() {}, warn() {}, error() {} };

export async function writeConfig(dir: string, value: HostConfig = config): Promise<string> {
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}
