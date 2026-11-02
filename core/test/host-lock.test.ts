import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readdir, utimes } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { acquireHostLock, acquireLock, lockPort } from "../host.ts";
import { quietLog, tempState } from "./fakes.ts";

const hostModule = join(dirname(fileURLToPath(import.meta.url)), "..", "host.ts");

test("trava do host disputada no processo: um só a tem; largada, o próximo a pega", async () => {
  const stateDir = await tempState();
  const locks = await Promise.all([1, 2, 3].map(() => acquireHostLock(stateDir, "claude.poller", quietLog)));
  const held = locks.filter((lock) => lock !== null);
  assert.equal(held.length, 1);
  assert.equal(await acquireHostLock(stateDir, "claude.poller", quietLog), null);
  // In-process stop and start (OpenCode reload): released, it is taken again at once.
  await held[0]!.release();
  const again = await acquireHostLock(stateDir, "claude.poller", quietLog);
  assert.notEqual(again, null);
  await again!.release();
});

test("dono morto por kill -9: o próximo candidato pega a trava na hora", { timeout: 20_000 }, async () => {
  const stateDir = await tempState();
  const script = `import { acquireHostLock } from ${JSON.stringify(hostModule)};
const lock = await acquireHostLock(${JSON.stringify(stateDir)}, "claude.poller");
process.stdout.write(lock ? "held\\n" : "lost\\n");
setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const first = await new Promise<string>((resolve) => child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString())));
  assert.equal(first, "held\n");
  assert.equal(await acquireHostLock(stateDir, "claude.poller", quietLog), null, "dono vivo em outro processo");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  const lock = await acquireHostLock(stateDir, "claude.poller", quietLog);
  assert.notEqual(lock, null);
  await lock!.release();
});

test("porta da trava ocupada por outro programa: este host não consulta, sem segunda porta", async () => {
  const stateDir = await tempState();
  const port = lockPort(stateDir, "claude.poller");
  const foreign = createServer((socket) => socket.end("SSH-2.0-OpenSSH_9.9\r\n"));
  await new Promise<void>((resolve) => foreign.listen(port, "127.0.0.1", resolve));
  try {
    const warnings: string[] = [];
    const lock = await acquireHostLock(stateDir, "claude.poller", { ...quietLog, warn: (message) => warnings.push(message) });
    assert.equal(lock, null);
    assert.deepEqual(warnings, [`porta ${port} ocupada por outro programa: este host não consulta`]);
  } finally {
    await new Promise((resolve) => foreign.close(resolve));
  }
});

test("release com um cliente que não fecha a conexão termina num prazo curto", { timeout: 10_000 }, async () => {
  const stateDir = await tempState();
  const lock = await acquireHostLock(stateDir, "claude.poller", quietLog);
  assert.notEqual(lock, null);
  // A client that connects and never reads nor closes (a probe stuck mid-way).
  const client = connect({ host: "127.0.0.1", port: lock!.port, allowHalfOpen: true });
  client.on("error", () => undefined);
  await new Promise((resolve) => client.once("connect", resolve));
  const started = Date.now();
  await lock!.release();
  assert.ok(Date.now() - started < 2_000, `release levou ${Date.now() - started} ms`);
  client.destroy();
});

test("mesmo nome de trava em outro diretório de estado é outra trava", async () => {
  const theirs = await acquireHostLock(await tempState(), "claude.poller", quietLog);
  const mine = await acquireHostLock(await tempState(), "claude.poller", quietLog);
  assert.notEqual(theirs, null);
  assert.notEqual(mine, null);
  await theirs!.release();
  await mine!.release();
});

test("trava de chamado vale uma vez, mesmo tomada há muito tempo e nunca terminada", async () => {
  const stateDir = await tempState();
  assert.equal(await acquireLock(stateDir, "release-90", "ses_a"), true);
  const old = new Date(Date.now() - 60 * 60_000);
  await utimes(join(stateDir, "release-90", "ses_a"), old, old);
  assert.equal(await acquireLock(stateDir, "release-90", "ses_a"), false);
});

test("publishExclusive: escrita que falha no meio (disco cheio) não deixa o temporário", { skip: process.platform === "win32" }, async () => {
  const dir = await tempState();
  // A file size limit with SIGXFSZ ignored: the write fails with EFBIG after the temp file exists.
  const script = `import { publishExclusive } from ${JSON.stringify(hostModule)};
try { await publishExclusive(process.argv[1] + "/r.json", "x".repeat(4 << 20)); console.log("ok"); } catch (e) { console.log(e.code); }`;
  const result = spawnSync("sh", ["-c", 'trap "" XFSZ; ulimit -f 64; exec "$0" --input-type=module -e "$1" "$2"', process.execPath, script, dir], {
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.stdout.trim(), "EFBIG", result.stderr);
  assert.deepEqual(await readdir(dir), []);
});
