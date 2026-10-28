// The Releases screen (mock p5): the run in flight with its image lanes, the runner queue, the
// vigia's reverts and the verdict table. Opened from the footer row, the popovers and the
// Command Center. Reads the client store; "Atualizar" asks the daemon to re-read GitHub.
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { openExternalUrl } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  commitUrl,
  freshness,
  imageLanes,
  queueHint,
  RELEASE_ACTIONS_URL,
  releaseBadge,
  revertRows,
  shortSha,
  verdictRows,
  verdictSignals,
  waitingLabel,
  type Lane,
} from "../shared/release-copy.ts";
import {
  activeReleases,
  formatShortDuration,
  isActive,
  lastFinished,
  queueSummary,
  RELEASE_REPOSITORY,
  releaseDurationMs,
  releaseLabel,
  trippedSignals,
  type Release,
  type ReleaseSnapshot,
} from "../shared/release-status.ts";
import type { ReleaseView } from "../shared/rpc.ts";
import { refreshReleases, retryReleases, useNow, useReleaseState } from "./data.ts";
import { Badge, LinkText, MONO, PressText, Sha, Tint, toneColor } from "./kit.tsx";
import { CommitLine, Pipe, PusherLine, QueueLine, ReleaseHeader, RunnerQueue, SectionLabel, Signals, Spin } from "./release-parts.tsx";
import { pusherTitle, VerdictBanner } from "./release-popover.tsx";

const BADGE_ICONS: Record<string, string | undefined> = { ok: "Check", bad: "X", warn: "Undo2", muted: "CircleHelp" };

function HeaderButton({
  theme,
  icon,
  label,
  onPress,
  busy,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress(): void;
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy: !!busy, disabled: !!busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 28,
        paddingHorizontal: 10,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
        opacity: busy ? 0.7 : 1,
      })}
    >
      {busy ? <Spin color={theme.colors.foregroundMuted} size={13} /> : <Icon name={icon} size={13} color={theme.colors.foregroundMuted} />}
      <Text style={{ color: theme.colors.foreground, fontSize: 12.5 }}>{label}</Text>
    </Pressable>
  );
}

function Panel({
  theme,
  icon,
  title,
  trailing,
  children,
}: {
  theme: PluginTheme;
  icon?: string;
  title?: string;
  trailing?: string | null;
  children: ReactNode;
}) {
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, backgroundColor: theme.colors.surface1, paddingHorizontal: 18, paddingVertical: 16 }}>
      {title ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
          {icon ? <Icon name={icon} size={14} color={theme.colors.foregroundMuted} /> : null}
          <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{title}</Text>
          <View style={{ flex: 1 }} />
          {trailing ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{trailing}</Text> : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

function LaneRow({ theme, lane, compact }: { theme: PluginTheme; lane: Lane; compact: boolean }) {
  const tone = lane.state === "success" ? "ok" : lane.state === "failure" ? "bad" : lane.state === "running" ? "run" : "muted";
  const color = toneColor(theme, tone);
  const queued = lane.state === "queued";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View style={{ width: compact ? 120 : 170, flexDirection: "row", alignItems: "center", gap: 7 }}>
        {tone === "ok" ? (
          <Icon name="Check" size={12} color={color} />
        ) : tone === "bad" ? (
          <Icon name="X" size={12} color={color} />
        ) : queued ? (
          <View style={{ width: 8, height: 8, borderRadius: 4, borderWidth: 1.5, borderColor: theme.colors.foregroundMuted, opacity: 0.8 }} />
        ) : null}
        <Text numberOfLines={1} style={{ fontFamily: MONO, fontSize: 11.5, color: theme.colors.foreground, flexShrink: 1 }}>
          {lane.name}
        </Text>
      </View>
      <View style={{ flex: 1, height: 16, borderRadius: 4, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
        {queued ? (
          <View
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${lane.left}%`,
              width: `${lane.width}%`,
              borderRadius: 4,
              borderWidth: 1,
              borderStyle: "dashed",
              borderColor: theme.colors.foregroundMuted,
              opacity: 0.6,
            }}
          />
        ) : (
          <Tint
            color={color}
            opacity={tone === "run" ? 0.5 : 0.55}
            style={{ position: "absolute", top: 0, bottom: 0, left: `${lane.left}%`, width: `${lane.width}%`, borderRadius: 4 }}
          />
        )}
      </View>
      <Text style={{ width: 70, textAlign: "right", color: theme.colors.foregroundMuted, fontSize: 11.5, fontVariant: ["tabular-nums"] }}>{lane.label}</Text>
    </View>
  );
}

/** The run in flight (or the last one), with the image lanes. */
function RunPanel({ theme, view, release, compact, now }: { theme: PluginTheme; view: ReleaseView; release: Release; compact: boolean; now: Date }) {
  const snapshot = view.snapshot!;
  const active = isActive(release);
  const images = release.steps.find((step) => step.id === "images")!;
  const lanes = imageLanes(release, now);
  const queue = active ? queueSummary(snapshot) : null;
  return (
    <Panel theme={theme}>
      <ReleaseHeader theme={theme} release={release} now={now} icon={!active} />
      <CommitLine theme={theme} release={release} />
      <PusherLine theme={theme} release={release} title={pusherTitle(view, release)} now={now} />
      <View style={{ marginTop: 18, marginBottom: 6 }}>
        <Pipe theme={theme} release={release} now={now} compact={compact} />
      </View>
      {lanes.length ? (
        <>
          <SectionLabel
            theme={theme}
            trailing={queue && !compact ? <QueueLine theme={theme} text={queue.replace("runner ", "")} style={{ marginTop: 0 }} /> : null}
          >
            {images.total ? `Imagens ${images.done ?? 0}/${images.total}` : "Imagens"}
          </SectionLabel>
          {queue && compact ? <QueueLine theme={theme} text={queue} style={{ marginTop: 0, marginBottom: 6 }} /> : null}
          <View style={{ gap: 5 }}>
            {lanes.map((lane) => (
              <LaneRow key={lane.name} theme={theme} lane={lane} compact={compact} />
            ))}
          </View>
        </>
      ) : null}
      <VerdictBanner theme={theme} release={release} />
      {release.verdict === "reverted" || release.verdict === "red" ? <Signals theme={theme} release={release} /> : null}
      <View style={{ flexDirection: "row", gap: 14, marginTop: 12 }}>
        <LinkText theme={theme} href={release.url} icon="ExternalLink" label="ver run" />
        <LinkText theme={theme} href={commitUrl(snapshot.repository, release.headSha)} icon="GitCommitHorizontal" label="ver commit" muted />
      </View>
    </Panel>
  );
}

function RunnersPanel({ theme, snapshot }: { theme: PluginTheme; snapshot: ReleaseSnapshot }) {
  const hint = queueHint(snapshot);
  return (
    <Panel theme={theme} icon="Server" title="Fila de runners" trailing={waitingLabel(snapshot) ?? "nenhum job aguardando"}>
      <RunnerQueue theme={theme} snapshot={snapshot} />
      {hint ? (
        <Tint color={theme.colors.statusWarning} opacity={0.1} style={{ marginTop: 10, paddingHorizontal: 10, paddingVertical: 9, borderRadius: 8, flexDirection: "row", gap: 7 }}>
          <Icon name="TriangleAlert" size={13} color={theme.colors.statusWarning} />
          <Text style={{ color: theme.colors.statusWarning, fontSize: 12, flex: 1 }}>{hint}</Text>
        </Tint>
      ) : null}
    </Panel>
  );
}

function agentLabel(view: ReleaseView, release: Release): string {
  const pusher = release.pusher;
  if (!pusher) return "—";
  if (pusher.harness === "paseo") return pusherTitle(view, release) ?? `Paseo ${pusher.id.slice(0, 8)}`;
  return `OpenCode · ${pusher.host}`;
}

function RevertsPanel({ theme, view }: { theme: PluginTheme; view: ReleaseView }) {
  const snapshot = view.snapshot!;
  const rows = revertRows(snapshot);
  return (
    <Panel theme={theme} icon="Undo2" title="Reversões do vigia" trailing={`últimos ${snapshot.releases.length} runs`}>
      {rows.length ? (
        rows.map((release) => {
          const tripped = trippedSignals(release).map((signal) => (signal.reason ? `${signal.label} ${signal.reason}` : signal.label));
          const detail = [...tripped, release.pusher ? `sessão ${agentLabel(view, release)}` : null].filter(Boolean).join(" · ");
          return (
            <View key={release.number} style={{ flexDirection: "row", gap: 9, paddingVertical: 5, alignItems: "flex-start" }}>
              <Text style={{ width: 84, fontFamily: MONO, fontSize: 11.5, color: theme.colors.foreground }}>{releaseLabel(release)}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{verdictSignals(release).text}</Text>
                {detail ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>{detail}</Text> : null}
              </View>
            </View>
          );
        })
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Nenhuma reversão nos runs carregados.</Text>
      )}
    </Panel>
  );
}

const COLUMNS = [
  { label: "release", width: 104 },
  { label: "commit", flex: 2.4 },
  { label: "agente", flex: 1.2 },
  { label: "duração", width: 64 },
  { label: "veredito do vigia", width: 130 },
  { label: "sinais", flex: 1.6 },
  { label: "", width: 60 },
] as const;

function cell(index: number) {
  const column = COLUMNS[index]!;
  return "width" in column ? { width: column.width, paddingHorizontal: 10 } : { flex: column.flex, minWidth: 0, paddingHorizontal: 10 };
}

function linkOf(release: Release): { href: string; label: string } {
  return release.verdict === "failed" ? { href: release.failedJob?.url ?? release.url, label: "ver log" } : { href: release.url, label: "ver run" };
}

function VerdictsPanel({ theme, view, compact, now }: { theme: PluginTheme; view: ReleaseView; compact: boolean; now: Date }) {
  const snapshot = view.snapshot!;
  const rows = verdictRows(snapshot);
  const border = { borderBottomWidth: 1, borderBottomColor: theme.colors.border };
  return (
    <Panel theme={theme} icon="History" title="Vereditos do vigia" trailing={`últimos ${rows.length} releases`}>
      {!rows.length ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Nenhum veredito nos runs carregados.</Text>
      ) : compact ? (
        rows.map((release, index) => {
          const badge = releaseBadge(release);
          const signals = verdictSignals(release);
          const link = linkOf(release);
          return (
            <View key={release.number} style={[{ paddingVertical: 9, gap: 4 }, index < rows.length - 1 ? border : null]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ fontFamily: MONO, fontSize: 12, color: theme.colors.foreground }}>{release.tag ?? "—"}</Text>
                <Badge theme={theme} tone={badge.tone} label={badge.label} icon={BADGE_ICONS[badge.tone]} />
                <View style={{ flex: 1 }} />
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{formatShortDuration(releaseDurationMs(release, now))}</Text>
              </View>
              <CommitLine theme={theme} release={release} />
              <Text numberOfLines={2} style={{ color: toneColor(theme, signals.tone), fontSize: 12 }}>
                {[agentLabel(view, release), signals.text].filter(Boolean).join(" · ")}
              </Text>
              <LinkText theme={theme} href={link.href} label={link.label} />
            </View>
          );
        })
      ) : (
        <View>
          <View style={[{ flexDirection: "row", paddingBottom: 8 }, border]}>
            {COLUMNS.map((column, index) => (
              <Text
                key={column.label || index}
                style={[cell(index), { color: theme.colors.foregroundMuted, opacity: 0.75, fontSize: 11, fontWeight: "500", letterSpacing: 0.5, textTransform: "uppercase" }]}
              >
                {column.label}
              </Text>
            ))}
          </View>
          {rows.map((release, index) => {
            const badge = releaseBadge(release);
            const signals = verdictSignals(release);
            const link = linkOf(release);
            return (
              <View key={release.number} style={[{ flexDirection: "row", alignItems: "center", paddingVertical: 9 }, index < rows.length - 1 ? border : null]}>
                <Text style={[cell(0), { fontFamily: MONO, fontSize: 12, color: theme.colors.foreground }]}>{release.tag ?? "—"}</Text>
                <View style={[cell(1), { flexDirection: "row", alignItems: "center", gap: 6 }]}>
                  <Sha theme={theme} sha={shortSha(release.headSha)} />
                  <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12.5, flexShrink: 1 }}>
                    {release.title}
                  </Text>
                </View>
                <Text numberOfLines={1} style={[cell(2), { color: theme.colors.foregroundMuted, fontSize: 12.5 }]}>
                  {agentLabel(view, release)}
                </Text>
                <Text style={[cell(3), { color: theme.colors.foregroundMuted, fontSize: 12.5 }]}>{formatShortDuration(releaseDurationMs(release, now))}</Text>
                <View style={[cell(4), { flexDirection: "row" }]}>
                  <Badge theme={theme} tone={badge.tone} label={badge.label} icon={BADGE_ICONS[badge.tone]} />
                </View>
                <Text numberOfLines={1} style={[cell(5), { color: toneColor(theme, signals.tone), fontSize: 12.5 }]}>
                  {signals.text}
                </Text>
                <View style={[cell(6), { alignItems: "flex-end" }]}>
                  <LinkText theme={theme} href={link.href} label={link.label} />
                </View>
              </View>
            );
          })}
        </View>
      )}
    </Panel>
  );
}

export function ReleasesScreen({ theme, layout }: PluginScreenProps) {
  const { view, error, loading, refreshing } = useReleaseState();
  const toast = useToast();
  const now = useNow();
  const compact = layout.compact;
  const snapshot = view?.snapshot ?? null;
  const repository = snapshot?.repository ?? RELEASE_REPOSITORY;
  const featured = snapshot ? (activeReleases(snapshot)[0] ?? lastFinished(snapshot)) : null;
  const fresh = snapshot ? freshness(snapshot, now) : null;

  async function refresh() {
    const result = await refreshReleases();
    if (!result.ok && result.error) toast.error(result.error);
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View
        style={{
          flexDirection: compact ? "column" : "row",
          alignItems: compact ? "flex-start" : "center",
          gap: compact ? 8 : 10,
          paddingHorizontal: compact ? 14 : 22,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10, flexShrink: 1, flexWrap: "wrap" }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>Releases</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>{`${repository} · release workflow em push na main`}</Text>
        </View>
        {compact ? null : <View style={{ flex: 1 }} />}
        <View style={{ flexDirection: "row", gap: 8 }}>
          <HeaderButton theme={theme} icon="RefreshCw" label="Atualizar" busy={refreshing} onPress={() => void refresh()} />
          <HeaderButton theme={theme} icon="Github" label="Abrir no GitHub" onPress={() => void openExternalUrl(RELEASE_ACTIONS_URL(repository))} />
        </View>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: compact ? 14 : 22, paddingVertical: compact ? 14 : 20, gap: 16 }}>
        {fresh || error ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {fresh ? (
              <Text style={{ color: fresh.stale ? theme.colors.statusWarning : theme.colors.foregroundMuted, fontSize: 12 }}>{fresh.text}</Text>
            ) : null}
            {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
            {error ? <PressText theme={theme} label="Tentar de novo" icon="RotateCw" onPress={retryReleases} /> : null}
          </View>
        ) : null}
        {loading && !view ? (
          <Loading />
        ) : !snapshot ? (
          <Panel theme={theme}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
              {error ? "O status dos releases não carregou." : "Aguardando a primeira leitura do GitHub…"}
            </Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 6 }}>
              O daemon lê o GitHub com o token do gh deste host (gh auth token). Sem token válido, nada aparece aqui.
            </Text>
          </Panel>
        ) : (
          <>
            <View style={{ flexDirection: compact ? "column" : "row", gap: 16, alignItems: "flex-start" }}>
              <View style={{ flex: compact ? undefined : 1, alignSelf: "stretch", minWidth: 0 }}>
                {featured ? (
                  <RunPanel theme={theme} view={view!} release={featured} compact={compact} now={now} />
                ) : (
                  <Panel theme={theme}>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>Nenhum run do release workflow carregado.</Text>
                  </Panel>
                )}
              </View>
              <View style={{ width: compact ? undefined : 350, alignSelf: compact ? "stretch" : "flex-start", gap: 16 }}>
                <RunnersPanel theme={theme} snapshot={snapshot} />
                <RevertsPanel theme={theme} view={view!} />
              </View>
            </View>
            <VerdictsPanel theme={theme} view={view!} compact={compact} now={now} />
          </>
        )}
      </ScrollView>
    </View>
  );
}
