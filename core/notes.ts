import { existsSync } from "node:fs";
import type { Exec, Note } from "./types.ts";

export const FETCH_TIMEOUT_MS = 25_000;

export interface FetchedNote {
  /** Commit of tag `release-<n>`, the note's annotated object. */
  readonly key: string;
  readonly raw: string;
  readonly note: Note | null;
}

export interface FetchNotesInput {
  readonly exec: Exec;
  readonly gitDir: string;
  readonly repository: string;
  readonly notesRef: string;
  readonly token: string;
}

/** Token in the environment, never argv: `http.extraHeader` through `GIT_CONFIG_*`. */
function gitEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_1: `Authorization: Basic ${basic}`,
  };
}

const remoteUrl = (repository: string) => `https://github.com/${repository}.git`;

/** `git fetch +<ref>:<ref>` into the private bare repository (created on first use). */
async function fetchRef(input: FetchNotesInput): Promise<void> {
  const { exec, gitDir, notesRef } = input;
  if (!existsSync(gitDir)) {
    const init = await exec("git", ["init", "--bare", "--quiet", gitDir], { timeoutMs: 10_000 });
    if (init.code !== 0) throw new Error(`git init falhou: ${init.stderr.trim()}`);
  }
  const fetched = await exec(
    "git",
    ["--git-dir", gitDir, "fetch", "--quiet", "--no-tags", remoteUrl(input.repository), `+${notesRef}:${notesRef}`],
    { timeoutMs: FETCH_TIMEOUT_MS, env: gitEnv(input.token) },
  );
  if (fetched.code !== 0) throw new Error(`git fetch ${notesRef} falhou: ${fetched.stderr.trim()}`);
}

/** Fetches the notes ref into a private bare repository and returns every note body. */
export async function fetchNotes(input: FetchNotesInput): Promise<FetchedNote[]> {
  const { exec, gitDir, notesRef } = input;
  await fetchRef(input);
  const list = await exec("git", ["--git-dir", gitDir, "notes", "--ref", notesRef, "list"], {
    timeoutMs: 10_000,
  });
  if (list.code !== 0) throw new Error(`git notes list falhou: ${list.stderr.trim()}`);
  const pairs = parseNotesList(list.stdout);
  if (pairs.length === 0) return [];
  const batch = await exec("git", ["--git-dir", gitDir, "cat-file", "--batch"], {
    timeoutMs: 10_000,
    input: `${pairs.map((pair) => pair.blob).join("\n")}\n`,
  });
  if (batch.code !== 0) throw new Error(`git cat-file falhou: ${batch.stderr.trim()}`);
  const bodies = parseCatFileBatch(batch.stdout);
  return pairs.map(({ blob, key }) => {
    const raw = bodies.get(blob) ?? "";
    return { key, raw, note: parseNote(raw) };
  });
}

/** `recall` in the note: the call that failed on every rung (design "Telemetria"). */
export interface RecallFailure {
  readonly failedAt: string;
  readonly reason: string;
  /** `<harness>/<host>` of the plugin that gave up. */
  readonly by: string;
  readonly role: string;
  /** The session it tried, or absent for a new investigation session. */
  readonly target?: string;
  /** Note state the call was for. */
  readonly state: string;
}

export interface RecordFailureInput extends FetchNotesInput {
  readonly key: string;
  readonly recall: RecallFailure;
}

const PUSH_ATTEMPTS = 3;
const REJECTED = /rejected|non-fast-forward|fetch first|failed to update ref|cannot lock ref/i;

/**
 * Writes `recall` (and `updatedAt`) into the note of `key`. CAS is git: the push without
 * `--force` only lands as a fast-forward; a rejection re-fetches, re-reads and retries. False when
 * the note is gone or the push keeps losing.
 */
export async function recordRecallFailure(input: RecordFailureInput): Promise<boolean> {
  const { exec, gitDir, notesRef, key } = input;
  for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
    await fetchRef(input);
    const shown = await exec("git", ["--git-dir", gitDir, "notes", "--ref", notesRef, "show", key], { timeoutMs: 10_000 });
    if (shown.code !== 0 || !parseNote(shown.stdout)) return false;
    const body = { ...(JSON.parse(shown.stdout) as Record<string, unknown>), recall: input.recall, updatedAt: input.recall.failedAt };
    const identity = {
      GIT_AUTHOR_NAME: "agent-recall",
      GIT_AUTHOR_EMAIL: "agent-recall@dbolt.invalid",
      GIT_COMMITTER_NAME: "agent-recall",
      GIT_COMMITTER_EMAIL: "agent-recall@dbolt.invalid",
    };
    const added = await exec("git", ["--git-dir", gitDir, "notes", "--ref", notesRef, "add", "-f", "-F", "-", key], {
      timeoutMs: 10_000,
      input: `${JSON.stringify(body, null, 2)}\n`,
      env: identity,
    });
    if (added.code !== 0) throw new Error(`git notes add falhou: ${added.stderr.trim()}`);
    const pushed = await exec("git", ["--git-dir", gitDir, "push", "--quiet", remoteUrl(input.repository), `${notesRef}:${notesRef}`], {
      timeoutMs: FETCH_TIMEOUT_MS,
      env: gitEnv(input.token),
    });
    if (pushed.code === 0) return true;
    if (!REJECTED.test(pushed.stderr)) throw new Error(`git push ${notesRef} falhou: ${pushed.stderr.trim()}`);
  }
  return false;
}

/** `git notes list` lines: `<note blob> <annotated object>`. */
export function parseNotesList(stdout: string): { blob: string; key: string }[] {
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[0] !== "")
    .map(([blob, key]) => ({ blob, key }));
}

/** `git cat-file --batch` output: `<sha> <type> <size>\n<content>\n` per object. */
export function parseCatFileBatch(stdout: string): Map<string, string> {
  const bytes = Buffer.from(stdout, "utf8");
  const bodies = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) break;
    const header = bytes.subarray(offset, newline).toString("utf8").split(" ");
    offset = newline + 1;
    if (header[1] === "missing" || header.length < 3) continue;
    const size = Number(header[2]);
    bodies.set(header[0]!, bytes.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  return bodies;
}

/** A note body, or null when it is not the JSON object the CI writes. */
export function parseNote(raw: string): Note | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const note = value as Record<string, unknown>;
  const release = note["release"];
  if ((typeof release !== "string" && typeof release !== "number") || typeof note["state"] !== "string") {
    return null;
  }
  if (typeof note["updatedAt"] !== "string") return null;
  return value as Note;
}

/** `release-90` whether the note says `90` or `"release-90"`. */
export function releaseName(note: Note): string {
  const value = String(note.release);
  return value.startsWith("release-") ? value : `release-${value}`;
}
