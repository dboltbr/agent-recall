// Timeline card of a release (mocks p4a/p4b), rendered from the item the daemon appends to the
// agent that pushed and re-appends with the same id as the run moves. Reads only `item.data`.
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { View } from "react-native";
import type { ReleaseCard } from "../shared/release-cards.ts";
import { commitUrl, releaseBadge } from "../shared/release-copy.ts";
import { isActive, RELEASE_REPOSITORY } from "../shared/release-status.ts";
import { useNow } from "./data.ts";
import { Card, LinkText, PressText } from "./kit.tsx";
import { CommitLine, ImageChips, Pipe, PusherLine, QueueLine, ReleaseHeader, Signals, StepList } from "./release-parts.tsx";
import { VerdictBanner } from "./release-popover.tsx";

export function ReleaseTimelineCard({ item, theme, layout }: PluginTimelineItemProps<ReleaseCard>) {
  const { release, pusherTitle, queue } = item.data;
  const now = useNow();
  const [open, setOpen] = useState(false);
  const active = isActive(release);
  const badge = releaseBadge(release);
  const images = release.steps.find((step) => step.id === "images");
  return (
    <Card theme={theme} tone={active ? null : badge.tone} compact={layout.compact} style={{ marginVertical: 10 }}>
      <ReleaseHeader theme={theme} release={release} now={now} icon={!active} />
      <CommitLine theme={theme} release={release} />
      {active || release.verdict === "reverted" ? <PusherLine theme={theme} release={release} title={pusherTitle} now={now} /> : null}
      <View style={{ marginTop: 14, marginBottom: active ? 4 : 2 }}>
        <Pipe theme={theme} release={release} now={now} compact={layout.compact} />
      </View>
      {active && images?.state === "running" ? <ImageChips theme={theme} release={release} /> : null}
      {active && queue ? <QueueLine theme={theme} text={queue} /> : null}
      <VerdictBanner theme={theme} release={release} />
      {release.verdict === "reverted" || release.verdict === "red" ? <Signals theme={theme} release={release} /> : null}
      {open ? (
        <View style={{ marginTop: 10 }}>
          <StepList theme={theme} release={release} queue={active ? queue : null} now={now} />
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
        <LinkText theme={theme} href={release.url} icon="ExternalLink" label="ver run" />
        <LinkText theme={theme} href={commitUrl(RELEASE_REPOSITORY, release.headSha)} icon="GitCommitHorizontal" label="ver commit" muted />
        <View style={{ flex: 1 }} />
        <PressText theme={theme} label={open ? "ocultar" : "detalhes"} onPress={() => setOpen((value) => !value)} muted />
      </View>
    </Card>
  );
}
