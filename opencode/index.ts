// OpenCode V2 plugin. One poller per host: OpenCode loads plugins per server and per instance, so
// every load registers here and only the holder of `~/.local/state/agent-recall/opencode.poller`
// polls. A dead holder's pid is taken over on the next cycle.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Delivery } from "../core/deliver.ts";
import { nodeExec } from "../core/exec.ts";
import { isAlive, loadConfig, stateDirectory } from "../core/host.ts";
import { describe, POLL_INTERVAL_MS } from "../core/poll.ts";
import type { Exec, HostConfig, Logger, SessionRef } from "../core/types.ts";
import { createWatcher, type Watcher } from "../core/watcher.ts";

declare const AGENT_RECALL_BUILD_SHA: string;

/** The slice of the OpenCode plugin context this plugin uses (runtime objects carry more). */
interface SessionInfo {
  readonly id: string;
  readonly location?: { readonly directory?: string };
}
interface Context {
  readonly location?: { readonly directory?: string };
  readonly session: {
    prompt(input: { sessionID: string; text: string }): Promise<unknown>;
    create(input: { title?: string; parentID?: string; location?: { directory: string } }): Promise<SessionInfo>;
    get(input: { sessionID: string }): Promise<SessionInfo>;
    list(input?: { limit?: number; order?: "asc" | "desc" }): Promise<{ data?: SessionInfo[] } | SessionInfo[]>;
    fork?(input: { sessionID: string }): Promise<SessionInfo>;
  };
}

const log: Logger = {
  info: (message) => console.log(`[agent-recall] ${message}`),
  warn: (message) => console.warn(`[agent-recall] ${message}`),
  error: (message) => console.error(`[agent-recall] ${message}`),
};

interface Registry {
  readonly contexts: Set<Context>;
  stop: (() => Promise<void>) | null;
}

const KEY = Symbol.for("dbolt.agent-recall.opencode");
const registry: Registry = ((globalThis as Record<symbol, unknown>)[KEY] as Registry | undefined) ??
  ((globalThis as Record<symbol, unknown>)[KEY] = { contexts: new Set<Context>(), stop: null } as Registry);

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
export async function claimPoller(stateDir: string, pid = process.pid): Promise<boolean> {
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

async function releasePoller(stateDir: string, pid = process.pid): Promise<void> {
  const path = pollerPath(stateDir);
  if ((await readHolder(path).catch(() => 0)) === pid) await rm(path, { force: true });
}

/** Commit of the installed plugin: `agent-recall.sha` beside the file, else the build's commit. */
async function installedSha(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const sidecar = (await readFile(join(here, "agent-recall.sha"), "utf8").catch(() => "")).trim();
    if (/^[0-9a-f]{7,40}$/.test(sidecar)) return sidecar;
  } catch {
    // import.meta.url is not a file URL in some loaders.
  }
  return typeof AGENT_RECALL_BUILD_SHA === "string" ? AGENT_RECALL_BUILD_SHA : "unknown";
}

function opencodeBinary(): string {
  return /opencode/.test(process.execPath) ? process.execPath : "opencode";
}

function anyContext(): Context {
  const first = registry.contexts.values().next();
  if (first.done) throw new Error("nenhuma instância OpenCode carregada");
  return first.value;
}

async function originMatches(exec: Exec, cwd: string, repository: string): Promise<boolean> {
  if (!existsSync(cwd)) return false;
  const origin = await exec("git", ["-C", cwd, "remote", "get-url", "origin"], { timeoutMs: 10_000 });
  return origin.code === 0 && new RegExp(`[/:]${repository}(\\.git)?$`).test(origin.stdout.trim());
}

function createDelivery(exec: Exec, config: () => HostConfig): Delivery {
  async function promptNew(session: SessionInfo, text: string): Promise<string> {
    await anyContext().session.prompt({ sessionID: session.id, text });
    return session.id;
  }
  async function fork(sessionID: string): Promise<SessionInfo> {
    const ctx = anyContext();
    if (typeof ctx.session.fork === "function") return ctx.session.fork({ sessionID });
    const result = await exec(opencodeBinary(), ["api", "post", `/api/session/${sessionID}/fork`, "--data", "{}"], {
      timeoutMs: 30_000,
    });
    const id = (() => {
      try {
        return (JSON.parse(result.stdout) as { data?: { id?: string } }).data?.id;
      } catch {
        return undefined;
      }
    })();
    if (result.code !== 0 || !id) throw new Error(`fork: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    return { id };
  }
  return {
    async prompt(target: SessionRef, text: string) {
      await anyContext().session.prompt({ sessionID: target.id, text });
    },
    async fallback(target: SessionRef, text: string, title: string) {
      try {
        return await promptNew(await fork(target.id), text);
      } catch (error) {
        log.warn(`fork de ${target.id}: ${describe(error)}; tentando sessão filha`);
      }
      const ctx = anyContext();
      const original = await ctx.session.get({ sessionID: target.id });
      const directory = original.location?.directory;
      if (!directory) throw new Error(`sessão ${target.id} sem diretório`);
      return promptNew(await ctx.session.create({ title, parentID: target.id, location: { directory } }), text);
    },
    async create(text: string, title: string) {
      const { repository } = config();
      const ctx = anyContext();
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

function startPoller(): () => Promise<void> {
  const exec = nodeExec;
  const stateDir = stateDirectory();
  let current: HostConfig | null = null;
  let watcher: Watcher | null = null;
  let stopped = false;
  let holding = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<unknown> = Promise.resolve();

  async function cycle(): Promise<void> {
    const own = await claimPoller(stateDir);
    if (own !== holding) log.info(own ? `poller do host: pid ${process.pid}` : `poller do host é outro processo`);
    holding = own;
    if (!own) return;
    if (!watcher) {
      const sha = await installedSha();
      log.info(`iniciado: SHA ${sha.slice(0, 12)}, pid ${process.pid}`);
      watcher = createWatcher({
        harness: "opencode",
        host: (config) => config.instance,
        loadConfig: async () => (current = await loadConfig()),
        stateDir,
        sha,
        pid: process.pid,
        clock: { now: () => new Date() },
        fetch: (input, init) => fetch(input, init),
        exec,
        delivery: createDelivery(exec, () => current!),
        log,
      });
    }
    await watcher.tick();
  }

  const loop = (): void => {
    if (stopped) return;
    running = cycle()
      .catch((error) => log.error(`ciclo: ${describe(error)}`))
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, POLL_INTERVAL_MS);
      });
  };
  loop();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
    await releasePoller(stateDir).catch(() => undefined);
  };
}

export default {
  id: "agent-recall",
  setup(ctx: Context) {
    registry.contexts.add(ctx);
    registry.stop ??= startPoller();
    return async () => {
      registry.contexts.delete(ctx);
      if (registry.contexts.size === 0 && registry.stop) {
        const stop = registry.stop;
        registry.stop = null;
        await stop();
      }
    };
  },
};
