import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { sessionsRpc, setPreferredAccountRpc } from "../shared/contracts";
import { BRAND, ProviderLogo } from "./brand";
import { ForceConfirmCard } from "./force-controls";
import type { AccountProvider } from "./harness";
import { HEALTH_KEY } from "./health-pill";
import { SESSIONS_KEY } from "./sessions-overview";
import { Button, Check, Chevron, CLICKABLE, Dot, Meter, TABULAR, type Theme, useUi } from "./ui";

type Usage = { label: string; utilization: number; resetsAt?: string | null };
export type SheetAccount = { id: string; email: string; usage: Usage[]; needsReauth?: boolean };

const shortWindow = (label: string) => {
  const match = /^(\d+)-(hour|day|week|month)$/.exec(label);
  return match ? `${match[1]}${match[2][0]}` : label;
};

function resetsAt(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(date.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

function OptionRow({ theme, title, detail, selected, disabled, onPress }: { theme: Theme; title: string; detail: string; selected?: boolean; disabled?: boolean; onPress(): void }) {
  const ui = useUi(theme, true);
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 9, marginHorizontal: -9, borderRadius: 8 },
        CLICKABLE,
        pressed || hovered ? { backgroundColor: c.surface2 } : null,
        disabled ? { opacity: 0.4 } : null,
      ]}
    >
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={[ui.primary, { fontWeight: "600" }]}>{title}</Text>
        <Text style={ui.secondary}>{detail}</Text>
      </View>
      {selected ? <Check color={c.foreground} /> : <Text style={{ color: c.foregroundMuted, fontSize: 15 }}>›</Text>}
    </Pressable>
  );
}

/** Everything about one account, shown floating so the page underneath never moves. */
export function AccountSheet({
  theme,
  provider,
  account,
  isDefault,
  isRecommended,
  busy,
  onClose,
  onRemove,
  onReconnect,
}: {
  theme: Theme;
  provider: AccountProvider;
  account: SheetAccount;
  isDefault: boolean;
  isRecommended: boolean;
  busy: boolean;
  onClose(): void;
  onRemove(): void;
  onReconnect(): void;
}) {
  const ui = useUi(theme, true);
  const c = theme.colors;
  const brand = BRAND[provider];
  const queryClient = useQueryClient();
  const getSessions = useRpc(sessionsRpc);
  const setPreferred = useRpc(setPreferredAccountRpc);
  const [listOpen, setListOpen] = useState(false);
  const [forcing, setForcing] = useState(false);
  const sessions = useQuery({ queryKey: SESSIONS_KEY, queryFn: () => getSessions({}), staleTime: 5_000 });
  const preferrer = useMutation({
    mutationFn: setPreferred,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ai-accounts"] });
      void queryClient.invalidateQueries({ queryKey: HEALTH_KEY });
      onClose();
    },
  });
  const mine = (sessions.data?.sessions ?? []).filter((session) => session.accountId === account.id);
  const running = mine.filter((session) => session.running);
  const ordered = [...running, ...mine.filter((session) => !session.running)];
  const separator = <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginHorizontal: -14 }} />;

  if (forcing) {
    return (
      <View style={{ paddingHorizontal: 14, paddingVertical: 6 }}>
        <ForceConfirmCard
          theme={theme}
          dense
          provider={provider}
          providerLabel={brand.name}
          accent={brand.accent}
          target={{ accountId: account.id, email: account.email }}
          onCancel={() => setForcing(false)}
          onStarted={onClose}
        />
      </View>
    );
  }

  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 8, gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <ProviderLogo provider={provider} size={26} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text numberOfLines={1} style={[ui.primary, { fontWeight: "600" }]}>
            {account.email}
          </Text>
          <Text numberOfLines={1} style={ui.secondary}>
            {[brand.name, isDefault ? "Default for new conversations" : null, isRecommended ? "Recommended" : null].filter(Boolean).join(" · ")}
          </Text>
        </View>
      </View>

      {account.needsReauth ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={[ui.danger, { flex: 1 }]}>The sign-in expired.</Text>
          <Button theme={theme} kind="secondary" title="Reconnect" onPress={onReconnect} />
        </View>
      ) : null}

      {account.usage.length ? (
        <View style={{ flexDirection: "row", gap: 16 }}>
          {account.usage.map((window) => {
            const hot = window.utilization >= 85;
            return (
              <View key={window.label} style={{ flex: 1, gap: 5 }}>
                <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
                  <Text style={ui.secondary}>{shortWindow(window.label)}</Text>
                  <Text style={[ui.primary, TABULAR, { fontSize: 12.5, color: hot ? c.statusDanger : c.foreground }]}>{`${Math.round(window.utilization)}%`}</Text>
                </View>
                <Meter theme={theme} value={window.utilization / 100} color={hot ? c.statusDanger : brand.accent} />
                <Text style={[ui.secondary, { fontSize: 11 }]}>{resetsAt(window.resetsAt) ? `Resets ${resetsAt(window.resetsAt)}` : "\u00a0"}</Text>
              </View>
            );
          })}
        </View>
      ) : (
        <Text style={ui.secondary}>Usage unavailable</Text>
      )}

      {separator}

      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: listOpen }}
          disabled={mine.length === 0}
          onPress={() => setListOpen(!listOpen)}
          style={[{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 2 }, mine.length ? CLICKABLE : null]}
        >
          <Text style={[ui.primary, { flex: 1 }]}>Conversations</Text>
          {sessions.isLoading ? <ActivityIndicator color={c.foregroundMuted} size="small" /> : null}
          <Text style={[ui.secondary, TABULAR]}>{mine.length ? `${running.length} running · ${mine.length - running.length} idle` : "None"}</Text>
          {mine.length ? <Chevron theme={theme} open={listOpen} /> : null}
        </Pressable>
        {listOpen
          ? ordered.map((session) => (
              <View key={session.agentId} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}>
                <View style={{ width: 10, alignItems: "center" }}>
                  <Dot color={session.running ? c.statusSuccess : c.foregroundMuted} hollow={!session.running} size={6} />
                </View>
                <Text numberOfLines={1} style={[ui.secondary, { flex: 1, color: c.foreground }]}>
                  {session.workspaceTitle && session.workspaceSessions <= 1 ? session.workspaceTitle : session.workspaceTitle ? `${session.workspaceTitle} · ${session.title}` : session.title}
                </Text>
              </View>
            ))
          : null}
      </View>

      {separator}

      <View style={{ gap: 2 }}>
        {isDefault ? (
          <OptionRow
            theme={theme}
            title="Default"
            detail="New conversations start here. Tap to follow the recommendation again."
            selected
            disabled={busy || preferrer.isPending}
            onPress={() => preferrer.mutate({ provider, accountId: null })}
          />
        ) : (
          <OptionRow
            theme={theme}
            title="Make default"
            detail="New conversations start on this account."
            disabled={busy || preferrer.isPending}
            onPress={() => preferrer.mutate({ provider, accountId: account.id })}
          />
        )}
        <OptionRow theme={theme} title="Force" detail="Make default, then pause, switch and resume every conversation." disabled={busy} onPress={() => setForcing(true)} />
      </View>

      {preferrer.error ? <Text style={ui.danger}>{preferrer.error instanceof Error ? preferrer.error.message : String(preferrer.error)}</Text> : null}

      {separator}

      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Button
          theme={theme}
          kind="destructive"
          title="Remove account"
          disabled={busy}
          onPress={() => {
            onClose();
            onRemove();
          }}
        />
      </View>
    </View>
  );
}
