import type { PluginPopoverProps, PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { cleanRpc, levelFor, preferences, sessionsRpc, statsRpc, type Level, type Session } from "../shared/contracts";

type Theme = PluginScreenProps["theme"];

// Fixed traffic-light hues: the meaning must not shift with the theme.
const HUE: Record<Level, string> = { green: "#22A06B", orange: "#E8912D", red: "#E5484D" };

const METRICS = [
  { key: "cpu", label: "CPU" },
  { key: "ram", label: "RAM" },
  { key: "disk", label: "DISK" },
] as const;

export function useStats() {
  const getStats = useRpc(statsRpc);
  return useQuery({ queryKey: ["system-health", "stats"], queryFn: () => getStats({}), refetchInterval: 15_000, staleTime: 10_000 });
}

export function useSessions(enabled = true) {
  const getSessions = useRpc(sessionsRpc);
  return useQuery({ queryKey: ["system-health", "sessions"], queryFn: () => getSessions({}), staleTime: 30_000, enabled });
}

function Pill({ label, percent }: { label: string; percent: number }) {
  const hue = HUE[levelFor(percent)];
  return (
    <View
      accessibilityLabel={`${label} ${percent}%`}
      style={{ flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, borderWidth: 1, borderColor: hue }}
    >
      <Text style={{ color: hue, fontSize: 10, fontWeight: "600" }}>{label}</Text>
      <Text style={{ color: hue, fontSize: 10 }}>{percent}%</Text>
    </View>
  );
}

/** The three pills shown in the sidebar row. */
export function SidebarPills() {
  const stats = useStats();
  if (!stats.data) return stats.isLoading ? <ActivityIndicator size="small" /> : null;
  return (
    <View style={{ flexDirection: "row", gap: 4 }}>
      {METRICS.map(({ key, label }) => (
        <Pill key={key} label={label} percent={stats.data[key].percent} />
      ))}
    </View>
  );
}

function Bar({ theme, percent }: { theme: Theme; percent: number }) {
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View style={{ width: `${Math.min(100, percent)}%`, height: 6, backgroundColor: HUE[levelFor(percent)] }} />
    </View>
  );
}

function SessionPicker({ theme, sessions, selectedId, onPick }: { theme: Theme; sessions: Session[]; selectedId: string; onPick: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visible = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
  return (
    <View style={{ borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, overflow: "hidden" }}>
      <TextInput
        autoFocus
        value={query}
        onChangeText={setQuery}
        placeholder="Search sessions"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="Search sessions by title"
        style={{ paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, color: theme.colors.foreground, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}
      />
      <ScrollView style={{ maxHeight: 240 }}>
        {visible.length === 0 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, padding: 10 }}>No session matches</Text>
        ) : null}
        {visible.map((s, i) => {
          const selected = s.id === selectedId;
          const header = i === 0 || visible[i - 1].group !== s.group;
          return (
            <View key={s.id}>
              {header ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 2 }}>{s.group}</Text>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => onPick(s.id)}
                style={{ paddingHorizontal: 10, paddingVertical: 7, backgroundColor: selected ? theme.colors.surface2 : "transparent" }}
              >
                <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: selected ? "600" : "400" }}>
                  {s.title}
                </Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function HealthPopover({ theme, close, openScreen }: PluginPopoverProps) {
  const stats = useStats();
  const settings = useSettings(preferences);
  const [picking, setPicking] = useState(false);
  const sessions = useSessions();
  const clean = useRpc(cleanRpc);

  const targetId = settings.status === "ready" ? settings.values.targetWorkspaceId : "";
  const target = sessions.data?.sessions.find((s) => s.id === targetId);
  const targetMissing = Boolean(targetId) && sessions.isSuccess && !target;

  const mutation = useMutation({
    mutationFn: () => {
      const d = stats.data;
      const summary = d ? `CPU ${d.cpu.percent}%, RAM ${d.ram.percent}% (${d.ram.detail}), disk ${d.disk.percent}% (${d.disk.detail})` : "stats unavailable";
      return clean({ stats: summary });
    },
    onSuccess: ({ agentId }) => openScreen({ screenId: "cleanup", params: { agentId } }),
  });

  async function pick(id: string) {
    if (settings.status !== "ready") return;
    await settings.save({ ...settings.values, targetWorkspaceId: id }, settings.revision);
    setPicking(false);
  }

  const canClean = Boolean(target) && !mutation.isPending;

  return (
    <View style={{ padding: 16, gap: 14, minWidth: 280, maxWidth: 340 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>System health</Text>
      {stats.data ? (
        METRICS.map(({ key, label }) => {
          const m = stats.data[key];
          return (
            <View key={key} style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
                  {label} <Text style={{ color: HUE[levelFor(m.percent)], fontWeight: "600" }}>{m.percent}%</Text>
                </Text>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{m.detail}</Text>
              </View>
              <Bar theme={theme} percent={m.percent} />
            </View>
          );
        })
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted }}>{stats.error ? "Could not read stats" : "Reading…"}</Text>
      )}

      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Send cleanup prompt to</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose the session that receives the cleanup message"
          onPress={() => setPicking((v) => !v)}
          style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border }}
        >
          <Text numberOfLines={1} style={{ flex: 1, color: target ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: 13 }}>
            {target ? target.title : targetMissing ? "Session archived, pick another" : sessions.isLoading ? "Loading sessions…" : "Pick a session"}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{picking ? "▲" : "▼"}</Text>
        </Pressable>
        {picking && sessions.data ? <SessionPicker theme={theme} sessions={sessions.data.sessions} selectedId={targetId} onPick={(id) => void pick(id)} /> : null}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Send a cleanup round to the selected session"
        disabled={!canClean}
        onPress={() => mutation.mutate()}
        style={{ paddingVertical: 10, borderRadius: 8, backgroundColor: theme.colors.accent, opacity: canClean ? 1 : 0.5 }}
      >
        <Text style={{ color: theme.colors.accentForeground, textAlign: "center", fontWeight: "600" }}>
          {mutation.isPending ? "Sending…" : "Clean"}
        </Text>
      </Pressable>
      {mutation.error ? <Text style={{ color: HUE.red, fontSize: 12 }}>{(mutation.error as Error).message}</Text> : null}
      <Pressable accessibilityRole="button" onPress={close}>
        <Text style={{ color: theme.colors.foregroundMuted, textAlign: "center", fontSize: 12 }}>Close</Text>
      </Pressable>
    </View>
  );
}

/** Opened after Clean: jumps straight to the receiving session. */
export function CleanupScreen({ theme, navigation, params }: PluginScreenProps) {
  const agentId = params.agentId;
  useEffect(() => {
    if (agentId) navigation?.openAgent({ agentId });
  }, [navigation, agentId]);
  return (
    <View style={{ flex: 1, padding: 24, gap: 12, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 16 }}>Cleanup round sent.</Text>
      {navigation && agentId ? (
        <Pressable accessibilityRole="button" onPress={() => navigation.openAgent({ agentId })}>
          <Text style={{ color: theme.colors.accent }}>Open the session</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
