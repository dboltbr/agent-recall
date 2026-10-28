import type { PluginClientContext } from "@getpaseo/plugin/client";
import { startReleaseStore } from "./client/data.ts";
import { RELEASES_SCREEN, ReleaseFooterItem } from "./client/footer.tsx";
import { startReleasePills } from "./client/pills.tsx";
import { ReleasesScreen } from "./client/screen.tsx";
import { ReleaseTimelineCard } from "./client/timeline-card.tsx";
import { RELEASE_CARD_KIND, RELEASE_CARD_VERSION, ReleaseCardSchema } from "./shared/release-cards.ts";

export default function contribute(client: PluginClientContext) {
  const stopStore = startReleaseStore((contract, input) => client.rpc(contract, input));
  const cleanups = [
    client.addScreen({ id: RELEASES_SCREEN, title: "Releases", Component: ReleasesScreen }),
    client.addSidebarFooterItem({ id: "release-status", title: "Release", Component: ReleaseFooterItem }),
    client.addCommandCenterItem({
      id: "open-releases",
      title: "Abrir Releases",
      icon: "Rocket",
      keywords: ["release", "deploy", "vigia", "github actions"],
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
  ];
  return async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    stopStore();
  };
}
