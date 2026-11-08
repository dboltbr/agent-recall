// The Paseo delivery's lease checks (server/paseo.ts): the root a lane stands in for, and whether
// an agent works, lanes included. Agent records live under $PASEO_HOME/agents/<project>/<id>.json.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createDelivery } from "../../server/paseo.ts";
import type { Exec, ExecResult } from "../types.ts";
import { tempState } from "./fakes.ts";

const SERVER = "srv_here";

async function paseoHome(records: Record<string, Record<string, string>>): Promise<string> {
  const home = await tempState();
  await mkdir(join(home, "agents", "proj"), { recursive: true });
  for (const [id, labels] of Object.entries(records)) {
    await writeFile(join(home, "agents", "proj", `${id}.json`), JSON.stringify({ id, labels }));
  }
  return home;
}

/** `paseo inspect` answers `inspect[id]`; `paseo ls --label parent=<id>` answers the agents whose parent is id. */
function fakePaseo(inspect: Record<string, { Status: string; UpdatedAt: string }>, agents: Array<{ id: string; parent: string; status: string }>) {
  const calls: string[] = [];
  const exec: Exec = async (command, args): Promise<ExecResult> => {
    calls.push([command, ...args].join(" "));
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify(inspect[args[1]!] ?? {}), stderr: "" };
    if (args[0] === "ls") {
      const parent = args[args.indexOf("--label") + 1]!.split("=")[1];
      const listed = agents.filter((agent) => agent.parent === parent).map(({ id, status }) => ({ id, status }));
      return { code: 0, stdout: JSON.stringify(listed), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "?" };
  };
  return { exec, calls };
}

const ref = (id: string) => ({ harness: "paseo" as const, host: SERVER, id });

test("Paseo resolveRoot: sobe pelos pais deste daemon; para no pai de outro servidor ou sem registro", async () => {
  process.env["PASEO_HOME"] = await paseoHome({
    lane: { "paseo.parent-agent-id": "mid", "paseo.parent-server-id": SERVER },
    mid: { "paseo.parent-agent-id": "root" },
    root: {},
    remote_lane: { "paseo.parent-agent-id": "root", "paseo.parent-server-id": "srv_other" },
    orphan_lane: { "paseo.parent-agent-id": "gone" },
  });
  const delivery = createDelivery(fakePaseo({}, []).exec, await tempState(), SERVER);
  assert.deepEqual(await delivery.resolveRoot!(ref("lane")), ref("root"));
  assert.deepEqual(await delivery.resolveRoot!(ref("remote_lane")), ref("remote_lane"), "pai em outro daemon");
  assert.deepEqual(await delivery.resolveRoot!(ref("orphan_lane")), ref("orphan_lane"), "pai sem registro aqui");
});

test("Paseo isWorking: em turno, ativo há menos de 10 min, ou com lane rodando abaixo", async () => {
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  const { exec } = fakePaseo(
    {
      busy: { Status: "running", UpdatedAt: old },
      recent: { Status: "idle", UpdatedAt: new Date().toISOString() },
      orchestrator: { Status: "idle", UpdatedAt: old },
      quiet: { Status: "idle", UpdatedAt: old },
    },
    [
      { id: "lane1", parent: "orchestrator", status: "idle" },
      { id: "sub", parent: "lane1", status: "running" },
      { id: "done", parent: "quiet", status: "idle" },
    ],
  );
  process.env["PASEO_HOME"] = await paseoHome({});
  const delivery = createDelivery(exec, await tempState(), SERVER);
  assert.equal(await delivery.isWorking!(ref("busy")), true);
  assert.equal(await delivery.isWorking!(ref("recent")), true);
  assert.equal(await delivery.isWorking!(ref("orchestrator")), true, "a lane da lane roda");
  assert.equal(await delivery.isWorking!(ref("quiet")), false);
});
