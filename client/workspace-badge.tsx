// Sidebar workspace meta-row badge (`client.addWorkspaceRowBadgeItem`, Paseo 0.16+):
// draws merge-queue progress (`queue 2/3`, `fila #2`, `ejetado`) or release progress
// (`#702 · img 2/3`, `#702 · vigia`, `#702 · verde`) right beside host, PR and checks.
import { useWorkspace, type PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import { WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { useNow, useReleaseState } from "./data.ts";
import { selectWorkspaceRowBadge } from "./workspace-badge-model.ts";

export { releaseForWorkspace, selectWorkspaceRowBadge } from "./workspace-badge-model.ts";

export function WorkspacePipelineBadge({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
  const branch = useWorkspace(workspaceId, (workspace) => workspace.branch);
  const { view } = useReleaseState();
  const now = useNow(30_000);
  const badge = selectWorkspaceRowBadge(view, workspaceId, branch, now);
  if (!badge) return null;
  return <WorkspaceRowBadge icon={badge.icon} label={badge.label} tone={badge.tone} />;
}
