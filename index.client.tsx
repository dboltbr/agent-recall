import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startReleaseStore } from "./client/data.ts";
import { startDirectory } from "./client/directory.ts";
import { ReleaseFooterItem } from "./client/footer.tsx";
import { startWorkspaceHeaderButtons } from "./client/header-buttons.tsx";
import { RELEASES_SCREEN, setClientOpenScreen } from "./client/navigate.ts";
import { startReleasePills } from "./client/pills.tsx";
import { ReleasesScreen } from "./client/screen.tsx";
import { ReleaseTimelineCard } from "./client/timeline-card.tsx";
import { WorkspacePipelineBadge } from "./client/workspace-badge.tsx";
import { RELEASE_CARD_KIND, RELEASE_CARD_VERSION, ReleaseCardSchema } from "./shared/release-cards.ts";

export default function contribute(client: PluginClientContext) {
  const stopStore = startReleaseStore((contract, input) => client.rpc(contract, input));
  const stopDirectory = startDirectory(client);
  const cleanups: Array<() => void | Promise<void>> = [
    setClientOpenScreen((input) => client.openScreen(input)),
    client.addScreen({ id: RELEASES_SCREEN, title: "Releases", Component: ReleasesScreen }),
    client.addSidebarFooterItem({ id: "release-status", title: "Release", Component: ReleaseFooterItem }),
    client.addCommandCenterItem({
      id: "open-releases",
      title: "Abrir Releases",
      icon: "Rocket",
      keywords: ["release", "deploy", "vigia", "github actions", "queue", "fila", "mergify"],
      context: "global",
      onSelect: (context) => context.openScreen({ screenId: RELEASES_SCREEN }),
    }),
    client.addTimelineRenderer({
      kind: RELEASE_CARD_KIND,
      version: RELEASE_CARD_VERSION,
      schema: ReleaseCardSchema,
      Component: ReleaseTimelineCard,
    }),
    startReleasePills(client),
    startWorkspaceHeaderButtons(client),
  ];
  // Paseo 0.16+ adds badges directly to each workspace's sidebar meta line; older apps omit it.
  if (typeof client.addWorkspaceRowBadgeItem === "function") {
    cleanups.push(
      client.addWorkspaceRowBadgeItem({
        id: "pipeline",
        title: "Queue & Release",
        icon: "Rocket",
        Component: WorkspacePipelineBadge,
      }),
    );
  }
  return async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    stopDirectory();
    stopStore();
  };
}
