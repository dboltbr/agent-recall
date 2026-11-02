// Claude Code harness. There is no long-lived plugin process in Claude Code: the plugin's
// `asyncRewake` hooks (SessionStart, Stop, PostToolUse) start this watcher inside each Claude Code
// process, and an `asyncRewake` hook that exits 2 wakes the model with its stderr. So:
//
// - One watcher per Claude Code process: `mkdir claude/armed/<CLAUDE_PID>` elects it and its pid
//   goes inside (`holder`); a hook that finds a live holder exits 0 at once, a dead holder's
//   directory is removed and the mkdir retried once. The watcher exits when CLAUDE_PID dies (a SIGKILLed Claude
//   Code orphans its hooks to PID 1).
// - `claude/pids/<CLAUDE_PID>` holds the process's current session id. `/clear` gives a new id
//   without killing running hooks, so the watcher re-reads it every loop.
// - Among the watchers of the host, the holder of the host lock `claude.poller` runs the shared core watcher
//   (GitHub poll, heartbeat `claude.alive`, routing). Calling a session writes a request into
//   `claude/inbox/<sessionId>/`; that session's watcher picks it up, prints the prompt on stderr
//   and exits 2. The next hook re-arms the watcher.
// - An incident call is done once the session's watcher picks it up, like a prompt Paseo or
//   OpenCode accepted. A blocked-release call is done only when the blocked note names the session
//   (`owner` or `fix.session`); picked without that for 2 min, it is forked. A session that cannot get it (no live process, a live one with no watcher for 2 min,
//   or a stuck watcher) is forked in the background (`claude --bg --fork-session --resume <id>`) in
//   its original directory; a failed fork goes to the note's `recall`, like every harness.
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Delivery } from "../core/deliver.ts";
import { acquireHostLock, publishExclusive, readHandoffs, writeHandoff, type HostLock } from "../core/host.ts";
import { recordRecallFailure, releaseName } from "../core/notes.ts";
import { describe, POLL_INTERVAL_MS } from "../core/poll.ts";
import { createReleaseSource, createReleaseTracker, type ReleaseTracker } from "../core/release-fetch.ts";
import { ACK_TIMEOUT_MS, blockedConfirmation, CATCH_UP_MS, releaseHistory, shippedSince, type Action } from "../core/route.ts";
import { formatSession } from "../core/trailer.ts";
import type { BlockedNote, Clock, Exec, Fetch, HostConfig, Logger, Note, Role, SessionRef } from "../core/types.ts";
import { createWatcher, type Watcher } from "../core/watcher.ts";

export const INBOX_INTERVAL_MS = 2_000;
export { ACK_TIMEOUT_MS };
/** Flag settings layer of a recall fork of a closed session: it may edit the original checkout (see `fallback`). */
export const FORK_SETTINGS = JSON.stringify({ worktree: { bgIsolation: "none" } });
/** `claude --bg` has this long to start the background session. */
export const FORK_TIMEOUT_MS = 60_000;
/** A fallback claim left by a poller killed mid-fork is dropped after this long, never retried. */
const STALE_FALLBACK_MS = 10 * 60_000;
/**
 * A request waiting for a session whose watcher is armed is picked within a loop; past this the
 * watcher is taken as stuck and the poller forks anyway.
 */
export const PICKUP_LIMIT_MS = 10 * 60_000;
/** Enough of a transcript to reach its first line with a `cwd`. */
const TRANSCRIPT_HEAD_BYTES = 1024 * 1024;

const SAFE = /[^A-Za-z0-9._-]/g;
const safe = (value: string) => value.replace(SAFE, "_");

export interface Paths {
  readonly root: string;
  pidFile(claudePid: number): string;
  armedFile(claudePid: number): string;
  inbox(sessionId: string): string;
  readonly inboxRoot: string;
}

export function claudePaths(stateDir: string): Paths {
  const root = join(stateDir, "claude");
  return {
    root,
    pidFile: (claudePid) => join(root, "pids", String(claudePid)),
    armedFile: (claudePid) => join(root, "armed", String(claudePid)),
    inboxRoot: join(root, "inbox"),
    inbox: (sessionId) => join(root, "inbox", safe(sessionId)),
  };
}

/** The fields this plugin reads from a hook's stdin JSON. */
export interface HookInput {
  readonly sessionId: string;
  readonly event: string;
  readonly transcriptPath: string | null;
  readonly cwd: string | null;
}

export function parseHookInput(raw: string): HookInput | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const text = (key: string) => (typeof value[key] === "string" && value[key] !== "" ? (value[key] as string) : null);
  const sessionId = text("session_id");
  if (!sessionId) return null;
  return { sessionId, event: text("hook_event_name") ?? "", transcriptPath: text("transcript_path"), cwd: text("cwd") };
}

interface PidRecord {
  readonly sessionId: string;
  readonly transcriptPath: string | null;
  readonly cwd: string | null;
  readonly at: string;
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}

/** `claude/pids/<CLAUDE_PID>` ← the session the process runs now (every hook writes it). */
export async function recordSession(stateDir: string, claudePid: number, input: HookInput, clock: Clock): Promise<void> {
  const path = claudePaths(stateDir).pidFile(claudePid);
  await mkdir(join(path, ".."), { recursive: true });
  const record: PidRecord = {
    sessionId: input.sessionId,
    transcriptPath: input.transcriptPath,
    cwd: input.cwd,
    at: clock.now().toISOString(),
  };
  await writeAtomic(path, `${JSON.stringify(record)}\n`);
}

async function readPidRecord(path: string): Promise<PidRecord | null> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as PidRecord;
    return typeof record.sessionId === "string" ? record : null;
  } catch {
    return null;
  }
}

export async function sessionOf(stateDir: string, claudePid: number): Promise<string | null> {
  return (await readPidRecord(claudePaths(stateDir).pidFile(claudePid)))?.sessionId ?? null;
}

export interface LiveSession extends PidRecord {
  readonly pid: number;
  /** A watcher of this process is running now: a request reaches the session within a loop. */
  readonly armed: boolean;
}

/** Host lock of the watcher that polls for the host. */
export const POLLER_LOCK = "claude.poller";

/** Live Claude Code processes of this host, with their current session; dead entries are removed. */
export async function liveSessions(stateDir: string, alive: (pid: number) => boolean): Promise<LiveSession[]> {
  const dir = join(claudePaths(stateDir).root, "pids");
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: LiveSession[] = [];
  for (const name of names) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!alive(pid)) {
      await rm(join(dir, name), { force: true });
      continue;
    }
    const record = await readPidRecord(join(dir, name));
    if (record) out.push({ ...record, pid, armed: await armedWatcher(claudePaths(stateDir).armedFile(pid), alive) });
  }
  return out;
}

/** Whether the process has a live watcher now (a reused pid can say yes: a timing hint only). */
async function armedWatcher(dir: string, alive: (pid: number) => boolean): Promise<boolean> {
  const holder = await readArmedHolder(dir);
  return holder !== null && alive(holder);
}

const HOLDER_FILE = "holder";
/** Staging and tombstone directories older than this were left by a hook killed mid-way. */
const LEFTOVER_TTL_MS = 60_000;
const STAGED = ".arming-";
const TOMBSTONE = ".dead-";

async function readArmedHolder(dir: string): Promise<number | null> {
  const raw = await readFile(join(dir, HOLDER_FILE), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const pid = Number((JSON.parse(raw) as { pid?: unknown }).pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Takes a dead watcher's directory out of the way: an atomic rename to a unique tombstone, which
 * only one contender can do to that directory. The tombstone is checked: if it holds someone other
 * than the dead holder this hook saw, a contender armed in between and its lock goes back.
 */
async function reclaimArmed(dir: string, seen: number | null): Promise<boolean> {
  const tomb = `${dir}${TOMBSTONE}${randomBytes(6).toString("hex")}`;
  try {
    await rename(dir, tomb);
  } catch {
    return false;
  }
  if ((await readArmedHolder(tomb)) !== seen) {
    await rename(tomb, dir).catch(() => undefined);
    return false;
  }
  await rm(tomb, { recursive: true, force: true });
  return true;
}

async function sweepLeftovers(parent: string): Promise<void> {
  for (const name of await readdir(parent).catch(() => [] as string[])) {
    if (!name.includes(TOMBSTONE) && !name.includes(STAGED)) continue;
    const info = await stat(join(parent, name)).catch(() => null);
    if (info && Date.now() - info.mtimeMs > LEFTOVER_TTL_MS) await rm(join(parent, name), { recursive: true, force: true });
  }
}

/**
 * Elects the one watcher of a Claude Code process. The directory `claude/armed/<CLAUDE_PID>` is
 * staged with its `holder` already inside and renamed into place, so it is never seen without a
 * holder (a rename onto a non-empty directory fails; an empty one, from a hook killed mid-way, is
 * simply replaced). Found: a live holder wins; a dead (or missing) holder is reclaimed through a
 * tombstone (`reclaimArmed`) and the rename tried once more, which elects one contender; a loser
 * exits. A reused pid can pass for a live holder; the hook's 24 h timeout bounds it.
 */
export async function armWatcher(stateDir: string, claudePid: number, pid: number, alive: (pid: number) => boolean): Promise<boolean> {
  const dir = claudePaths(stateDir).armedFile(claudePid);
  const parent = join(dir, "..");
  const staged = `${dir}${STAGED}${randomBytes(6).toString("hex")}`;
  await mkdir(staged, { recursive: true });
  try {
    await writeFile(join(staged, HOLDER_FILE), `${JSON.stringify({ pid })}\n`, "utf8");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await rename(staged, dir);
        await sweepLeftovers(parent);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Taken (EEXIST/ENOTEMPTY), or the previous version's plain file there (ENOTDIR).
        if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "ENOTDIR") throw error;
      }
      const holder = await readArmedHolder(dir);
      if (holder === pid) return true;
      if (holder !== null && alive(holder)) return false;
      if (!(await reclaimArmed(dir, holder))) return false;
    }
    return false;
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

/** Gives the process's lock up when this watcher still holds it. */
async function disarmWatcher(stateDir: string, claudePid: number, pid: number): Promise<void> {
  const dir = claudePaths(stateDir).armedFile(claudePid);
  if ((await readArmedHolder(dir)) === pid) await rm(dir, { recursive: true, force: true });
}

/** A call waiting in, or picked from, a session's inbox. */
export interface Request {
  readonly release: string;
  readonly kind: Action["kind"];
  /** The incident role, or `blocked` / `fix` for a blocked-release call. */
  readonly role: Role | "blocked" | "fix";
  readonly lock: string;
  readonly session: string;
  readonly text: string;
  readonly createdAt: string;
}

/** The call a stored request stands for, to hand back to the delivery. */
function actionOf(request: Request, target: SessionRef): Action {
  const { release, lock } = request;
  if (request.kind === "recall") return { kind: "recall", release, role: request.role as Role, target, lock };
  return { kind: "blocked", release, role: request.role === "fix" ? "fix" : "blocked", target, lock };
}

/**
 * A request's state is its file name, so every change is one atomic rename:
 * `<base>.json` waiting, `<base>.picked-<ms>` picked up by the session's watcher at `<ms>`,
 * `<base>.fallback` claimed by the poller for a fork.
 */
type RequestState = "pending" | "picked" | "fallback";
const PENDING = ".json";
const PICKED = ".picked-";
const FALLBACK = ".fallback";
const LEGACY_PICKED = ".picked";

function stateOf(name: string): { state: RequestState; base: string; pickedAt: number | null } | null {
  if (name.endsWith(PENDING)) return { state: "pending", base: name.slice(0, -PENDING.length), pickedAt: null };
  if (name.endsWith(FALLBACK)) return { state: "fallback", base: name.slice(0, -FALLBACK.length), pickedAt: null };
  // `.picked` without a time: written by the previous version; due as soon as it is judged.
  if (name.endsWith(LEGACY_PICKED)) return { state: "picked", base: name.slice(0, -LEGACY_PICKED.length), pickedAt: null };
  const at = name.lastIndexOf(PICKED);
  if (at < 0) return null;
  const pickedAt = Number(name.slice(at + PICKED.length));
  return Number.isFinite(pickedAt) ? { state: "picked", base: name.slice(0, at), pickedAt } : null;
}

function requestBase(request: Pick<Request, "release" | "lock">): string {
  return safe(`${request.release}.${request.lock}`);
}

/**
 * Writes the request once (a second call for the same incident and session is a no-op). The file
 * appears whole: written to a temp name, then linked into place without overwriting.
 */
export async function writeRequest(stateDir: string, request: Request): Promise<void> {
  const dir = claudePaths(stateDir).inbox(request.session);
  await mkdir(dir, { recursive: true });
  const base = requestBase(request);
  const names = await readdir(dir).catch(() => [] as string[]);
  if (names.some((name) => stateOf(name)?.base === base)) return;
  await publishExclusive(join(dir, `${base}${PENDING}`), `${JSON.stringify(request)}\n`);
}

async function readRequest(path: string): Promise<Request | null> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Request;
    return typeof value.text === "string" && typeof value.session === "string" && typeof value.createdAt === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Takes the oldest pending request of a session: the atomic rename to `.picked-<ms>` decides between
 * this watcher and a poller about to fall back, and stamps when the session got it. A request older
 * than `CATCH_UP_MS` is removed instead, and the next one is tried.
 */
export async function pickRequest(stateDir: string, sessionId: string, now: Date): Promise<Request | null> {
  const dir = claudePaths(stateDir).inbox(sessionId);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => stateOf(name)?.state === "pending").sort();
  for (const name of names) {
    const from = join(dir, name);
    const to = join(dir, `${name.slice(0, -PENDING.length)}${PICKED}${now.getTime()}`);
    try {
      await rename(from, to);
    } catch {
      continue;
    }
    const request = await readRequest(to);
    // Older than the catch-up window (a session resumed long after the call): dropped, never woken
    // with it; the next pending request may still be current.
    const created = request ? Date.parse(request.createdAt) : NaN;
    if (request && Number.isFinite(created) && now.getTime() - created <= CATCH_UP_MS) return request;
    await rm(to, { force: true });
  }
  return null;
}

interface Stored {
  readonly path: string;
  readonly dir: string;
  readonly base: string;
  readonly state: RequestState;
  readonly pickedAt: number | null;
  readonly request: Request | null;
}

async function storedRequests(stateDir: string): Promise<Stored[]> {
  const root = claudePaths(stateDir).inboxRoot;
  const out: Stored[] = [];
  for (const session of await readdir(root).catch(() => [] as string[])) {
    for (const name of await readdir(join(root, session)).catch(() => [] as string[])) {
      const parsed = stateOf(name);
      if (!parsed) continue;
      const path = join(root, session, name);
      out.push({ path, dir: join(root, session), ...parsed, request: await readRequest(path) });
    }
  }
  return out;
}

/** `~/.claude/projects/<project>/<sessionId>.jsonl`, or null. */
export async function findTranscript(projectsDir: string, sessionId: string): Promise<string | null> {
  const file = `${sessionId}.jsonl`;
  for (const project of await readdir(projectsDir).catch(() => [] as string[])) {
    const path = join(projectsDir, project, file);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Where the session started: the first transcript line with a `cwd` (`--resume` does not restore it). */
export async function transcriptCwd(path: string): Promise<string | null> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (bytesRead === buffer.length) lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === "string" && cwd !== "") return cwd;
      } catch {
        // A torn line: keep looking.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** The short id in `claude --bg`'s `backgrounded · d05b74cf` line (Claude Code 2.1.316). */
export function backgroundId(stdout: string): string | null {
  return /^\s*backgrounded\s*·\s*([0-9A-Za-z_-]+)\s*$/m.exec(stdout)?.[1] ?? null;
}

/**
 * The session id behind a background job, from `claude agents --json --all` (entries carry `id`,
 * the short id, and `sessionId`). Null when the listing worked and the job is not there; the short
 * id itself when the listing could not be read.
 */
export function backgroundSession(listing: string | null, shortId: string): string | null {
  if (listing === null) return shortId;
  let entries: unknown;
  try {
    entries = JSON.parse(listing);
  } catch {
    return shortId;
  }
  if (!Array.isArray(entries)) return shortId;
  const entry = entries.find((candidate) => (candidate as { id?: unknown })?.id === shortId) as { sessionId?: unknown } | undefined;
  if (!entry) return null;
  return typeof entry.sessionId === "string" && entry.sessionId !== "" ? entry.sessionId : shortId;
}

export interface ClaudeDeps {
  readonly stateDir: string;
  /** The Claude Code process this watcher belongs to (`CLAUDE_PID`). */
  readonly claudePid: number;
  /** This watcher's pid: in the heartbeat and in `claude/armed/<CLAUDE_PID>`. */
  readonly pid: number;
  readonly sha: string;
  readonly clock: Clock;
  readonly fetch: Fetch;
  readonly exec: Exec;
  readonly loadConfig: () => Promise<HostConfig>;
  readonly log: Logger;
  readonly alive: (pid: number) => boolean;
  /** `~/.claude/projects`, where the session transcripts live. */
  readonly projectsDir: string;
  /** The Claude Code CLI that starts background sessions. */
  readonly claude: string;
  readonly pollIntervalMs?: number;
}

export type Step = { readonly kind: "wake"; readonly text: string } | { readonly kind: "exit"; readonly reason: string } | { readonly kind: "wait" };

export interface ClaudeWatcher {
  /**
   * One loop: liveness and the session's own inbox. Every 30 s it also starts the host poll (when
   * this watcher holds it) in the background: the poll never delays the inbox or liveness checks.
   */
  step(): Promise<Step>;
  /** The host poll in flight, if any (resolved when idle). */
  idle(): Promise<void>;
  /**
   * Admits no new call and waits for the calls already started (lock, delivery and handoff record,
   * each bounded by its own deadlines). Not the whole host poll.
   */
  close(): Promise<void>;
  /**
   * Frees this watcher's host locks (process exit frees them too). Does not wait for the poll in
   * flight: a call it took and did not deliver is lost, and the release watch escalates it.
   */
  release(): Promise<void>;
}

/** Background sessions through the Claude Code CLI: the fork of a session that could not take a call. */
export function createClaudeDelivery(deps: ClaudeDeps): Delivery {
  const { exec, log } = deps;
  async function background(cwd: string, args: readonly string[]): Promise<string> {
    const result = await exec(deps.claude, ["--bg", ...args], { cwd, timeoutMs: FORK_TIMEOUT_MS });
    if (result.code !== 0) throw new Error(`claude --bg saiu ${result.code}: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    const shortId = backgroundId(result.stdout);
    if (!shortId) throw new Error(`claude --bg não imprimiu o id: ${result.stdout.trim().slice(0, 300)}`);
    const listed = await exec(deps.claude, ["agents", "--json", "--all"], { cwd, timeoutMs: 15_000 });
    const session = backgroundSession(listed.code === 0 ? listed.stdout : null, shortId);
    if (!session) throw new Error(`claude --bg ${shortId} não aparece em claude agents`);
    log.info(`claude --bg em ${cwd}: ${shortId} (sessão ${session})`);
    return session;
  }
  return {
    async prompt(target, text, action) {
      const live = (await liveSessions(deps.stateDir, deps.alive)).filter((entry) => entry.sessionId === target.id);
      if (live.length === 0) throw new Error(`sessão ${target.id} sem processo do Claude Code vivo neste host`);
      await writeRequest(deps.stateDir, {
        release: action.release,
        kind: action.kind,
        role: action.role,
        lock: action.lock,
        session: target.id,
        text,
        createdAt: deps.clock.now().toISOString(),
      });
    },
    async fallback(target, text) {
      const transcript = await findTranscript(deps.projectsDir, target.id);
      if (!transcript) throw new Error(`transcript de ${target.id} não está em ${deps.projectsDir}`);
      const cwd = await transcriptCwd(transcript);
      if (!cwd || !existsSync(cwd)) throw new Error(`diretório de ${target.id} sumiu: ${cwd ?? "sem cwd no transcript"}`);
      // Background sessions are confined to a worktree by default (`worktree.bgIsolation`). With the
      // original closed (no live Claude Code process for it on this host) the fork may edit the
      // original checkout: a flag settings layer for this command only, on top of the user's and
      // project's. While the original still runs (a busy turn, or a blocked call picked without
      // taking it) the two could edit the same checkout at once, so the fork keeps the default isolation.
      const live = (await liveSessions(deps.stateDir, deps.alive)).some((entry) => entry.sessionId === target.id);
      const isolation = live ? [] : ["--settings", FORK_SETTINGS];
      return background(cwd, ["--fork-session", "--resume", target.id, ...isolation, text]);
    },
  };
}

/** The note a stored request answers to, with the ref it lives on (for a `recall` failure). */
interface Found {
  readonly key: string;
  readonly ref: string;
  readonly note: Note | BlockedNote;
}

/**
 * Whether a delivered call was taken. An incident call: picked up by the session's watcher, as
 * Paseo and OpenCode take an accepted prompt. A blocked-release call: the blocked note names the
 * session (`blockedConfirmation`: moot when closed or taken by someone else, unknown while the
 * release history cannot tell whether a later release shipped).
 */
export function confirmation(
  request: Request,
  state: RequestState,
  note: BlockedNote | null,
  host: string,
  now: Date,
  shipped: boolean | null,
): "taken" | "open" | "moot" | "unknown" {
  if (request.kind !== "blocked") return state === "picked" ? "taken" : "open";
  return blockedConfirmation(request.role === "fix" ? "fix" : "blocked", { harness: "claude", host, id: request.session }, note, shipped, now);
}

/**
 * Whether an unconfirmed call goes to a fork now. Picked: 2 min after the session got it.
 * Waiting: at once without a live process for the session; with an armed watcher, only past
 * `PICKUP_LIMIT_MS` (it picks within a loop, so a slow loop never counts as silence); with a live
 * process and no watcher (busy turn after a wake), 2 min after the call.
 */
export function due(state: "pending" | "picked", pickedAt: number | null, age: number, now: number, sessions: readonly LiveSession[]): boolean {
  if (state === "picked") return pickedAt === null || now - pickedAt >= ACK_TIMEOUT_MS;
  if (sessions.length === 0) return true;
  if (sessions.some((entry) => entry.armed)) return age >= PICKUP_LIMIT_MS;
  return age >= ACK_TIMEOUT_MS;
}

export function createClaudeWatcher(deps: ClaudeDeps): ClaudeWatcher {
  const { clock, log } = deps;
  const paths = claudePaths(deps.stateDir);
  const pollInterval = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  let lastPoll = -Infinity;
  let config: HostConfig | null = null;
  let core: Watcher | null = null;
  let tracker: ReleaseTracker | null = null;
  // Once a wake (or Claude Code's death) begins, the process is about to exit: no new call starts
  // (its lock is not taken, so the next poller makes it), and the calls already started (lock,
  // delivery, handoff record; a fork or new session inside) finish first, each bounded by its own
  // deadlines. Every other step of a poll may be cut.
  let closing = false;
  const inFlight = new Set<Promise<unknown>>();
  function guard<T>(call: () => Promise<T>): Promise<T | null> {
    if (closing) return Promise.resolve(null);
    const running = call();
    inFlight.add(running);
    const done = () => inFlight.delete(running);
    running.then(done, done);
    return running;
  }
  const delivery = createClaudeDelivery(deps);

  /** The newest note of the request's release on the ref it came from (incident or blocked). */
  function noteFor(request: Request): Found | null {
    const blocked = request.kind === "blocked";
    const ref = blocked ? config?.blockedRef : config?.notesRef;
    const notes: ReadonlyMap<string, Note | BlockedNote> = (blocked ? core?.blockedNotes() : core?.notes()) ?? new Map();
    let found: Found | null = null;
    for (const [key, note] of notes) {
      if (releaseName(note) !== request.release || !ref) continue;
      if (!found || Date.parse(note.updatedAt) > Date.parse(found.note.updatedAt)) found = { key, ref, note };
    }
    return found;
  }

  async function token(): Promise<string> {
    const result = await deps.exec("gh", ["auth", "token"], { timeoutMs: 10_000 });
    const value = result.stdout.trim();
    if (result.code !== 0 || !value) throw new Error(`gh auth token falhou: ${result.stderr.trim()}`);
    return value;
  }

  async function fallBack(request: Request, found: Found | null, host: string): Promise<void> {
    const target: SessionRef = { harness: "claude", host, id: request.session };
    const blocked = request.kind === "blocked";
    try {
      const title = `${blocked ? "Release barrada" : "Incidente"} ${request.release}`;
      const id = await delivery.fallback(target, request.text, title, actionOf(request, target));
      log.warn(`${request.release}: ${formatSession(target)} ${blocked ? "não assumiu" : "não pegou"}; chamado foi para a cópia ${id}`);
      if (found?.note.drill) return;
      await writeHandoff(deps.stateDir, request.release, request.lock, {
        // Every blocked call is recorded as `blocked`, whatever the routing.
        role: blocked ? "blocked" : (request.role as Role),
        session: { harness: "claude", host, id },
        at: clock.now().toISOString(),
      }).catch((error) => log.warn(`${request.release}: registrar o chamado: ${describe(error)}`));
    } catch (error) {
      const reason = `prompt: ${blocked ? "sem confirmação" : "não pego"}; fallback: ${describe(error)}`;
      log.error(`não consegui chamar ${formatSession(target)} para ${request.release} (${request.role}): ${reason}`);
      if (!found || !config) return;
      try {
        const landed = await recordRecallFailure({
          exec: deps.exec,
          gitDir: join(deps.stateDir, "claude.git"),
          repository: config.repository,
          notesRef: found.ref,
          token: await token(),
          key: found.key,
          recall: {
            failedAt: clock.now().toISOString(),
            reason,
            by: `claude/${host}`,
            role: blocked ? "blocked" : request.role,
            target: formatSession(target),
            ...("state" in found.note ? { state: found.note.state } : { rollback: found.note.rollback?.outcome ?? null }),
          },
        });
        if (!landed) log.error(`${request.release}: a falha do chamado não entrou na nota`);
      } catch (failure) {
        log.error(`${request.release}: gravar a falha na nota: ${describe(failure)}`);
      }
    }
  }

  /**
   * Delivered calls: taken → done; otherwise fork when the session cannot get it (no live process,
   * a live one with no watcher for 2 min, or a watcher that has not picked in 10 min), or, for a
   * blocked call, got it 2 min ago without taking it. `blockedFresh`: the blocked notes match the
   * remote this tick; without that a blocked call is not judged at all, since a confirmation not
   * yet fetched would look like silence.
   */
  async function followUp(host: string, blockedFresh: boolean): Promise<void> {
    const at = clock.now();
    const now = at.getTime();
    // Not loaded, or its last refresh failed: a blocked call cannot be judged (`unknown`).
    const releases = releaseHistory(tracker?.current() ?? null);
    const sessions = await liveSessions(deps.stateDir, deps.alive);
    for (const { path, dir, base, state, pickedAt, request } of await storedRequests(deps.stateDir)) {
      const created = request ? Date.parse(request.createdAt) : NaN;
      const age = Number.isFinite(created) ? now - created : Infinity;
      if (!request || age > CATCH_UP_MS || (state === "fallback" && age > ACK_TIMEOUT_MS + PICKUP_LIMIT_MS + STALE_FALLBACK_MS)) {
        await rm(path, { force: true });
        continue;
      }
      if (state === "fallback") continue;
      if (request.kind === "blocked" && !blockedFresh) continue;
      const found = noteFor(request);
      const blockedNote = request.kind === "blocked" ? ((found?.note as BlockedNote | undefined) ?? null) : null;
      const taken = confirmation(request, state, blockedNote, host, at, blockedNote ? shippedSince(blockedNote, releases) : null);
      if (taken === "unknown") continue;
      if (taken === "taken" || taken === "moot") {
        const verb = request.kind === "blocked" ? "assumiu" : "pegou";
        const outcome = taken === "taken" ? `${request.session} ${verb} o chamado` : `chamado de ${request.session} encerrado`;
        log.info(`${request.release}: ${outcome}`);
        await rm(path, { force: true });
        continue;
      }
      if (!due(state, pickedAt, age, now, sessions.filter((entry) => entry.sessionId === request.session))) continue;
      await guard(async () => {
        const claim = join(dir, `${base}${FALLBACK}`);
        try {
          await rename(path, claim);
        } catch {
          return;
        }
        await fallBack(request, found, host);
        await rm(claim, { force: true });
      });
    }
    // Requests are written only by this poller, so an empty inbox can go (rmdir refuses a full one).
    for (const session of await readdir(paths.inboxRoot).catch(() => [] as string[])) {
      await rmdir(join(paths.inboxRoot, session)).catch(() => undefined);
    }
  }

  let pollerLock: HostLock | null = null;
  let armed = false;

  async function poll(): Promise<void> {
    pollerLock ??= await acquireHostLock(deps.stateDir, POLLER_LOCK, log);
    if (!pollerLock) return;
    core ??= createWatcher({
      harness: "claude",
      host: (value) => value.instance,
      loadConfig: async () => (config = await deps.loadConfig()),
      stateDir: deps.stateDir,
      sha: deps.sha,
      pid: deps.pid,
      clock,
      fetch: deps.fetch,
      exec: deps.exec,
      delivery,
      log,
      guard,
      // Blocked calls are confirmed by `followUp` below, through the inbox.
      confirmsCalls: true,
      release: (tracker = createReleaseTracker({
        source: createReleaseSource({
          fetch: deps.fetch,
          clock,
          log,
          handoffs: (release) => readHandoffs(deps.stateDir, release),
        }),
        clock,
        log,
      })),
    });
    const report = await core.tick();
    if (!config || report.poll === "config-error" || report.poll === "token-error") return;
    const blockedFresh = report.blocked === "unchanged" || report.blocked === "missing" || (report.blocked === "changed" && report.blockedFetched);
    await followUp(config.instance, blockedFresh);
  }

  let polling: Promise<void> | null = null;

  return {
    async step() {
      if (!deps.alive(deps.claudePid)) return { kind: "exit", reason: `Claude Code ${deps.claudePid} encerrou` };
      if (!armed) {
        armed = await armWatcher(deps.stateDir, deps.claudePid, deps.pid, deps.alive);
        if (!armed) return { kind: "exit", reason: `outro vigia já atende o Claude Code ${deps.claudePid}` };
      }
      const session = await sessionOf(deps.stateDir, deps.claudePid);
      if (session) {
        const request = await pickRequest(deps.stateDir, session, clock.now());
        if (request) {
          log.info(`${request.release}: acordando a sessão ${session} (${request.role})`);
          return { kind: "wake", text: request.text };
        }
      }
      const now = clock.now().getTime();
      if (!polling && now - lastPoll >= pollInterval) {
        lastPoll = now;
        polling = poll()
          .catch((error) => log.error(`consulta: ${describe(error)}`))
          .finally(() => {
            polling = null;
          });
      }
      return { kind: "wait" };
    },
    idle: () => polling ?? Promise.resolve(),
    async close() {
      closing = true;
      // No call is admitted from here on, so the set only shrinks.
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
    async release() {
      const lock = pollerLock;
      pollerLock = null;
      if (armed) await disarmWatcher(deps.stateDir, deps.claudePid, deps.pid).catch(() => undefined);
      armed = false;
      await lock?.release();
    },
  };
}

/** Loops `step` until the session must wake (exit 2 with the prompt) or the watcher is done (exit 0). */
export async function runWatcher(watcher: ClaudeWatcher, sleep: (ms: number) => Promise<void>, log: Logger): Promise<{ code: 0 | 2; text?: string }> {
  for (;;) {
    let step: Step;
    try {
      step = await watcher.step();
    } catch (error) {
      log.error(`vigia: ${describe(error)}`);
      step = { kind: "wait" };
    }
    if (step.kind === "wake") {
      // Not the whole host poll: only the calls it already started.
      await watcher.close();
      await watcher.release();
      return { code: 2, text: step.text };
    }
    if (step.kind === "exit") {
      log.info(step.reason);
      await watcher.close();
      await watcher.release();
      return { code: 0 };
    }
    await sleep(INBOX_INTERVAL_MS);
  }
}
