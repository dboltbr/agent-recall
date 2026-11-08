import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  fakeExec,
  fakeGitHub,
  fixedClock,
  hoursAgo,
  NOW,
  note,
  quietLog,
  session,
  tempState,
  writeConfig,
} from "../../core/test/fakes.ts";
import { loadConfig } from "../../core/host.ts";
import type { Note } from "../../core/types.ts";
import { attach, createDelivery, type Context, type PollerDeps, type Registry, type SessionInfo, type Timer } from "../poller.ts";

const INTERVAL = 30_000;
const PROBE = 10_000;

/** setTimeout stand-in: nothing runs until the test fires it. */
function manualTimer() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  const timer: Timer = {
    set(run, ms) {
      pending.set(++next, { run, ms });
      return next;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  return {
    timer,
    scheduled: (ms: number) => [...pending.values()].filter((entry) => entry.ms === ms).length,
    fire(ms: number): void {
      for (const [id, entry] of pending) {
        if (entry.ms !== ms) continue;
        pending.delete(id);
        entry.run();
        return;
      }
      assert.fail(`nada agendado para ${ms} ms`);
    },
  };
}

/** An OpenCode plugin context. `down` makes every session call fail, like a dead runtime. */
function fakeContext(name: string) {
  const state = { down: false, prompts: [] as Array<{ sessionID: string; text: string }> };
  const ctx: Context = {
    location: { directory: `/tmp/${name}` },
    session: {
      async list() {
        if (state.down) throw new Error(`${name} fora do ar`);
        return { data: [] };
      },
      async prompt(input) {
        if (state.down) throw new Error(`${name} fora do ar`);
        state.prompts.push(input);
      },
      async get(input) {
        return { id: input.sessionID, location: { directory: `/tmp/${name}` } };
      },
      async create() {
        return { id: "ses_child" };
      },
    },
  };
  return { ctx, state };
}

const culprit: Note = note({
  release: "release-90",
  updatedAt: hoursAgo(3),
  owner: session("opencode", "archdev", "ses_culprit", ["c0ffee1"]),
});

async function setup(refs: Array<{ status: number; etag?: string; sha?: string }>, notes: () => Record<string, Note>) {
  const stateDir = await tempState();
  const configFile = await writeConfig(await tempState());
  const clock = fixedClock();
  const manual = manualTimer();
  const github = fakeGitHub(refs);
  const git = fakeExec(notes);
  const registry: Registry = { ctx: null, poller: null };
  const deps = (sha: string): PollerDeps => ({
    sha,
    stateDir,
    pid: process.pid,
    clock,
    fetch: github.fetch,
    exec: git.exec,
    loadConfig: () => loadConfig(configFile),
    log: quietLog,
    intervalMs: INTERVAL,
    timer: manual.timer,
    probeTimeoutMs: PROBE,
  });
  const heartbeat = async () =>
    JSON.parse(await readFile(join(stateDir, "opencode.alive"), "utf8").catch(() => "null")) as {
      pid: number;
      polledAt: string;
      sha: string;
    } | null;
  const tick = async () => {
    manual.fire(INTERVAL);
    await registry.poller!.idle();
  };
  return { registry, deps, clock, manual, heartbeat, tick };
}

test("localização despejada: o poller segue e chama pelo contexto descartado", async () => {
  let notes: Record<string, Note> = {};
  const { registry, deps, clock, heartbeat, tick } = await setup(
    [{ status: 404 }, { status: 404 }, { status: 200, etag: 'W/"e1"', sha: "n1" }],
    () => notes,
  );
  const home = fakeContext("home");
  attach(registry, home.ctx, deps("aaaaaaaaaaaa1111"));
  await registry.poller!.idle();
  assert.equal((await heartbeat())?.polledAt, NOW.toISOString());

  // OpenCode evicts the idle location (60 min) and disposes the plugin; no other location loads it.
  clock.set(new Date(NOW.getTime() + 61 * 60_000));
  await tick();
  assert.deepEqual(await heartbeat(), {
    pid: process.pid,
    polledAt: "2026-10-27T16:01:00.000Z",
    sha: "aaaaaaaaaaaa1111",
  });

  notes = { tagcommit: culprit };
  clock.set(new Date(NOW.getTime() + 62 * 60_000));
  await tick();
  assert.equal(home.state.prompts.length, 1);
  assert.equal(home.state.prompts[0]!.sessionID, "ses_culprit");
  assert.match(home.state.prompts[0]!.text, /^Incidente release-90: carregue a skill dbolt-release-incident\. Papel: owner\./);
  assert.equal((await heartbeat())?.polledAt, "2026-10-27T16:02:00.000Z");
  await registry.poller!.stop();
});

test("contexto que não responde: nenhum heartbeat até voltar a responder", async () => {
  const { registry, deps, clock, heartbeat, tick } = await setup([{ status: 404 }], () => ({}));
  const home = fakeContext("home");
  home.state.down = true;
  attach(registry, home.ctx, deps("aaaaaaaaaaaa1111"));
  await registry.poller!.idle();
  assert.equal(await heartbeat(), null);

  home.state.down = false;
  clock.set(new Date(NOW.getTime() + 30_000));
  await tick();
  assert.equal((await heartbeat())?.polledAt, "2026-10-27T15:00:30.000Z");

  home.state.down = true;
  clock.set(new Date(NOW.getTime() + 60_000));
  await tick();
  assert.equal((await heartbeat())?.polledAt, "2026-10-27T15:00:30.000Z", "heartbeat congelado");
  await registry.poller!.stop();
});

test("o contexto mais novo atende; carga do mesmo SHA não cria outro poller", async () => {
  const { registry, deps, manual, clock, tick } = await setup(
    [{ status: 404 }, { status: 200, etag: 'W/"e1"', sha: "n1" }],
    () => ({ tagcommit: culprit }),
  );
  const home = fakeContext("home");
  const dbolt = fakeContext("dbolt");
  attach(registry, home.ctx, deps("aaaaaaaaaaaa1111"));
  await registry.poller!.idle();
  const first = registry.poller;
  attach(registry, dbolt.ctx, deps("aaaaaaaaaaaa1111"));
  assert.equal(registry.poller, first);
  assert.equal(manual.scheduled(INTERVAL), 1);

  clock.set(new Date(NOW.getTime() + 30_000));
  await tick();
  assert.equal(home.state.prompts.length, 0);
  assert.equal(dbolt.state.prompts.length, 1);
  await registry.poller!.stop();
});

test("arquivo recarregado com outro SHA assume o poller no mesmo processo", async () => {
  const { registry, deps, manual, clock, heartbeat, tick } = await setup([{ status: 404 }], () => ({}));
  const before = fakeContext("before");
  attach(registry, before.ctx, deps("aaaaaaaaaaaa1111"));
  await registry.poller!.idle();
  assert.equal((await heartbeat())?.sha, "aaaaaaaaaaaa1111");

  clock.set(new Date(NOW.getTime() + 5_000));
  const after = fakeContext("after");
  attach(registry, after.ctx, deps("bbbbbbbbbbbb2222"));
  await registry.poller!.idle();
  assert.equal(registry.poller!.sha, "bbbbbbbbbbbb2222");
  assert.deepEqual(await heartbeat(), { pid: process.pid, polledAt: "2026-10-27T15:00:05.000Z", sha: "bbbbbbbbbbbb2222" });
  assert.equal(manual.scheduled(INTERVAL), 1, "o poller antigo parou; só o novo está agendado");

  clock.set(new Date(NOW.getTime() + 35_000));
  await tick();
  assert.equal((await heartbeat())?.sha, "bbbbbbbbbbbb2222");
  assert.equal(manual.scheduled(INTERVAL), 1);
  await registry.poller!.stop();
  assert.equal(manual.scheduled(INTERVAL), 0);
});

test("trava de arquivo da versão anterior, do mesmo processo: o poller recarregado consulta", async () => {
  const { registry, deps, heartbeat } = await setup([{ status: 404 }], () => ({}));
  // The previous build held the host poller with a `{ pid }` file and was stopped by the reload.
  await writeFile(join(deps("x").stateDir, "opencode.poller"), `${JSON.stringify({ pid: process.pid })}\n`);
  attach(registry, fakeContext("home").ctx, deps("bbbbbbbbbbbb2222"));
  await registry.poller!.idle();
  assert.equal((await heartbeat())?.sha, "bbbbbbbbbbbb2222");
  await registry.poller!.stop();
});

test("entrega: filha sobe até a raiz; ocupada ou ativa há menos de 10 min trabalha; abre sessão nova no diretório", async () => {
  const now = Date.now();
  const sessions: Record<string, SessionInfo> = {
    ses_lane: { id: "ses_lane", parentID: "ses_mid", time: { updated: now - 60 * 60_000, busy: now - 2 * 60 * 60_000, idle: now - 60 * 60_000 } },
    ses_mid: { id: "ses_mid", parentID: "ses_root", time: { updated: now - 60_000 } },
    ses_root: { id: "ses_root", time: { updated: now - 60 * 60_000, busy: now - 30 * 60_000 } },
  };
  const created: Array<{ title?: string; location?: { directory: string } }> = [];
  const prompts: Array<{ sessionID: string; text: string }> = [];
  const ctx: Context = {
    session: {
      async list() {
        return { data: [] };
      },
      async prompt(input) {
        prompts.push(input);
      },
      async get(input) {
        return sessions[input.sessionID] ?? { id: input.sessionID };
      },
      async create(input) {
        created.push(input);
        return { id: "ses_new" };
      },
    },
  };
  const delivery = createDelivery({ ctx, poller: null });
  const target = (id: string) => ({ harness: "opencode" as const, host: "archdev", id });
  assert.deepEqual(await delivery.resolveRoot!(target("ses_lane")), target("ses_root"));
  assert.deepEqual(await delivery.resolveRoot!(target("ses_root")), target("ses_root"));
  assert.equal(await delivery.isWorking!(target("ses_lane")), false, "turno encerrado há 1 h");
  assert.equal(await delivery.isWorking!(target("ses_mid")), true, "ativa há 1 min");
  assert.equal(await delivery.isWorking!(target("ses_root")), true, "em turno (busy sem idle)");
  assert.equal(await delivery.isWorking!(target("ses_none")), false);
  assert.equal(await delivery.open!("/srv/dbolt", "texto", "Release barrada"), "ses_new");
  assert.deepEqual(created, [{ title: "Release barrada", location: { directory: "/srv/dbolt" } }]);
  assert.deepEqual(prompts, [{ sessionID: "ses_new", text: "texto" }]);
});
