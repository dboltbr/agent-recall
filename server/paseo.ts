// Paseo adapter. `server/core/` is a committed copy of `../core/` made by `scripts/sync-core.mjs`:
// Paseo only compiles modules under client/, server/ or shared/ and resolves symlinks, so the copy
// is what installs from git. `core/test/sync.test.ts` fails when the copy drifts.
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Delivery } from "./core/deliver.ts";
import { nodeExec } from "./core/exec.ts";
import { loadConfig, stateDirectory } from "./core/host.ts";
import { describe } from "./core/poll.ts";
import { HEARTBEAT_MS } from "./core/route.ts";
import { cancelUpdates, scheduleUpdates, updatePaseo } from "./core/self-update.ts";
import type { Exec, Logger, SessionRef } from "./core/types.ts";
import { createWatcher } from "./core/watcher.ts";
import { createReleaseService, type ReleaseService } from "./release.ts";

const REPO = "dboltbr/agent-recall";
const UPDATE_KEY = Symbol.for("dbolt.agent-recall.paseo.update");
const CLI_TIMEOUT_MS = 30_000;

const log: Logger = {
  info: (message) => console.log(`[agent-recall] ${message}`),
  warn: (message) => console.warn(`[agent-recall] ${message}`),
  error: (message) => console.error(`[agent-recall] ${message}`),
};

function paseoHome(): string {
  return process.env["PASEO_HOME"] || join(homedir(), ".paseo");
}

async function paseo(exec: Exec, args: readonly string[]): Promise<string> {
  const result = await exec("paseo", [...args, "--home", paseoHome()], { timeoutMs: CLI_TIMEOUT_MS });
  if (result.code !== 0) throw new Error(`paseo ${args[0]}: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
  return result.stdout;
}

/** Installed commit: `paseo plugin ls --json` (git source), else the checkout's HEAD. */
async function installedSha(exec: Exec): Promise<string> {
  try {
    const plugins = JSON.parse(await paseo(exec, ["plugin", "ls", "--json"])) as Array<Record<string, unknown>>;
    const mine = plugins.find(
      (p) => p["id"] === "agent-recall" || (typeof p["remote"] === "string" && (p["remote"] as string).includes(REPO)),
    );
    if (typeof mine?.["commit"] === "string") return mine["commit"] as string;
    if (typeof mine?.["path"] === "string") {
      const head = await exec("git", ["-C", mine["path"] as string, "rev-parse", "HEAD"], { timeoutMs: 10_000 });
      if (head.code === 0) return head.stdout.trim();
    }
  } catch (error) {
    log.warn(`SHA instalado: ${describe(error)}`);
  }
  return "unknown";
}

interface AgentRecord {
  readonly id?: string;
  readonly title?: string | null;
  readonly workspaceId?: string;
  readonly provider?: string;
  readonly cwd?: string;
  readonly config?: { readonly model?: string; readonly modeId?: string; readonly thinkingOptionId?: string };
  readonly persistence?: { readonly sessionId?: string | null } | null;
  readonly labels?: Readonly<Record<string, string>> | null;
}

/** A lane's label: the agent that spawned it. */
const PARENT_LABEL = "paseo.parent-agent-id";
/** The daemon the parent agent lives on; absent on agents older than the label. */
const PARENT_SERVER_LABEL = "paseo.parent-server-id";
/** Lanes of lanes are followed this deep at most (a cycle in the records cannot loop). */
const MAX_DEPTH = 10;

/** The daemon's agent record (`$PASEO_HOME/agents/<project>/<id>.json`): workspace and model. */
async function agentRecord(id: string): Promise<AgentRecord | null> {
  const root = join(paseoHome(), "agents");
  for (const project of await readdir(root).catch(() => [] as string[])) {
    const raw = await readFile(join(root, project, `${id}.json`), "utf8").catch(() => null);
    if (raw) return JSON.parse(raw) as AgentRecord;
  }
  return null;
}

/** The agent whose OpenCode session is `sessionId` (record `persistence.sessionId`), or null. */
async function agentOfSession(sessionId: string): Promise<string | null> {
  const root = join(paseoHome(), "agents");
  for (const project of await readdir(root).catch(() => [] as string[])) {
    for (const file of await readdir(join(root, project)).catch(() => [] as string[])) {
      if (!file.endsWith(".json")) continue;
      const raw = await readFile(join(root, project, file), "utf8").catch(() => null);
      if (!raw?.includes(sessionId)) continue;
      const record = JSON.parse(raw) as AgentRecord;
      if (record.provider === "opencode" && record.persistence?.sessionId === sessionId) return record.id ?? file.slice(0, -5);
    }
  }
  return null;
}

/** `paseo ls --json` entry. */
interface ListedAgent {
  readonly id?: string;
  readonly status?: string;
}

export function createDelivery(exec: Exec, stateDir: string, serverId: string): Delivery {
  /** Live agents whose parent is `id` (`paseo ls` leaves archived ones out). */
  async function children(id: string): Promise<ListedAgent[]> {
    const out = await paseo(exec, ["ls", "--global", "--background", "--label", `${PARENT_LABEL}=${id}`, "--json"]);
    const listed = JSON.parse(out) as unknown;
    return Array.isArray(listed) ? (listed as ListedAgent[]) : [];
  }
  async function run(args: string[], text: string): Promise<string> {
    const out = await paseo(exec, ["run", "--no-wait", "--json", ...args, text]);
    const id = (JSON.parse(out) as { agentId?: string }).agentId;
    if (!id) throw new Error("paseo run sem agentId");
    return id;
  }
  return {
    async prompt(target: SessionRef, text: string) {
      const file = join(stateDir, `prompt-${process.pid}-${Date.now()}.txt`);
      await writeFile(file, text, "utf8");
      try {
        // Steer: a busy agent takes the call inside its turn instead of losing it to an interrupt
        // (the CLI default for a caller outside an agent); Paseo interrupts only when it cannot steer.
        await paseo(exec, ["send", target.id, "--prompt-file", file, "--behavior", "steer", "--no-wait"]);
      } finally {
        await rm(file, { force: true });
      }
    },
    // Up the parents this daemon holds: a parent on another daemon (`paseo.parent-server-id`) or
    // without a record here cannot be called from here, the last one that can is the root.
    async resolveRoot(target: SessionRef) {
      let id = target.id;
      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const labels = (await agentRecord(id))?.labels;
        const parent = labels?.[PARENT_LABEL];
        if (typeof parent !== "string" || !parent || parent === id) break;
        const server = labels?.[PARENT_SERVER_LABEL];
        if (typeof server === "string" && server && server !== serverId) break;
        if (!(await agentRecord(parent))) break;
        id = parent;
      }
      return { ...target, id };
    },
    // In a turn or active in the last 10 min, or one of its lanes (down the parent label) running:
    // an orchestrator waits idle while its lanes do the work.
    async isWorking(target: SessionRef) {
      const agent = JSON.parse(await paseo(exec, ["inspect", target.id, "--json"])) as { Status?: unknown; UpdatedAt?: unknown };
      if (agent.Status === "running") return true;
      const updated = typeof agent.UpdatedAt === "string" ? Date.parse(agent.UpdatedAt) : Number.NaN;
      if (Number.isFinite(updated) && Date.now() - updated < HEARTBEAT_MS) return true;
      let level = [target.id];
      const seen = new Set(level);
      for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
        const next: string[] = [];
        for (const id of level) {
          for (const child of await children(id)) {
            if (child.status === "running") return true;
            if (child.id && !seen.has(child.id)) {
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
      return run(["--cwd", directory, "--title", title], text);
    },
    async fallback(target: SessionRef, text: string, title: string) {
      const record = await agentRecord(target.id);
      if (!record?.workspaceId) throw new Error(`agente ${target.id} sem registro de workspace`);
      const provider = record.config?.model ? `${record.provider}/${record.config.model}` : record.provider;
      const args = ["--workspace", record.workspaceId, "--title", title];
      if (provider) args.push("--provider", provider);
      if (record.config?.modeId) args.push("--mode", record.config.modeId);
      if (record.config?.thinkingOptionId) args.push("--thinking", record.config.thinkingOptionId);
      return run(args, text);
    },
  };
}

export interface PaseoRecall {
  readonly release: ReleaseService;
  stop(): Promise<void>;
}

/** Starts the poller (which also ticks the release tracker); returns its stop and the release view. */
export function startPaseoRecall(): PaseoRecall {
  const exec = nodeExec;
  const stateDir = stateDirectory();
  const clock = { now: () => new Date() };
  let stop: (() => Promise<void>) | null = null;
  let stopped = false;
  const release = createReleaseService({
    fetch: (input, init) => fetch(input, init),
    clock,
    log,
    stateDir,
    agent: async (id) => {
      const record = await agentRecord(id);
      return record ? { title: record.title ?? null, workspaceId: record.workspaceId ?? null } : null;
    },
    agentOfSession,
  });
  const boot = (async () => {
    const serverId = (await readFile(join(paseoHome(), "server-id"), "utf8")).trim();
    const sha = await installedSha(exec);
    if (stopped) return;
    log.info(`iniciado: host ${serverId}, SHA ${sha.slice(0, 12)}, pid ${process.pid}`);
    release.setHost(serverId);
    const watcher = createWatcher({
      harness: "paseo",
      host: () => serverId,
      loadConfig: () => loadConfig(),
      stateDir,
      sha,
      pid: process.pid,
      clock,
      fetch: (input, init) => fetch(input, init),
      exec,
      delivery: createDelivery(exec, stateDir, serverId),
      log,
      release: release.tracker,
    });
    stop = watcher.start();
    // Now and every 30 min, in the background and never awaited by stop(): applying an update
    // stops this plugin, and stop() cancels the schedule; the reloaded plugin starts its own.
    scheduleUpdates(globalThis as Record<symbol, unknown>, UPDATE_KEY, () =>
      updatePaseo({
        exec,
        log,
        clock,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
        home: paseoHome(),
        stateDir,
      }),
    );
  })().catch((error) => log.error(`não iniciou: ${describe(error)}`));
  return {
    release,
    async stop() {
      stopped = true;
      await boot;
      cancelUpdates(globalThis as Record<symbol, unknown>, UPDATE_KEY);
      await stop?.();
    },
  };
}
