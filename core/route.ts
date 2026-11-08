import { releaseName } from "./notes.ts";
import type { Release, ReleaseSnapshot } from "./release-status.ts";
import { formatSession, parseSessionValue, sameSession, toSessionRef } from "./trailer.ts";
import type { BlockedNote, Me, Note, Role, SessionRef } from "./types.ts";

export const CATCH_UP_MS = 8 * 60 * 60 * 1000;
/** A delivered blocked call the note does not confirm in this long goes to the fallback copy. */
export const ACK_TIMEOUT_MS = 2 * 60_000;
/**
 * A blocked note's lease: the holder (`owner` in `investigating`, `fix.session` in `fix-pending`)
 * keeps it while its newest sign (`heartbeatAt`, `updatedAt`) is younger than this; a red note, or a
 * `fix-pending` one without `fix.session`, whose `updatedAt` is older has a target that never took it.
 */
export const LEASE_MS = 20 * 60_000;
/** The holder's plugin writes `heartbeatAt` once the newest sign is this old and the session works. */
export const HEARTBEAT_MS = 10 * 60_000;
/**
 * How long the owner's call waits for the watch to record how the rollback ended. The watch gives
 * Flux 5 min to apply the revert; past this a `pending` note means the watch died mid-rollback,
 * and the owner is called with what the note says.
 */
export const ROLLBACK_WAIT_MS = 10 * 60 * 1000;

export type Action =
  /** Call an existing session of this host: the note's owner, or one of its notified sessions. */
  | { readonly kind: "recall"; readonly release: string; readonly role: Role; readonly target: SessionRef; readonly lock: string }
  /**
   * A release blocked before its tag (`refs/notes/release-blocked`): the range's session
   * (`blocked`), or a suspect's session once the investigation named it (`fix`). Both get the same
   * prompt; the skill reads the note state.
   */
  | {
      readonly kind: "blocked";
      readonly release: string;
      readonly role: "blocked" | "fix";
      readonly target: SessionRef;
      readonly lock: string;
      /** The note's session `target` stands in for when that one is a lane (`target` is its root). */
      readonly candidate?: SessionRef;
    };

/** A call that comes from an incident note. */
export type NoteAction = Extract<Action, { readonly kind: "recall" }>;
/** A call that comes from a blocked-release note. */
export type BlockedAction = Extract<Action, { readonly kind: "blocked" }>;

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
export function isRecent(note: Pick<Note | BlockedNote, "updatedAt">, now: Date): boolean {
  const at = Date.parse(note.updatedAt);
  return Number.isFinite(at) && now.getTime() - at <= CATCH_UP_MS;
}

/** A blocked note is also recent while its holder's heartbeat is: a long investigation stays live. */
export function isBlockedRecent(note: BlockedNote, now: Date): boolean {
  return isRecent(note, now) || (typeof note.heartbeatAt === "string" && isRecent({ updatedAt: note.heartbeatAt }, now));
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

/** The commit `sha` and a trailer's commit name the same commit (either may be abbreviated). */
function sameCommit(a: string, b: string): boolean {
  return a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));
}

/** The elements of `value` when it is an array; anything else (JSON from another repository) is empty. */
function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A string field of a JSON value, or null (the blocked note comes from another repository). */
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Distinct identified sessions of a blocked note's range, in note order, with their commits. The
 * note is JSON from another repository: a `sessions` that is not an array, an entry that is not a
 * session, or `commits` that is not an array of strings counts as empty, never throws.
 */
function blockedSessions(note: BlockedNote): { ref: SessionRef; commits: readonly string[] }[] {
  const out: { ref: SessionRef; commits: string[] }[] = [];
  for (const entry of list(note.sessions)) {
    const ref = toSessionRef(entry);
    if (!ref) continue;
    const commits = list((entry as { commits?: unknown }).commits).filter((commit): commit is string => typeof commit === "string");
    const known = out.find((seen) => sameSession(seen.ref, ref));
    if (known) known.commits.push(...commits);
    else out.push({ ref, commits: [...commits] });
  }
  return out;
}

/** The sessions in the note's `expired`, as `<harness>/<host>/<id>`. */
export function expiredSessions(note: BlockedNote): Set<string> {
  const out = new Set<string>();
  for (const entry of list(note.expired)) {
    const session = entry && typeof entry === "object" ? text((entry as { session?: unknown }).session) : null;
    if (session) out.add(session);
  }
  return out;
}

/**
 * The range's sessions nearest the head first: the head commit's session (`range.to`), then note
 * order (the CI lists them by their newest commit, newest first).
 */
export function blockedCandidates(note: BlockedNote): SessionRef[] {
  const sessions = blockedSessions(note);
  const head = text((note.range as { to?: unknown } | null | undefined)?.to);
  const atHead = head ? sessions.findIndex((entry) => entry.commits.some((commit) => sameCommit(commit, head))) : -1;
  if (atHead > 0) sessions.unshift(...sessions.splice(atHead, 1));
  return sessions.map((entry) => entry.ref);
}

/**
 * Who a red blocked release calls: the range's session nearest the head that is not in `expired`
 * (commits without a trailer are not in `sessions`); none → nobody here (no session at all: the
 * failed run tells the human; all expired: the incident host).
 */
export function blockedTarget(note: BlockedNote): SessionRef | null {
  const expired = expiredSessions(note);
  return blockedCandidates(note).find((ref) => !expired.has(formatSession(ref))) ?? null;
}

/**
 * Lock leaf of a blocked call. It carries the number of expired sessions: a session called again
 * after the note went back to `red` is a new call.
 */
export function blockedLock(role: "blocked" | "fix", target: SessionRef, note: BlockedNote): string {
  const generation = list(note.expired).length;
  return `${target.id}.${role === "fix" ? "blocked-fix" : "blocked"}${generation ? `-${generation}` : ""}`;
}

export type BlockedLease =
  /** Nothing to keep or expire: closed, waiting for its first call, or no session in the range. */
  | { readonly kind: "none" }
  /** `holder` keeps the lease; its plugin writes `heartbeatAt` when due and the session works. */
  | { readonly kind: "held"; readonly holder: SessionRef; readonly heartbeatDue: boolean }
  /** Back to `red` without `owner` nor `fix`, `who` into `expired`. */
  | { readonly kind: "expire"; readonly who: readonly string[]; readonly reason: string }
  /**
   * Red, and every session of the range expired: the incident host's call. `stale`: nobody took it
   * (its agent expired, or 20 min passed since the last change), the call failed for good.
   */
  | { readonly kind: "orphan"; readonly stale: boolean };

/** Milliseconds of an ISO time, or NaN. */
function at(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/** The newest finite time among `values`, or NaN. */
function newest(...values: number[]): number {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : Number.NaN;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);

/**
 * What the lease of a blocked note asks now (design "Posse"). Pure: every plugin reads the same
 * note and gets the same answer, and each write re-decides on the body it replaces (CAS).
 *
 * - `investigating` (or a `red` someone took) → held by `owner`; `fix-pending` with `fix.session` →
 *   held by it. Its newest sign over 20 min old → expire the holder.
 * - `red` without owner: the target (`blockedTarget`) not taken in 20 min → expire it; no target
 *   left but sessions in the range → orphan.
 * - `fix-pending` without `fix.session` 20 min old → expire the culprits called (the owner when none).
 * - `shipped`, `unrelated`, `escalated`, `duplicate` never expire.
 */
export function blockedLease(note: BlockedNote, now: Date): BlockedLease {
  const state = note.state;
  if (state !== "red" && state !== "investigating" && state !== "fix-pending") return { kind: "none" };
  const updated = at(note.updatedAt);
  const fixSession = text((note.fix as { session?: unknown } | null | undefined)?.session);
  const holder = state === "fix-pending" ? fixSession : text(note.owner);
  if (holder) {
    const idle = now.getTime() - newest(updated, at(note.heartbeatAt));
    if (idle > LEASE_MS) return { kind: "expire", who: [holder], reason: `sem sinal de trabalho há ${minutes(idle)} min` };
    const ref = parseSessionValue(holder);
    return ref ? { kind: "held", holder: ref, heartbeatDue: !(idle < HEARTBEAT_MS) } : { kind: "none" };
  }
  const idle = now.getTime() - updated;
  if (state === "fix-pending") {
    if (!(idle > LEASE_MS)) return { kind: "none" };
    const owner = parseSessionValue(text(note.owner));
    const expired = expiredSessions(note);
    const called = blockedCulprits(note)
      .filter((ref) => !(owner && sameSession(owner, ref)) && !expired.has(formatSession(ref)))
      .map(formatSession);
    const who = called.length ? called : owner ? [formatSession(owner)] : [];
    return { kind: "expire", who, reason: `correção não assumida em ${minutes(idle)} min` };
  }
  if (state === "investigating") {
    return idle > LEASE_MS ? { kind: "expire", who: [], reason: `investigação sem dona há ${minutes(idle)} min` } : { kind: "none" };
  }
  const target = blockedTarget(note);
  if (target) {
    return idle > LEASE_MS ? { kind: "expire", who: [formatSession(target)], reason: `chamado não assumido em ${minutes(idle)} min` } : { kind: "none" };
  }
  if (blockedSessions(note).length === 0) return { kind: "none" };
  const incident = note.incident && typeof note.incident === "object" ? note.incident : null;
  const agent = text(incident?.session);
  const quiet = now.getTime() - newest(updated, at(incident?.at));
  return { kind: "orphan", stale: (agent !== null && expiredSessions(note).has(agent)) || quiet > LEASE_MS };
}

/**
 * The note with the lease expired: back to `red` without `owner`, `fix` nor `heartbeatAt`, `who`
 * appended to `expired`. Everything else (assessment, incident, recall) is kept.
 */
export function expireLease(body: Record<string, unknown>, who: readonly string[], reason: string, now: Date): Record<string, unknown> {
  const { owner: _owner, fix: _fix, heartbeatAt: _heartbeat, ...rest } = body;
  const stamp = now.toISOString();
  return {
    ...rest,
    state: "red",
    expired: [...list(body["expired"]), ...who.map((session) => ({ session, at: stamp, reason }))],
    updatedAt: stamp,
  };
}

/** Sessions that wrote a suspect commit (`assessment.suspects[].commit`), in note order; malformed suspects are ignored. */
export function blockedCulprits(note: BlockedNote): SessionRef[] {
  const assessment = note.assessment as { suspects?: unknown } | null | undefined;
  const suspects = list(assessment?.suspects)
    .map((suspect) => (suspect && typeof suspect === "object" ? text((suspect as { commit?: unknown }).commit) : null))
    .filter((commit): commit is string => commit !== null);
  return blockedSessions(note)
    .filter((entry) => entry.commits.some((commit) => suspects.some((suspect) => sameCommit(commit, suspect))))
    .map((entry) => entry.ref);
}

/**
 * Calls a blocked-release note asks of this plugin, for sessions of its own harness and host.
 * Lock leaves differ from the incident's: a re-run that gets the tag may open an incident under the
 * same release name.
 *
 * - `red` without owner → `blockedTarget`, role `blocked`. A red note with an owner is taken.
 * - `fix-pending` → each suspect's session (`blockedCulprits`) not in `expired`, role `fix`, unless
 *   it is the owner.
 *
 * A target may be a lane: the watcher swaps it for its root (`Delivery.resolveRoot`) before calling.
 * - Any other state (`investigating`, `duplicate`, `shipped`, `unrelated`, `escalated`) calls nobody.
 */
export function routeBlocked(note: BlockedNote, me: Me): BlockedAction[] {
  const release = releaseName(note);
  const actions: BlockedAction[] = [];
  if (note.state === "red" && !note.owner) {
    const target = blockedTarget(note);
    if (target && mine(target, me)) actions.push({ kind: "blocked", release, role: "blocked", target, lock: blockedLock("blocked", target, note) });
  }
  if (note.state === "fix-pending") {
    const owner = parseSessionValue(text(note.owner));
    const expired = expiredSessions(note);
    const others = blockedCulprits(note).filter((target) => !(owner && sameSession(owner, target)));
    const callable = others.filter((target) => !expired.has(formatSession(target)));
    for (const target of callable) {
      if (!mine(target, me)) continue;
      actions.push({ kind: "blocked", release, role: "fix", target, lock: blockedLock("fix", target, note) });
    }
    // Every other culprit expired: the fix is the owner's own, it is told so once.
    const fixSession = text((note.fix as { session?: unknown } | null | undefined)?.session);
    if (owner && others.length > 0 && callable.length === 0 && !fixSession && mine(owner, me) && !expired.has(formatSession(owner))) {
      actions.push({ kind: "blocked", release, role: "fix", target: owner, lock: blockedLock("fix", owner, note) });
    }
  }
  return actions;
}

/** `351` for `release-351`; NaN when the name carries no number. */
function releaseNumber(note: Pick<BlockedNote, "release">): number {
  return Number(/^release-(\d+)$/.exec(releaseName(note))?.[1]);
}

/**
 * The release history that may close a blocked call: null when it is not loaded, or its last
 * refresh failed (the older history kept may miss the release that shipped).
 */
export function releaseHistory(snapshot: ReleaseSnapshot | null): readonly Release[] | null {
  return snapshot && !snapshot.error ? snapshot.releases : null;
}

/**
 * A release with a tag at or after the blocked one carried its range to production (a later push,
 * or a re-run of the same run): the blocked call is closed. Null when the release history cannot
 * tell: not at hand, or the blocked release is older than the oldest run it holds (the snapshot
 * keeps only the latest runs, so a tag in between may be missing) and no tag in it is at or after
 * it. Nobody is called on null.
 */
export function shippedSince(note: Pick<BlockedNote, "release">, releases: readonly Release[] | null): boolean | null {
  if (!releases || releases.length === 0) return null;
  const number = releaseNumber(note);
  if (releases.some((release) => release.tag !== null && release.number >= number)) return true;
  const oldest = Math.min(...releases.map((release) => release.number));
  return Number.isFinite(number) && number >= oldest ? false : null;
}

/**
 * Whether a delivered blocked call was taken: the note names the called session as `owner` or
 * `fix.session` (a fix call: `fix.session` only). Moot when the note is gone, closed by a tagged release, out of the 8 h window, or
 * left the state the call was for (someone else took it, the skill escalated, or the assessment no
 * longer names the fix call's session). Unknown when it would be open but whether a later release
 * shipped cannot be told (`shipped` null): the caller waits, keeping the call and starting no
 * fallback. `candidate` is the note's session the call stands in for when `target` is its root.
 */
export function blockedConfirmation(
  role: "blocked" | "fix",
  target: SessionRef,
  note: BlockedNote | null,
  shipped: boolean | null,
  now: Date,
  candidate: SessionRef = target,
): "taken" | "open" | "moot" | "unknown" {
  if (!note || shipped === true || !isBlockedRecent(note, now)) return "moot";
  const called = formatSession(target);
  const fixSession = text((note.fix as { session?: unknown } | null | undefined)?.session);
  // A fix call is taken by `fix.session` alone: the owner's own fix call targets the owner.
  if (fixSession === called || (role === "blocked" && text(note.owner) === called)) return "taken";
  const expired = expiredSessions(note);
  if (expired.has(called) || expired.has(formatSession(candidate))) return "moot";
  // A fix call stays open only while its session is still among the note's culprits: an
  // assessment that moved on to other commits makes it moot. A red call, while the note still
  // calls that session.
  // The owner's own fix call (every other culprit expired, or the culprit is its lane) stays open
  // while nobody took the fix.
  const next = blockedTarget(note);
  const ownFix = !fixSession && text(note.owner) === formatSession(candidate);
  const callable =
    role === "fix"
      ? note.state === "fix-pending" && (ownFix || blockedCulprits(note).some((culprit) => sameSession(culprit, candidate)))
      : note.state === "red" && !note.owner && next !== null && sameSession(next, candidate);
  if (!callable) return "moot";
  return shipped === null ? "unknown" : "open";
}

/** The role a delivered call records (handoff, note `recall`): every blocked call is `blocked`. */
export function roleOf(action: Action): Role | "blocked" {
  return action.kind === "recall" ? action.role : "blocked";
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case "recall":
      return `${action.release} ${action.role} → ${formatSession(action.target)}`;
    case "blocked":
      return `${action.release} barrada (${action.role}) → ${formatSession(action.target)}`;
  }
}
