// Sidebar footer row (mock p3): the release in flight, or the last verdict for two hours after,
// with the five-segment step bar. A press opens the step popover; with nothing to show the row
// reads "Releases" and opens the screen.
import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { watchTone } from "../shared/release-copy.ts";
import { displayName, footerRelease, isActive, type Release } from "../shared/release-status.ts";
import type { ReleaseView } from "../shared/rpc.ts";
import { useNow, useReleaseState } from "./data.ts";
import { SegBar } from "./kit.tsx";
import { ReleasePopover } from "./release-popover.tsx";

export const RELEASES_SCREEN = "releases";

function pickFooter(view: ReleaseView): Release | null {
  return view.snapshot ? footerRelease(view.snapshot, new Date()) : null;
}

function FooterPopover({ theme, close, openScreen }: PluginPopoverProps) {
  return (
    <ReleasePopover
      theme={theme}
      pick={pickFooter}
      openReleases={() => {
        close();
        openScreen({ screenId: RELEASES_SCREEN });
      }}
    />
  );
}

export function ReleaseFooterItem({ theme, currentScreen, openScreen, openPopover }: PluginSidebarItemProps) {
  const { view } = useReleaseState();
  const now = useNow(30_000);
  const release = view?.snapshot ? footerRelease(view.snapshot, now) : null;
  const onScreen = currentScreen?.screenId === RELEASES_SCREEN;
  if (!release) {
    return <SidebarRow icon="Rocket" label="Releases" active={onScreen} onPress={() => openScreen({ screenId: RELEASES_SCREEN })} />;
  }
  return (
    <SidebarRow
      label={displayName(release)}
      active={onScreen}
      onPress={() => openPopover(FooterPopover)}
      trailing={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <SegBar theme={theme} steps={release.steps} watchTone={isActive(release) ? null : watchTone(release)} />
          <Icon name="Ellipsis" size={14} color={theme.colors.foregroundMuted} />
        </View>
      }
    />
  );
}
