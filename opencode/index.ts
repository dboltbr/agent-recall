// OpenCode V2 plugin entry: the single default export OpenCode loads. The poller lives in
// ./poller.ts and is shared by every load in the process through `globalThis`.
import { nodeExec } from "../core/exec.ts";
import { loadConfig, stateDirectory } from "../core/host.ts";
import { POLL_INTERVAL_MS } from "../core/poll.ts";
import type { Logger } from "../core/types.ts";
import { attach, registryIn, type Context, type Timer } from "./poller.ts";

/** Source commit of this bundle, set by scripts/build-opencode.mjs. */
declare const AGENT_RECALL_BUILD_SHA: string;

const log: Logger = {
  info: (message) => console.log(`[agent-recall] ${message}`),
  warn: (message) => console.warn(`[agent-recall] ${message}`),
  error: (message) => console.error(`[agent-recall] ${message}`),
};

// Unref'd: the poller must never keep a shutting-down server alive.
const timer: Timer = {
  set: (run, ms) => setTimeout(run, ms).unref(),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const registry = registryIn(globalThis as Record<symbol, unknown>, Symbol.for("dbolt.agent-recall.opencode.poller"));

export default {
  id: "agent-recall",
  // No dispose: the poller and the newest context outlive location eviction (see ./poller.ts).
  setup(ctx: Context) {
    attach(registry, ctx, {
      sha: typeof AGENT_RECALL_BUILD_SHA === "string" ? AGENT_RECALL_BUILD_SHA : "unknown",
      stateDir: stateDirectory(),
      pid: process.pid,
      clock: { now: () => new Date() },
      fetch: (input, init) => fetch(input, init),
      exec: nodeExec,
      loadConfig: () => loadConfig(),
      log,
      intervalMs: POLL_INTERVAL_MS,
      timer,
      probeTimeoutMs: 10_000,
    });
  },
};
