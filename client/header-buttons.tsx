// Workspace header buttons (`client.addHeaderButton`): one compact button on the right side of
// the workspace header whenever the workspace has a merge-queue PR or an active/recent release,
// opening the full Queue or Release popover from any tab (agent, diff, terminal).
import type {
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { prPillLabel, prStageBadge, type PullRequestStatus } from "../shared/queue-status.ts";
import { releaseBadge, releaseRowBadge } from "../shared/release-copy.ts";
import { isActive, pillLabel, prBeatsFinishedRelease, type Release } from "../shared/release-status.ts";
import type { ReleaseView } from "../shared/rpc.ts";
import { releaseState, subscribeReleases, useReleaseState } from "./data.ts";
import { directorySnapshot, matchesRepository, subscribeDirectory } from "./directory.ts";
import { toneColor } from "./kit.tsx";
import { hopToAgent, RELEASES_SCREEN } from "./navigate.ts";
import { QueuePopover } from "./queue-popover.tsx";
import { ReleasePopover } from "./release-popover.tsx";
import { prForWorkspace, releaseForWorkspace } from "./workspace-badge-model.ts";

const BUTTON_ID = "pipeline";
const RETRY_COOLDOWN_MS = 15_000;

type ButtonMode = "release" | "queue";

function prOfWorkspace(view: ReleaseView | null, workspaceId: string): PullRequestStatus | null {
  const snapshot = view?.snapshot;
  if (!snapshot?.queue) return null;
  const workspace = directorySnapshot().workspaces.get(workspaceId);
  const branch = workspace?.branch && matchesRepository(workspace.remoteUrl, snapshot.repository) ? workspace.branch : null;
  return prForWorkspace(view, workspaceId, branch);
}

/** Active release → active/newer PR in merge queue → recent release (<= 2 h). */
function targetOfWorkspace(
  view: ReleaseView | null,
  workspaceId: string,
  now: Date = new Date(),
): { mode: "release"; release: Release; label: string } | { mode: "queue"; pr: PullRequestStatus; label: string } | null {
  const release = releaseForWorkspace(view, workspaceId, now);
  if (release && isActive(release)) {
    return { mode: "release", release, label: pillLabel(release, now) };
  }
  const hasRecentRelease = !!(release && releaseRowBadge(release, now));
  const pr = prOfWorkspace(view, workspaceId);
  if (
    pr &&
    (pr.stage !== "open" || pr.ciState === "running" || pr.ciState === "failure") &&
    (!hasRecentRelease || !release || prBeatsFinishedRelease(pr, release))
  ) {
    return { mode: "queue", pr, label: prPillLabel(pr) };
  }
  if (hasRecentRelease && release) {
    return { mode: "release", release, label: pillLabel(release, now) };
  }
  return null;
}

function HeaderIcon(props: PluginButtonIconProps) {
  const { size, color, theme, workspaceId } = props;
  const { view } = useReleaseState();
  const target = targetOfWorkspace(view, workspaceId);
  const iconName =
    target?.mode === "queue" ? (target.pr.stage === "open" ? "GitPullRequest" : "GitMerge") : "Rocket";
  const tone =
    target?.mode === "release"
      ? releaseBadge(target.release).tone
      : target?.mode === "queue"
        ? prStageBadge(target.pr).tone
        : "muted";
  return (
    <View style={{ width: size, height: size }}>
      <Icon name={iconName} size={size} color={color} />
      {target ? (
        <View
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: 7,
            height: 7,
            borderRadius: 4,
            borderWidth: 1,
            borderColor: theme.colors.surface0,
            backgroundColor: toneColor(theme, tone),
          }}
        />
      ) : null}
    </View>
  );
}

interface Entry {
  readonly registration: PluginButtonRegistration;
  mode: ButtonMode;
  label: string;
  visible: boolean;
}

export function startWorkspaceHeaderButtons(client: PluginClientContext): () => void {
  const buttons = new Map<string, Entry>();
  const retryAfter = new Map<string, number>();

  function ReleaseContent({ theme, close, workspaceId }: PluginButtonContentProps) {
    return (
      <ReleasePopover
        theme={theme}
        pick={(view) => releaseForWorkspace(view, workspaceId)}
        openReleases={() => {
          close();
          client.openScreen({ screenId: RELEASES_SCREEN });
        }}
        openAgent={(target) => {
          close();
          hopToAgent((input) => client.openScreen(input), target);
        }}
      />
    );
  }

  function QueueContent({ theme, close, workspaceId }: PluginButtonContentProps) {
    return (
      <QueuePopover
        theme={theme}
        pick={(view) => prOfWorkspace(view, workspaceId)}
        openReleases={() => {
          close();
          client.openScreen({ screenId: RELEASES_SCREEN });
        }}
      />
    );
  }

  function behaviorFor(mode: ButtonMode) {
    return { kind: "popover" as const, Content: mode === "release" ? ReleaseContent : QueueContent };
  }

  function titleFor(mode: ButtonMode, label: string): string {
    return mode === "release" ? `Release: ${label}` : `Fila / CI: ${label}`;
  }

  function sync(clearBackoff = false): void {
    if (clearBackoff) retryAfter.clear();
    const { view } = releaseState();
    const dir = directorySnapshot();
    const nowMs = Date.now();
    const now = new Date(nowMs);

    const workspaceIds = new Set<string>();
    for (const workspace of dir.workspaces.values()) {
      if (!workspace.archived) workspaceIds.add(workspace.id);
    }
    for (const agent of view?.agents ?? []) {
      if (!agent.workspaceId) continue;
      const known = dir.workspaces.get(agent.workspaceId);
      if (known?.archived) continue;
      workspaceIds.add(agent.workspaceId);
    }

    const wanted = new Map<string, { mode: ButtonMode; label: string }>();
    for (const workspaceId of workspaceIds) {
      const target = targetOfWorkspace(view, workspaceId, now);
      if (target) wanted.set(workspaceId, { mode: target.mode, label: target.label });
    }

    for (const [workspaceId, entry] of buttons) {
      if (!workspaceIds.has(workspaceId)) {
        entry.registration.remove();
        buttons.delete(workspaceId);
      } else if (!wanted.has(workspaceId) && entry.visible) {
        entry.registration.update({ visible: false });
        entry.visible = false;
      }
    }

    for (const [workspaceId, want] of wanted) {
      const entry = buttons.get(workspaceId);
      if (entry) {
        if (entry.mode !== want.mode) {
          entry.registration.update({
            label: want.label,
            title: titleFor(want.mode, want.label),
            visible: true,
            behavior: behaviorFor(want.mode),
          });
          entry.mode = want.mode;
          entry.label = want.label;
          entry.visible = true;
        } else if (entry.label !== want.label || !entry.visible) {
          entry.registration.update({
            label: want.label,
            title: titleFor(want.mode, want.label),
            visible: true,
          });
          entry.label = want.label;
          entry.visible = true;
        }
        continue;
      }
      if ((retryAfter.get(workspaceId) ?? 0) > nowMs) continue;
      try {
        const registration = client.addHeaderButton({
          id: BUTTON_ID,
          workspaceId,
          button: {
            title: titleFor(want.mode, want.label),
            icon: HeaderIcon,
            label: want.label,
            visible: true,
            behavior: behaviorFor(want.mode),
          },
        });
        buttons.set(workspaceId, {
          registration,
          mode: want.mode,
          label: want.label,
          visible: true,
        });
        retryAfter.delete(workspaceId);
      } catch (error) {
        retryAfter.set(workspaceId, nowMs + RETRY_COOLDOWN_MS);
        console.warn(`agent-recall: header button para ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  sync();
  const offReleases = subscribeReleases(() => sync(false));
  const offDirectory = subscribeDirectory(() => sync(true));
  return () => {
    offReleases();
    offDirectory();
    for (const entry of buttons.values()) entry.registration.remove();
    buttons.clear();
    retryAfter.clear();
  };
}
