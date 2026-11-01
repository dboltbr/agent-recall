// Sidebar footer row (mock p3): the release in focus (with `+N` for the others in flight), or the
// last verdict for two hours after, with the five-segment step bar. A press opens the step
// popover; with nothing to show the row reads "Releases" and opens the screen.
import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { watchTone } from "../shared/release-copy.ts";
import { footerRelease, isActive, otherActive, releaseLabel, watchPhaseLabel, type Release } from "../shared/release-status.ts";
import type { ReleaseView } from "../shared/rpc.ts";
import { useNow, useReleaseState } from "./data.ts";
import { SegBar } from "./kit.tsx";
import { hopToAgent, RELEASES_SCREEN } from "./navigate.ts";
import { ReleasePopover } from "./release-popover.tsx";

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
      openAgent={(agentId) => {
        close();
        hopToAgent(openScreen, agentId);
      }}
    />
  );
}

export function ReleaseFooterItem({ theme, currentScreen, openScreen, openPopover }: PluginSidebarItemProps) {
  const { view } = useReleaseState();
  const now = useNow(30_000);
  const release = view?.snapshot ? footerRelease(view.snapshot, now) : null;
  // `+2`: other releases in flight, listed in the popover.
  const others = release && isActive(release) && view?.snapshot ? otherActive(view.snapshot, release).length : 0;
  const onScreen = currentScreen?.screenId === RELEASES_SCREEN;
  if (!release) {
    return <SidebarRow icon="Rocket" label="Releases" active={onScreen} onPress={() => openScreen({ screenId: RELEASES_SCREEN })} />;
  }
  // `#356 01/11 14:02 · faltam 7m`: the open watch's phase, short.
  const phase = watchPhaseLabel(release, now, true);
  const label = phase ? `${releaseLabel(release)} · ${phase}` : releaseLabel(release);
  return (
    <SidebarRow
      label={others ? `${label} +${others}` : label}
      active={onScreen}
      onPress={() => openPopover(FooterPopover)}
      trailing={<SegBar theme={theme} steps={release.steps} watchTone={isActive(release) ? null : watchTone(release)} />}
    />
  );
}
