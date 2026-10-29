// The popover of the composer pill and of the sidebar footer row (mocks p1b and p3): header,
// commit, pusher, the step list, the runner queue while a run is in flight, the verdict banner
// once it ended, and the links. Both read the client store; neither calls the daemon itself.
// Paseo's popover owns scrolling and padding: the content sizes itself, no inner ScrollView.
import type { PluginTheme } from "@getpaseo/plugin";
import { Loading } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { commitUrl, verdictBanner, waitingLabel, watchUrl } from "../shared/release-copy.ts";
import { isActive, queueSummary, type Release } from "../shared/release-status.ts";
import type { ReleaseView } from "../shared/rpc.ts";
import { agentTitle, retryReleases, useNow, useReleaseState } from "./data.ts";
import { Banner, LinkText, PressText } from "./kit.tsx";
import { localAgent, watchLinks, type OpenAgent } from "./navigate.ts";
import { CommitLine, PusherLine, ReleaseHeader, RunnerQueue, SectionLabel, Signals, StepList } from "./release-parts.tsx";

const BANNER_ICONS = { ok: "ShieldCheck", bad: "CircleX", warn: "Undo2", run: "Info", muted: "Info" } as const;

/** Title of the pusher when it is an agent of this daemon. */
export function pusherTitle(view: ReleaseView, release: Release): string | null {
  const agentId = release.pusher ? localAgent(view, release.pusher) : null;
  return agentId ? agentTitle(view, agentId) : null;
}

/** The finished release's banner with its link (ver log / ver sinais). */
export function VerdictBanner({ theme, release }: { theme: PluginTheme; release: Release }) {
  const banner = verdictBanner(release);
  if (!banner) return null;
  const href = banner.link === "log" ? (release.failedJob?.url ?? release.url) : banner.link === "signals" ? (watchUrl(release) ?? release.url) : null;
  return (
    <Banner
      theme={theme}
      tone={banner.tone}
      icon={BANNER_ICONS[banner.tone]}
      text={banner.text}
      link={href ? { label: banner.link === "log" ? "ver log" : "ver sinais", href } : null}
    />
  );
}

export function ReleaseBody({
  theme,
  view,
  release,
  openReleases,
  openAgent,
}: {
  theme: PluginTheme;
  view: ReleaseView;
  release: Release;
  openReleases: (() => void) | null;
  openAgent: OpenAgent | null;
}) {
  const now = useNow();
  const snapshot = view.snapshot!;
  const active = isActive(release);
  const waiting = waitingLabel(snapshot);
  const watch = openAgent ? { links: watchLinks(view, release), open: openAgent } : null;
  return (
    <View>
      <ReleaseHeader theme={theme} release={release} now={now} />
      <CommitLine theme={theme} release={release} />
      <PusherLine theme={theme} release={release} title={pusherTitle(view, release)} now={now} />
      <SectionLabel theme={theme}>Etapas</SectionLabel>
      <StepList theme={theme} release={release} queue={active ? queueSummary(snapshot) : null} now={now} watch={watch} />
      {active && snapshot.runners.length ? (
        <>
          <SectionLabel theme={theme} trailing={waiting ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>{waiting}</Text> : null}>
            Fila de runners
          </SectionLabel>
          <RunnerQueue theme={theme} snapshot={snapshot} />
        </>
      ) : null}
      <VerdictBanner theme={theme} release={release} />
      {release.verdict === "reverted" || release.verdict === "red" ? <Signals theme={theme} release={release} /> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
        <LinkText theme={theme} href={release.url} icon="ExternalLink" label="ver run" />
        <LinkText theme={theme} href={commitUrl(snapshot.repository, release.headSha)} icon="GitCommitHorizontal" label="ver commit" muted />
        <View style={{ flex: 1 }} />
        {openReleases ? <PressText theme={theme} label="abrir Releases" onPress={openReleases} muted /> : null}
      </View>
    </View>
  );
}

/** Popover frame: store states (B11) around the body of the chosen release. */
export function ReleasePopover({
  theme,
  pick,
  openReleases,
  openAgent,
}: {
  theme: PluginTheme;
  pick: (view: ReleaseView) => Release | null;
  openReleases: (() => void) | null;
  openAgent: OpenAgent | null;
}) {
  const { view, error, loading } = useReleaseState();
  const release = view?.snapshot ? pick(view) : null;
  return (
    <View style={{ padding: 12, width: 410, maxWidth: "100%" }}>
      {loading && !view ? (
        <Loading />
      ) : !view || !view.snapshot ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: error ? theme.colors.statusDanger : theme.colors.foregroundMuted, fontSize: 12.5 }}>
            {error ?? "Aguardando a primeira leitura do GitHub…"}
          </Text>
          {error ? <PressText theme={theme} label="Tentar de novo" icon="RotateCw" onPress={retryReleases} /> : null}
        </View>
      ) : !release ? (
        <View style={{ gap: 10 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>Nenhum release em andamento nem veredito recente.</Text>
          {openReleases ? <PressText theme={theme} label="abrir Releases" onPress={openReleases} /> : null}
        </View>
      ) : (
        <>
          <ReleaseBody theme={theme} view={view} release={release} openReleases={openReleases} openAgent={openAgent} />
          {error ? <Text style={{ color: theme.colors.statusWarning, fontSize: 11.5, marginTop: 8 }}>{error}</Text> : null}
        </>
      )}
    </View>
  );
}
