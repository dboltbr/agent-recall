// Claude Code hook entry, bundled into claude/dist/watch.mjs and started by claude/bin/watch.sh from
// the plugin's asyncRewake hooks. Nothing goes to stdout; stderr carries only the prompt of a call,
// with exit 2, which Claude Code shows the model as the hook's wake-up message. Everything else goes
// to ~/.local/state/agent-recall/claude/watch.log.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { nodeExec } from "../core/exec.ts";
import { isAlive, loadConfig, stateDirectory } from "../core/host.ts";
import { updateClaude } from "../core/self-update.ts";
import type { Logger } from "../core/types.ts";
import { createClaudeWatcher, parseHookInput, recordSession, runWatcher } from "./watch.ts";

/** Source commit of this bundle, set by scripts/build-claude.mjs. */
declare const AGENT_RECALL_BUILD_SHA: string;

const LOG_MAX_BYTES = 1024 * 1024;
const STDIN_TIMEOUT_MS = 5_000;

/**
 * Variables that tie a process to the Claude Code session that started this hook (as seen in a
 * hook's environment on 2.1.316). Children (`claude --bg`, git, gh) must not inherit them: a
 * background session would take the hook's session for its own.
 */
const SESSION_ENV = [
  "CLAUDECODE",
  // A child session saves no transcript: the fork would be lost.
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_ENV_FILE",
  "CLAUDE_PID",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PROJECT_DIR",
];

function fileLogger(path: string): Logger {
  mkdirSync(join(path, ".."), { recursive: true });
  try {
    if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // No log yet.
  }
  const write = (level: string, message: string) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${process.pid} ${level} ${message}\n`);
    } catch {
      // The log is best effort; stdout and stderr belong to Claude Code.
    }
  };
  return { info: (m) => write("info", m), warn: (m) => write("warn", m), error: (m) => write("error", m) };
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

/** The CLI on PATH, else where the native installer puts it. */
function claudeCommand(home: string): string {
  const candidates = [
    ...(process.env["PATH"] ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "claude")),
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
  ];
  return candidates.find((path) => existsSync(path)) ?? "claude";
}

async function main(): Promise<number> {
  const home = homedir();
  const stateDir = stateDirectory(home);
  const log = fileLogger(join(stateDir, "claude", "watch.log"));
  const claudePid = Number(process.env["CLAUDE_PID"]);
  for (const name of SESSION_ENV) delete process.env[name];
  if (!Number.isInteger(claudePid) || claudePid <= 1) {
    log.warn("hook sem CLAUDE_PID: nada a vigiar");
    return 0;
  }
  const clock = { now: () => new Date() };
  const input = parseHookInput(await readStdin());
  if (input) await recordSession(stateDir, claudePid, input, clock).catch((error) => log.error(`mapa pid→sessão: ${String(error)}`));
  const watcher = createClaudeWatcher({
    stateDir,
    claudePid,
    pid: process.pid,
    sha: typeof AGENT_RECALL_BUILD_SHA === "string" ? AGENT_RECALL_BUILD_SHA : "unknown",
    clock,
    fetch: (url, init) => fetch(url, init),
    exec: nodeExec,
    loadConfig: () => loadConfig(),
    log,
    alive: isAlive,
    projectsDir: join(process.env["CLAUDE_CONFIG_DIR"] || join(home, ".claude"), "projects"),
    claude: claudeCommand(home),
    update: () => updateClaude({ exec: nodeExec, log, clock, claude: claudeCommand(home), stateDir }),
  });
  // `/exit` SIGTERMs live hooks: leave at once; the kernel frees the host locks, and the next
  // poller redoes whatever the poll in flight left half-done.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => process.exit(0));
  const result = await runWatcher(watcher, (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log);
  // The prompt goes out as soon as it was picked, without waiting for the host poll in flight.
  if (result.code === 2) await new Promise<void>((resolve) => process.stderr.write(`${result.text}\n`, () => resolve()));
  return result.code;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0),
);
