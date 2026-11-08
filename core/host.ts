import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { HandoffSchema, type Handoff } from "./release-status.ts";
import type { Exec, Harness, HostConfig, Logger } from "./types.ts";

export function stateDirectory(home = homedir()): string {
  return join(home, ".local", "state", "agent-recall");
}

export function configPath(home = homedir()): string {
  return join(home, ".config", "agent-recall", "config.json");
}

/** Reads the host config. Throws with the file path when it is missing or malformed. */
export async function loadConfig(path = configPath()): Promise<HostConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`sem ${path}: rode bash scripts/agent-recall.sh install no repo dbolt`);
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${path} não é JSON`);
  }
  const text = (key: string, fallback: string): string => {
    const field = value[key];
    return typeof field === "string" && field.trim() !== "" ? field.trim() : fallback;
  };
  const instance = text("instance", "");
  if (!instance) throw new Error(`${path} sem "instance"`);
  const notesRef = text("notesRef", "refs/notes/release-watch");
  return {
    instance,
    ...(text("factoryApiUrl", "") ? { factoryApiUrl: text("factoryApiUrl", ""), factoryToken: process.env["FACTORY_RECALL_TOKEN"] ?? text("factoryToken", "") } : {}),
    repository: text("repository", "dboltbr/dbolt"),
    notesRef,
    // A drill reads the drill refs of both kinds unless the config names the blocked one.
    blockedRef: text("blockedRef", notesRef.endsWith("-drill") ? "refs/notes/release-blocked-drill" : "refs/notes/release-blocked"),
    // An incident host without a checkout to open the agent in is not one.
    ...(value["incidentHost"] === true && text("incidentCheckout", "") ? { incidentHost: true, incidentCheckout: text("incidentCheckout", "") } : {}),
  };
}

export interface Heartbeat {
  readonly pid: number;
  readonly polledAt: Date;
  readonly sha: string;
}

/** `~/.local/state/agent-recall/<harness>.alive`, replaced atomically. */
export async function writeHeartbeat(stateDir: string, harness: Harness, beat: Heartbeat): Promise<void> {
  const path = join(stateDir, `${harness}.alive`);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const body = { pid: beat.pid, polledAt: beat.polledAt.toISOString(), sha: beat.sha };
  await writeFile(tmp, `${JSON.stringify(body)}\n`, "utf8");
  await rename(tmp, path);
}

const SAFE = /[^A-Za-z0-9._-]/g;

/**
 * Atomic `mkdir` of `<stateDir>/<release>/<leaf>`: true for the one caller that created it, once.
 * A poller that dies between taking a call and delivering it loses that call; the release watch
 * escalates an incident nobody takes within 10 min. Losing the state directory costs at most one
 * repeated recall, which the note already absorbs.
 */
export async function acquireLock(stateDir: string, release: string, leaf: string): Promise<boolean> {
  const parent = join(stateDir, release.replace(SAFE, "_"));
  await mkdir(parent, { recursive: true });
  try {
    await mkdir(join(parent, leaf.replace(SAFE, "_")));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

const HANDOFF_FILE = "handoff.json";

/**
 * Records where a delivered call went, inside the lock directory that guarded it
 * (`<stateDir>/<release>/<lock>/handoff.json`): one writer per directory, so no race between the
 * Paseo and OpenCode pollers of the host. The release surfaces read it back with `readHandoffs`.
 */
export async function writeHandoff(stateDir: string, release: string, lock: string, handoff: Handoff): Promise<void> {
  const dir = join(stateDir, release.replace(SAFE, "_"), lock.replace(SAFE, "_"));
  await mkdir(dir, { recursive: true });
  const path = join(dir, HANDOFF_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(handoff)}\n`, "utf8");
  await rename(tmp, path);
}

/** The calls this host delivered for `release`; unreadable or malformed records are skipped. */
export async function readHandoffs(stateDir: string, release: string): Promise<Handoff[]> {
  const parent = join(stateDir, release.replace(SAFE, "_"));
  const locks = await readdir(parent, { withFileTypes: true }).catch(() => []);
  const out: Handoff[] = [];
  for (const lock of locks) {
    if (!lock.isDirectory()) continue;
    const raw = await readFile(join(parent, lock.name, HANDOFF_FILE), "utf8").catch(() => null);
    if (!raw) continue;
    try {
      const parsed = HandoffSchema.safeParse(JSON.parse(raw));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // A torn or foreign file: the lock still stands, only the link is lost.
    }
  }
  return out;
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `link` publishes a complete file at `path` only when nothing is there: false when something was. */
export async function publishExclusive(path: string, body: string): Promise<boolean> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    // Inside the try: a write that fails midway (ENOSPC, EFBIG) still removes the partial file.
    await writeFile(tmp, body, "utf8");
    await link(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(tmp, { force: true });
  }
}

/*
 * Host locks are TCP listeners on 127.0.0.1: the kernel frees the port when the holder dies, even
 * by SIGKILL, and `release` frees it for an in-process reload. Nothing on disk can go stale. One
 * port per lock, from a hash of the state directory and the lock name, in 20000–31999 (below the
 * Linux and macOS ephemeral ranges). The holder writes `agent-recall <state dir hash> <name> <pid>`
 * to every connection and closes it. A port held by anything that does not answer that line
 * (another program, or silence) means this host does not take the lock at all: no second port.
 */
const LOCK_PORT_BASE = 20_000;
const LOCK_PORT_SPAN = 12_000;
const LOCK_PROBE_MS = 3_000;
const LOCK_RELEASE_MS = 1_000;
const LOCK_BANNER = "agent-recall";
/** Ports already reported as taken by another program, so each watcher logs it once. */
const reportedPorts = new Set<number>();

export interface HostLock {
  readonly name: string;
  readonly port: number;
  /** Frees the port (the next contender acquires at once); bounded by a short deadline. */
  release(): Promise<void>;
}

/** The port of a lock. */
export function lockPort(stateDir: string, name: string): number {
  const digest = createHash("sha256").update(`${stateDir}\0${name}`).digest();
  return LOCK_PORT_BASE + (digest.readUInt32BE(0) % LOCK_PORT_SPAN);
}

/** What the holder of `name` under `stateDir` answers, up to its pid. */
function lockBanner(stateDir: string, name: string): string {
  return `${LOCK_BANNER} ${createHash("sha256").update(stateDir).digest("hex").slice(0, 12)} ${name} `;
}

type Listen = { kind: "held"; server: Server } | { kind: "busy" } | { kind: "error"; error: NodeJS.ErrnoException };

function listenOn(port: number, banner: string): Promise<Listen> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.write(`${banner}${process.pid}\n`, () => socket.destroy());
      socket.setTimeout(LOCK_PROBE_MS, () => socket.destroy());
    });
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "EADDRINUSE" ? { kind: "busy" } : { kind: "error", error }),
    );
    server.listen({ host: "127.0.0.1", port }, () => {
      // The holder must never keep its process alive on its own.
      server.unref();
      resolve({ kind: "held", server });
    });
  });
}

/**
 * Who answers on a port that refused our listen: this lock's holder, nobody (refused: it just
 * died), or something else (another answer, or silence: under WSL mirrored networking even a free
 * port can stay silent, so the port is only probed after a refused listen).
 */
function probeLock(port: number, banner: string): Promise<"ours" | "free" | "other"> {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const finish = (verdict: "ours" | "free" | "other") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(verdict);
    };
    const socket = connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => finish("other"), LOCK_PROBE_MS);
    const verdict = () => (data.startsWith(banner) ? "ours" : "other");
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.includes("\n")) finish(verdict());
    });
    socket.on("close", () => finish(verdict()));
    socket.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" ? "free" : "other"));
  });
}

function closeWithin(server: Server, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * The lock `name` of this host, or null when it is held: by a live holder of this lock, or by
 * another program on its port (logged once; then this host does not take the lock at all).
 */
export async function acquireHostLock(stateDir: string, name: string, log?: Logger): Promise<HostLock | null> {
  const port = lockPort(stateDir, name);
  const banner = lockBanner(stateDir, name);
  // Refused right after a failed listen: the holder just died, so listen again (twice at most).
  for (let attempt = 0; attempt < 3; attempt++) {
    const listened = await listenOn(port, banner);
    if (listened.kind === "held") {
      const { server } = listened;
      return { name, port, release: () => closeWithin(server, LOCK_RELEASE_MS) };
    }
    const verdict = listened.kind === "error" ? "other" : await probeLock(port, banner);
    if (verdict === "ours") return null;
    if (verdict === "other") {
      if (!reportedPorts.has(port)) log?.warn(`porta ${port} ocupada por outro programa: este host não consulta`);
      reportedPorts.add(port);
      return null;
    }
  }
  return null;
}

/** True when `dir` is a checkout whose `origin` is `repository` (`owner/name`). */
export async function isCheckoutOf(exec: Exec, dir: string, repository: string): Promise<boolean> {
  if (!existsSync(dir)) return false;
  const origin = await exec("git", ["-C", dir, "remote", "get-url", "origin"], { timeoutMs: 10_000 });
  return origin.code === 0 && new RegExp(`[/:]${repository}(\\.git)?$`).test(origin.stdout.trim());
}
