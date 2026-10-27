// OpenCode poller: one per process for the whole process lifetime, one holder per host.
//
// OpenCode V2 instantiates plugins per location and disposes them when the location is evicted
// (`experimental.location_idle_timeout`, 60 min by default). A disposed context's `session.*` keeps
// working: calls route to the session's own location and load it again on demand. So the poller
// outlives every dispose and keeps the latest context; a reloaded plugin file (another build SHA)
// stops the previous poller and takes over in the same process.
//
// Only the holder of `~/.local/state/agent-recall/opencode.poller` polls; a dead holder's pid is
// taken over on the next cycle. The heartbeat is written only after the context answered.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Delivery } from "../core/deliver.ts";
import { isAlive } from "../core/host.ts";
import { describe } from "../core/poll.ts";
import type { Clock, Exec, Fetch, HostConfig, Logger, SessionRef } from "../core/types.ts";
import { createWatcher, type Watcher } from "../core/watcher.ts";

/** The slice of the OpenCode plugin context this plugin uses (runtime objects carry more). */
export interface SessionInfo {
  readonly id: string;
  readonly location?: { readonly directory?: string };
}
export interface Context {
  readonly location?: { readonly directory?: string };
  readonly session: {
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    create(input: { title?: string; parentID?: string; location?: { directory: string } }): Promise<SessionInfo>;
    get(input: { sessionID: string }): Promise<SessionInfo>;
    list(input?: { limit?: number; order?: "asc" | "desc" }): Promise<{ data?: SessionInfo[] } | SessionInfo[]>;
  };
}

export interface Timer {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface PollerDeps {
  readonly sha: string;
  readonly stateDir: string;
  readonly pid: number;
  readonly clock: Clock;
  readonly fetch: Fetch;
  readonly exec: Exec;
  readonly loadConfig: () => Promise<HostConfig>;
  readonly log: Logger;
  readonly intervalMs: number;
  readonly timer: Timer;
  /** Deadline for the context check that gates the heartbeat. */
  readonly probeTimeoutMs: number;
}

export interface Poller {
  readonly sha: string;
  /** The cycle in flight (resolved when idle). */
  idle(): Promise<void>;
  stop(): Promise<void>;
}

/** Process-wide state, shared by every load of the plugin file (one per location and reload). */
export interface Registry {
  ctx: Context | null;
  poller: Poller | null;
}

export function registryIn(scope: Record<symbol, unknown>, key: symbol): Registry {
  return ((scope[key] as Registry | undefined) ??= { ctx: null, poller: null });
}

/** Every plugin load: keep the newest context; start the poller, or take over one of another build. */
export function attach(registry: Registry, ctx: Context, deps: PollerDeps): void {
  registry.ctx = ctx;
  const previous = registry.poller;
  if (previous?.sha === deps.sha) return;
  if (previous) deps.log.info(`SHA ${deps.sha.slice(0, 12)} assume o poller do SHA ${previous.sha.slice(0, 12)}`);
  registry.poller = startPoller(registry, deps, previous ? previous.stop() : Promise.resolve());
}

function pollerPath(stateDir: string): string {
  return join(stateDir, "opencode.poller");
}

async function readHolder(path: string): Promise<number | null> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (raw === null) return null;
  const pid = Number((JSON.parse(raw.trim() || "{}") as { pid?: unknown }).pid);
  return Number.isInteger(pid) ? pid : 0;
}

/** True when this process holds the host poller lock (keeps it, creates it, or takes a dead one). */
export async function claimPoller(stateDir: string, pid: number): Promise<boolean> {
  const path = pollerPath(stateDir);
  await mkdir(stateDir, { recursive: true });
  const body = `${JSON.stringify({ pid })}\n`;
  const holder = await readHolder(path).catch(() => 0);
  if (holder === pid) return true;
  if (holder === null) {
    try {
      await writeFile(path, body, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
  if (isAlive(holder)) return false;
  const tmp = `${path}.${pid}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, path);
  // Two takers can rename at once; the file decides, and the loser yields on this read.
  return (await readHolder(path).catch(() => 0)) === pid;
}

async function originMatches(exec: Exec, cwd: string, repository: string): Promise<boolean> {
  if (!existsSync(cwd)) return false;
  const origin = await exec("git", ["-C", cwd, "remote", "get-url", "origin"], { timeoutMs: 10_000 });
  return origin.code === 0 && new RegExp(`[/:]${repository}(\\.git)?$`).test(origin.stdout.trim());
}

function within<T>(promise: Promise<T>, ms: number, timer: Timer, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = timer.set(() => reject(new Error(`${what}: sem resposta em ${ms} ms`)), ms);
    promise.then(
      (value) => {
        timer.clear(handle);
        resolve(value);
      },
      (error: unknown) => {
        timer.clear(handle);
        reject(error);
      },
    );
  });
}

/**
 * Sessions are reached through the newest context, disposed or not. The plugin API has no fork,
 * so a refused prompt goes to a child session in the original's directory.
 */
export function createDelivery(registry: Registry, exec: Exec, config: () => HostConfig): Delivery {
  const context = (): Context => {
    if (!registry.ctx) throw new Error("nenhum contexto OpenCode carregado");
    return registry.ctx;
  };
  async function promptNew(session: SessionInfo, text: string): Promise<string> {
    await context().session.prompt({ sessionID: session.id, text });
    return session.id;
  }
  return {
    async prompt(target: SessionRef, text: string) {
      await context().session.prompt({ sessionID: target.id, text });
    },
    async fallback(target: SessionRef, text: string, title: string) {
      const ctx = context();
      const original = await ctx.session.get({ sessionID: target.id });
      const directory = original.location?.directory;
      if (!directory) throw new Error(`sessão ${target.id} sem diretório`);
      return promptNew(await ctx.session.create({ title, parentID: target.id, location: { directory } }), text);
    },
    async create(text: string, title: string) {
      const { repository } = config();
      const ctx = context();
      const candidates = [join(homedir(), "dev", "dbolt")];
      const listed = await ctx.session.list({ limit: 50, order: "desc" }).catch(() => [] as SessionInfo[]);
      const sessions = Array.isArray(listed) ? listed : (listed.data ?? []);
      for (const session of sessions) if (session.location?.directory) candidates.push(session.location.directory);
      if (ctx.location?.directory) candidates.push(ctx.location.directory);
      for (const directory of [...new Set(candidates)]) {
        if (await originMatches(exec, directory, repository)) {
          return promptNew(await ctx.session.create({ title, location: { directory } }), text);
        }
      }
      throw new Error(`nenhum checkout de ${repository} neste host`);
    },
  };
}

function startPoller(registry: Registry, deps: PollerDeps, handover: Promise<void>): Poller {
  const { log, timer } = deps;
  let current: HostConfig | null = null;
  let watcher: Watcher | null = null;
  let holding = false;
  let ready: boolean | null = null;
  let stopped = false;
  let handle: unknown = null;
  let running: Promise<void> = Promise.resolve();

  async function cycle(): Promise<void> {
    const own = await claimPoller(deps.stateDir, deps.pid);
    if (own !== holding) log.info(own ? `poller do host: pid ${deps.pid}` : "poller do host é outro processo");
    holding = own;
    if (!own) return;
    const ctx = registry.ctx;
    try {
      if (!ctx) throw new Error("nenhum contexto OpenCode carregado");
      await within(ctx.session.list({ limit: 1 }), deps.probeTimeoutMs, timer, "session.list");
      if (ready !== true) log.info(`entregando: SHA ${deps.sha.slice(0, 12)}, pid ${deps.pid}`);
      ready = true;
    } catch (error) {
      // No heartbeat: the commit hook must see that this process cannot call anyone.
      if (ready !== false) log.error(`sem entrega, heartbeat parado: ${describe(error)}`);
      ready = false;
      return;
    }
    watcher ??= createWatcher({
      harness: "opencode",
      host: (config) => config.instance,
      loadConfig: async () => (current = await deps.loadConfig()),
      stateDir: deps.stateDir,
      sha: deps.sha,
      pid: deps.pid,
      clock: deps.clock,
      fetch: deps.fetch,
      exec: deps.exec,
      delivery: createDelivery(registry, deps.exec, () => current!),
      log,
    });
    await watcher.tick();
  }

  const loop = (): void => {
    if (stopped) return;
    running = cycle()
      .catch((error) => log.error(`ciclo: ${describe(error)}`))
      .finally(() => {
        if (!stopped) handle = timer.set(loop, deps.intervalMs);
      });
  };
  running = handover
    .catch((error) => log.error(`parar o poller anterior: ${describe(error)}`))
    .finally(() => {
      loop();
      return running;
    });

  return {
    sha: deps.sha,
    idle: () => running,
    async stop() {
      stopped = true;
      if (handle !== null) timer.clear(handle);
      await running;
    },
  };
}
