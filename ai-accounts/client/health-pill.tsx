import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { healthRpc, type HealthLevel } from "../shared/contracts";
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
