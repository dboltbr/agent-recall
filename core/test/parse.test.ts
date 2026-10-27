import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCatFileBatch, parseNote, parseNotesList, releaseName } from "../notes.ts";
import { pollRef } from "../poll.ts";
import { route } from "../route.ts";
import { parseAgentSession, parseSessionValue } from "../trailer.ts";
import { fakeGitHub, note, session } from "./fakes.ts";

test("trailer Agent-Session: Paseo, OpenCode e lixo", () => {
  const message = "fix: algo\n\nRelease-Note: x\nAgent-Session: paseo/srv_KkHRlgUn9pdj/c257d30e-8e80-4df1-bb9e-f8cbb360d8e7\n";
  assert.deepEqual(parseAgentSession(message), {
    harness: "paseo",
    host: "srv_KkHRlgUn9pdj",
    id: "c257d30e-8e80-4df1-bb9e-f8cbb360d8e7",
  });
  assert.deepEqual(parseSessionValue("opencode/archdev/ses_e817f2a10ffeXW8F6QF1FYbjTU"), {
    harness: "opencode",
    host: "archdev",
    id: "ses_e817f2a10ffeXW8F6QF1FYbjTU",
  });
  assert.equal(parseSessionValue("codex/archdev/x"), null);
  assert.equal(parseSessionValue("opencode/archdev"), null);
  assert.equal(parseAgentSession("commit humano\n"), null);
});

test("notas: list, cat-file --batch com UTF-8 e corpo inválido", () => {
  assert.deepEqual(parseNotesList("b1 k1\nb2 k2\n"), [
    { blob: "b1", key: "k1" },
    { blob: "b2", key: "k2" },
  ]);
  const body = '{"release":"release-90","state":"red","updatedAt":"2026-10-27T14:00:00Z","sessions":[],"x":"ção"}';
  const out = `b1 blob ${Buffer.byteLength(body)}\n${body}\nb2 missing\nb3 blob 3\nabc\n`;
  const bodies = parseCatFileBatch(out);
  assert.equal(bodies.get("b1"), body);
  assert.equal(bodies.get("b3"), "abc");
  assert.equal(parseNote(bodies.get("b3")!), null);
  assert.equal(releaseName(parseNote(body)!), "release-90");
  assert.equal(releaseName(note({ release: 91 })), "release-91");
});

test("poll: 304, 200 com ETag, 404", async () => {
  const base = { token: "t", repository: "dboltbr/dbolt", notesRef: "refs/notes/release-watch" };
  assert.deepEqual(await pollRef({ ...base, etag: '"x"', fetch: fakeGitHub([{ status: 304 }]).fetch }), { kind: "unchanged" });
  assert.deepEqual(await pollRef({ ...base, etag: null, fetch: fakeGitHub([{ status: 200, etag: '"y"', sha: "s1" }]).fetch }), {
    kind: "changed",
    etag: '"y"',
    sha: "s1",
  });
  assert.deepEqual(await pollRef({ ...base, etag: null, fetch: fakeGitHub([{ status: 404 }]).fetch }), { kind: "missing" });
});

test("rota: uma sessão → investigar no host dela; várias → só o incident-host", () => {
  const me = { harness: "paseo" as const, host: "srv_a", incidentHost: false };
  const one = note({ release: "release-1", sessions: [session("paseo", "srv_a", "agent-1"), session("paseo", "srv_a", "agent-1")] });
  assert.deepEqual(route(one, me), [
    { kind: "recall", release: "release-1", role: "investigate", target: { harness: "paseo", host: "srv_a", id: "agent-1" }, lock: "agent-1" },
  ]);
  const two = note({ release: "release-2", sessions: [session("paseo", "srv_a", "agent-1"), session("opencode", "archdev", "ses_2")] });
  assert.deepEqual(route(two, me), []);
  assert.deepEqual(route(two, { ...me, incidentHost: true }), [{ kind: "investigation", release: "release-2", lock: "investigation" }]);
  assert.deepEqual(route({ ...two, state: "investigating" }, { ...me, incidentHost: true }), []);
});
