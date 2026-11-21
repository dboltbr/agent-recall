// Sidebar footer row: the release in focus (with `+N` for the others in flight), or the last
// verdict for two hours after, with the step bar. When no release is in focus and the Mergify
// queue is active, shows the queue summary; otherwise "Releases".
import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { queueFooterLabel, queuedPrs } from "../shared/queue-status.ts";
import { popoverSteps, watchTone } from "../shared/release-copy.ts";
import { footerLabel, footerRelease, isActive, otherActive, type Release } from "../shared/release-status.ts";
import type { ReleaseView } from "../shared/rpc.ts";
import { useNow, useReleaseState } from "./data.ts";
import { SegBar } from "./kit.tsx";
import { hopToAgent, RELEASES_SCREEN } from "./navigate.ts";
import { QueuePopover } from "./queue-popover.tsx";
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

function QueueFooterPopover({ theme, close, openScreen }: PluginPopoverProps) {
  return (
    <QueuePopover
      theme={theme}
      pick={(view) => queuedPrs(view.snapshot?.queue)[0] ?? null}
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
  // `+2`: other releases in flight, listed in the popover.
  const others = release && isActive(release) && view?.snapshot ? otherActive(view.snapshot, release).length : 0;
  const onScreen = currentScreen?.screenId === RELEASES_SCREEN;
  if (!release) {
    const queueLabel = queueFooterLabel(view?.snapshot?.queue);
    if (queueLabel) {
      return <SidebarRow icon="GitMerge" label={queueLabel} active={onScreen} onPress={() => openPopover(QueueFooterPopover)} />;
    }
    return <SidebarRow icon="Rocket" label="Releases" active={onScreen} onPress={() => openScreen({ screenId: RELEASES_SCREEN })} />;
  }
  // `PR #275 · deploy`, `PR #275 · img 4/9`, `PR #275 · faltam 7m (+1)` — compact, no date noise.
  const label = footerLabel(release, now, others);
  return (
    <SidebarRow
      icon="Rocket"
      label={label}
      active={onScreen}
      onPress={() => openPopover(FooterPopover)}
      trailing={<SegBar theme={theme} steps={popoverSteps(release)} watchTone={isActive(release) ? null : watchTone(release)} />}
    />
  );
}
