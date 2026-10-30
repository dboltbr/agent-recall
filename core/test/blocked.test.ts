import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, readHandoffs } from "../host.ts";
import type { ReleaseTracker } from "../release-fetch.ts";
import { buildRelease, buildSnapshot, type Release } from "../release-status.ts";
import { blockedRecalls } from "../route.ts";
import type { Me } from "../types.ts";
import { createWatcher } from "../watcher.ts";
import { config, fakeDelivery, fakeExec, fakeGitHub, fixedClock, NOW, quietLog, tempState, writeConfig } from "./fakes.ts";
import { finished, job, minutesAgo, run, RUNNERS } from "./releases.ts";

const me: Me = { harness: "opencode", host: "archdev", incidentHost: false };

/** A run whose `verify-production / check` failed: nothing built, nothing tagged, no note. */
function blocked(number: number, completedMinutesAgo: number, pusher = "opencode/archdev/ses_pusher"): Release {
  return buildRelease({
    run: run({
      run_number: number,
      status: "completed",
      conclusion: "failure",
      updated_at: minutesAgo(completedMinutesAgo),
      head_commit: { message: `feat(mobile): prepara a publicação\n\nAgent-Session: ${pusher}\n` },
    }),
    jobs: [
      job("trigger", "success", [completedMinutesAgo + 9, completedMinutesAgo + 8.9]),
      job("verify-production / check", "failure", [completedMinutesAgo + 8, completedMinutesAgo + 0.5]),
      job("release-tag", "skipped", [completedMinutesAgo, completedMinutesAgo]),
      job("watch", "skipped", [completedMinutesAgo, completedMinutesAgo]),
    ],
    note: null,
    commits: null,
    now: NOW,
  });
}

function shipped(number: number, completedMinutesAgo: number): Release {
  return buildRelease({
    run: run({ run_number: number, status: "completed", conclusion: "success", updated_at: minutesAgo(completedMinutesAgo) }),
    jobs: finished("success"),
    note: null,
    commits: null,
    now: NOW,
  });
}

test("release barrada antes da tag chama quem fez o push, uma vez por release", () => {
  const release = blocked(292, 20);
  assert.equal(release.verdict, "failed");
  assert.equal(release.tag, null);
  assert.deepEqual(blockedRecalls([release], me, NOW), [
    {
      kind: "blocked",
      release: "release-292",
      target: { harness: "opencode", host: "archdev", id: "ses_pusher" },
      lock: "ses_pusher.blocked",
    },
  ]);
});

test("release barrada: verde, com tag, cancelada, antiga ou de outro host não chama ninguém", () => {
  const green = shipped(300, 5);
  assert.deepEqual(blockedRecalls([green], me, NOW), []);
  const cancelled = { ...blocked(301, 5), verdict: "cancelled" as const };
  assert.deepEqual(blockedRecalls([cancelled], me, NOW), []);
  const tagged = { ...blocked(302, 5), tag: "release-302" };
  assert.deepEqual(blockedRecalls([tagged], me, NOW), []);
  assert.deepEqual(blockedRecalls([blocked(303, 9 * 60)], me, NOW), [], "fora da janela de 8 h");
  assert.deepEqual(blockedRecalls([blocked(304, 5, "opencode/outro/ses_x")], me, NOW), []);
  assert.deepEqual(blockedRecalls([blocked(305, 5, "paseo/archdev/agent-x")], me, NOW), []);
  const anonymous = { ...blocked(306, 5), pusher: null };
  assert.deepEqual(blockedRecalls([anonymous], me, NOW), []);
});

test("release barrada que uma release posterior já levou à produção não chama ninguém", () => {
  const releases = [shipped(294, 2), blocked(293, 10, "opencode/archdev/ses_b"), blocked(292, 20)];
  assert.deepEqual(blockedRecalls(releases, me, NOW), []);
  const stillBlocked = [blocked(294, 2, "opencode/archdev/ses_c"), blocked(292, 20)];
  assert.deepEqual(
    blockedRecalls(stillBlocked, me, NOW).map((action) => action.release),
    ["release-294", "release-292"],
  );
});

async function setup(releases: Release[], delivery = fakeDelivery()) {
  const stateDir = await tempState();
  const configFile = await writeConfig(await tempState(), config);
  const git = fakeExec(() => ({}));
  const snapshot = buildSnapshot({ repository: "dboltbr/dbolt", workflow: "release", releases, runners: RUNNERS, now: NOW });
  const release: ReleaseTracker = { tick: async () => {}, refresh: async () => false, current: () => snapshot };
  const watcher = createWatcher({
    harness: "opencode",
    host: (c) => c.instance,
    loadConfig: () => loadConfig(configFile),
    stateDir,
    sha: "1234567890abcdef",
    pid: process.pid,
    clock: fixedClock(),
    fetch: fakeGitHub([{ status: 404 }, { status: 404 }]).fetch,
    exec: git.exec,
    delivery: delivery.delivery,
    log: quietLog,
    release,
  });
  return { watcher, delivery, git, stateDir };
}

test("watcher: release barrada vira um prompt à sessão do push e um handoff `blocked`", async () => {
  const { watcher, delivery, stateDir } = await setup([blocked(292, 20)]);
  const report = await watcher.tick();
  assert.deepEqual(
    report.handled.map((handled) => [handled.action.kind, handled.action.release, handled.outcome]),
    [["blocked", "release-292", "prompt"]],
  );
  const [call] = delivery.recorded.prompts;
  assert.equal(call!.target.id, "ses_pusher");
  assert.ok(call!.text.startsWith("Release barrada release-292: carregue a skill dbolt-release-incident. Papel: blocked. Release: {"));
  const payload = JSON.parse(call!.text.slice(call!.text.indexOf("Release: ") + "Release: ".length));
  assert.equal(payload.number, 292);
  assert.equal(payload.failedJob.name, "verify-production / check");
  assert.deepEqual(payload.sessions, ["opencode/archdev/ses_pusher"]);
  const handoffs = await readHandoffs(stateDir, "release-292");
  assert.deepEqual(
    handoffs.map((handoff) => [handoff.role, handoff.session.id]),
    [["blocked", "ses_pusher"]],
  );
  await watcher.tick();
  assert.equal(delivery.recorded.prompts.length, 1, "segundo tick: o lock segura o chamado");
});

test("watcher: release barrada que ninguém recebeu só vai ao log, sem nota", async () => {
  const { watcher, delivery, git } = await setup([blocked(292, 20)], fakeDelivery({ prompt: "refuse", fallback: "refuse" }));
  const report = await watcher.tick();
  assert.deepEqual(
    report.handled.map((handled) => handled.outcome),
    ["failed"],
  );
  assert.equal(delivery.recorded.fallbacks.length, 1);
  assert.equal(git.gitCalls("push").length, 0);
});
