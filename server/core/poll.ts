import type { Fetch } from "./types.ts";

export const POLL_INTERVAL_MS = 30_000;
export const POLL_TIMEOUT_MS = 10_000;

export type PollResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "changed"; readonly etag: string | null; readonly sha: string }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly status: number | null; readonly message: string };

export interface PollInput {
  readonly fetch: Fetch;
  readonly token: string;
  readonly repository: string;
  readonly notesRef: string;
  readonly etag: string | null;
}

/** `GET /repos/<repository>/git/ref/<ref without refs/>` with `If-None-Match`; 304 costs nothing. */
export async function pollRef(input: PollInput): Promise<PollResult> {
  const ref = input.notesRef.replace(/^refs\//, "");
  const url = `https://api.github.com/repos/${input.repository}/git/ref/${ref}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${input.token}`,
    "User-Agent": "agent-recall",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (input.etag) headers["If-None-Match"] = input.etag;
  let response: Response;
  try {
    response = await input.fetch(url, { headers, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
  } catch (error) {
    return { kind: "error", status: null, message: describe(error) };
  }
  if (response.status === 304) return { kind: "unchanged" };
  if (response.status === 404) return { kind: "missing" };
  if (response.status !== 200) {
    return { kind: "error", status: response.status, message: `GitHub respondeu ${response.status}` };
  }
  let sha: unknown;
  try {
    sha = ((await response.json()) as { object?: { sha?: unknown } }).object?.sha;
  } catch (error) {
    return { kind: "error", status: 200, message: describe(error) };
  }
  if (typeof sha !== "string") return { kind: "error", status: 200, message: "ref sem object.sha" };
  return { kind: "changed", etag: response.headers.get("etag"), sha };
}

/** One line for a thrown value. Harness clients throw tagged errors with an empty `message`. */
export function describe(error: unknown): string {
  if (error === null || typeof error !== "object") return String(error);
  const fields = error as { message?: unknown; _tag?: unknown; name?: unknown };
  const message = typeof fields.message === "string" ? fields.message.trim() : "";
  const tag = typeof fields._tag === "string" ? fields._tag : typeof fields.name === "string" ? fields.name : "";
  if (message) return tag && tag !== "Error" && !message.includes(tag) ? `${tag}: ${message}` : message;
  if (tag && tag !== "Error") return tag;
  try {
    return JSON.stringify(error).slice(0, 300);
  } catch {
    return String(error);
  }
}
