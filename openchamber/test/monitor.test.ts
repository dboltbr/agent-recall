import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVE_INTERVAL_MS, createMonitor, IDLE_INTERVAL_MS, PAUSE_AFTER_MS } from "../src/service/monitor.ts";
import { manualTime, settle } from "./timers.ts";

interface Snap {
  readonly active: boolean;
  readonly n: number;
}

function setup(script: Array<Snap | Error>) {
  const time = manualTime(1_000_000);
  let loads = 0;
  const monitor = createMonitor<Snap>({
    load: async () => {
      const next = script[Math.min(loads, script.length - 1)]!;
      loads++;
      if (next instanceof Error) throw next;
      return next;
    },
    isActive: (snap) => snap.active,
    now: time.now,
    timers: time.timers,
  });
  return { time, monitor, loads: () => loads };
}

test("monitor: não carrega nada antes da primeira requisição", async () => {
  const { time, loads } = setup([{ active: false, n: 1 }]);
  await time.advance(IDLE_INTERVAL_MS * 3);
  assert.equal(loads(), 0);
});

test("monitor: 30 s com release ativo, 5 min parado", async () => {
  const { time, monitor, loads } = setup([
    { active: true, n: 1 },
    { active: true, n: 2 },
    { active: false, n: 3 },
  ]);
  monitor.touch();
  await settle();
  assert.equal(loads(), 1);
  assert.deepEqual(time.pending(), [ACTIVE_INTERVAL_MS]);
  await time.advance(ACTIVE_INTERVAL_MS);
  assert.equal(loads(), 2);
  await time.advance(ACTIVE_INTERVAL_MS);
  assert.equal(loads(), 3);
  assert.deepEqual(time.pending(), [IDLE_INTERVAL_MS]);
  await time.advance(IDLE_INTERVAL_MS - 1);
  assert.equal(loads(), 3);
});

test("monitor: pausa depois de 10 min sem requisições e retoma no próximo touch", async () => {
  const { time, monitor, loads } = setup([{ active: true, n: 1 }]);
  monitor.touch();
  await settle();
  await time.advance(PAUSE_AFTER_MS + ACTIVE_INTERVAL_MS * 2);
  const paused = loads();
  assert.ok(paused >= PAUSE_AFTER_MS / ACTIVE_INTERVAL_MS);
  assert.deepEqual(time.pending(), []);
  await time.advance(IDLE_INTERVAL_MS);
  assert.equal(loads(), paused);
  monitor.touch();
  await settle();
  assert.equal(loads(), paused + 1);
});

test("monitor: falha conta como carga, mantém o último snapshot e sobe o seq", async () => {
  const { time, monitor } = setup([{ active: true, n: 1 }, new Error("GitHub 502"), { active: true, n: 1 }]);
  monitor.touch();
  await settle();
  assert.equal(monitor.current().seq, 1);
  await time.advance(ACTIVE_INTERVAL_MS);
  const failed = monitor.current();
  assert.equal(failed.seq, 2);
  assert.equal(failed.error, "GitHub 502");
  assert.deepEqual(failed.snapshot, { active: true, n: 1 });
  assert.deepEqual(time.pending(), [ACTIVE_INTERVAL_MS], "sem retry imediato");
  await time.advance(ACTIVE_INTERVAL_MS);
  assert.equal(monitor.current().error, null);
  assert.equal(monitor.current().seq, 3);
});

test("monitor: snapshot igual não sobe o seq", async () => {
  const { time, monitor } = setup([{ active: true, n: 1 }]);
  monitor.touch();
  await settle();
  await time.advance(ACTIVE_INTERVAL_MS * 2);
  assert.equal(monitor.current().seq, 1);
});

test("monitor: long-poll resolve na mudança ou no prazo", async () => {
  const { time, monitor } = setup([{ active: true, n: 1 }, { active: true, n: 2 }]);
  const cold = monitor.waitForChange(0, 15_000);
  monitor.touch();
  assert.equal((await cold).seq, 1);

  let settled: number | null = null;
  void monitor.waitForChange(1, 60_000).then((envelope) => (settled = envelope.seq));
  await time.advance(ACTIVE_INTERVAL_MS);
  assert.equal(settled, 2);

  let timedOut: number | null = null;
  void monitor.waitForChange(2, 5_000).then((envelope) => (timedOut = envelope.seq));
  await time.advance(4_999);
  assert.equal(timedOut, null);
  await time.advance(1);
  assert.equal(timedOut, 2);
});

test("monitor: refresh concorrente reaproveita a carga em andamento", async () => {
  const { monitor, loads } = setup([{ active: false, n: 1 }]);
  await Promise.all([monitor.refresh(), monitor.refresh()]);
  assert.equal(loads(), 1);
  monitor.stop();
});
