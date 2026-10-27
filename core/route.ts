import { releaseName } from "./notes.ts";
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
  | { readonly kind: "remind"; readonly release: string; readonly target: SessionRef; readonly lock: string };

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
export function route(note: Note, me: Me): Action[] {
  const release = releaseName(note);
  const actions: Action[] = [];
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

/** The 30-min fix-forward reminder, when it is due for an owner on this host. */
export function dueReminder(note: Note, me: Me, now: Date): Action | null {
  if (note.state !== "fix-pending" || note.fix?.readyAt) return null;
  const owner = parseSessionValue(note.owner);
  const at = Date.parse(note.assessment?.at ?? "");
  if (!owner || !mine(owner, me) || !Number.isFinite(at)) return null;
  if (now.getTime() - at < FIX_FORWARD_MS) return null;
  return { kind: "remind", release: releaseName(note), target: owner, lock: `${owner.id}.remind` };
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case "recall":
      return `${action.release} ${action.role} → ${formatSession(action.target)}`;
    case "investigation":
      return `${action.release} investigate → nova sessão`;
    case "remind":
      return `${action.release} lembrete 30 min → ${formatSession(action.target)}`;
  }
}
