// Pure workspace badge & release selector shared by `workspace-badge.tsx` and `header-buttons.tsx`.
import { prForBranch, prForSession, prRowBadge, type PullRequestStatus, type RowBadgeDescriptor } from "../shared/queue-status.ts";
import { releaseRowBadge } from "../shared/release-copy.ts";
import { isActive, prBeatsFinishedRelease, releaseForSession, type Release } from "../shared/release-status.ts";
import type { ReleaseView } from "../shared/rpc.ts";
import { sessionsOfAgent } from "./navigate.ts";

/** Best PR linked to `workspaceId`: matching branch first, else any PR authored by an agent in this workspace. */
export function prForWorkspace(view: ReleaseView | null, workspaceId: string, branch: string | null): PullRequestStatus | null {
  const queue = view?.snapshot?.queue;
  if (!view || !queue) return null;
  const byBranch = prForBranch(queue, branch);
  if (byBranch) return byBranch;
  for (const agent of view.agents) {
    if (agent.workspaceId !== workspaceId) continue;
    for (const session of sessionsOfAgent(view, agent.id)) {
      const bySession = prForSession(queue, session);
      if (bySession) return bySession;
    }
  }
  return null;
}

/** Best release linked to any agent of `workspaceId`: active first, else newest finished. */
export function releaseForWorkspace(view: ReleaseView | null, workspaceId: string, now: Date = new Date()): Release | null {
  const snapshot = view?.snapshot;
  if (!view || !snapshot) return null;
  const matched: Release[] = [];
  for (const agent of view.agents) {
    if (agent.workspaceId !== workspaceId) continue;
    for (const session of sessionsOfAgent(view, agent.id)) {
      const release = releaseForSession(snapshot, session, now);
      if (release && !matched.some((known) => known.runId === release.runId)) matched.push(release);
    }
  }
  if (!matched.length) return null;
  const active = matched.find(isActive);
  if (active) return active;
  return matched.sort((a, b) => b.number - a.number)[0] ?? null;
}

/** Pure selector for a workspace's sidebar badge: active release → active/newer PR → recent release. */
export function selectWorkspaceRowBadge(
  view: ReleaseView | null,
  workspaceId: string,
  branch: string | null,
  now: Date = new Date(),
): RowBadgeDescriptor | null {
  const snapshot = view?.snapshot;
  if (!view || !snapshot) return null;
  const release = releaseForWorkspace(view, workspaceId, now);
  if (release && isActive(release)) return releaseRowBadge(release, now);
  const recentReleaseBadge = release ? releaseRowBadge(release, now) : null;
  const pr = prForWorkspace(view, workspaceId, branch);
  if (pr) {
    const queueBadge = prRowBadge(pr);
    if (queueBadge && (!recentReleaseBadge || !release || prBeatsFinishedRelease(pr, release))) {
      return queueBadge;
    }
  }
  return recentReleaseBadge;
}
