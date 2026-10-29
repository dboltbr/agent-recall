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
import { firstIn, updatePaseo } from "./core/self-update.ts";
import type { Exec, HostConfig, Logger, SessionRef } from "./core/types.ts";
import { createWatcher } from "./core/watcher.ts";
import { createReleaseService, type ReleaseService } from "./release.ts";

const REPO = "dboltbr/agent-recall";
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
}

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

async function originMatches(exec: Exec, cwd: string, repository: string): Promise<boolean> {
  const origin = await exec("git", ["-C", cwd, "remote", "get-url", "origin"], { timeoutMs: 10_000 });
  return origin.code === 0 && new RegExp(`[/:]${repository}(\\.git)?$`).test(origin.stdout.trim());
}

function createDelivery(exec: Exec, stateDir: string, config: () => HostConfig): Delivery {
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
        await paseo(exec, ["send", target.id, "--prompt-file", file, "--no-wait"]);
      } finally {
        await rm(file, { force: true });
      }
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
    async create(text: string, title: string) {
      const { repository } = config();
      const workspaces = JSON.parse(await paseo(exec, ["workspace", "ls", "--json"])) as Array<{
        workspaceId: string;
        cwd: string;
        isolation?: string;
      }>;
      const preferred = join(homedir(), "dev", "dbolt");
      const ordered = [...workspaces].sort(
        (a, b) => Number(b.cwd === preferred) - Number(a.cwd === preferred) || Number(b.isolation === "local") - Number(a.isolation === "local"),
      );
      for (const workspace of ordered) {
        if (await originMatches(exec, workspace.cwd, repository)) return run(["--workspace", workspace.workspaceId, "--title", title], text);
      }
      throw new Error(`nenhum workspace Paseo com checkout de ${repository}`);
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
  let current: HostConfig | null = null;
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
      loadConfig: async () => (current = await loadConfig()),
      stateDir,
      sha,
      pid: process.pid,
      clock,
      fetch: (input, init) => fetch(input, init),
      exec,
      delivery: createDelivery(exec, stateDir, () => current!),
      log,
      release: release.tracker,
    });
    stop = watcher.start();
    // In the background and never awaited by stop(): applying an update stops this plugin.
    if (firstIn(globalThis as Record<symbol, unknown>, Symbol.for("dbolt.agent-recall.paseo.update"))) {
      void updatePaseo({
        exec,
        log,
        clock,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
        home: paseoHome(),
        stateDir,
      });
    }
  })().catch((error) => log.error(`não iniciou: ${describe(error)}`));
  return {
    release,
    async stop() {
      stopped = true;
      await boot;
      await stop?.();
    },
  };
}
