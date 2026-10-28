import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRelease } from "../../shared/release-status.ts";
import type { ReleaseView } from "../../shared/rpc.ts";
import { NOW } from "../../core/test/fakes.ts";
import { finished, minutesAgo, run } from "../../core/test/releases.ts";
import type { Note } from "../../shared/types.ts";
import { hopToAgent, RELEASES_SCREEN, takeHop, watchLinks } from "../navigate.ts";

const HOST = "srv_X";

function redRelease() {
  return buildRelease({
    run: run({
      run_number: 190,
      status: "completed",
      conclusion: "failure",
      head_commit: { message: "fix: x\n\nAgent-Session: paseo/srv_X/agent-pusher\n" },
    }),
    jobs: finished("failure"),
    note: { release: "release-190", state: "investigating", updatedAt: minutesAgo(1), owner: "paseo/srv_X/agent-gone" } as Note,
    commits: null,
    handoffs: [
      { role: "investigate", session: { harness: "paseo", host: HOST, id: "agent-inv" }, at: minutesAgo(3) },
      { role: "fix", session: { harness: "opencode", host: "archdev", id: "ses_fix" }, at: minutesAgo(2) },
      { role: "remind", session: { harness: "paseo", host: "srv_other", id: "agent-elsewhere" }, at: minutesAgo(1) },
    ],
    now: NOW,
  });
}

function viewOf(agents: string[]): ReleaseView {
  return { host: HOST, snapshot: null, agents: agents.map((id) => ({ id, title: id === "agent-pusher" ? "Aviso" : null, workspaceId: "w" })) };
}

test("watchLinks: só agentes Paseo deste host que existem; o agente do cartão conta como existente", () => {
  const release = redRelease();
  assert.deepEqual(watchLinks(viewOf(["agent-pusher", "agent-inv"]), release), [
    { agentId: "agent-pusher", label: "push · “Aviso”" },
    { agentId: "agent-inv", label: "investigação · agente agent-in" },
  ]);
  assert.deepEqual(
    watchLinks(null, release, ["agent-pusher"]).map((link) => link.agentId),
    ["agent-pusher"],
    "sem view: só o agente conhecido",
  );
});

test("salto pela tela: abre uma vez por nonce e ignora salto velho", () => {
  const opened: unknown[] = [];
  hopToAgent((input) => opened.push(input), "agent-1");
  const input = opened[0] as { screenId: string; params: Record<string, string> };
  assert.equal(input.screenId, RELEASES_SCREEN);
  assert.equal(input.params["open"], "agent-1");
  const now = Number(input.params["nonce"]);
  assert.equal(takeHop(input.params, now + 1000), "agent-1");
  assert.equal(takeHop(input.params, now + 1000), null, "mesmo nonce não abre de novo");
  assert.equal(takeHop({ open: "agent-2", nonce: String(now - 60_000) }, now), null, "salto de 1 min atrás é recarga");
  assert.equal(takeHop({}, now), null);
});
