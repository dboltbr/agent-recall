import { releaseName } from "./notes.ts";
import type { Release } from "./release-status.ts";
import { formatSession, parseSessionValue, sameSession, toSessionRef } from "./trailer.ts";
import type { Me, Note, Role, SessionRef } from "./types.ts";

export const CATCH_UP_MS = 8 * 60 * 60 * 1000;
export const FIX_FORWARD_MS = 30 * 60 * 1000;

export type Action =
  /** Call an existing session of this host. */
  | { readonly kind: "recall"; readonly release: string; readonly role: Role; readonly target: SessionRef; readonly lock: string }
  /** Several sessions in the range: the incident host opens a new investigation session. */
  | { readonly kind: "investigation"; readonly release: string; readonly lock: string }
  /** Fix-forward past 30 min without `fix.readyAt`: remind the owner. */
  | { readonly kind: "remind"; readonly release: string; readonly target: SessionRef; readonly lock: string }
  /** The run failed before the tag (verification, build, publication): the pusher gets it green. */
  | { readonly kind: "blocked"; readonly release: string; readonly target: SessionRef; readonly lock: string };

/** A call that comes from an incident note (everything but `blocked`). */
export type NoteAction = Exclude<Action, { readonly kind: "blocked" }>;

const FIX_STATES = new Set(["reverted", "fix-pending"]);

/** Distinct sessions of the range, in note order. */
export function rangeSessions(note: Note): SessionRef[] {
  const out: SessionRef[] = [];
  for (const entry of note.sessions ?? []) {
    const ref = toSessionRef(entry);
    if (ref && !out.some((seen) => sameSession(seen, ref))) out.push(ref);
  }
  return out;
}

function mine(ref: SessionRef, me: Me): boolean {
  return ref.harness === me.harness && ref.host === me.host;
}

/** Sessions that wrote a suspect commit (`assessment.suspects[].commit`). */
export function culpritSessions(note: Note): SessionRef[] {
  const suspects = (note.assessment?.suspects ?? [])
    .map((suspect) => suspect?.commit)
    .filter((commit): commit is string => typeof commit === "string" && commit.length >= 7);
  if (suspects.length === 0) return [];
  const out: SessionRef[] = [];
  for (const entry of note.sessions ?? []) {
    const ref = toSessionRef(entry);
    const commits = entry.commits ?? [];
    const wrote = commits.some((commit) => suspects.some((s) => commit.startsWith(s) || s.startsWith(commit)));
    if (ref && wrote && !out.some((seen) => sameSession(seen, ref))) out.push(ref);
  }
  return out;
}

/** Recent enough to act on: `updatedAt` within the 8 h catch-up window. */
export function isRecent(note: Note, now: Date): boolean {
  const at = Date.parse(note.updatedAt);
  return Number.isFinite(at) && now.getTime() - at <= CATCH_UP_MS;
}

/**
 * Calls a note asks of this plugin, by state. Every action carries its lock leaf; the caller
 * acts only when `mkdir <release>/<lock>` succeeds.
 *
 * - `red`: one session in the range → that session investigates (on its own host). Several →
 *   only the incident host opens a new investigation session.
 * - `reverted` | `fix-pending`: the original session of each suspect commit gets `fix`, unless it
 *   is the owner (it is already fixing).
 */
export function route(note: Note, me: Me): NoteAction[] {
  const release = releaseName(note);
  const actions: NoteAction[] = [];
  if (note.state === "red") {
    const sessions = rangeSessions(note);
    if (sessions.length === 1) {
      const target = sessions[0]!;
      if (mine(target, me)) actions.push({ kind: "recall", release, role: "investigate", target, lock: target.id });
    } else if (sessions.length > 1 && me.incidentHost) {
      actions.push({ kind: "investigation", release, lock: "investigation" });
    }
  }
  if (FIX_STATES.has(note.state)) {
    const owner = parseSessionValue(note.owner);
    for (const target of culpritSessions(note)) {
      if (!mine(target, me) || (owner && sameSession(owner, target))) continue;
      actions.push({ kind: "recall", release, role: "fix", target, lock: `${target.id}.fix` });
    }
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

/** The 30-min fix-forward reminder, when it is due for an owner on this host. */
export function dueReminder(note: Note, me: Me, now: Date): NoteAction | null {
  if (note.state !== "fix-pending" || note.fix?.readyAt) return null;
  const owner = parseSessionValue(note.owner);
  const at = Date.parse(note.assessment?.at ?? "");
  if (!owner || !mine(owner, me) || !Number.isFinite(at)) return null;
  if (now.getTime() - at < FIX_FORWARD_MS) return null;
  return { kind: "remind", release: releaseName(note), target: owner, lock: `${owner.id}.remind` };
}

/** The role a delivered call records (handoff, note `recall`). */
export function roleOf(action: Action): "investigate" | "fix" | "remind" | "blocked" {
  switch (action.kind) {
    case "recall":
      return action.role;
    case "investigation":
      return "investigate";
    case "remind":
      return "remind";
    case "blocked":
      return "blocked";
  }
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case "recall":
      return `${action.release} ${action.role} → ${formatSession(action.target)}`;
    case "investigation":
      return `${action.release} investigate → nova sessão`;
    case "remind":
      return `${action.release} lembrete 30 min → ${formatSession(action.target)}`;
    case "blocked":
      return `${action.release} barrada antes da produção → ${formatSession(action.target)}`;
  }
}
