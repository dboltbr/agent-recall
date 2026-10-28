// Self-update at startup. OpenCode only checks package plugins on restart (it never installs the
// newer revision) and Paseo only updates on `paseo plugin update`, so each adapter asks its own
// harness, once per process and in the background, to install the newest revision. The new code
// runs on the next OpenCode restart; Paseo activates it right away. Failures are only logged.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe } from "./poll.ts";
import type { Clock, Exec, Logger } from "./types.ts";

export const PACKAGE = "agent-recall";
/** Hard deadline for the whole update, CLI calls included. */
export const UPDATE_DEADLINE_MS = 60_000;
/** A Paseo update to the same commit is not attempted again within this window. */
export const PASEO_RETRY_MS = 30 * 60_000;
const PASEO_CHECK_MS = 15_000;
const PASEO_CHECK_RETRY_DELAY_MS = 10_000;
const PASEO_APPLY_MIN_MS = 15_000;
const PINNED = /#[0-9a-f]{40}$/i;
/** Waits between OpenCode attempts while its background service is still starting. */
export const OPENCODE_RETRY_DELAYS_MS = [5_000, 10_000] as const;
const OPENCODE_ATTEMPT_MIN_MS = 10_000;
// A freshly started `opencode serve --service` answers before it has read the config.
const OPENCODE_COLD = /not configured|No package plugins found/i;

export type UpdateResult = "local" | "pinned" | "current" | "updated" | "throttled" | "failed";

/** True for the first caller per process (the key lives in `scope`, normally `globalThis`). */
export function firstIn(scope: Record<symbol, unknown>, key: symbol): boolean {
  if (scope[key]) return false;
  scope[key] = true;
  return true;
}

function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).pop()?.trim().slice(0, 400) ?? "";
}

/**
 * The configured OpenCode target this bundle was installed from: OpenCode installs a package plugin
 * at `<root>/node_modules/agent-recall/` and writes the configured spec as the dependency in
 * `<root>/package.json`. Null for a local path, a copied file or a dev checkout.
 */
export async function openCodeTarget(moduleUrl: string): Promise<string | null> {
  let path: string;
  try {
    path = fileURLToPath(moduleUrl);
  } catch {
    return null;
  }
  const at = path.lastIndexOf(`${sep}node_modules${sep}${PACKAGE}${sep}`);
  if (at < 0) return null;
  const raw = await readFile(join(path.slice(0, at), "package.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const spec = (JSON.parse(raw) as { dependencies?: Record<string, unknown> }).dependencies?.[PACKAGE];
    return typeof spec === "string" && spec.trim() !== "" ? spec.trim() : null;
  } catch {
    return null;
  }
}

/** The OpenCode binary running this plugin, so the update uses the same version; else PATH. */
export function openCodeCommand(execPath: string): string {
  return /^opencode(\.exe)?$/i.test(basename(execPath)) ? execPath : "opencode";
}

export interface OpenCodeUpdateDeps {
  readonly exec: Exec;
  readonly log: Logger;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  /** `import.meta.url` of the loaded bundle. */
  readonly moduleUrl: string;
  readonly command: string;
}

/**
 * `opencode plugin update <target>`: installs the newest revision for the next restart. The CLI goes
 * through OpenCode's background service; right after that service starts it answers "not
 * configured" or "No package plugins found", so those answers and failed exits are retried within
 * the deadline.
 */
export async function updateOpenCode(deps: OpenCodeUpdateDeps): Promise<UpdateResult> {
  const { exec, log, clock } = deps;
  const started = clock.now().getTime();
  const remaining = (): number => UPDATE_DEADLINE_MS - (clock.now().getTime() - started);
  try {
    const target = await openCodeTarget(deps.moduleUrl);
    if (!target) {
      log.info("autoatualização: carregado de um caminho local, nada a atualizar");
      return "local";
    }
    if (PINNED.test(target)) {
      log.info(`autoatualização: ${target} fixado num commit, nada a atualizar`);
      return "pinned";
    }
    const run = () => exec(deps.command, ["plugin", "update", target], { timeoutMs: remaining() });
    let result = await run();
    for (const delay of OPENCODE_RETRY_DELAYS_MS) {
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.code === 0 && !OPENCODE_COLD.test(output)) break;
      if (remaining() - delay < OPENCODE_ATTEMPT_MIN_MS) break;
      log.info(`autoatualização: serviço do OpenCode ainda subindo (${lastLine(output)}); nova tentativa em ${delay / 1000}s`);
      await deps.sleep(delay);
      result = await run();
    }
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0 || OPENCODE_COLD.test(output)) {
      log.warn(`autoatualização: opencode plugin update ${target} saiu ${result.code}: ${lastLine(result.stderr || result.stdout)}`);
      return "failed";
    }
    if (/^Updated\b/m.test(result.stdout)) {
      log.info(`autoatualização: ${target} atualizado, vale no próximo reinício do OpenCode`);
      return "updated";
    }
    log.info(`autoatualização: ${target} em dia (${lastLine(result.stdout)})`);
    return "current";
  } catch (error) {
    log.warn(`autoatualização: ${describe(error)}`);
    return "failed";
  }
}

export interface PaseoUpdateDeps {
  readonly exec: Exec;
  readonly log: Logger;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  /** `--home` of the daemon that runs this plugin. */
  readonly home: string;
  /** Holds `paseo.update`, the last attempted commit. */
  readonly stateDir: string;
}

interface PaseoPreview {
  readonly id?: string;
  readonly outcome?: string;
  readonly error?: string;
  readonly current?: { readonly identity?: { readonly kind?: string }; readonly currentRevision?: string };
  readonly target?: { readonly kind?: string; readonly commit?: string };
}

interface Attempt {
  readonly commit: string;
  readonly at: string;
}

async function readAttempt(path: string): Promise<Attempt | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<Attempt>;
    return typeof value.commit === "string" && typeof value.at === "string" ? { commit: value.commit, at: value.at } : null;
  } catch {
    return null;
  }
}

async function writeAttempt(path: string, attempt: Attempt): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(attempt)}\n`, "utf8");
  await rename(tmp, path);
}

/**
 * `paseo plugin update agent-recall`, only for a Git install with a newer revision. Applying it
 * makes Paseo stop this plugin and start the new one, which checks again and finds it current. A
 * commit already attempted in the last 30 min is not applied again, so a Paseo that keeps
 * proposing the same revision cannot loop the reloads.
 */
export async function updatePaseo(deps: PaseoUpdateDeps): Promise<UpdateResult> {
  const { exec, log, clock } = deps;
  const started = clock.now().getTime();
  const remaining = (): number => UPDATE_DEADLINE_MS - (clock.now().getTime() - started);
  const paseo = (args: string[], timeoutMs: number) =>
    exec("paseo", ["plugin", "update", PACKAGE, ...args, "--json", "--home", deps.home], { timeoutMs });
  try {
    let check = await paseo(["--check"], Math.min(PASEO_CHECK_MS, remaining()));
    // At daemon startup the CLI can reach the daemon before it serves: one more try.
    if (check.code !== 0 && remaining() - PASEO_CHECK_RETRY_DELAY_MS - PASEO_CHECK_MS >= PASEO_APPLY_MIN_MS) {
      await deps.sleep(PASEO_CHECK_RETRY_DELAY_MS);
      check = await paseo(["--check"], Math.min(PASEO_CHECK_MS, remaining()));
    }
    if (check.code !== 0) {
      log.warn(`autoatualização: paseo plugin update --check saiu ${check.code}: ${lastLine(check.stderr || check.stdout)}`);
      return "failed";
    }
    const previews = JSON.parse(check.stdout) as PaseoPreview[];
    const mine = previews.find((item) => item.id === PACKAGE);
    if (!mine) throw new Error(`${PACKAGE} ausente da prévia do Paseo`);
    const kind = mine.outcome === "local" ? "directory" : (mine.current?.identity?.kind ?? "git");
    if (kind !== "git") {
      log.info(`autoatualização: instalação ${kind}, nada a atualizar`);
      return "local";
    }
    if (mine.outcome === "error") throw new Error(mine.error ?? "prévia com erro");
    const commit = mine.target?.commit;
    if (mine.outcome !== "update" || !commit) {
      log.info(`autoatualização: em dia (${(mine.current?.currentRevision ?? "?").slice(0, 12)})`);
      return "current";
    }
    const marker = join(deps.stateDir, "paseo.update");
    const last = await readAttempt(marker);
    if (last?.commit === commit && clock.now().getTime() - Date.parse(last.at) < PASEO_RETRY_MS) {
      log.warn(`autoatualização: ${commit.slice(0, 12)} já tentado às ${last.at}; não repete`);
      return "throttled";
    }
    if (remaining() < PASEO_APPLY_MIN_MS) throw new Error("sem tempo para aplicar dentro do prazo");
    await writeAttempt(marker, { commit, at: clock.now().toISOString() });
    log.info(`autoatualização: ${(mine.current?.currentRevision ?? "?").slice(0, 12)} → ${commit.slice(0, 12)}`);
    // The daemon stops this plugin while applying; it finishes the update even if this CLI dies.
    const applied = await paseo(["--yes"], remaining());
    if (applied.code !== 0) {
      log.warn(`autoatualização: paseo plugin update --yes saiu ${applied.code}: ${lastLine(applied.stderr || applied.stdout)}`);
      return "failed";
    }
    return "updated";
  } catch (error) {
    log.warn(`autoatualização: ${describe(error)}`);
    return "failed";
  }
}
