import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { config, fakeExec, fixedClock, hoursAgo, NOW, note, quietLog, removeTempDirs, session, tempState, writeConfig } from "../../core/test/fakes.ts";
import { job, minutesAgo, run } from "../../core/test/releases.ts";
import { acquireHostLock, loadConfig, lockPort, readHandoffs } from "../../core/host.ts";
import type { BlockedNote, Exec, Fetch, Note } from "../../core/types.ts";
import {
  ACK_TIMEOUT_MS,
  armWatcher,
  PICKUP_LIMIT_MS,
  POLLER_LOCK,
  backgroundId,
  backgroundSession,
  claudePaths,
  createClaudeWatcher,
  due,
  parseHookInput,
  recordSession,
  runWatcher,
  transcriptCwd,
  writeRequest,
  type ClaudeDeps,
  type ClaudeWatcher,
} from "../watch.ts";

const CLAUDE = "/opt/claude/bin/claude";

/** Watchers of the running test: their host locks (TCP listeners) are freed after it. */
const started: ClaudeWatcher[] = [];
afterEach(async () => {
  // Locks first: a released watcher writes nothing more into the directories removed next.
  await Promise.all(started.splice(0).map((watcher) => watcher.release()));
  await removeTempDirs();
});
const SESSION = "86117ef6-50de-42ad-8ffc-a2d6f03df9ec";
const FORK_SHORT = "d05b74cf";
const FORK_ID = "d05b74cf-81ed-4497-a610-76c3236cab79";

/**
 * `refs/notes/release-watch` that answers 304 until `bump()`; `refs/notes/release-blocked` likewise
 * with `bumpBlocked()`, 404 until `blocked: true`; the release workflow runs list serves `runs`;
 * every other GitHub path is 404.
 */
function refServer(options: { blocked?: boolean; runs?: unknown[] } = {}) {
  let version = 1;
  let blockedVersion = 1;
  let gate: Promise<void> | null = null;
  const refCalls: string[] = [];
  const fetch: Fetch = async (url, init) => {
    if (options.runs && url.includes("/actions/workflows/release.yml/runs")) {
      return new Response(JSON.stringify({ total_count: options.runs.length, workflow_runs: options.runs }), { status: 200 });
    }
    if (options.runs && url.includes("/matching-refs/tags/release-")) return new Response("[]", { status: 200 });
    if (options.runs && url.includes("/actions/runs/") && url.includes("/jobs")) {
      return new Response(JSON.stringify({ total_count: 1, jobs: [job("verify-production / check", "failure", [15, 5])] }), { status: 200 });
    }
    if (url.includes("/git/ref/notes/release-blocked")) {
      if (!options.blocked) return new Response(null, { status: 404 });
      const etag = `W/"b${blockedVersion}"`;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers["If-None-Match"] === etag) return new Response(null, { status: 304 });
      return new Response(JSON.stringify({ object: { sha: `b${blockedVersion}` } }), { status: 200, headers: { etag } });
    }
    if (!url.includes("/git/ref/")) return new Response(null, { status: 404 });
    refCalls.push(url);
    if (gate) await gate;
    const etag = `W/"v${version}"`;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers["If-None-Match"] === etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify({ object: { sha: `n${version}` } }), { status: 200, headers: { etag } });
  };
  /** Holds every ref request until the returned function is called (GitHub hanging). */
  const hold = () => {
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));
    return () => {
      gate = null;
      open();
    };
  };
  return { fetch, refCalls, bump: () => version++, bumpBlocked: () => blockedVersion++, hold };
}

async function host(options: {
  notes: Record<string, Note>;
  /** Blocked-release notes; with them the blocked ref and a release history answer. */
  blocked?: Record<string, BlockedNote>;
  /** The release history does not load (GitHub failing). */
  history?: "fail";
  fork?: "ok" | "fail";
  /** Holds `claude --bg` until it resolves (a fork in progress). */
  forkGate?: Promise<void>;
}) {
  const stateDir = await tempState();
  const configFile = await writeConfig(await tempState(), config);
  const projectsDir = await tempState();
  const clock = fixedClock();
  const github = refServer(options.blocked ? { blocked: true, runs: options.history === "fail" ? undefined : [blockedRun] } : {});
  const git = fakeExec(() => options.notes, { blocked: () => options.blocked ?? {} });
  const forks: Array<{ args: readonly string[]; cwd: string | undefined }> = [];
  let forkStarted!: () => void;
  const firstFork = new Promise<void>((resolve) => (forkStarted = resolve));
  const exec: Exec = async (command, args, execOptions) => {
    if (command !== CLAUDE) return git.exec(command, args, execOptions);
    if (args[0] === "agents") {
      const listing = [{ pid: 497530, id: FORK_SHORT, cwd: execOptions.cwd, kind: "background", sessionId: FORK_ID, status: "busy" }];
      return { code: 0, stdout: JSON.stringify(listing), stderr: "" };
    }
    forks.push({ args, cwd: execOptions.cwd });
    forkStarted();
    if (options.forkGate) await options.forkGate;
    if (options.fork === "fail") return { code: 1, stdout: "", stderr: "Workspace not trusted" };
    // Claude Code 2.1.316, verbatim.
    const stdout = `Starting background service…\nbackgrounded · ${FORK_SHORT}\n  claude agents             list sessions\n  claude attach ${FORK_SHORT}    open in this terminal\n`;
    return { code: 0, stdout, stderr: "" };
  };
  const live = new Set<number>();
  const deps = (pid: number, claudePid: number): ClaudeDeps => ({
    stateDir,
    claudePid,
    pid,
    sha: "1234567890abcdef",
    clock,
    fetch: github.fetch,
    exec,
    loadConfig: () => loadConfig(configFile),
    log: quietLog,
    alive: (candidate) => live.has(candidate),
    projectsDir,
    claude: CLAUDE,
  });
  /** A Claude Code process (`claudePid`) whose hook started a watcher (`pid`) for `sessionId`. */
  async function process(pid: number, claudePid: number, sessionId: string) {
    live.add(pid);
    live.add(claudePid);
    await recordSession(stateDir, claudePid, { sessionId, event: "SessionStart", transcriptPath: null, cwd: null }, clock);
    const watcher = createClaudeWatcher(deps(pid, claudePid));
    started.push(watcher);
    return watcher;
  }
  /** The session's transcript: Claude Code writes queue lines without `cwd` before the first turn. */
  async function transcript(sessionId: string, cwd: string) {
    const dir = join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, "-"));
    await mkdir(dir, { recursive: true });
    const lines = [
      { type: "queue-operation", operation: "enqueue", sessionId },
      { type: "user", cwd, sessionId, message: { role: "user", content: "oi" } },
      { type: "user", cwd: "/elsewhere", sessionId },
    ];
    await writeFile(join(dir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
  const inbox = async (sessionId: string) => (await readdir(claudePaths(stateDir).inbox(sessionId)).catch(() => [] as string[])).sort();
  const later = (ms: number) => clock.set(new Date(clock.now().getTime() + ms));
  return { stateDir, clock, github, git, forks, firstFork, live, process, transcript, inbox, later };
}

/** One loop and the host poll it started, if any. */
async function settle(watcher: ClaudeWatcher) {
  const step = await watcher.step();
  await watcher.idle();
  return step;
}

/** A red release whose owner (the range head's session) is the Claude Code session `id`. */
const red = (id = SESSION): Note => note({ release: "release-90", updatedAt: hoursAgo(0.1), owner: session("claude", "archdev", id, ["c0ffee1"]) });

const BLOCKED_HEAD = "0292aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
/** Run 292 failed before the tag: the release history the poller reads. */
const blockedRun = run({ run_number: 292, status: "completed", conclusion: "failure", updated_at: minutesAgo(5) });
const blockedRed = (partial: Partial<BlockedNote> = {}): BlockedNote => ({
  release: "release-292",
  state: "red",
  range: { from: null, to: BLOCKED_HEAD },
  sessions: [session("claude", "archdev", SESSION, ["c0ffee1"])],
  run: { id: 292, url: "https://github.com/dboltbr/dbolt/actions/runs/292", failedJob: "verify-production / check" },
  updatedAt: hoursAgo(0.1),
  ...partial,
});

test("hook stdin: session_id, evento, transcript e cwd; lixo é null", () => {
  assert.deepEqual(
    parseHookInput(JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart", transcript_path: "/t.jsonl", cwd: "/w", source: "clear" })),
    { sessionId: SESSION, event: "SessionStart", transcriptPath: "/t.jsonl", cwd: "/w" },
  );
  assert.equal(parseHookInput("{}"), null);
  assert.equal(parseHookInput("não é json"), null);
});

test("pedido na caixa: o vigia da sessão sai 2 com o prompt e larga a trava do processo", async () => {
  const notes = { tagcommit: red() };
  const h = await host({ notes });
  const watcher = await h.process(1001, 2001, SESSION);
  // First loop: this watcher is the host poller, reads the note and writes the session's request.
  assert.deepEqual(await settle(watcher), { kind: "wait" });
  assert.deepEqual(await h.inbox(SESSION), ["release-90.86117ef6-50de-42ad-8ffc-a2d6f03df9ec.owner.json"]);
  const result = await runWatcher(watcher, async () => h.later(2_000), quietLog);
  assert.equal(result.code, 2);
  assert.match(result.text!, /^Incidente release-90: carregue a skill dbolt-release-incident\. Papel: owner\. /);
  assert.deepEqual(await h.inbox(SESSION), [`release-90.86117ef6-50de-42ad-8ffc-a2d6f03df9ec.owner.picked-${NOW.getTime()}`]);
  assert.equal(existsSync(claudePaths(h.stateDir).armedFile(2001)), false, "o próximo hook rearma sem esperar");
  assert.notEqual(await acquireHostLock(h.stateDir, POLLER_LOCK, quietLog), null, "outro vigia assume a consulta");
  const beat = JSON.parse(await readFile(join(h.stateDir, "claude.alive"), "utf8"));
  assert.deepEqual(beat, { pid: 1001, polledAt: NOW.toISOString(), sha: "1234567890abcdef" });
  assert.equal(h.forks.length, 0);
});

test("/clear: o id novo no mapa pid→sessão casa com o vigia que já roda", async () => {
  const h = await host({ notes: {} });
  const watcher = await h.process(1001, 2001, "old-session");
  assert.deepEqual(await settle(watcher), { kind: "wait" });
  // `/clear` fires SessionStart with a new id; its hook finds the process armed and only records it.
  await recordSession(h.stateDir, 2001, { sessionId: "new-session", event: "SessionStart", transcriptPath: null, cwd: null }, h.clock);
  const duplicate = createClaudeWatcher(depsOf(h, 1002, 2001));
  started.push(duplicate);
  h.live.add(1002);
  assert.equal((await settle(duplicate)).kind, "exit");
  const request = { release: "release-91", kind: "recall", role: "owner", lock: "x", text: "Incidente release-91: …", createdAt: NOW.toISOString() } as const;
  await writeRequest(h.stateDir, { ...request, session: "old-session" });
  await writeRequest(h.stateDir, { ...request, session: "new-session" });
  assert.deepEqual(await settle(watcher), { kind: "wake", text: "Incidente release-91: …" });
  assert.deepEqual(await h.inbox("old-session"), ["release-91.x.json"], "a sessão antiga não recebe");
});

test("CLAUDE_PID morto: o vigia órfão sai 0 sem acordar ninguém", async () => {
  const h = await host({ notes: {} });
  const watcher = await h.process(1001, 2001, SESSION);
  assert.deepEqual(await settle(watcher), { kind: "wait" });
  await writeRequest(h.stateDir, {
    release: "release-91",
    kind: "recall",
    role: "owner",
    lock: SESSION,
    session: SESSION,
    text: "Incidente release-91: …",
    createdAt: NOW.toISOString(),
  });
  h.live.delete(2001);
  const result = await runWatcher(watcher, async () => h.later(2_000), quietLog);
  assert.deepEqual(result, { code: 0 });
  assert.deepEqual(await h.inbox(SESSION), ["release-91.86117ef6-50de-42ad-8ffc-a2d6f03df9ec.json"]);
});

test("turno ocupado sem vigia por 2 min: o poller abre a cópia no diretório da original e registra o chamado", async () => {
  const notes: Record<string, Note> = { tagcommit: red() };
  const h = await host({ notes });
  const cwd = await tempState();
  await h.transcript(SESSION, cwd);
  // The owner's process (2001) is alive but its watcher never runs (a busy turn); 2002 polls.
  await h.process(1001, 2001, SESSION);
  const poller = await h.process(1002, 2002, "other-session");
  assert.deepEqual(await settle(poller), { kind: "wait" });
  assert.equal((await h.inbox(SESSION)).length, 1);

  h.later(ACK_TIMEOUT_MS - 1_000);
  assert.deepEqual(await settle(poller), { kind: "wait" });
  assert.equal(h.forks.length, 0, "ainda no prazo");

  h.later(31_000);
  assert.deepEqual(await settle(poller), { kind: "wait" });
  // The original still runs in its process: the fork keeps the default worktree isolation.
  const fork = h.forks[0]!.args;
  assert.deepEqual(fork.slice(0, 4), ["--bg", "--fork-session", "--resume", SESSION]);
  assert.equal(fork.length, 5, "sem --settings: a original pode estar editando o checkout");
  assert.equal(h.forks[0]!.cwd, cwd);
  assert.match(fork[4]!, /^Incidente release-90: .*Papel: owner\./);
  assert.deepEqual(await h.inbox(SESSION), []);
  assert.equal(existsSync(claudePaths(h.stateDir).inbox(SESSION)), false, "caixa vazia sai");
  const handoffs = await readHandoffs(h.stateDir, "release-90");
  assert.deepEqual(handoffs.map((handoff) => [handoff.role, handoff.session]), [["owner", { harness: "claude", host: "archdev", id: FORK_ID }]]);
});

test("chamado de incidente pego: encerrado, nenhuma cópia", async () => {
  const h = await host({ notes: { tagcommit: red() } });
  await h.transcript(SESSION, await tempState());
  const poller = await h.process(1002, 2002, "other-session");
  const owner = await h.process(1001, 2001, SESSION);
  await settle(poller);
  assert.equal((await settle(owner)).kind, "wake");
  h.later(ACK_TIMEOUT_MS + 30_000);
  await settle(poller);
  assert.deepEqual(await h.inbox(SESSION), []);
  assert.equal(h.forks.length, 0);
});
test("sessão sem processo vivo no host: a cópia sai na hora, sem caixa", async () => {
  const h = await host({ notes: { tagcommit: red() } });
  const cwd = await tempState();
  await h.transcript(SESSION, cwd);
  const poller = await h.process(1002, 2002, "other-session");
  await settle(poller);
  assert.equal(h.forks.length, 1);
  assert.equal(h.forks[0]!.cwd, cwd);
  // The original is closed: the fork may edit its checkout (background sessions are confined to a
  // worktree by default), through a flag settings layer on top of the user's, for this command only.
  assert.deepEqual(h.forks[0]!.args.slice(0, 6), ["--bg", "--fork-session", "--resume", SESSION, "--settings", '{"worktree":{"bgIsolation":"none"}}']);
  assert.deepEqual(await h.inbox(SESSION), []);
});

test("cópia que falha: recall gravado na nota", async () => {
  // The owner has no live process here: the prompt is refused and the fork fails.
  const h = await host({ notes: { tagcommit: red() }, fork: "fail" });
  await h.transcript(SESSION, await tempState());
  const poller = await h.process(1002, 2002, "other-session");
  await settle(poller);
  assert.equal(h.forks.length, 1);
  assert.equal(h.git.written.length, 1);
  const recall = h.git.written[0]!.body["recall"] as Record<string, unknown>;
  assert.equal(recall["by"], "claude/archdev");
  assert.equal(recall["target"], `claude/archdev/${SESSION}`);
  assert.equal(recall["role"], "owner");
  assert.match(String(recall["reason"]), /Workspace not trusted/);
});
test("release barrada pega sem owner em 2 min: pego não confirma, a cópia sai isolada", async () => {
  const h = await host({ notes: {}, blocked: { [BLOCKED_HEAD]: blockedRed() } });
  const cwd = await tempState();
  await h.transcript(SESSION, cwd);
  const poller = await h.process(1002, 2002, "other-session");
  const culprit = await h.process(1001, 2001, SESSION);
  assert.deepEqual(await settle(poller), { kind: "wait" });
  const woke = await settle(culprit);
  assert.equal(woke.kind, "wake");
  assert.match((woke as { text: string }).text, /^Release barrada release-292: carregue a skill dbolt-release-incident\. Papel: blocked\. Release: /);

  h.later(ACK_TIMEOUT_MS - 1_000);
  await settle(poller);
  assert.equal(h.forks.length, 0, "ainda no prazo");
  h.later(31_000);
  await settle(poller);
  assert.equal(h.forks.length, 1);
  // The original's process still runs: no `--settings`, the default worktree isolation stays.
  assert.deepEqual(h.forks[0]!.args.slice(0, 4), ["--bg", "--fork-session", "--resume", SESSION]);
  assert.match(h.forks[0]!.args[4]!, /^Release barrada release-292: /);
  assert.equal(h.forks[0]!.cwd, cwd);
  const handoffs = await readHandoffs(h.stateDir, "release-292");
  assert.deepEqual(handoffs.map((handoff) => [handoff.role, handoff.session.id]), [["blocked", FORK_ID]]);
});

test("release barrada com owner da sessão dentro do prazo: confirmada, nenhuma cópia", async () => {
  const blocked: Record<string, BlockedNote> = { [BLOCKED_HEAD]: blockedRed() };
  const h = await host({ notes: {}, blocked });
  await h.transcript(SESSION, await tempState());
  const poller = await h.process(1002, 2002, "other-session");
  const culprit = await h.process(1001, 2001, SESSION);
  await settle(poller);
  assert.equal((await settle(culprit)).kind, "wake");
  blocked[BLOCKED_HEAD] = blockedRed({ state: "investigating", owner: `claude/archdev/${SESSION}`, updatedAt: NOW.toISOString() });
  h.github.bumpBlocked();
  h.later(60_000);
  await settle(poller);
  assert.deepEqual(await h.inbox(SESSION), []);
  h.later(ACK_TIMEOUT_MS);
  await settle(poller);
  assert.equal(h.forks.length, 0);
});

test("release barrada cuja cópia falha: recall na nota barrada", async () => {
  const h = await host({ notes: {}, blocked: { [BLOCKED_HEAD]: blockedRed() }, fork: "fail" });
  await h.transcript(SESSION, await tempState());
  const poller = await h.process(1002, 2002, "other-session");
  const culprit = await h.process(1001, 2001, SESSION);
  await settle(poller);
  assert.equal((await settle(culprit)).kind, "wake");
  h.later(ACK_TIMEOUT_MS + 30_000);
  await settle(poller);
  assert.equal(h.git.written.length, 1);
  const { key, ref, body } = h.git.written[0]!;
  assert.deepEqual([key, ref], [BLOCKED_HEAD, "refs/notes/release-blocked"]);
  const recall = body["recall"] as Record<string, unknown>;
  assert.deepEqual([recall["role"], recall["target"], recall["state"]], ["blocked", `claude/archdev/${SESSION}`, "red"]);
});

test("release barrada sem histórico de releases na partida: pedido guardado, sem cópia", async () => {
  const h = await host({ notes: {}, blocked: { [BLOCKED_HEAD]: blockedRed() }, history: "fail" });
  await h.transcript(SESSION, await tempState());
  // A request a previous poller delivered, picked 3 min ago and never taken.
  const dir = claudePaths(h.stateDir).inbox(SESSION);
  await mkdir(dir, { recursive: true });
  const request = { release: "release-292", kind: "blocked", role: "blocked", lock: `${SESSION}.blocked`, session: SESSION, text: "Release barrada release-292: …", createdAt: hoursAgo(0.1) };
  const name = `release-292.${SESSION}.blocked.picked-${NOW.getTime() - 3 * 60_000}`;
  await writeFile(join(dir, name), JSON.stringify(request));
  const poller = await h.process(1002, 2002, "other-session");
  await settle(poller);
  assert.equal(h.forks.length, 0, "uma release posterior pode já ter ido à produção");
  assert.equal(h.git.written.length, 0);
  assert.deepEqual(await h.inbox(SESSION), [name]);
});

test("pedido aparece inteiro para quem lê a caixa durante a escrita", async () => {
  for (let round = 0; round < 20; round++) {
    const stateDir = await tempState();
    const dir = claudePaths(stateDir).inbox("s");
    const request = { release: "release-1", kind: "recall", role: "owner", lock: "s", session: "s", text: "x".repeat(8_000_000), createdAt: NOW.toISOString() } as const;
    let done = false;
    let partial = 0;
    const reader = (async () => {
      while (!done) {
        for (const name of (await readdir(dir).catch(() => [] as string[])).filter((entry) => entry.endsWith(".json"))) {
          const raw = await readFile(join(dir, name), "utf8").catch(() => null);
          if (raw === null) continue;
          try {
            JSON.parse(raw);
          } catch {
            partial++;
          }
        }
      }
    })();
    await writeRequest(stateDir, request);
    done = true;
    await reader;
    assert.equal(partial, 0);
    assert.deepEqual(await readdir(dir), ["release-1.s.json"], "nenhum temporário fica para trás");
    await removeTempDirs();
  }
});

test("consulta do host pendurada não segura a caixa da sessão", { timeout: 5_000 }, async () => {
  const h = await host({ notes: {} });
  const watcher = await h.process(1001, 2001, SESSION);
  const open = h.github.hold();
  assert.deepEqual(await watcher.step(), { kind: "wait" }, "a consulta segue em segundo plano");
  await writeRequest(h.stateDir, {
    release: "release-91",
    kind: "blocked",
    role: "blocked",
    lock: `${SESSION}.blocked`,
    session: SESSION,
    text: "Release barrada release-91: …",
    createdAt: NOW.toISOString(),
  });
  assert.deepEqual(await watcher.step(), { kind: "wake", text: "Release barrada release-91: …" });
  h.live.delete(2001);
  assert.equal((await watcher.step()).kind, "exit", "a vida do Claude Code segue conferida");
  open();
  await watcher.idle();
});

test("sessão com vigia armado que ainda não pegou: sem cópia pela idade do pedido", async () => {
  const notes: Record<string, Note> = {};
  const h = await host({ notes });
  await h.transcript(SESSION, await tempState());
  const poller = await h.process(1002, 2002, "other-session");
  const culprit = await h.process(1001, 2001, SESSION);
  await settle(poller);
  await settle(culprit);
  notes["tagcommit"] = red();
  h.github.bump();
  h.later(30_000);
  await settle(poller);
  assert.equal((await h.inbox(SESSION)).length, 1);
  // The culprit's watcher is armed but has not looped since (busy disk, slow machine).
  h.later(ACK_TIMEOUT_MS + 30_000);
  await settle(poller);
  assert.equal(h.forks.length, 0);
  assert.equal((await settle(culprit)).kind, "wake");
});

test("prazo da cópia: conta da entrega à sessão, não da escrita do pedido", () => {
  const now = NOW.getTime();
  const session = (armed: boolean) => ({ pid: 2001, armed, sessionId: SESSION, transcriptPath: null, cwd: null, at: "" });
  assert.equal(due("picked", now - 1_000, 30 * 60_000, now, []), false, "pego agora, criado há 30 min");
  assert.equal(due("picked", now - ACK_TIMEOUT_MS, 30 * 60_000, now, []), true);
  assert.equal(due("pending", null, 0, now, []), true, "sem processo vivo: na hora");
  assert.equal(due("pending", null, PICKUP_LIMIT_MS - 1, now, [session(true)]), false);
  assert.equal(due("pending", null, PICKUP_LIMIT_MS, now, [session(true)]), true, "vigia travado");
  assert.equal(due("pending", null, ACK_TIMEOUT_MS, now, [session(false)]), true, "turno ocupado sem vigia");
});

test("arquivos de trava da versão anterior (dono morto, marca abandonada) não seguram a consulta", async () => {
  const h = await host({ notes: {} });
  const lock = join(claudePaths(h.stateDir).root, "poller.lock");
  await mkdir(join(lock, ".."), { recursive: true });
  const dead = `${JSON.stringify({ pid: 9, start: "t9", nonce: "n" })}\n`;
  await writeFile(lock, dead);
  // A previous claimant created its takeover mark and was killed before replacing the file.
  await writeFile(`${lock}.taken-${createHash("sha256").update(dead).digest("hex").slice(0, 24)}`, "{}");
  const watcher = await h.process(1001, 2001, SESSION);
  await settle(watcher);
  assert.equal(h.github.refCalls.length, 1);
});

test("chamado pego sai na hora, mesmo com a consulta do host pendurada", { timeout: 5_000 }, async () => {
  const h = await host({ notes: {} });
  const watcher = await h.process(1001, 2001, SESSION);
  const open = h.github.hold();
  assert.deepEqual(await watcher.step(), { kind: "wait" });
  await writeRequest(h.stateDir, {
    release: "release-91",
    kind: "blocked",
    role: "blocked",
    lock: `${SESSION}.blocked`,
    session: SESSION,
    text: "Release barrada release-91: …",
    createdAt: NOW.toISOString(),
  });
  const result = await runWatcher(watcher, async () => h.later(2_000), quietLog);
  assert.deepEqual(result, { code: 2, text: "Release barrada release-91: …" });
  open();
  await watcher.idle();
});

test("chamado pego com uma cópia em curso: a saída espera só a cópia", { timeout: 10_000 }, async () => {
  let openFork!: () => void;
  const forkGate = new Promise<void>((resolve) => (openFork = resolve));
  // The culprit session has no live process here: the poll forks it at once.
  const h = await host({ notes: { tagcommit: red("closed-session") }, forkGate });
  await h.transcript("closed-session", await tempState());
  const watcher = await h.process(1001, 2001, SESSION);
  await watcher.step();
  await h.firstFork;
  await writeRequest(h.stateDir, {
    release: "release-91",
    kind: "blocked",
    role: "blocked",
    lock: `${SESSION}.blocked`,
    session: SESSION,
    text: "Release barrada release-91: …",
    createdAt: NOW.toISOString(),
  });
  let settled = false;
  let recordedAtExit = false;
  const run = runWatcher(watcher, async () => h.later(2_000), quietLog).then((result) => {
    settled = true;
    // The process exits right here: whatever is not on disk now is lost.
    recordedAtExit = existsSync(join(h.stateDir, "release-90", "closed-session.owner", "handoff.json"));
    return result;
  });
  for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "não sai no meio da cópia");
  openFork();
  assert.deepEqual(await run, { code: 2, text: "Release barrada release-91: …" });
  assert.equal(recordedAtExit, true, "registro da cópia gravado antes da saída");
  await watcher.idle();
  const handoffs = await readHandoffs(h.stateDir, "release-90");
  assert.deepEqual(handoffs.map((handoff) => handoff.session.id), [FORK_ID]);
});

test("vigia saindo não começa chamado novo: sem trava de chamado, sem cópia", { timeout: 10_000 }, async () => {
  const h = await host({ notes: { tagcommit: red("closed-session") } });
  await h.transcript("closed-session", await tempState());
  const watcher = await h.process(1001, 2001, SESSION);
  // The host poll is stuck on GitHub, before it reads the note.
  const open = h.github.hold();
  await watcher.step();
  await writeRequest(h.stateDir, {
    release: "release-91",
    kind: "blocked",
    role: "blocked",
    lock: `${SESSION}.blocked`,
    session: SESSION,
    text: "Release barrada release-91: …",
    createdAt: NOW.toISOString(),
  });
  assert.equal((await runWatcher(watcher, async () => h.later(2_000), quietLog)).code, 2);
  // The poll goes on after the wake began: it must not take or start the call.
  open();
  await watcher.idle();
  assert.equal(h.forks.length, 0);
  assert.equal(existsSync(join(h.stateDir, "release-90", "closed-session.owner")), false, "trava do chamado livre para o próximo poller");
});

test("dois vigias do mesmo Claude Code ao mesmo tempo: um só arma", async () => {
  const h = await host({ notes: {} });
  const first = await h.process(1001, 2001, SESSION);
  const second = await h.process(1002, 2001, SESSION);
  const steps = await Promise.all([settle(first), settle(second)]);
  assert.deepEqual(steps.map((step) => step.kind).sort(), ["exit", "wait"]);
});

test("vigia morto por kill -9 deixa a trava do processo: o próximo hook rearma", async () => {
  const h = await host({ notes: {} });
  const killed = await h.process(1001, 2001, SESSION);
  assert.equal((await settle(killed)).kind, "wait");
  // SIGKILL: nothing runs on the way out; only the pid stops being alive.
  h.live.delete(1001);
  const next = await h.process(1002, 2001, SESSION);
  assert.equal((await settle(next)).kind, "wait", "rearmado");
  assert.equal(JSON.parse(await readFile(join(claudePaths(h.stateDir).armedFile(2001), "holder"), "utf8")).pid, 1002);
});

test("dois hooks sobre um vigia morto: um só arma e a trava viva nunca some", async () => {
  for (let round = 0; round < 200; round++) {
    const stateDir = await tempState();
    const dir = claudePaths(stateDir).armedFile(2001);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "holder"), JSON.stringify({ pid: 9 }));
    const contenders = [101, 102];
    const alive = (pid: number) => contenders.includes(pid);
    // Staggered by a few event-loop turns, so one can look while another is already reclaiming.
    const won = await Promise.all(
      contenders.map(async (pid, index) => {
        for (let turn = 0; turn < (round + index) % 4; turn++) await new Promise((resolve) => setImmediate(resolve));
        return armWatcher(stateDir, 2001, pid, alive);
      }),
    );
    assert.equal(won.filter(Boolean).length, 1, `rodada ${round}: ${won}`);
    const holder = JSON.parse(await readFile(join(dir, "holder"), "utf8")).pid;
    assert.equal(holder, contenders[won.indexOf(true)], "a trava do vencedor segue no lugar");
    assert.deepEqual(await readdir(join(dir, "..")), ["2001"], "sem lápide nem diretório de preparo");
  }
});

test("hook que morreu entre o mkdir e o holder: o próximo arma na hora", async () => {
  const stateDir = await tempState();
  // An armed directory with no holder: a hook killed between its mkdir and its write.
  await mkdir(claudePaths(stateDir).armedFile(2001), { recursive: true });
  assert.equal(await armWatcher(stateDir, 2001, 1002, () => true), true);
  assert.equal(JSON.parse(await readFile(join(claudePaths(stateDir).armedFile(2001), "holder"), "utf8")).pid, 1002);
});

test("diretório de trava sem holder mas com lixo dentro: tomado como morto", async () => {
  const stateDir = await tempState();
  const dir = claudePaths(stateDir).armedFile(2001);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "holder.123.tmp"), "{");
  assert.equal(await armWatcher(stateDir, 2001, 1002, () => true), true);
});

test("arquivo armed/<pid> da versão anterior: o vigia novo arma no lugar", async () => {
  const stateDir = await tempState();
  const path = claudePaths(stateDir).armedFile(2001);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify({ pid: 9 }));
  assert.equal(await armWatcher(stateDir, 2001, 1002, () => true), true);
  assert.equal(JSON.parse(await readFile(join(path, "holder"), "utf8")).pid, 1002);
});

test("trava do vigia de um processo nunca toma a porta da trava do host", async () => {
  const h = await host({ notes: {} });
  // A CLAUDE_PID whose per-process lock name would hash onto the poller's port.
  const pollerPort = lockPort(h.stateDir, POLLER_LOCK);
  let claudePid = 3000;
  while (lockPort(h.stateDir, `claude.armed.${claudePid}`) !== pollerPort) claudePid++;
  const watcher = await h.process(1001, claudePid, SESSION);
  await settle(watcher);
  assert.equal(h.github.refCalls.length, 1, "o vigia armado consulta pelo host");
});

test("pedido .picked da versão anterior: julgado como pego sem hora", async () => {
  const h = await host({ notes: {} });
  const dir = claudePaths(h.stateDir).inbox(SESSION);
  await mkdir(dir, { recursive: true });
  const request = { release: "release-93", kind: "recall", role: "owner", lock: `${SESSION}.owner`, session: SESSION, text: "Incidente release-93: …", createdAt: NOW.toISOString() };
  await writeFile(join(dir, `release-93.${SESSION}.owner.picked`), JSON.stringify(request));
  const poller = await h.process(1002, 2002, "other-session");
  await settle(poller);
  assert.deepEqual(await h.inbox(SESSION), [], "pego: confirmado e removido");
});

test("dois vigias no host: uma consulta só; o outro assume quando o dono morre", async () => {
  const h = await host({ notes: {} });
  const first = await h.process(1001, 2001, "session-a");
  const second = await h.process(1002, 2002, "session-b");
  await settle(first);
  await settle(second);
  assert.equal(h.github.refCalls.length, 1);

  h.later(30_000);
  await settle(first);
  await settle(second);
  assert.equal(h.github.refCalls.length, 2);

  // The first watcher dies: the kernel frees its host locks.
  h.live.delete(1001);
  await first.release();
  h.later(30_000);
  await settle(second);
  assert.equal(h.github.refCalls.length, 3);
  const beat = JSON.parse(await readFile(join(h.stateDir, "claude.alive"), "utf8"));
  assert.equal(beat.pid, 1002);
});

test("transcript: cwd da primeira linha que o tem; id do claude --bg", async () => {
  const dir = await tempState();
  const path = join(dir, "s.jsonl");
  await writeFile(path, '{"type":"queue-operation"}\n{"type":"user","cwd":"/home/me/dev/dbolt"}\n{"cwd":"/x"}\n');
  assert.equal(await transcriptCwd(path), "/home/me/dev/dbolt");
  assert.equal(backgroundId(`Starting background service…\nbackgrounded · ${FORK_SHORT}\n  claude attach ${FORK_SHORT}\n`), FORK_SHORT);
  assert.equal(backgroundId("Workspace not trusted. Run `claude` in /tmp/x once"), null);
  assert.equal(backgroundSession(JSON.stringify([{ id: FORK_SHORT, sessionId: FORK_ID }]), FORK_SHORT), FORK_ID);
  assert.equal(backgroundSession("[]", FORK_SHORT), null, "listado sem o job: a cópia não subiu");
  assert.equal(backgroundSession(null, FORK_SHORT), FORK_SHORT, "listagem indisponível: fica o id curto");
});

function depsOf(h: Awaited<ReturnType<typeof host>>, pid: number, claudePid: number): ClaudeDeps {
  return {
    stateDir: h.stateDir,
    claudePid,
    pid,
    sha: "1234567890abcdef",
    clock: h.clock,
    fetch: h.github.fetch,
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    loadConfig: async () => {
      throw new Error("sem config");
    },
    log: quietLog,
    alive: (candidate) => h.live.has(candidate),
    projectsDir: "/nowhere",
    claude: CLAUDE,
    };
}
