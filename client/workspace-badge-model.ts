// Pure workspace badge & release selector shared by `workspace-badge.tsx` and `header-buttons.tsx`.
import { prForBranch, prRowBadge, type RowBadgeDescriptor } from "../shared/queue-status.ts";
import { releaseRowBadge } from "../shared/release-copy.ts";
import { isActive, releaseForSession, type Release } from "../shared/release-status.ts";
import type { ReleaseView } from "../shared/rpc.ts";
import { sessionsOfAgent } from "./navigate.ts";

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

/** Pure selector for a workspace's sidebar badge: active release → merge queue PR → recent release. */
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
  const pr = prForBranch(snapshot.queue, branch);
  if (pr) {
    const queueBadge = prRowBadge(pr);
    if (queueBadge) return queueBadge;
  }
  if (release) return releaseRowBadge(release, now);
  return null;
}
