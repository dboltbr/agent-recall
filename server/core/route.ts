import { releaseName } from "./notes.ts";
import type { Release } from "./release-status.ts";
import { formatSession, sameSession, toSessionRef } from "./trailer.ts";
import type { Me, Note, Role, SessionRef } from "./types.ts";

export const CATCH_UP_MS = 8 * 60 * 60 * 1000;
/**
 * How long the owner's call waits for the watch to record how the rollback ended. The watch gives
 * Flux 5 min to apply the revert; past this a `pending` note means the watch died mid-rollback,
 * and the owner is called with what the note says.
 */
export const ROLLBACK_WAIT_MS = 10 * 60 * 1000;

export type Action =
  /** Call an existing session of this host: the note's owner, or one of its notified sessions. */
  | { readonly kind: "recall"; readonly release: string; readonly role: Role; readonly target: SessionRef; readonly lock: string }
  /** The run failed before the tag (verification, build, publication): the pusher gets it green. */
  | { readonly kind: "blocked"; readonly release: string; readonly target: SessionRef; readonly lock: string };

/** A call that comes from an incident note (everything but `blocked`). */
export type NoteAction = Exclude<Action, { readonly kind: "blocked" }>;

function mine(ref: SessionRef, me: Me): boolean {
  return ref.harness === me.harness && ref.host === me.host;
}

/** The note's owner, or null when the range head carries no `Agent-Session`. */
export function noteOwner(note: Note): SessionRef | null {
  return toSessionRef(note.owner);
}

/** Distinct notified sessions, in note order, without the owner. */
export function notifiedSessions(note: Note): SessionRef[] {
  const owner = noteOwner(note);
  const out: SessionRef[] = [];
  for (const entry of Array.isArray(note.notified) ? note.notified : []) {
    const ref = toSessionRef(entry);
    if (ref && !(owner && sameSession(owner, ref)) && !out.some((seen) => sameSession(seen, ref))) out.push(ref);
  }
  return out;
}

/** Recent enough to act on: `updatedAt` within the 8 h catch-up window. */
export function isRecent(note: Note, now: Date): boolean {
  const at = Date.parse(note.updatedAt);
  return Number.isFinite(at) && now.getTime() - at <= CATCH_UP_MS;
}

/** The rollback has an outcome, or waited long enough (`ROLLBACK_WAIT_MS` since the verdict). */
export function rollbackSettled(note: Note, now: Date): boolean {
  if (note.rollback?.outcome !== "pending") return true;
  const verdictAt = (note.verdict as { at?: unknown } | null | undefined)?.at;
  const at = Date.parse(typeof verdictAt === "string" ? verdictAt : note.updatedAt);
  return !Number.isFinite(at) || now.getTime() - at >= ROLLBACK_WAIT_MS;
}

/**
 * Calls a note asks of this plugin, for sessions of its own harness and host. Every action
 * carries its lock leaf; the caller acts only when `mkdir <release>/<lock>` succeeds, so routing
 * the same note again is harmless.
 *
 * - No owner (range head without `Agent-Session`) or a resolved note (`resolvedBy`) → nobody.
 * - `owner` → asked to act, once the rollback has an outcome (`rollbackSettled`).
 * - `notified` → told at once, with the owner's name; never asked to act.
 */
export function route(note: Note, me: Me, now: Date): NoteAction[] {
  const owner = noteOwner(note);
  if (!owner || note.resolvedBy) return [];
  const release = releaseName(note);
  const actions: NoteAction[] = [];
  if (mine(owner, me) && rollbackSettled(note, now)) {
    actions.push({ kind: "recall", release, role: "owner", target: owner, lock: `${owner.id}.owner` });
  }
  for (const target of notifiedSessions(note)) {
    if (mine(target, me)) actions.push({ kind: "recall", release, role: "notified", target, lock: `${target.id}.notified` });
  }
  return actions;
}

/**
 * Releases that failed before production (verdict `failed`, no tag) and whose pusher is a session
 * of this harness and host, finished within the 8 h catch-up window. No note exists for them: the
 * watch never ran, nothing reached production and nothing gets reverted, but the push is blocked
 * until main is green again, so the session that pushed is called once per release. A newer
 * release that got its tag already carried the range to production: nothing left to call.
 */
export function blockedRecalls(releases: readonly Release[], me: Me, now: Date): Action[] {
  const actions: Action[] = [];
  const shipped = Math.max(-Infinity, ...releases.filter((release) => release.tag !== null).map((release) => release.number));
  for (const release of releases) {
    if (release.verdict !== "failed" || release.tag !== null || !release.pusher) continue;
    if (release.number < shipped) continue;
    const at = Date.parse(release.completedAt ?? "");
    if (!Number.isFinite(at) || now.getTime() - at > CATCH_UP_MS) continue;
    const target = toSessionRef(release.pusher);
    if (!target || !mine(target, me)) continue;
    actions.push({ kind: "blocked", release: release.name, target, lock: `${target.id}.blocked` });
  }
  return actions;
}

/** The role a delivered call records (handoff, note `recall`). */
export function roleOf(action: Action): Role | "blocked" {
  return action.kind === "recall" ? action.role : "blocked";
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case "recall":
      return `${action.release} ${action.role} → ${formatSession(action.target)}`;
    case "blocked":
      return `${action.release} barrada antes da produção → ${formatSession(action.target)}`;
  }
}
