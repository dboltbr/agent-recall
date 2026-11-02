import { releaseName } from "./notes.ts";
import type { Release, ReleaseSnapshot } from "./release-status.ts";
import { formatSession, parseSessionValue, sameSession, toSessionRef } from "./trailer.ts";
import type { BlockedNote, Me, Note, Role, SessionRef } from "./types.ts";

export const CATCH_UP_MS = 8 * 60 * 60 * 1000;
/** A delivered blocked call the note does not confirm in this long goes to the fallback copy. */
export const ACK_TIMEOUT_MS = 2 * 60_000;
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
  | { readonly kind: "blocked"; readonly release: string; readonly role: "blocked" | "fix"; readonly target: SessionRef; readonly lock: string };

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

/**
 * Who a red blocked release calls: the one identified session of the range (commits without a
 * trailer are not in `sessions`); with several, the session of the head commit (`range.to`), as
 * the incident's owner rule; none of them → nobody (the failed run tells the human).
 */
export function blockedTarget(note: BlockedNote): SessionRef | null {
  const sessions = blockedSessions(note);
  if (sessions.length === 1) return sessions[0]!.ref;
  const head = text((note.range as { to?: unknown } | null | undefined)?.to);
  if (!head) return null;
  return sessions.find((entry) => entry.commits.some((commit) => sameCommit(commit, head)))?.ref ?? null;
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
 * - `fix-pending` → each suspect's session (`blockedCulprits`), role `fix`, unless it is the owner.
 * - Any other state (`investigating`, `duplicate`, `shipped`, `unrelated`, `escalated`) calls nobody.
 */
export function routeBlocked(note: BlockedNote, me: Me): BlockedAction[] {
  const release = releaseName(note);
  const actions: BlockedAction[] = [];
  if (note.state === "red" && !note.owner) {
    const target = blockedTarget(note);
    if (target && mine(target, me)) actions.push({ kind: "blocked", release, role: "blocked", target, lock: `${target.id}.blocked` });
  }
  if (note.state === "fix-pending") {
    const owner = parseSessionValue(text(note.owner));
    for (const target of blockedCulprits(note)) {
      if (!mine(target, me) || (owner && sameSession(owner, target))) continue;
      actions.push({ kind: "blocked", release, role: "fix", target, lock: `${target.id}.blocked-fix` });
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
 * `fix.session`. Moot when the note is gone, closed by a tagged release, out of the 8 h window, or
 * left the state the call was for (someone else took it, the skill escalated, or the assessment no
 * longer names the fix call's session). Unknown when it would be open but whether a later release
 * shipped cannot be told (`shipped` null): the caller waits, keeping the call and starting no
 * fallback.
 */
export function blockedConfirmation(
  role: "blocked" | "fix",
  target: SessionRef,
  note: BlockedNote | null,
  shipped: boolean | null,
  now: Date,
): "taken" | "open" | "moot" | "unknown" {
  if (!note || shipped === true || !isRecent(note, now)) return "moot";
  const called = formatSession(target);
  const fixSession = text((note.fix as { session?: unknown } | null | undefined)?.session);
  if (text(note.owner) === called || fixSession === called) return "taken";
  // A fix call stays open only while its session is still among the note's culprits: an
  // assessment that moved on to other commits makes it moot.
  const callable =
    role === "fix"
      ? note.state === "fix-pending" && blockedCulprits(note).some((culprit) => sameSession(culprit, target))
      : note.state === "red" && !note.owner;
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
