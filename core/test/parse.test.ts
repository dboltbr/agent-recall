import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCatFileBatch, parseNote, parseNotesList, releaseName } from "../notes.ts";
import { describe, pollRef } from "../poll.ts";
import { parseAgentSession, parseSessionValue } from "../trailer.ts";
import { fakeGitHub, note } from "./fakes.ts";

test("trailer Agent-Session: Paseo, OpenCode, Claude Code e lixo", () => {
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
  assert.deepEqual(parseAgentSession("fix: x\n\nAgent-Session: claude/archdev/86117ef6-50de-42ad-8ffc-a2d6f03df9ec\n"), {
    harness: "claude",
    host: "archdev",
    id: "86117ef6-50de-42ad-8ffc-a2d6f03df9ec",
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
  const body = '{"release":"release-90","owner":null,"notified":[],"updatedAt":"2026-10-27T14:00:00Z","x":"ção"}';
  const out = `b1 blob ${Buffer.byteLength(body)}\n${body}\nb2 missing\nb3 blob 3\nabc\n`;
  const bodies = parseCatFileBatch(out);
  assert.equal(bodies.get("b1"), body);
  assert.equal(bodies.get("b3"), "abc");
  assert.equal(parseNote(bodies.get("b3")!), null);
  assert.equal(parseNote('{"release":"release-90"}'), null, "sem updatedAt");
  assert.equal(parseNote('{"updatedAt":"2026-10-27T14:00:00Z"}'), null, "sem release");
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

test("describe: erro marcado sem message vira o _tag", () => {
  const tagged = Object.assign(new Error(""), { _tag: "SessionNotFoundError" });
  assert.equal(describe(tagged), "SessionNotFoundError");
  assert.equal(describe(new Error("caiu")), "caiu");
  assert.equal(describe({ code: 7 }), '{"code":7}');
});
