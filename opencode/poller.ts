// OpenCode poller: one per process for the whole process lifetime, one holder per host.
//
// OpenCode V2 instantiates plugins per location and disposes them when the location is evicted
// (`experimental.location_idle_timeout`, 60 min by default). A disposed context's `session.*` keeps
// working: calls route to the session's own location and load it again on demand. So the poller
// outlives every dispose and keeps the latest context; a reloaded plugin file (another build SHA)
// stops the previous poller and takes over in the same process.
//
// Only the holder of the host lock `opencode.poller` (a TCP listener on 127.0.0.1, freed by the
// kernel when the process dies and by `stop` on a reload) polls; another process takes it on its
// next cycle. The heartbeat is written only after the context answered.
import { join } from "node:path";
import type { Delivery } from "../core/deliver.ts";
import { acquireHostLock, readHandoffs, type HostLock } from "../core/host.ts";
import { describe } from "../core/poll.ts";
import { createReleaseSource, createReleaseTracker } from "../core/release-fetch.ts";
import { HEARTBEAT_MS } from "../core/route.ts";
import type { Clock, Exec, Fetch, HostConfig, Logger, SessionRef } from "../core/types.ts";
import { createWatcher, type Watcher } from "../core/watcher.ts";

/** The slice of the OpenCode plugin context this plugin uses (runtime objects carry more). */
export interface SessionInfo {
  readonly id: string;
  /** The session that spawned this one (a subagent's lane). */
  readonly parentID?: string;
  readonly location?: { readonly directory?: string };
  /** `busy` is the start of the current or last turn, `idle` its end (epoch ms or a date). */
  readonly time?: { readonly updated?: Instant; readonly busy?: Instant; readonly idle?: Instant };
}

type Instant = number | string | Date;

function millis(value: Instant | undefined): number | null {
  if (value === undefined) return null;
  const ms = typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** In a turn (`busy` after the last `idle`), or updated in the last 10 min. */
export function sessionWorking(session: SessionInfo, now: number): boolean {
  const busy = millis(session.time?.busy);
  const idle = millis(session.time?.idle);
  if (busy !== null && (idle === null || busy > idle)) return true;
  const updated = millis(session.time?.updated);
  return updated !== null && now - updated < HEARTBEAT_MS;
}

/** Child sessions are followed this deep at most (a cycle cannot loop). */
const MAX_DEPTH = 10;
export interface Context {
  readonly location?: { readonly directory?: string };
  readonly session: {
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    create(input: { title?: string; parentID?: string; location?: { directory: string } }): Promise<SessionInfo>;
    get(input: { sessionID: string }): Promise<SessionInfo>;
    list(input?: { limit?: number; order?: "asc" | "desc"; parentID?: string }): Promise<{ data?: SessionInfo[] } | SessionInfo[]>;
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

/** Host lock of the OpenCode poller (a TCP listener, `acquireHostLock`). */
export const POLLER_LOCK = "opencode.poller";

const defaultTimer: Timer = {
  set: (run, ms) => setTimeout(run, ms).unref(),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

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
export function createDelivery(registry: Registry, limits: { timer: Timer; timeoutMs: number } = { timer: defaultTimer, timeoutMs: 10_000 }): Delivery {
  const context = (): Context => {
    if (!registry.ctx) throw new Error("nenhum contexto OpenCode carregado");
    return registry.ctx;
  };
  // Lease checks run inside the tick: a context that does not answer must not hold it.
  const bounded = <T>(promise: Promise<T>, what: string) => within(promise, limits.timeoutMs, limits.timer, what);
  const get = (sessionID: string) => bounded(context().session.get({ sessionID }), "session.get");
  async function children(parentID: string): Promise<SessionInfo[]> {
    const listed = await bounded(context().session.list({ parentID }), "session.list");
    const all = Array.isArray(listed) ? listed : (listed.data ?? []);
    return all.filter((session) => session.parentID === parentID);
  }
  async function promptNew(session: SessionInfo, text: string): Promise<string> {
    await context().session.prompt({ sessionID: session.id, text });
    return session.id;
  }
  return {
    async promptCandidate(target: SessionRef, text: string, key: string) {
      await bounded(context().session.prompt({ sessionID: target.id, text }), 'candidate.prompt');
      return `opencode:${key}`;
    },
    async prompt(target: SessionRef, text: string) {
      await context().session.prompt({ sessionID: target.id, text });
    },
    async resolveRoot(target: SessionRef) {
      let id = target.id;
      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const parent = (await get(id)).parentID;
        if (!parent || parent === id) break;
        id = parent;
      }
      return { ...target, id };
    },
    // The session or one of its children (subagents, down to MAX_DEPTH): a parent waits idle
    // while its subagents work.
    async isWorking(target: SessionRef) {
      const now = Date.now();
      if (sessionWorking(await get(target.id), now)) return true;
      let level = [target.id];
      const seen = new Set(level);
      for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
        const next: string[] = [];
        for (const id of level) {
          for (const child of await children(id)) {
            if (sessionWorking(child, now)) return true;
            if (!seen.has(child.id)) {
              seen.add(child.id);
              next.push(child.id);
            }
          }
        }
        level = next;
      }
      return false;
    },
    async open(directory: string, text: string, title: string) {
      return promptNew(await context().session.create({ title, location: { directory } }), text);
    },
    async fallback(target: SessionRef, text: string, title: string) {
      const ctx = context();
      const original = await ctx.session.get({ sessionID: target.id });
      const directory = original.location?.directory;
      if (!directory) throw new Error(`sessão ${target.id} sem diretório`);
      return promptNew(await ctx.session.create({ title, parentID: target.id, location: { directory } }), text);
    },
  };
}

function startPoller(registry: Registry, deps: PollerDeps, handover: Promise<void>): Poller {
  const { log, timer } = deps;
  let watcher: Watcher | null = null;
  let lock: HostLock | null = null;
  let ready: boolean | null = null;
  let stopped = false;
  let handle: unknown = null;
  let running: Promise<void> = Promise.resolve();

  async function cycle(): Promise<void> {
    if (!lock) {
      lock = await acquireHostLock(deps.stateDir, POLLER_LOCK, log);
      if (!lock) return;
      log.info(`poller do host: pid ${deps.pid}, porta ${lock.port}`);
    }
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
      loadConfig: deps.loadConfig,
      stateDir: deps.stateDir,
      sha: deps.sha,
      pid: deps.pid,
      clock: deps.clock,
      fetch: deps.fetch,
      exec: deps.exec,
      delivery: createDelivery(registry, { timer, timeoutMs: deps.probeTimeoutMs }),
      log,
      // No release UI here: the history only tells whether a later release shipped (closes a blocked call).
      release: createReleaseTracker({
        source: createReleaseSource({
          fetch: deps.fetch,
          clock: deps.clock,
          log,
          handoffs: (release) => readHandoffs(deps.stateDir, release),
        }),
        clock: deps.clock,
        log,
      }),
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
      // An in-process reload starts the next poller right after: it acquires at once.
      await lock?.release();
      lock = null;
    },
  };
}
