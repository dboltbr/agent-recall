import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { HandoffSchema, type Handoff } from "./release-status.ts";
import type { Harness, HostConfig } from "./types.ts";

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
  return {
    instance,
    incidentHost: value["incidentHost"] === true,
    repository: text("repository", "dboltbr/dbolt"),
    notesRef: text("notesRef", "refs/notes/release-watch"),
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
 * Atomic `mkdir` of `<stateDir>/<release>/<leaf>`: true for the one caller that created it.
 * Losing the state directory costs at most one repeated recall, which the note already absorbs.
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
