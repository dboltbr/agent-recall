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

/** Writes each record (labels, lastStatus, updatedAt, archivedAt…) as `$PASEO_HOME/agents/proj/<id>.json`. */
async function paseoHome(records: Record<string, Record<string, unknown>>): Promise<string> {
  const home = await tempState();
  await mkdir(join(home, "agents", "proj"), { recursive: true });
  for (const [id, record] of Object.entries(records)) {
    await writeFile(join(home, "agents", "proj", `${id}.json`), JSON.stringify({ id, ...record }));
  }
  return home;
}

/** `paseo inspect` answers `inspect[id]`; anything else fails (lanes come from the records). */
function fakePaseo(inspect: Record<string, { Status: string; UpdatedAt: string }>) {
  const calls: string[] = [];
  const exec: Exec = async (command, args): Promise<ExecResult> => {
    calls.push([command, ...args].join(" "));
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify(inspect[args[1]!] ?? {}), stderr: "" };
    return { code: 1, stdout: "", stderr: "?" };
  };
  return { exec, calls };
}

const ref = (id: string) => ({ harness: "paseo" as const, host: SERVER, id });
const parent = (id: string) => ({ "paseo.parent-agent-id": id });

test("Paseo resolveRoot: sobe pelos pais deste daemon; para no pai de outro servidor, sem registro ou arquivado", async () => {
  process.env["PASEO_HOME"] = await paseoHome({
    lane: { labels: { ...parent("mid"), "paseo.parent-server-id": SERVER } },
    mid: { labels: parent("root") },
    root: { labels: {} },
    remote_lane: { labels: { ...parent("root"), "paseo.parent-server-id": "srv_other" } },
    orphan_lane: { labels: parent("gone") },
    under_archived: { labels: parent("archived_mid") },
    archived_mid: { labels: parent("root"), archivedAt: "2026-11-01T00:00:00.000Z" },
  });
  const delivery = createDelivery(fakePaseo({}).exec, await tempState(), SERVER);
  assert.deepEqual(await delivery.resolveRoot!(ref("lane")), ref("root"));
  assert.deepEqual(await delivery.resolveRoot!(ref("remote_lane")), ref("remote_lane"), "pai em outro daemon");
  assert.deepEqual(await delivery.resolveRoot!(ref("orphan_lane")), ref("orphan_lane"), "pai sem registro aqui");
  assert.deepEqual(await delivery.resolveRoot!(ref("under_archived")), ref("under_archived"), "pai arquivado não é chamável");
});

test("Paseo isWorking: em turno, ativo há menos de 10 min, ou com lane viva trabalhando abaixo; um só inspect", async () => {
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  const fresh = new Date().toISOString();
  const { exec, calls } = fakePaseo({
    busy: { Status: "running", UpdatedAt: old },
    recent: { Status: "idle", UpdatedAt: fresh },
    orchestrator: { Status: "idle", UpdatedAt: old },
    recent_lane: { Status: "idle", UpdatedAt: old },
    quiet: { Status: "idle", UpdatedAt: old },
    cyclic: { Status: "idle", UpdatedAt: old },
  });
  process.env["PASEO_HOME"] = await paseoHome({
    lane1: { labels: parent("orchestrator"), lastStatus: "idle", updatedAt: old },
    sub: { labels: parent("lane1"), lastStatus: "running", updatedAt: old },
    talker: { labels: parent("recent_lane"), lastStatus: "idle", updatedAt: fresh },
    // Archived while its record still says running: it works no more.
    zombie: { labels: parent("quiet"), lastStatus: "running", updatedAt: fresh, archivedAt: old },
    done: { labels: parent("quiet"), lastStatus: "closed", updatedAt: old },
    loop_a: { labels: parent("cyclic"), lastStatus: "idle", updatedAt: old },
    loop_b: { labels: parent("loop_a"), lastStatus: "idle", updatedAt: old },
    cyclic: { labels: parent("loop_b"), lastStatus: "idle", updatedAt: old },
  });
  const delivery = createDelivery(exec, await tempState(), SERVER);
  assert.equal(await delivery.isWorking!(ref("busy")), true);
  assert.equal(await delivery.isWorking!(ref("recent")), true);
  assert.equal(await delivery.isWorking!(ref("orchestrator")), true, "a lane da lane roda");
  assert.equal(await delivery.isWorking!(ref("recent_lane")), true, "a lane mexeu há menos de 10 min");
  assert.equal(await delivery.isWorking!(ref("quiet")), false, "lane arquivada e lane fechada antiga não contam");
  assert.equal(await delivery.isWorking!(ref("cyclic")), false, "ciclo nos registros termina");
  assert.deepEqual(
    calls.map((call) => call.split(" ")[1]),
    ["inspect", "inspect", "inspect", "inspect", "inspect", "inspect"],
    "nenhum paseo ls por lane",
  );
});
