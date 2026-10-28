import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  firstIn,
  openCodeCommand,
  openCodeTarget,
  PASEO_RETRY_MS,
  updateOpenCode,
  updatePaseo,
  type OpenCodeUpdateDeps,
  type PaseoUpdateDeps,
} from "../self-update.ts";
import type { Exec, ExecResult } from "../types.ts";
import { fixedClock, NOW, quietLog, tempState } from "./fakes.ts";

const OLD = "5509e22c9b8e3eb84e968ddbf590c952a13d2e24";
const NEW = "e1675ab0000000000000000000000000000000aa";

/** An OpenCode package install: `<root>/package.json` + `<root>/node_modules/agent-recall/dist/`. */
async function openCodeInstall(spec: string | null): Promise<string> {
  const root = await tempState();
  const dist = join(root, "node_modules", "agent-recall", "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "agent-recall.js"), "// bundle\n");
  if (spec !== null) await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "agent-recall": spec } }));
  return pathToFileURL(join(dist, "agent-recall.js")).href;
}

/** Records every call; `reply` answers by argument list. */
function recordingExec(reply: (args: readonly string[]) => ExecResult) {
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs });
    return reply(args);
  };
  return { exec, calls };
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

test("firstIn: só o primeiro chamador do processo", () => {
  const scope: Record<symbol, unknown> = {};
  const key = Symbol("k");
  assert.equal(firstIn(scope, key), true);
  assert.equal(firstIn(scope, key), false);
});

test("openCodeCommand: o binário do OpenCode em execução, senão o PATH", () => {
  assert.equal(openCodeCommand("/opt/@opencode/cli/bin/opencode.exe"), "/opt/@opencode/cli/bin/opencode.exe");
  assert.equal(openCodeCommand("/usr/local/bin/opencode"), "/usr/local/bin/opencode");
  assert.equal(openCodeCommand("/usr/bin/node"), "opencode");
});

test("openCodeTarget: o spec configurado da instalação de pacote; nulo fora dela", async () => {
  assert.equal(await openCodeTarget(await openCodeInstall("github:dboltbr/agent-recall")), "github:dboltbr/agent-recall");
  assert.equal(await openCodeTarget(await openCodeInstall(null)), null);
  assert.equal(await openCodeTarget(pathToFileURL("/home/me/dev/agent-recall/dist/agent-recall.js").href), null);
  assert.equal(await openCodeTarget(pathToFileURL("/home/me/.config/opencode/plugins/agent-recall.js").href), null);
});

function openCodeDeps(exec: Exec, moduleUrl: string, command = "opencode") {
  const clock = fixedClock();
  const slept: number[] = [];
  const deps: OpenCodeUpdateDeps = {
    exec,
    log: quietLog,
    clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock.set(new Date(clock.now().getTime() + ms));
    },
    moduleUrl,
    command,
  };
  return { deps, slept };
}

test("OpenCode: instalação git roda opencode plugin update <spec> com prazo", async () => {
  const moduleUrl = await openCodeInstall("github:dboltbr/agent-recall");
  const { exec, calls } = recordingExec(() => ok('Updated Server plugin "agent-recall"\n'));
  const result = await updateOpenCode(openCodeDeps(exec, moduleUrl, "/bin/opencode").deps);
  assert.equal(result, "updated");
  assert.deepEqual(calls, [{ command: "/bin/opencode", args: ["plugin", "update", "github:dboltbr/agent-recall"], timeoutMs: 60_000 }]);
});

test("OpenCode: em dia, falha do CLI e checkout local", async () => {
  const moduleUrl = await openCodeInstall("github:dboltbr/agent-recall");
  const current = recordingExec(() => ok("No plugin updates available\n"));
  assert.equal(await updateOpenCode(openCodeDeps(current.exec, moduleUrl).deps), "current");
  assert.equal(current.calls.length, 1);

  const failing = recordingExec(() => ({ code: 124, stdout: "", stderr: "prazo estourou" }));
  const failed = openCodeDeps(failing.exec, moduleUrl);
  assert.equal(await updateOpenCode(failed.deps), "failed");
  assert.deepEqual(failed.slept, [5_000, 10_000]);
  assert.equal(failing.calls.length, 3);

  const local = recordingExec(() => ok(""));
  const dev = pathToFileURL("/home/me/dev/agent-recall/dist/agent-recall.js").href;
  assert.equal(await updateOpenCode(openCodeDeps(local.exec, dev).deps), "local");
  assert.equal(local.calls.length, 0);
});

test("OpenCode: serviço recém-iniciado responde 'not configured' e a nova tentativa atualiza", async () => {
  const moduleUrl = await openCodeInstall("github:dboltbr/agent-recall");
  const replies: ExecResult[] = [
    { code: 1, stdout: "", stderr: "Error: Plugin is not configured\n    at cli.plugin.inspect" },
    ok("No package plugins found\n"),
    ok('Updated Server plugin "agent-recall"\n'),
  ];
  const { exec, calls } = recordingExec(() => replies.shift() ?? ok(""));
  const { deps, slept } = openCodeDeps(exec, moduleUrl);
  assert.equal(await updateOpenCode(deps), "updated");
  assert.deepEqual(slept, [5_000, 10_000]);
  // Every attempt shares the 60 s budget.
  assert.deepEqual(calls.map((call) => call.timeoutMs), [60_000, 55_000, 45_000]);
});

test("OpenCode: serviço que nunca esquenta termina como falha, não como em dia", async () => {
  const moduleUrl = await openCodeInstall("github:dboltbr/agent-recall");
  const { exec, calls } = recordingExec(() => ok("No package plugins found\n"));
  assert.equal(await updateOpenCode(openCodeDeps(exec, moduleUrl).deps), "failed");
  assert.equal(calls.length, 3);
});

test("OpenCode: spec fixado num commit não chama o CLI", async () => {
  const moduleUrl = await openCodeInstall(`github:dboltbr/agent-recall#${OLD}`);
  const { exec, calls } = recordingExec(() => ok(""));
  assert.equal(await updateOpenCode(openCodeDeps(exec, moduleUrl).deps), "pinned");
  assert.equal(calls.length, 0);
});

function preview(outcome: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      id: "agent-recall",
      outcome,
      current: { identity: { kind: "git", remote: "https://github.com/dboltbr/agent-recall.git" }, currentRevision: OLD },
      links: [],
      ...extra,
    },
  ]);
}

async function paseoDeps(exec: Exec, clock = fixedClock()) {
  const slept: number[] = [];
  const deps: PaseoUpdateDeps = {
    exec,
    log: quietLog,
    clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock.set(new Date(clock.now().getTime() + ms));
    },
    home: "/home/me/.paseo",
    stateDir: await tempState(),
  };
  return { deps, slept };
}

test("Paseo: revisão nova numa instalação git → --check e depois --yes, marca o commit", async () => {
  const { exec, calls } = recordingExec((args) =>
    args.includes("--check") ? ok(preview("update", { target: { kind: "git", commit: NEW } })) : ok("[]"),
  );
  const { deps } = await paseoDeps(exec);
  assert.equal(await updatePaseo(deps), "updated");
  assert.deepEqual(
    calls.map((call) => [call.command, ...call.args]),
    [
      ["paseo", "plugin", "update", "agent-recall", "--check", "--json", "--home", "/home/me/.paseo"],
      ["paseo", "plugin", "update", "agent-recall", "--yes", "--json", "--home", "/home/me/.paseo"],
    ],
  );
  assert.ok(calls.every((call) => call.timeoutMs <= 60_000));
  const marker = JSON.parse(await readFile(join(deps.stateDir, "paseo.update"), "utf8")) as { commit: string; at: string };
  assert.deepEqual(marker, { commit: NEW, at: NOW.toISOString() });
});

test("Paseo: diretório (checkout de dev) e revisão em dia não aplicam nada", async () => {
  const local = recordingExec(() =>
    ok(JSON.stringify([{ id: "agent-recall", outcome: "local", current: { identity: { kind: "directory", path: "/dev/agent-recall" } }, links: [] }])),
  );
  assert.equal(await updatePaseo((await paseoDeps(local.exec)).deps), "local");
  assert.equal(local.calls.length, 1);

  const current = recordingExec(() => ok(preview("current")));
  assert.equal(await updatePaseo((await paseoDeps(current.exec)).deps), "current");
  assert.equal(current.calls.length, 1);
});

test("Paseo: sem laço — o plugin recarregado acha em dia; o mesmo commit não é reaplicado em 30 min", async () => {
  let installed = OLD;
  const { exec, calls } = recordingExec((args) => {
    if (args.includes("--yes")) return ok("[]"); // a Paseo that "applies" but keeps proposing NEW
    return ok(preview("update", { current: { identity: { kind: "git" }, currentRevision: installed }, target: { kind: "git", commit: NEW } }));
  });
  const clock = fixedClock();
  const { deps } = await paseoDeps(exec, clock);
  assert.equal(await updatePaseo(deps), "updated");
  // The reloaded plugin (another process) runs again with the same state directory.
  assert.equal(await updatePaseo(deps), "throttled");
  assert.equal(calls.filter((call) => call.args.includes("--yes")).length, 1);

  clock.set(new Date(NOW.getTime() + PASEO_RETRY_MS + 1));
  assert.equal(await updatePaseo(deps), "updated");
  assert.equal(calls.filter((call) => call.args.includes("--yes")).length, 2);

  installed = NEW;
  const reloaded = recordingExec(() => ok(preview("current", { current: { identity: { kind: "git" }, currentRevision: installed } })));
  assert.equal(await updatePaseo({ ...deps, exec: reloaded.exec }), "current");
});

test("Paseo: daemon ainda não atende → uma nova tentativa; falhas só registram", async () => {
  let checks = 0;
  const { exec } = recordingExec((args) => {
    if (args.includes("--check")) return ++checks === 1 ? { code: 1, stdout: "", stderr: "connect ECONNREFUSED" } : ok(preview("current"));
    return ok("[]");
  });
  const { deps, slept } = await paseoDeps(exec);
  assert.equal(await updatePaseo(deps), "current");
  assert.deepEqual(slept, [10_000]);

  const down = recordingExec(() => ({ code: 1, stdout: "", stderr: "connect ECONNREFUSED" }));
  const second = await paseoDeps(down.exec);
  assert.equal(await updatePaseo(second.deps), "failed");
  assert.equal(down.calls.length, 2);

  const garbage = recordingExec(() => ok("not json"));
  assert.equal(await updatePaseo((await paseoDeps(garbage.exec)).deps), "failed");

  const applyFails = recordingExec((args) =>
    args.includes("--check") ? ok(preview("update", { target: { kind: "git", commit: NEW } })) : { code: 1, stdout: "", stderr: "preparation failed" },
  );
  assert.equal(await updatePaseo((await paseoDeps(applyFails.exec)).deps), "failed");
});
