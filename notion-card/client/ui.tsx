import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native";

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

/** Hairline-bordered surface, no fill: the card sits in the conversation like a quiet panel. */
export function Card({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        overflow: "hidden",
        marginVertical: 2,
      }}
    >
      {children}
    </View>
  );
}

export function Divider({ theme }: { theme: PluginTheme }) {
  return <View style={{ height: 1, backgroundColor: theme.colors.border }} />;
}

export function Dot({ color, size = 6 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

/** Text-only action: muted until it matters, no chrome. */
export function Action({
  theme,
  icon,
  label,
  onPress,
  busy,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  icon: string;
  label?: string;
  onPress: () => void;
  busy?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={busy}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingVertical: 4,
        paddingHorizontal: 6,
        borderRadius: 5,
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      ) : (
        <Icon name={icon} size={13} color={theme.colors.foregroundMuted} />
      )}
      {label ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text> : null}
    </Pressable>
  );
}

/** The replaced tool row: one muted mono line, output on tap. */
export function CommandLine({
  theme,
  command,
  output,
  running,
  exitCode,
}: {
  theme: PluginTheme;
  command: string;
  output: string;
  running: boolean;
  exitCode: number | null;
}) {
  const [open, setOpen] = useState(false);
  const failed = exitCode !== null && exitCode !== 0;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? "Hide command output" : "Show command output"}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontFamily: MONO, fontSize: 12 }}>$</Text>
        <Text
          style={{ color: theme.colors.foregroundMuted, fontFamily: MONO, fontSize: 12, flexShrink: 1 }}
          numberOfLines={open ? undefined : 1}
        >
          {command}
        </Text>
        {running ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
        {failed ? (
          <Text style={{ color: theme.colors.statusDanger, fontFamily: MONO, fontSize: 11, flexShrink: 0 }}>
            exit {exitCode}
          </Text>
        ) : null}
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={12} color={theme.colors.foregroundMuted} />
      </Pressable>
      {open ? (
        <ScrollView
          nestedScrollEnabled
          style={{
            maxHeight: 220,
            borderLeftWidth: 2,
            borderLeftColor: theme.colors.border,
            paddingLeft: 10,
            paddingVertical: 2,
            marginBottom: 6,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontFamily: MONO, fontSize: 11, lineHeight: 16 }} selectable>
            {output.length > 0 ? output : "(no output)"}
          </Text>
        </ScrollView>
      ) : null}
    </>
  );
}

/** A thin bar split by share, GitHub-style. Segments with a zero value are dropped. */
export function SegmentBar({
  theme,
  segments,
}: {
  theme: PluginTheme;
  segments: Array<{ value: number; color: string }>;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <View
      style={{
        flexDirection: "row",
        height: 3,
        borderRadius: 2,
        overflow: "hidden",
        gap: total > 0 ? 2 : 0,
        backgroundColor: total > 0 ? "transparent" : theme.colors.surface2,
      }}
    >
      {segments
        .filter((segment) => segment.value > 0)
        .map((segment, index) => (
          <View key={index} style={{ flex: segment.value, backgroundColor: segment.color }} />
        ))}
    </View>
  );
}
