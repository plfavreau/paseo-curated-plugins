import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Platform, Text, View } from "react-native";
import { healthRpc, type HealthLevel } from "../shared/contracts";
import type { RpcOutput } from "@getpaseo/plugin";
import { Dot } from "./ui";

type Theme = PluginScreenProps["theme"];

export const HEALTH_KEY = ["ai-accounts", "health"] as const;
const LABEL: Record<HealthLevel, string> = { green: "Balanced", orange: "Could be better", red: "Needs rebalancing" };
// Fixed traffic-light hues: the meaning must not shift with the theme.
export const HEALTH_HUE: Record<HealthLevel, string> = { green: "#22A06B", orange: "#E8912D", red: "#E5484D" };

export function useHealth() {
  const getHealth = useRpc(healthRpc);
  return useQuery({ queryKey: HEALTH_KEY, queryFn: () => getHealth({}), staleTime: 30_000, refetchInterval: 60_000 });
}

/** `compact` is the bare dot that fits a sidebar row. */
export function HealthPill({ level, compact = false }: { theme: Theme; level: HealthLevel | undefined; compact?: boolean }) {
  if (!level) return null;
  const hue = HEALTH_HUE[level];
  return (
    <View accessibilityLabel={`Balance: ${LABEL[level].toLowerCase()}`} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Dot color={hue} size={compact ? 7 : 6} />
      {compact ? null : <Text style={{ color: hue, fontSize: 12, fontWeight: "500" }}>{LABEL[level]}</Text>}
    </View>
  );
}

type Health = RpcOutput<typeof healthRpc>;

function tooltip(health: Health): string {
  const limited = health.signedIn - health.usable;
  const signedOut = health.total - health.signedIn;
  return [
    `${health.usable} of ${health.total} accounts usable now${limited > 0 ? ` (${limited} at their limit)` : ""}`,
    `${health.signedIn} of ${health.total} sign-ins connected${signedOut > 0 ? ` (${signedOut} to reconnect)` : ""}`,
    "",
    `Dot: are conversations on the best accounts? ${LABEL[health.level]}.`,
    ...health.reasons.map((reason) => `• ${reason}`),
  ].join("\n");
}

/** Sidebar summary: usable accounts, broken sign-ins when there are any, and the balance dot. Hover explains it. */
export function SidebarStatus({ theme, health }: { theme: Theme; health: Health | undefined }) {
  const ref = useRef<View>(null);
  const text = health ? tooltip(health) : "";
  useEffect(() => {
    // React Native has no tooltip; on desktop the DOM title attribute is the native one.
    if (Platform.OS === "web") (ref.current as unknown as HTMLElement | null)?.setAttribute?.("title", text);
  }, [text]);
  if (!health) return null;
  const c = theme.colors;
  const signedOut = health.total - health.signedIn;
  return (
    <View ref={ref} accessibilityLabel={text} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <Text style={{ color: health.usable === 0 ? c.statusDanger : c.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{`${health.usable}/${health.total} usable`}</Text>
      {signedOut > 0 ? <Text style={{ color: c.statusDanger, fontSize: 12 }}>{`· ${signedOut} signed out`}</Text> : null}
      <HealthPill theme={theme} level={health.level} compact />
    </View>
  );
}
