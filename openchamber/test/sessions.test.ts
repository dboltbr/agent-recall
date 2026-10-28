import assert from "node:assert/strict";
import { test } from "node:test";
import type { GuestSessionRecord } from "@openchamber/sdk";
import type { Release } from "../../core/release-status.ts";
import { loadSessionTitles, sessionIndex, watchLinks, watchSessionIds, type SessionLister } from "../src/ui/sessions.ts";
import { reverted, running } from "./fixture.ts";
import { settle } from "./timers.ts";

/** Release 170 after the watch reverted: pushed from ses_pusher, then investigated and fixed. */
const incident: Release = {
  ...reverted,
  pusher: { harness: "opencode", host: "archdev", id: "ses_pusher" },
  handoffs: [
    { role: "investigate", session: { harness: "opencode", host: "archdev", id: "ses_pusher" }, at: "2026-10-27T11:00:00Z" },
    { role: "fix", session: { harness: "opencode", host: "archdev", id: "ses_fix" }, at: "2026-10-27T11:05:00Z" },
    { role: "owner", session: { harness: "paseo", host: "srv_X", id: "agent-owner" }, at: "2026-10-27T11:06:00Z" },
    { role: "fix", session: { harness: "opencode", host: "archdev", id: "ses_gone" }, at: "2026-10-27T11:07:00Z" },
  ],
};

function record(id: string, title: string, projectId: string): GuestSessionRecord {
  return { id, title, projectId } as GuestSessionRecord;
}

function fakeLister(projects: Record<string, GuestSessionRecord[] | Error>) {
  let projectCalls = 0;
  const lister: SessionLister = {
    async listProjects() {
      projectCalls++;
      return { kind: "projects", state: "ready", projects: Object.keys(projects).map((id) => ({ id, name: id, directory: `/p/${id}` })) };
    },
    async listSessions(projectId) {
      const sessions = projects[projectId]!;
      if (sessions instanceof Error) throw sessions;
      return { kind: "sessions", projectId, state: "ready", coverage: [], sessions };
    },
  };
  return { lister, calls: () => projectCalls };
}

test("watchLinks: só sessões OpenCode que o servidor lista, push primeiro e papéis juntos", () => {
  const titles = new Map([
    ["ses_pusher", "Aviso ao morador"],
    ["ses_fix", ""],
  ]);
  assert.deepEqual(watchLinks(incident, titles), [
    { sessionId: "ses_pusher", label: "push + investigação · “Aviso ao morador”" },
    { sessionId: "ses_fix", label: "correção · sessão ses_fix" },
  ]);
  assert.deepEqual(watchLinks(incident, new Map()), [], "sessão que este servidor não lista não vira link");
  assert.deepEqual(watchSessionIds(incident), ["ses_pusher", "ses_fix", "ses_gone"], "agente Paseo fica de fora");
  assert.deepEqual(watchSessionIds(running), ["ses_pusher"]);
});

test("loadSessionTitles: junta os projetos e pula o que falha", async () => {
  const { lister } = fakeLister({
    dbolt: [record("ses_pusher", "Aviso ao morador", "dbolt")],
    other: new Error("NOT_FOUND"),
    tools: [record("ses_fix", "", "tools")],
  });
  assert.deepEqual([...(await loadSessionTitles(lister))], [
    ["ses_pusher", "Aviso ao morador"],
    ["ses_fix", ""],
  ]);
});

test("sessionIndex: recarrega só para sessão desconhecida e no máximo uma vez por intervalo", async () => {
  let clock = 0;
  let changes = 0;
  const { lister, calls } = fakeLister({ dbolt: [record("ses_pusher", "Aviso ao morador", "dbolt")] });
  const index = sessionIndex(lister, () => changes++, 15_000, () => clock);

  index.want(["ses_pusher"]);
  await settle();
  assert.equal(calls(), 1);
  assert.equal(changes, 1);
  assert.equal(index.titles().get("ses_pusher"), "Aviso ao morador");

  index.want(["ses_pusher"]);
  index.want([]);
  await settle();
  assert.equal(calls(), 1, "tudo conhecido: sem nova leitura");

  index.want(["ses_gone"]);
  await settle();
  assert.equal(calls(), 1, "desconhecida dentro do intervalo espera");

  clock = 15_000;
  index.want(["ses_gone"]);
  await settle();
  assert.equal(calls(), 2);
});

test("sessionIndex: host que recusa a capacidade não quebra nem martela", async () => {
  let clock = 0;
  let projectCalls = 0;
  const refusing: SessionLister = {
    async listProjects() {
      projectCalls++;
      throw Object.assign(new Error("not granted"), { code: "NOT_GRANTED" });
    },
    async listSessions() {
      throw new Error("unreachable");
    },
  };
  const index = sessionIndex(refusing, () => assert.fail("sem mudança"), 15_000, () => clock);
  index.want(["ses_pusher"]);
  await settle();
  index.want(["ses_pusher"]);
  await settle();
  assert.equal(projectCalls, 1);
  assert.equal(index.titles().size, 0);
});
