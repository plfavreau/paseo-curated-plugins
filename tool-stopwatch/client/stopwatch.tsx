import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
// Icon names must be the exported lucide symbol (PascalCase). Unknown names render nothing.
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { StopwatchData } from "../shared/stopwatch";
import { formatElapsed } from "../shared/stopwatch";

const WARN_AFTER_MS = 60_000;
const DANGER_AFTER_MS = 5 * 60_000;

// First time this client saw each call running. Guards against a renderer
// timestamp that moves forward on streaming updates.
const firstSeen = new Map<string, number>();

function startOf(callId: string, timestamp: Date): number {
  const fromRow = timestamp.getTime();
  const seen = firstSeen.get(callId);
  const start = Number.isFinite(fromRow) ? Math.min(fromRow, seen ?? fromRow) : (seen ?? Date.now());
  firstSeen.set(callId, start);
  return start;
}

export function StopwatchItem({ theme, item, timestamp }: PluginTimelineItemProps<StopwatchData>) {
  const { callId, label, summary, icon } = item.data;
  const start = useMemo(() => startOf(callId, timestamp), [callId, timestamp]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = now - start;
  const tone =
    elapsed >= DANGER_AFTER_MS
      ? theme.colors.statusDanger
      : elapsed >= WARN_AFTER_MS
        ? theme.colors.statusWarning
        : theme.colors.foregroundMuted;

  return (
    <View
      style={styles.row}
      accessibilityLabel={`${label} running for ${formatElapsed(elapsed)}`}
    >
      <Icon name={icon} size={14} color={theme.colors.foregroundMuted} />
      <Text style={[styles.label, { color: theme.colors.foregroundMuted }]}>{label}</Text>
      <Text style={[styles.summary, { color: theme.colors.foregroundMuted }]} numberOfLines={1}>
        {summary}
      </Text>
      <View style={[styles.pill, { borderColor: tone }]}>
        <Icon name="Timer" size={12} color={tone} />
        <Text style={[styles.elapsed, { color: tone }]}>{formatElapsed(elapsed)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
  },
  label: { fontSize: 14, fontWeight: "500" },
  summary: { flex: 1, fontSize: 14 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    borderWidth: 1,
  },
  elapsed: { fontSize: 12, fontVariant: ["tabular-nums"] },
});
