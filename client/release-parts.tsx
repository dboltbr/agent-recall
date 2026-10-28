// Building blocks of the release surfaces (mocks p1b/p3/p4a/p4b/p5): header, commit and pusher
// lines, the vertical step list, the horizontal pipe, image chips, the runner queue and the
// watch signals. Copy comes from `shared/release-copy.ts`; nothing here reads the network.
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Easing, Platform, Pressable, Text, View } from "react-native";
import {
  imageChips,
  pipeMeta,
  pusherLine,
  releaseBadge,
  runnerRows,
  signalOutcome,
  signalText,
  stepDetail,
  stepDurationMs,
  stepLabelOf,
  stepTone,
  watchTone,
  shortSha,
  type Tone,
} from "../shared/release-copy.ts";
import {
  formatDuration,
  formatShortDuration,
  isActive,
  releaseDurationMs,
  releaseLabel,
  type Release,
  type ReleaseSnapshot,
  type Step,
} from "../shared/release-status.ts";
import { Badge, MONO, Sha, StepMark, Tint, toneColor } from "./kit.tsx";
import type { OpenAgent, WatchLink } from "./navigate.ts";

const BADGE_ICONS: Partial<Record<Tone, string>> = { ok: "Check", bad: "X", warn: "Undo2" };
const HEAD_ICONS: Partial<Record<Tone, string>> = { ok: "CircleCheck", bad: "CircleX", warn: "Undo2" };

/** Spinning loader (native driver off on web, where it is not supported). */
export function Spin({ color, size = 15 }: { color: string; size?: number }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(turn, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: Platform.OS !== "web" }),
    );
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      <Icon name="LoaderCircle" size={size} color={color} />
    </Animated.View>
  );
}

export function ReleaseHeader({ theme, release, now, icon }: { theme: PluginTheme; release: Release; now: Date; icon?: boolean }) {
  const badge = releaseBadge(release);
  const headIcon = icon ? HEAD_ICONS[badge.tone] : undefined;
  const duration = releaseDurationMs(release, now);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      {headIcon ? <Icon name={headIcon} size={15} color={toneColor(theme, badge.tone)} /> : null}
      <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 13.5 }}>{releaseLabel(release)}</Text>
      <Badge theme={theme} tone={badge.tone} label={badge.label} icon={BADGE_ICONS[badge.tone]} />
      <View style={{ flex: 1 }} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {formatShortDuration(duration)}
      </Text>
    </View>
  );
}

export function CommitLine({ theme, release }: { theme: PluginTheme; release: Release }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginTop: 4, minWidth: 0 }}>
      <Sha theme={theme} sha={shortSha(release.headSha)} />
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>
        {release.title}
      </Text>
    </View>
  );
}

export function PusherLine({ theme, release, title, now }: { theme: PluginTheme; release: Release; title: string | null; now: Date }) {
  const line = pusherLine(release, title, now);
  if (!line) return null;
  // The quoted title reads in the foreground color, the rest muted (mock p1b).
  const open = line.indexOf("“");
  const close = line.indexOf("”");
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginTop: 4, minWidth: 0 }}>
      <Icon name="Bot" size={13} color={theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>
        {open >= 0 && close > open ? (
          <>
            {line.slice(0, open)}
            <Text style={{ color: theme.colors.foreground }}>{line.slice(open, close + 1)}</Text>
            {line.slice(close + 1)}
          </>
        ) : (
          line
        )}
      </Text>
    </View>
  );
}

export function SectionLabel({ theme, children, trailing }: { theme: PluginTheme; children: ReactNode; trailing?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12, marginBottom: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, opacity: 0.75, fontSize: 11, fontWeight: "500", letterSpacing: 0.6, textTransform: "uppercase" }}>
        {children}
      </Text>
      {trailing ? <View style={{ flex: 1 }} /> : null}
      {trailing}
    </View>
  );
}

/** `6 na fila — runner solid-srv ocupado`, in the warning color. */
export function QueueLine({ theme, text, style }: { theme: PluginTheme; text: string; style?: object }) {
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 }, style]}>
      <Icon name="Clock" size={13} color={theme.colors.statusWarning} />
      <Text style={{ color: theme.colors.statusWarning, fontSize: 12, flexShrink: 1 }}>{text}</Text>
    </View>
  );
}

function Chip({ theme, children, tone, queued }: { theme: PluginTheme; children: ReactNode; tone?: Tone; queued?: boolean }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        height: 22,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: queued ? "transparent" : theme.colors.surface2,
        borderWidth: queued || tone === "run" ? 1 : 0,
        borderStyle: queued ? "dashed" : "solid",
        borderColor: tone === "run" ? theme.colors.accent : theme.colors.border,
      }}
    >
      {children}
    </View>
  );
}

/** Published and building images, then `+N na fila` (mock p1b/p4a). */
export function ImageChips({ theme, release, limit }: { theme: PluginTheme; release: Release; limit?: number }) {
  const { chips, hidden, queued } = imageChips(release, limit);
  if (!chips.length && !queued) return null;
  const text = { fontFamily: MONO, fontSize: 11.5 } as const;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
      {hidden ? (
        <Chip theme={theme} queued>
          <Text style={[text, { color: theme.colors.foregroundMuted }]}>+{hidden}</Text>
        </Chip>
      ) : null}
      {chips.map((chip) => {
        const tone: Tone =
          chip.state === "success" ? "ok" : chip.state === "failure" ? "bad" : chip.state === "running" ? "run" : "muted";
        const icon = tone === "ok" ? "Check" : tone === "bad" ? "X" : null;
        return (
          <Chip key={chip.name} theme={theme} tone={tone}>
            {icon ? <Icon name={icon} size={11} color={toneColor(theme, tone)} /> : null}
            <Text style={[text, { color: tone === "muted" ? theme.colors.foregroundMuted : theme.colors.foreground }]}>{chip.name}</Text>
          </Chip>
        );
      })}
      {queued ? (
        <Chip theme={theme} queued>
          <Text style={[text, { color: theme.colors.foregroundMuted }]}>+{queued} na fila</Text>
        </Chip>
      ) : null}
    </View>
  );
}

/** Sessions behind the vigia step and how to open one. */
export interface WatchTargets {
  readonly links: readonly WatchLink[];
  readonly open: OpenAgent;
}

/** `push · “title”` / `investigação · “title”` rows under the vigia step. */
export function WatchLinks({ theme, watch, style }: { theme: PluginTheme; watch: WatchTargets; style?: object }) {
  if (!watch.links.length) return null;
  return (
    <View style={[{ gap: 2, marginTop: 3 }, style]}>
      {watch.links.map((link) => (
        <Pressable
          key={link.agentId}
          accessibilityRole="link"
          accessibilityLabel={`Abrir ${link.label}`}
          onPress={() => watch.open(link.agentId)}
          hitSlop={4}
          style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 5, opacity: pressed ? 0.6 : 1, minWidth: 0 })}
        >
          <Icon name="Bot" size={12} color={theme.colors.accent} />
          <Text numberOfLines={1} style={{ color: theme.colors.accent, fontSize: 11.5, flexShrink: 1 }}>
            {link.label}
          </Text>
          <Icon name="ArrowUpRight" size={11} color={theme.colors.accent} />
        </Pressable>
      ))}
    </View>
  );
}

function stepMarkTone(release: Release, step: Step): Tone | undefined {
  return step.id === "watch" && !isActive(release) ? (watchTone(release) ?? undefined) : undefined;
}

/** "Etapas": the vertical list with a connector line (mock p1b). */
export function StepList({
  theme,
  release,
  queue,
  now,
  watch,
}: {
  theme: PluginTheme;
  release: Release;
  queue: string | null;
  now: Date;
  watch?: WatchTargets | null;
}) {
  return (
    <View>
      {release.steps.map((step, index) => {
        const pending = step.state === "pending" || step.state === "skipped";
        const duration = stepDurationMs(step, now);
        const detail = stepDetail(release, step);
        const markTone = stepMarkTone(release, step);
        return (
          <View key={step.id} style={{ flexDirection: "row", gap: 10, paddingVertical: 4, alignItems: "flex-start" }}>
            {index < release.steps.length - 1 ? (
              <View style={{ position: "absolute", left: 8.5, top: 23, bottom: -3, width: 1, backgroundColor: theme.colors.border }} />
            ) : null}
            {step.state === "running" ? (
              <View style={{ width: 18, height: 18, alignItems: "center", justifyContent: "center" }}>
                <Spin color={theme.colors.accent} />
              </View>
            ) : (
              <StepMark theme={theme} state={step.state} tone={markTone} />
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: pending ? theme.colors.foregroundMuted : theme.colors.foreground, fontWeight: pending ? "400" : "500", fontSize: 13 }}>
                {stepLabelOf(step)}
                {step.id === "images" && step.total ? (
                  <Text style={{ color: theme.colors.foregroundMuted, fontWeight: "400" }}>{` ${step.done ?? 0}/${step.total}`}</Text>
                ) : null}
              </Text>
              {step.id === "images" && (step.state === "running" || step.state === "failed") ? (
                <>
                  <ImageChips theme={theme} release={release} />
                  {queue && step.state === "running" ? <QueueLine theme={theme} text={queue} style={{ marginTop: 6 }} /> : null}
                </>
              ) : detail ? (
                <Text
                  style={{
                    color: markTone ? toneColor(theme, markTone) : step.state === "failed" ? theme.colors.statusDanger : theme.colors.foregroundMuted,
                    fontSize: 11.5,
                    marginTop: 1,
                    fontFamily: step.id === "tag" ? MONO : undefined,
                  }}
                >
                  {detail}
                </Text>
              ) : null}
              {step.id === "watch" && watch ? <WatchLinks theme={theme} watch={watch} /> : null}
            </View>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, fontVariant: ["tabular-nums"] }}>
              {pending ? "" : formatDuration(duration)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** The compact horizontal pipe of the timeline card and the screen (mock p4a). */
export function Pipe({
  theme,
  release,
  now,
  compact,
  watch,
}: {
  theme: PluginTheme;
  release: Release;
  now: Date;
  compact: boolean;
  watch?: WatchTargets | null;
}) {
  // One session: the vigia node itself opens it. More: the links go under the pipe.
  const single = watch && watch.links.length === 1 ? watch.links[0]! : null;
  const pipe = (
    <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
      {release.steps.map((step, index) => {
        const markTone = stepMarkTone(release, step);
        const tone = markTone ?? stepTone(step.state);
        const color = toneColor(theme, tone);
        const last = index === release.steps.length - 1;
        const muted = tone === "muted";
        const link = step.id === "watch" ? single : null;
        const node = (
          <View key={step.id} style={{ flex: 1, minWidth: 0, paddingTop: 22 }}>
            {!last ? (
              <Tint
                color={step.state === "done" ? theme.colors.statusSuccess : theme.colors.border}
                opacity={step.state === "done" ? 0.55 : 1}
                style={{ position: "absolute", top: 7.5, left: 20, right: 4, height: 1 }}
              />
            ) : null}
            <Tint
              color={muted ? theme.colors.surface2 : color}
              opacity={muted ? 1 : 0.2}
              style={{ position: "absolute", top: 0, left: 0, width: 16, height: 16, borderRadius: 8, alignItems: "center", justifyContent: "center" }}
            >
              {step.state === "done" ? (
                <Icon name="Check" size={10} color={color} />
              ) : step.state === "failed" ? (
                <Icon name="X" size={10} color={color} />
              ) : markTone === "warn" ? (
                <Icon name="Undo2" size={10} color={color} />
              ) : (
                <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: color }} />
              )}
            </Tint>
            <Text
              numberOfLines={1}
              style={{
                color: muted ? theme.colors.foregroundMuted : theme.colors.foreground,
                fontWeight: muted ? "400" : "500",
                fontSize: compact ? 11.5 : 12.5,
              }}
            >
              {stepLabelOf(step)}
            </Text>
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: compact ? 10.5 : 11.5, marginTop: 1 }}>
              {pipeMeta(release, step, now)}
            </Text>
            {link ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3, marginTop: 1, minWidth: 0 }}>
                <Icon name="Bot" size={11} color={theme.colors.accent} />
                <Text numberOfLines={1} style={{ color: theme.colors.accent, fontSize: compact ? 10.5 : 11.5, flexShrink: 1 }}>
                  {link.label.split(" · ")[0]}
                </Text>
              </View>
            ) : null}
          </View>
        );
        if (!link || !watch) return node;
        return (
          <Pressable
            key={step.id}
            accessibilityRole="link"
            accessibilityLabel={`Abrir ${link.label}`}
            onPress={() => watch.open(link.agentId)}
            style={({ pressed }) => ({ flex: 1, minWidth: 0, opacity: pressed ? 0.6 : 1 })}
          >
            {node}
          </Pressable>
        );
      })}
    </View>
  );
  if (!watch || watch.links.length < 2) return pipe;
  return (
    <View>
      {pipe}
      <WatchLinks theme={theme} watch={watch} style={{ marginTop: 8 }} />
    </View>
  );
}

/** "Fila de runners": one row per self-hosted runner (mock p5). */
export function RunnerQueue({ theme, snapshot }: { theme: PluginTheme; snapshot: ReleaseSnapshot }) {
  const rows = runnerRows(snapshot.runners);
  if (!rows.length) return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Nenhum runner self-hosted registrado.</Text>;
  return (
    <View style={{ gap: 2 }}>
      {rows.map((row) => (
        <View key={row.name} style={{ flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 5 }}>
          <Icon name="Server" size={13} color={theme.colors.foregroundMuted} />
          <Text style={{ fontFamily: MONO, fontSize: 11.5, color: theme.colors.foreground }}>{row.name}</Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12, flex: 1, minWidth: 0 }}>
            {row.detail}
          </Text>
          <Badge theme={theme} tone={row.tone} label={row.status} />
        </View>
      ))}
    </View>
  );
}

/** "Sinais do blast radius" (mock p4b revert card). */
export function Signals({ theme, release }: { theme: PluginTheme; release: Release }) {
  if (!release.signals.length) return null;
  return (
    <View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, marginTop: 10, marginBottom: 2 }}>Sinais do blast radius</Text>
      {release.signals.map((signal) => {
        const outcome = signalOutcome(signal);
        const color = toneColor(theme, outcome.tone);
        return (
          <View key={signal.source} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3 }}>
            <Icon name={outcome.tone === "bad" ? "CircleX" : outcome.tone === "ok" ? "CircleCheck" : "CircleDashed"} size={13} color={color} />
            <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 12, flex: 1 }}>
              {signalText(signal)}
            </Text>
            <Text style={{ color: outcome.tone === "bad" ? color : theme.colors.foregroundMuted, fontSize: 12 }}>{outcome.label}</Text>
          </View>
        );
      })}
    </View>
  );
}
