// Claude Code CLI `statusLine` and `/agent-recall:release` command entrypoint.
// Bundled into claude/dist/status.mjs. Reads the shared Paseo snapshot cache in <5 ms when fresh;
// in `--full` mode falls back to a live GitHub read via `gh auth token` when the cache is stale.
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { nodeExec } from "../core/exec.ts";
import { stateDirectory } from "../core/host.ts";
import { createReleaseSource } from "../core/release-fetch.ts";
import { ReleaseSnapshotSchema, type ReleaseSnapshot } from "../core/release-status.ts";
import { formatClaudeFullStatus, formatClaudeStatusLine } from "./status-format.ts";

const execFileAsync = promisify(execFile);
const STATUSLINE_MAX_AGE_MS = 5 * 60 * 1000;
const FULL_CACHE_MAX_AGE_MS = 60 * 1000;

interface HookStdin {
  readonly session_id?: string;
  readonly workspace?: { readonly current_dir?: string; readonly project_dir?: string };
  readonly cwd?: string;
}

function readStdinQuick(timeoutMs = 200): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 500 });
    const branch = stdout.trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

async function readCachedSnapshot(path: string, maxAgeMs: number, now: Date): Promise<ReleaseSnapshot | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = ReleaseSnapshotSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const fetchedAt = Date.parse(parsed.data.fetchedAt);
    if (Number.isNaN(fetchedAt) || now.getTime() - fetchedAt > maxAgeMs) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

async function ghToken(): Promise<string | null> {
  if (process.env["GITHUB_TOKEN"]) return process.env["GITHUB_TOKEN"]!;
  if (process.env["GH_TOKEN"]) return process.env["GH_TOKEN"]!;
  try {
    const result = await nodeExec("gh", ["auth", "token"], { timeoutMs: 3_000 });
    return result.code === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

async function fetchLiveSnapshot(snapshotPath: string, now: Date): Promise<ReleaseSnapshot | null> {
  const token = await ghToken();
  if (!token) return null;
  const silent = { info() {}, warn() {}, error() {} };
  const source = createReleaseSource({ fetch: (url, init) => fetch(url, init), clock: { now: () => now }, log: silent });
  const snapshot = await source.load({ token, notes: new Map() });
  try {
    await mkdir(join(snapshotPath, ".."), { recursive: true });
    const tmp = `${snapshotPath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(snapshot)}\n`, "utf8");
    await rename(tmp, snapshotPath);
  } catch {
    // Best-effort cache write.
  }
  return snapshot;
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const statusLineMode = args.has("--statusline");
  const rawStdin = statusLineMode ? await readStdinQuick(200) : "";
  let input: HookStdin = {};
  if (rawStdin.trim()) {
    try {
      input = JSON.parse(rawStdin) as HookStdin;
    } catch {
      input = {};
    }
  }
  const cwd = input.workspace?.current_dir || input.workspace?.project_dir || input.cwd || process.cwd();
  const branch = await currentBranch(cwd);
  const now = new Date();
  const stateDir = stateDirectory(homedir());
  const snapshotPath = join(stateDir, "snapshot.json");

  if (statusLineMode) {
    const snapshot = await readCachedSnapshot(snapshotPath, STATUSLINE_MAX_AGE_MS, now);
    if (!snapshot) return 0;
    const line = formatClaudeStatusLine(snapshot, { sessionId: input.session_id ?? null, branch, now });
    if (line) process.stdout.write(`${line}\n`);
    return 0;
  }

  const snapshot =
    (!args.has("--refresh") ? await readCachedSnapshot(snapshotPath, FULL_CACHE_MAX_AGE_MS, now) : null) ??
    (await fetchLiveSnapshot(snapshotPath, now));
  if (!snapshot) {
    process.stdout.write("Sem snapshot local nem token `gh auth token` disponível.\n");
    return 0;
  }
  process.stdout.write(`${formatClaudeFullStatus(snapshot, { sessionId: input.session_id ?? null, branch, now })}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(0));
