// Composer pills: one per local Paseo agent with either a release (active or in snapshot history)
// or an open PR / Mergify merge queue entry on its workspace branch. Driven by the shared release
// store and Paseo's live agent/workspace directory; label updates never replace `behavior` so an
// open popover stays open across live ticks.
import type {
  PluginButtonContentProps,
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { prForBranch, prForSession, prPillLabel, prStageBadge, type PullRequestStatus } from "../shared/queue-status.ts";
import { releaseBadge } from "../shared/release-copy.ts";
import { isActive, pillLabel, prBeatsFinishedRelease, releaseForSession, type Release } from "../shared/release-status.ts";
import type { ReleaseView } from "../shared/rpc.ts";
import { releaseState, subscribeReleases, useReleaseState } from "./data.ts";
import { directorySnapshot, matchesRepository, subscribeDirectory } from "./directory.ts";
import { toneColor } from "./kit.tsx";
import { hopToAgent, RELEASES_SCREEN, sessionsOfAgent } from "./navigate.ts";
import { QueuePopover } from "./queue-popover.tsx";
import { ReleasePopover } from "./release-popover.tsx";

const PILL_ID = "release";
/** Transient registration failures back off briefly instead of blacklisting an agent forever. */
const RETRY_COOLDOWN_MS = 15_000;

type PillMode = "release" | "queue";

export function releaseOfAgent(view: ReleaseView | null, agentId: string): Release | null {
  const snapshot = view?.snapshot;
  if (!view || !snapshot) return null;
  for (const session of sessionsOfAgent(view, agentId)) {
    const release = releaseForSession(snapshot, session);
    if (release) return release;
  }
  return null;
}

function prOfAgent(view: ReleaseView | null, agentId: string, workspaceId: string): PullRequestStatus | null {
  const snapshot = view?.snapshot;
  if (!view || !snapshot?.queue) return null;
  for (const session of sessionsOfAgent(view, agentId)) {
    const bySession = prForSession(snapshot.queue, session);
    if (bySession) return bySession;
  }
  const workspace = directorySnapshot().workspaces.get(workspaceId);
  if (!workspace?.branch || !matchesRepository(workspace.remoteUrl, snapshot.repository)) return null;
  return prForBranch(snapshot.queue, workspace.branch);
}

/** Active release → active/newer PR in merge queue → finished release in snapshot. */
function targetOfAgent(
  view: ReleaseView | null,
  agentId: string,
  workspaceId: string,
): { mode: "release"; release: Release; label: string } | { mode: "queue"; pr: PullRequestStatus; label: string } | null {
  const release = releaseOfAgent(view, agentId);
  if (release && isActive(release)) {
    return { mode: "release", release, label: pillLabel(release) };
  }
  const pr = prOfAgent(view, agentId, workspaceId);
  if (pr && (!release || prBeatsFinishedRelease(pr, release))) {
    return { mode: "queue", pr, label: prPillLabel(pr) };
  }
  if (release) {
    return { mode: "release", release, label: pillLabel(release) };
  }
  return null;
}

/** Rocket (release) or GitMerge/GitPullRequest (PR/queue) with a status dot in the current tone. */
function PillIcon(props: PluginButtonIconProps) {
  const { size, color, theme } = props;
  const { view } = useReleaseState();
  const target = props.context === "agent" ? targetOfAgent(view, props.agentId, props.workspaceId) : null;
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

interface Pill {
  readonly workspaceId: string;
  readonly registration: PluginButtonRegistration;
  mode: PillMode;
  label: string;
  visible: boolean;
}

/** Keeps composer pills synchronized with both the release/queue store and the Paseo directory. */
export function startReleasePills(client: PluginClientContext): () => void {
  const pills = new Map<string, Pill>();
  const retryAfter = new Map<string, number>();

  function ReleaseContent(props: PluginButtonContentProps) {
    const { theme, close } = props;
    const agentId = props.context === "agent" ? props.agentId : null;
    return (
      <ReleasePopover
        theme={theme}
        pick={(view) => (agentId ? releaseOfAgent(view, agentId) : null)}
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

  function QueueContent(props: PluginButtonContentProps) {
    const { theme, close } = props;
    const workspaceId = props.workspaceId;
    const agentId = props.context === "agent" ? props.agentId : null;
    return (
      <QueuePopover
        theme={theme}
        pick={(view) => (agentId ? prOfAgent(view, agentId, workspaceId) : null)}
        openReleases={() => {
          close();
          client.openScreen({ screenId: RELEASES_SCREEN });
        }}
      />
    );
  }

  function behaviorFor(mode: PillMode) {
    return { kind: "popover" as const, Content: mode === "release" ? ReleaseContent : QueueContent };
  }

  function titleFor(mode: PillMode, label: string): string {
    return mode === "release" ? `Release: ${label}` : `Fila / CI: ${label}`;
  }

  function sync(clearBackoff = false): void {
    if (clearBackoff) retryAfter.clear();
    const { view } = releaseState();
    const dir = directorySnapshot();
    const now = Date.now();

    // Candidate agents: every live non-archived agent in the directory, plus daemon-resolved
    // release agents when the directory hasn't delivered its initial snapshot yet.
    const candidates = new Map<string, string>();
    for (const agent of dir.agents.values()) {
      if (!agent.archived) candidates.set(agent.id, agent.workspaceId);
    }
    for (const agent of view?.agents ?? []) {
      if (!agent.workspaceId) continue;
      const known = dir.agents.get(agent.id);
      if (known?.archived) continue;
      if (!candidates.has(agent.id)) candidates.set(agent.id, agent.workspaceId);
    }

    const wanted = new Map<string, { workspaceId: string; mode: PillMode; label: string }>();
    for (const [agentId, workspaceId] of candidates) {
      const target = targetOfAgent(view, agentId, workspaceId);
      if (target) wanted.set(agentId, { workspaceId, mode: target.mode, label: target.label });
    }

    for (const [agentId, pill] of pills) {
      const want = wanted.get(agentId);
      if (!candidates.has(agentId) || (want && want.workspaceId !== pill.workspaceId)) {
        pill.registration.remove();
        pills.delete(agentId);
      } else if (!want && pill.visible) {
        pill.registration.update({ visible: false });
        pill.visible = false;
      }
    }

    for (const [agentId, want] of wanted) {
      const pill = pills.get(agentId);
      if (pill) {
        if (pill.mode !== want.mode) {
          pill.registration.update({
            label: want.label,
            title: titleFor(want.mode, want.label),
            visible: true,
            behavior: behaviorFor(want.mode),
          });
          pill.mode = want.mode;
          pill.label = want.label;
          pill.visible = true;
        } else if (pill.label !== want.label || !pill.visible) {
          pill.registration.update({
            label: want.label,
            title: titleFor(want.mode, want.label),
            visible: true,
          });
          pill.label = want.label;
          pill.visible = true;
        }
        continue;
      }
      const key = `${agentId}@${want.workspaceId}`;
      if ((retryAfter.get(key) ?? 0) > now) continue;
      try {
        const registration = client.addComposerPill({
          id: PILL_ID,
          workspaceId: want.workspaceId,
          agentId,
          button: {
            title: titleFor(want.mode, want.label),
            icon: PillIcon,
            label: want.label,
            visible: true,
            behavior: behaviorFor(want.mode),
          },
        });
        pills.set(agentId, {
          workspaceId: want.workspaceId,
          registration,
          mode: want.mode,
          label: want.label,
          visible: true,
        });
        retryAfter.delete(key);
      } catch (error) {
        retryAfter.set(key, now + RETRY_COOLDOWN_MS);
        console.warn(`agent-recall: pill para ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  sync();
  const offReleases = subscribeReleases(() => sync(false));
  const offDirectory = subscribeDirectory(() => sync(true));
  return () => {
    offReleases();
    offDirectory();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
    retryAfter.clear();
  };
}
