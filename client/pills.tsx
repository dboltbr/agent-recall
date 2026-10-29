// Composer pills (mock p1b): one per local Paseo agent with a commit in the release in flight or
// the most recent one, labelled `#172 27/10 11:24 · imagens 3/9`, opening the step popover. Driven by
// the client store; a label change only updates label/title (changing `behavior` would close an
// open popover).
import type { PluginButtonContentProps, PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { releaseBadge } from "../shared/release-copy.ts";
import { pillLabel, releaseForSession, type Release } from "../shared/release-status.ts";
import type { ReleaseView } from "../shared/rpc.ts";
import { releaseState, subscribeReleases, useReleaseState } from "./data.ts";
import { toneColor } from "./kit.tsx";
import { hopToAgent, RELEASES_SCREEN, sessionsOfAgent } from "./navigate.ts";
import { ReleasePopover } from "./release-popover.tsx";

const PILL_ID = "release";

function releaseOfAgent(view: ReleaseView | null, agentId: string): Release | null {
  const snapshot = view?.snapshot;
  if (!snapshot) return null;
  for (const session of sessionsOfAgent(view, agentId)) {
    const release = releaseForSession(snapshot, session);
    if (release) return release;
  }
  return null;
}

/** Rocket with a status dot in the release's tone (reads the store, so it follows the run). */
function PillIcon(props: PluginButtonIconProps) {
  const { size, color, theme } = props;
  const { view } = useReleaseState();
  const release = props.context === "agent" ? releaseOfAgent(view, props.agentId) : null;
  const tone = release ? releaseBadge(release).tone : "muted";
  return (
    <View style={{ width: size, height: size }}>
      <Icon name="Rocket" size={size} color={color} />
      {release ? (
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
  label: string;
  visible: boolean;
}

/** Keeps the pills in step with the store; returns the cleanup. */
export function startReleasePills(client: PluginClientContext): () => void {
  const pills = new Map<string, Pill>();
  const failed = new Set<string>();

  function Content(props: PluginButtonContentProps) {
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

  function sync(): void {
    const { view } = releaseState();
    const wanted = new Map<string, { workspaceId: string; label: string }>();
    for (const agent of view?.agents ?? []) {
      if (!agent.workspaceId) continue;
      const release = releaseOfAgent(view, agent.id);
      if (release) wanted.set(agent.id, { workspaceId: agent.workspaceId, label: pillLabel(release) });
    }
    for (const [agentId, pill] of pills) {
      const want = wanted.get(agentId);
      if (want && want.workspaceId !== pill.workspaceId) {
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
        if (pill.label !== want.label || !pill.visible) {
          pill.registration.update({ label: want.label, title: `Release: ${want.label}`, visible: true });
          pill.label = want.label;
          pill.visible = true;
        }
        continue;
      }
      const key = `${agentId}@${want.workspaceId}`;
      if (failed.has(key)) continue;
      try {
        const registration = client.addComposerPill({
          id: PILL_ID,
          workspaceId: want.workspaceId,
          agentId,
          button: {
            title: `Release: ${want.label}`,
            icon: PillIcon,
            label: want.label,
            visible: true,
            behavior: { kind: "popover", Content },
          },
        });
        pills.set(agentId, { workspaceId: want.workspaceId, registration, label: want.label, visible: true });
      } catch (error) {
        // An agent the app does not know (other host, archived): skip it until its workspace changes.
        failed.add(key);
        console.warn(`agent-recall: pill do release para ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  sync();
  const unsubscribe = subscribeReleases(sync);
  return () => {
    unsubscribe();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
