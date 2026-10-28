// Small React Native pieces shared by the release surfaces. Colors come only from `theme.colors`;
// tinted backgrounds are a theme color under opacity (no color parsing, no color-mix).
import type { PluginTheme } from "@getpaseo/plugin";
import { ExternalLink, Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import type { Tone } from "../shared/release-copy.ts";
import type { Step } from "../shared/release-status.ts";

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" });

export function toneColor(theme: PluginTheme, tone: Tone): string {
  switch (tone) {
    case "ok":
      return theme.colors.statusSuccess;
    case "bad":
      return theme.colors.statusDanger;
    case "warn":
      return theme.colors.statusWarning;
    case "run":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundMuted;
  }
}

/** A view on a translucent wash of `color`. */
export function Tint(props: {
  color: string;
  opacity?: number;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  return (
    <View style={[{ overflow: "hidden" }, props.style]}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: props.color, opacity: props.opacity ?? 0.14 }]} />
      {props.children}
    </View>
  );
}

export function Badge({ theme, tone, label, icon }: { theme: PluginTheme; tone: Tone; label: string; icon?: string }) {
  const color = toneColor(theme, tone);
  const muted = tone === "muted";
  return (
    <Tint
      color={muted ? theme.colors.surface2 : color}
      opacity={muted ? 1 : 0.14}
      style={{ borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1, flexDirection: "row", alignItems: "center", gap: 4 }}
    >
      {icon ? <Icon name={icon} size={11} color={color} /> : null}
      <Text style={{ color, fontSize: 11 }}>{label}</Text>
    </Tint>
  );
}

export function Sha({ theme, sha }: { theme: PluginTheme; sha: string }) {
  return (
    <View style={{ backgroundColor: theme.colors.surface2, borderRadius: 4, paddingHorizontal: 5 }}>
      <Text style={{ fontFamily: MONO, fontSize: 11.5, color: theme.colors.foreground }}>{sha}</Text>
    </View>
  );
}

export function Section({ theme, children, trailing }: { theme: PluginTheme; children: string; trailing?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14, marginBottom: 6 }}>
      <Text
        style={{
          color: theme.colors.foregroundMuted,
          fontSize: 11,
          fontWeight: "500",
          letterSpacing: 0.6,
          textTransform: "uppercase",
          opacity: 0.8,
        }}
      >
        {children}
      </Text>
      {trailing ? <View style={{ flex: 1 }} /> : null}
      {trailing}
    </View>
  );
}

/** The 18 px step marker of the vertical list. */
export function StepMark({ theme, state, tone }: { theme: PluginTheme; state: Step["state"]; tone?: Tone }) {
  const box = { width: 18, height: 18, alignItems: "center", justifyContent: "center" } as const;
  if (tone === "warn") return <View style={box}><Icon name="Undo2" size={15} color={theme.colors.statusWarning} /></View>;
  if (state === "done") return <View style={box}><Icon name="CircleCheck" size={15} color={theme.colors.statusSuccess} /></View>;
  if (state === "failed") return <View style={box}><Icon name="CircleX" size={15} color={theme.colors.statusDanger} /></View>;
  if (state === "running") return <View style={box}><Icon name="LoaderCircle" size={15} color={theme.colors.accent} /></View>;
  if (state === "cancelled") return <View style={box}><Icon name="CircleSlash" size={14} color={theme.colors.foregroundMuted} /></View>;
  return (
    <View style={box}>
      <View
        style={{
          width: 9,
          height: 9,
          borderRadius: 5,
          borderWidth: 1.5,
          borderColor: theme.colors.foregroundMuted,
          opacity: state === "skipped" ? 0.4 : 0.8,
        }}
      />
    </View>
  );
}

/** Five-segment step bar (sidebar row trailing). */
export function SegBar({ theme, steps, watchTone }: { theme: PluginTheme; steps: readonly Step[]; watchTone?: Tone | null }) {
  return (
    <View style={{ flexDirection: "row", gap: 3, alignItems: "center" }}>
      {steps.map((step) => {
        const color =
          step.id === "watch" && watchTone
            ? toneColor(theme, watchTone)
            : step.state === "done"
              ? theme.colors.statusSuccess
              : step.state === "failed"
                ? theme.colors.statusDanger
                : null;
        if (step.state === "running") {
          const fraction = step.total ? Math.max(0.15, Math.min(1, (step.done ?? 0) / step.total)) : 0.33;
          return (
            <Tint key={step.id} color={theme.colors.foregroundMuted} opacity={0.28} style={{ width: 18, height: 5, borderRadius: 3 }}>
              <View style={{ width: `${fraction * 100}%`, height: 5, backgroundColor: theme.colors.accent }} />
            </Tint>
          );
        }
        // Pending: a translucent muted tone, visible on the plain and on the highlighted row.
        if (!color) return <Tint key={step.id} color={theme.colors.foregroundMuted} opacity={0.28} style={{ width: 18, height: 5, borderRadius: 3 }} />;
        return <View key={step.id} style={{ width: 18, height: 5, borderRadius: 3, backgroundColor: color }} />;
      })}
    </View>
  );
}

export function Banner({
  theme,
  tone,
  icon,
  text,
  link,
}: {
  theme: PluginTheme;
  tone: Tone;
  icon: string;
  text: string;
  link?: { label: string; href: string } | null;
}) {
  const color = toneColor(theme, tone);
  return (
    <Tint
      color={tone === "muted" ? theme.colors.surface2 : color}
      opacity={tone === "muted" ? 1 : 0.12}
      style={{ flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, marginTop: 10 }}
    >
      <Icon name={icon} size={14} color={color} />
      <Text style={{ color, fontSize: 12.5, flex: 1 }}>{text}</Text>
      {link ? (
        <ExternalLink href={link.href}>
          <Text style={{ color, fontSize: 12.5, textDecorationLine: "underline" }}>{link.label}</Text>
        </ExternalLink>
      ) : null}
    </Tint>
  );
}

export function LinkText({
  theme,
  href,
  icon,
  label,
  muted,
}: {
  theme: PluginTheme;
  href: string;
  icon?: string;
  label: string;
  muted?: boolean;
}) {
  const color = muted ? theme.colors.foregroundMuted : theme.colors.accent;
  return (
    <ExternalLink href={href} accessibilityLabel={label}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {icon ? <Icon name={icon} size={12} color={color} /> : null}
        <Text style={{ color, fontSize: 12 }}>{label}</Text>
      </View>
    </ExternalLink>
  );
}

export function PressText({
  theme,
  label,
  onPress,
  muted,
  icon,
}: {
  theme: PluginTheme;
  label: string;
  onPress(): void;
  muted?: boolean;
  icon?: string;
}) {
  const color = muted ? theme.colors.foregroundMuted : theme.colors.accent;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={6} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        {icon ? <Icon name={icon} size={12} color={color} /> : null}
        <Text style={{ color, fontSize: 12 }}>{label}</Text>
      </View>
    </Pressable>
  );
}

export function Muted({ theme, children, style }: { theme: PluginTheme; children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[{ color: theme.colors.foregroundMuted, fontSize: 12 }, style]}>{children}</Text>;
}

export function Card({
  theme,
  tone,
  compact,
  children,
  style,
}: {
  theme: PluginTheme;
  tone?: Tone | null;
  compact: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const accent = tone && tone !== "muted" && tone !== "run" ? toneColor(theme, tone) : null;
  return (
    <View
      style={[
        {
          borderWidth: 1,
          borderColor: accent ?? theme.colors.border,
          backgroundColor: theme.colors.surface1,
          borderRadius: 12,
          paddingHorizontal: compact ? 12 : 14,
          paddingVertical: 12,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
