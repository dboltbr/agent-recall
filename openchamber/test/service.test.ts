import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Exec, Note } from "../../core/types.ts";
import { createTokenSource, TOKEN_TTL_MS } from "../src/service/gh.ts";
import { createLoader } from "../src/service/loader.ts";
import { createMonitor } from "../src/service/monitor.ts";
import { createHandler, MAX_WAIT_MS } from "../src/service/server.ts";
import { fixtureSnapshot, green, running } from "./fixture.ts";
import { manualTime } from "./timers.ts";

function ghExec(outputs: Array<{ code: number; stdout: string }>) {
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    const out = outputs[Math.min(calls.length - 1, outputs.length - 1)]!;
    return { ...out, stderr: "" };
  };
  return { exec, calls };
}

test("gh: token em cache pelo TTL, renovado depois e após forget", async () => {
  let now = 0;
  const { exec, calls } = ghExec([
    { code: 0, stdout: "gho_a\n" },
    { code: 0, stdout: "gho_b\n" },
    { code: 0, stdout: "gho_c\n" },
  ]);
  const tokens = createTokenSource(exec, () => now);
  assert.equal(await tokens.token(), "gho_a");
  assert.equal(await tokens.token(), "gho_a");
  assert.deepEqual(calls[0]?.args, ["auth", "token"]);
  assert.ok(calls[0]!.timeoutMs <= 25_000);
  now = TOKEN_TTL_MS;
  assert.equal(await tokens.token(), "gho_b");
  tokens.forget();
  assert.equal(await tokens.token(), "gho_c");
  assert.equal(calls.length, 3);
});

test("gh: login ausente vira erro pt-BR sem vazar saída", async () => {
  const tokens = createTokenSource(ghExec([{ code: 1, stdout: "" }]).exec, () => 0);
  await assert.rejects(tokens.token(), /gh auth login/);
});

test("loader: falha das notas mantém as últimas carregadas", async () => {
  const note = { release: "release-170", state: "reverted", updatedAt: "2026-10-27T12:00:00Z" } as Note;
  let notesFail = false;
  const seen: number[] = [];
  const warnings: string[] = [];
  const loader = createLoader({
    source: {
      load: async ({ notes }) => {
        seen.push(notes.size);
        return fixtureSnapshot();
      },
      lookup: async ({ notes, number }) => {
        seen.push(notes.size);
        return number === 171 ? green : null;
      },
    },
    token: async () => "gho_x",
    notes: async () => {
      if (notesFail) throw new Error("git fetch expirou");
      return new Map([["abc", note]]);
    },
    warn: (message) => warnings.push(message),
  });
  await loader.load();
  notesFail = true;
  await loader.load();
  assert.deepEqual(seen, [1, 1]);
  assert.match(warnings[0] ?? "", /git fetch expirou/);
  assert.equal((await loader.lookup(171))?.number, 171);
  assert.equal(await loader.lookup(9), null);
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("servidor: bearer obrigatório, rotas de snapshot, refresh, release e health", async (t) => {
  const time = manualTime();
  let loads = 0;
  const monitor = createMonitor({
    load: async () => {
      loads++;
      return fixtureSnapshot();
    },
    isActive: () => true,
    now: time.now,
    timers: time.timers,
  });
  const server = createServer(
    createHandler({ token: "s3cret", monitor, lookup: async (number) => (number === 172 ? running : null) }),
  );
  const base = await listen(server);
  t.after(() => {
    monitor.stop();
    server.close();
  });
  const auth = { authorization: "Bearer s3cret" };

  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/health`, { headers: { authorization: "Bearer errado" } })).status, 401);
  assert.deepEqual(await (await fetch(`${base}/health`, { headers: auth })).json(), { ok: true });

  const first = await (await fetch(`${base}/snapshot?after=-1&wait=0`, { headers: auth })).json();
  assert.equal(first.seq, 0, "responde já, a carga começa em paralelo");
  const loaded = await (await fetch(`${base}/snapshot?after=0&wait=${MAX_WAIT_MS * 4}`, { headers: auth })).json();
  assert.equal(loaded.seq, 1);
  assert.equal(loaded.snapshot.releases[0].number, 172);

  const refreshed = await fetch(`${base}/refresh`, { method: "POST", headers: auth });
  assert.equal(refreshed.status, 200);
  assert.equal(loads, 2);

  assert.equal((await (await fetch(`${base}/release?number=172`, { headers: auth })).json()).runId, running.runId);
  assert.equal((await fetch(`${base}/release?number=99`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/release?number=abc`, { headers: auth })).status, 400);
  assert.equal((await fetch(`${base}/nada`, { headers: auth })).status, 404);
});

test("servidor: erro do lookup vira 502 com a mensagem", async (t) => {
  const time = manualTime();
  const monitor = createMonitor({ load: async () => fixtureSnapshot(), isActive: () => false, now: time.now, timers: time.timers });
  const server = createServer(
    createHandler({
      token: "t",
      monitor,
      lookup: async () => {
        throw new Error("gh auth token falhou");
      },
    }),
  );
  const base = await listen(server);
  t.after(() => {
    monitor.stop();
    server.close();
  });
  const response = await fetch(`${base}/release?number=1`, { headers: { authorization: "Bearer t" } });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "gh auth token falhou" });
});
