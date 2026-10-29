// Timeline card of a release (mocks p4a/p4b), rendered from the item the daemon appends to the
// agent that pushed and re-appends with the same id as the run moves (handoffs included). Draws
// `item.data`; the client store only says which vigia sessions exist to link. A live run shows the
// full card; a finished one collapses to one line, and a streak of superseded runs to a single
// group line (the older cards of the streak render nothing, see `cardView`).
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { ReleaseCard } from "../shared/release-cards.ts";
import { commitUrl, releaseBadge } from "../shared/release-copy.ts";
import { isActive, RELEASE_REPOSITORY, type Release } from "../shared/release-status.ts";
import { cardView, releaseOpen } from "./card-view.ts";
import { useNow, useReleaseState } from "./data.ts";
import { Card, LinkText, PressText } from "./kit.tsx";
import { clientHop, watchLinks } from "./navigate.ts";
import {
  CommitLine,
  ImageChips,
  Pipe,
  PusherLine,
  QueueLine,
  ReleaseHeader,
  ReleaseLine,
  Signals,
  StepList,
  SupersededLine,
  type WatchTargets,
} from "./release-parts.tsx";
import { VerdictBanner } from "./release-popover.tsx";

export function ReleaseTimelineCard({ item, theme, layout, agentId }: PluginTimelineItemProps<ReleaseCard>) {
  const view = cardView(item.data);
  if (view.kind === "hidden") return null;
  if (view.kind === "group") {
    return <SupersededGroup theme={theme} compact={layout.compact} agentId={agentId} card={item.data} releases={view.releases} />;
  }
  return (
    <ReleaseEntry
      theme={theme}
      compact={layout.compact}
      agentId={agentId}
      release={item.data.release}
      pusherTitle={item.data.pusherTitle}
      queue={item.data.queue}
      style={{ marginVertical: 10 }}
    />
  );
}

function useWatch(release: Release, agentId: string): WatchTargets | null {
  const { view } = useReleaseState();
  const hop = clientHop();
  // The card lives in the agent that pushed, so that agent exists even when the view is cold.
  return hop ? { links: watchLinks(view, release, [agentId]), open: hop } : null;
}

interface EntryProps {
  readonly theme: PluginTheme;
  readonly compact: boolean;
  readonly agentId: string;
  readonly release: Release;
  readonly pusherTitle: string | null;
  readonly queue: string | null;
  readonly style?: StyleProp<ViewStyle>;
}

/** One release: the full card while live, a line once finished until pressed. */
function ReleaseEntry(props: EntryProps) {
  const { theme, compact, release, style } = props;
  const now = useNow();
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = releaseOpen(release, choice);
  const tone = isActive(release) ? null : releaseBadge(release).tone;
  if (!open) {
    return (
      <Card theme={theme} tone={tone} compact={compact} style={[{ paddingVertical: 9 }, style]}>
        <ReleaseLine theme={theme} release={release} now={now} open={false} onPress={() => setChoice(true)} />
      </Card>
    );
  }
  return (
    <Card theme={theme} tone={tone} compact={compact} style={style}>
      <ReleaseDetails {...props} now={now} onCollapse={isActive(release) ? null : () => setChoice(false)} />
    </Card>
  );
}

/** The full card body (header, pipe, banner, steps on demand, links). */
function ReleaseDetails({
  theme,
  compact,
  agentId,
  release,
  pusherTitle,
  queue,
  now,
  onCollapse,
}: EntryProps & { now: Date; onCollapse: (() => void) | null }) {
  const watch = useWatch(release, agentId);
  const [steps, setSteps] = useState(false);
  const active = isActive(release);
  const images = release.steps.find((step) => step.id === "images");
  return (
    <>
      <ReleaseHeader theme={theme} release={release} now={now} icon={!active} />
      <CommitLine theme={theme} release={release} />
      {active || release.verdict === "reverted" ? <PusherLine theme={theme} release={release} title={pusherTitle} now={now} /> : null}
      <View style={{ marginTop: 14, marginBottom: active ? 4 : 2 }}>
        <Pipe theme={theme} release={release} now={now} compact={compact} watch={watch} />
      </View>
      {active && images?.state === "running" ? <ImageChips theme={theme} release={release} /> : null}
      {active && queue ? <QueueLine theme={theme} text={queue} /> : null}
      <VerdictBanner theme={theme} release={release} />
      {release.verdict === "reverted" || release.verdict === "red" ? <Signals theme={theme} release={release} /> : null}
      {steps ? (
        <View style={{ marginTop: 10 }}>
          <StepList theme={theme} release={release} queue={active ? queue : null} now={now} watch={watch} />
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
        <LinkText theme={theme} href={release.url} icon="ExternalLink" label="ver run" />
        <LinkText theme={theme} href={commitUrl(RELEASE_REPOSITORY, release.headSha)} icon="GitCommitHorizontal" label="ver commit" muted />
        <View style={{ flex: 1 }} />
        <PressText theme={theme} label={steps ? "ocultar etapas" : "etapas"} onPress={() => setSteps((value) => !value)} muted />
        {onCollapse ? <PressText theme={theme} label="recolher" icon="ChevronUp" onPress={onCollapse} muted /> : null}
      </View>
    </>
  );
}

/** A streak of superseded releases as one line; open, one collapsed line per release. */
function SupersededGroup({
  theme,
  compact,
  agentId,
  card,
  releases,
}: {
  theme: PluginTheme;
  compact: boolean;
  agentId: string;
  card: ReleaseCard;
  releases: readonly Release[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card theme={theme} compact={compact} style={{ marginVertical: 10, paddingVertical: 9 }}>
      <SupersededLine theme={theme} releases={releases} open={open} onPress={() => setOpen((value) => !value)} />
      {open ? (
        <View style={{ gap: 6, marginTop: 9 }}>
          {releases.map((release) => (
            <ReleaseEntry
              key={release.number}
              theme={theme}
              compact={compact}
              agentId={agentId}
              release={release}
              pusherTitle={card.pusherTitle}
              queue={null}
            />
          ))}
        </View>
      ) : null}
    </Card>
  );
}
