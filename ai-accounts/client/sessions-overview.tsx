import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { balancePlanRpc, balanceStartRpc, sessionsRpc, setTierRpc } from "../shared/contracts";
import { BRAND, ProviderLogo } from "./brand";
import { FORCE_STATUS_KEY } from "./force-controls";
import { HEALTH_KEY, HealthPill, useHealth } from "./health-pill";
import type { AccountProvider } from "./harness";
import { Button, Check, Chevron, CLICKABLE, Dot, Group, Meter, SectionHead, TABULAR, type Theme, useUi } from "./ui";

export const SESSIONS_KEY = ["ai-accounts", "sessions"] as const;

const SHORT_NAME: Record<AccountProvider, string> = { anthropic: "Claude", openai: "Codex" };
const localPart = (email: string) => email.split("@", 1)[0];
const accountLabel = (provider: AccountProvider, email: string) => `${SHORT_NAME[provider]} ${localPart(email)}`;
/** The workspace name Paseo shows in its sidebar; the agent title only breaks ties inside a shared workspace. */
const nameOf = (session: { workspaceTitle: string | null; workspaceSessions: number; title: string }) => {
  if (!session.workspaceTitle) return session.title;
  return session.workspaceSessions > 1 ? `${session.workspaceTitle} · ${session.title}` : session.workspaceTitle;
};

export function SessionsOverview({ theme, locked }: { theme: Theme; layout: PluginScreenProps["layout"]; locked: boolean }) {
  const ui = useUi(theme);
  const c = theme.colors;
  const queryClient = useQueryClient();
  const getSessions = useRpc(sessionsRpc);
  const planBalance = useRpc(balancePlanRpc);
  const startBalance = useRpc(balanceStartRpc);
  const setTier = useRpc(setTierRpc);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [listOpen, setListOpen] = useState(false);

  const health = useHealth();
  const sessions = useQuery({ queryKey: SESSIONS_KEY, queryFn: () => getSessions({}), staleTime: 5_000, refetchInterval: 15_000 });
  const planner = useMutation({
    mutationFn: planBalance,
    // Moves are reviewed by unticking rows, so the list must be visible.
    onSuccess: (result) => {
      if (result.moves.length > 0) setListOpen(true);
    },
  });
  const runPlan = (change: { housekeepingToCodex?: boolean; aiSort?: boolean } = {}) => planner.mutate(change);
  const settings = planner.data?.settings;
  const applier = useMutation({
    mutationFn: startBalance,
    onSuccess: () => {
      planner.reset();
      void queryClient.invalidateQueries({ queryKey: FORCE_STATUS_KEY });
    },
  });
  const tierSetter = useMutation({
    mutationFn: setTier,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
      void queryClient.invalidateQueries({ queryKey: HEALTH_KEY });
      // A flipped tier changes where the conversation belongs, so an open proposal is stale.
      if (planner.data) runPlan();
    },
  });

  const data = sessions.data;
  const plan = planner.data;
  const busy = locked || applier.isPending;
  const moveOf = useMemo(() => new Map((plan?.moves ?? []).map((move) => [move.agentId, move])), [plan]);
  const chosen = (plan?.moves ?? []).filter((move) => !skipped.has(move.agentId));
  const all = data?.sessions ?? [];
  const running = all.filter((session) => session.running);
  const ordered = [...running, ...all.filter((session) => !session.running)];
  const accounts = useMemo(() => [...(data?.accounts ?? [])].sort((a, b) => a.provider.localeCompare(b.provider) || a.email.localeCompare(b.email)), [data?.accounts]);
  const afterOf = useMemo(() => new Map((plan?.accounts ?? []).map((account) => [account.accountId, account])), [plan]);
  const error = sessions.error ?? planner.error ?? applier.error ?? tierSetter.error;

  const renderSession = (session: (typeof all)[number]) => {
    const move = moveOf.get(session.agentId);
    const included = move ? !skipped.has(move.agentId) : false;
    const toggle = () => {
      if (!move) return;
      setSkipped((current) => {
        const next = new Set(current);
        if (included) next.add(move.agentId);
        else next.delete(move.agentId);
        return next;
      });
    };
    const provider = session.provider ?? "anthropic";
    const careful = session.tier === "careful";
    return (
      <Pressable
        accessibilityRole={move ? "checkbox" : "text"}
        accessibilityState={move ? { checked: included } : undefined}
        key={session.agentId}
        onPress={toggle}
        style={[ui.row, move ? CLICKABLE : null]}
      >
        <View style={{ width: 14, alignItems: "center" }}>
          <Dot color={session.running ? c.statusSuccess : c.foregroundMuted} hollow={!session.running} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text numberOfLines={1} style={[ui.primary, move && !included ? { color: c.foregroundMuted } : null]}>
            {nameOf(session)}
          </Text>
          <Text numberOfLines={1} style={ui.secondary}>
            {move ? (
              <>
                <Text style={{ textDecorationLine: included ? "line-through" : "none" }}>{accountLabel(provider, session.email ?? "?")}</Text>
                <Text style={{ color: included ? BRAND[move.toProvider].accent : c.foregroundMuted }}>{`  →  ${accountLabel(move.toProvider, move.toEmail)}`}</Text>
              </>
            ) : (
              <Text style={{ color: BRAND[provider].accent }}>{accountLabel(provider, session.email ?? "?")}</Text>
            )}
            {session.tierReason ? <Text>{`  ·  ${session.tierReason}`}</Text> : null}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Marked ${careful ? "careful work" : "housekeeping"}. Tap to mark as ${careful ? "housekeeping" : "careful work"}`}
          disabled={tierSetter.isPending || planner.isPending}
          onPress={(event) => {
            event.stopPropagation();
            tierSetter.mutate({ agentId: session.agentId, tier: careful ? "housekeeping" : "careful" });
          }}
          style={({ pressed }) => [
            { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 999, backgroundColor: c.surface2 },
            CLICKABLE,
            pressed ? { opacity: 0.7 } : null,
          ]}
        >
          <Text style={{ color: careful ? c.foreground : c.foregroundMuted, fontSize: 11, fontWeight: "500" }}>{careful ? "Careful" : "Housekeeping"}</Text>
        </Pressable>
        {move ? (
          <View style={{ width: 18, alignItems: "center" }}>{included ? <Check color={c.foreground} /> : <Dot color={c.foregroundMuted} hollow size={12} />}</View>
        ) : null}
      </Pressable>
    );
  };

  const reasons = health.data && health.data.level !== "green" ? health.data.reasons : [];

  return (
    <View style={{ gap: 8 }}>
      <SectionHead theme={theme} title="Load" leading={null}>
        {sessions.isFetching ? <ActivityIndicator color={c.foregroundMuted} size="small" /> : null}
        <HealthPill theme={theme} level={health.data?.level} />
        <Button
          theme={theme}
          kind="primary"
          title={planner.isPending ? "Planning…" : "Balance"}
          accessibilityLabel="Plan a balanced distribution of conversations across accounts"
          disabled={busy || planner.isPending || !data}
          onPress={() => {
            setSkipped(new Set());
            runPlan();
          }}
        />
      </SectionHead>

      {plan ? (
        <Group theme={theme}>
          <View key="head" style={[ui.row, { flexWrap: "wrap" }]}>
            <View style={{ flex: 1, minWidth: 180, gap: 2 }}>
              <Text style={[ui.primary, { fontWeight: "600" }]}>{plan.moves.length === 0 ? "Already balanced" : `${chosen.length} of ${plan.moves.length} moves selected`}</Text>
              {plan.notes.map((note) => (
                <Text key={note} style={ui.secondary}>
                  {note}
                </Text>
              ))}
              {plan.moves.length > 0 ? <Text style={ui.secondary}>Tap a conversation below to leave it out. Tap its tag to change its kind.</Text> : null}
              {plan.busy ? <Text style={ui.danger}>Another switch is already running.</Text> : null}
            </View>
          </View>
          <Toggle
            key="housekeeping"
            theme={theme}
            label="Send housekeeping to Codex"
            value={settings?.housekeepingToCodex ?? false}
            onChange={(value) => runPlan({ housekeepingToCodex: value })}
          />
          <Toggle
            key="ai-sort"
            theme={theme}
            label="Sort conversations with a Codex model"
            hint="One small Codex call per Balance. Off: sorted by title."
            value={settings?.aiSort ?? false}
            onChange={(value) => runPlan({ aiSort: value })}
          />
          <View key="actions" style={[ui.row, { justifyContent: "flex-end", gap: 14 }]}>
            <Button theme={theme} kind="plain" color={c.foregroundMuted} title={plan.moves.length === 0 ? "Close" : "Cancel"} onPress={() => planner.reset()} />
            {plan.moves.length > 0 ? (
              <Button
                theme={theme}
                kind="primary"
                title={`Apply ${chosen.length} move${chosen.length === 1 ? "" : "s"}`}
                disabled={busy || plan.busy || chosen.length === 0}
                onPress={() => applier.mutate({ moves: chosen.map((move) => ({ agentId: move.agentId, accountId: move.toAccountId })), releaseForced: plan.releasesForce })}
              />
            ) : null}
          </View>
        </Group>
      ) : null}

      {sessions.isLoading ? <ActivityIndicator color={c.foregroundMuted} /> : null}

      {data ? (
        <Group theme={theme}>
          {accounts.map((account) => {
            const after = plan ? afterOf.get(account.accountId) : undefined;
            const changed = after && (after.running !== account.running || after.idle !== account.idle);
            return (
              <View key={account.accountId} style={[ui.row, { flexDirection: "column", alignItems: "stretch", gap: 8 }]}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <ProviderLogo provider={account.provider} size={20} />
                  <Text numberOfLines={1} style={[ui.primary, { flex: 1 }]}>
                    {accountLabel(account.provider, account.email)}
                  </Text>
                  <Text style={[ui.secondary, TABULAR]}>
                    {changed ? `${account.running} → ${after.running} running · ${account.idle} → ${after.idle} idle` : `${account.running} running · ${account.idle} idle`}
                  </Text>
                </View>
                <Meter theme={theme} value={after?.share ?? account.share} color={BRAND[account.provider].accent} marker={account.idealShare} />
                {account.note ? <Text style={ui.danger}>{account.note}</Text> : null}
              </View>
            );
          })}
          {all.length > 0 ? (
            <Pressable key="conversations" accessibilityRole="button" accessibilityState={{ expanded: listOpen }} onPress={() => setListOpen(!listOpen)} style={[ui.row, CLICKABLE]}>
              <Text style={[ui.primary, { flex: 1 }]}>Conversations</Text>
              <Text style={[ui.secondary, TABULAR]}>{`${running.length} running · ${all.length - running.length} idle`}</Text>
              <Chevron theme={theme} open={listOpen} />
            </Pressable>
          ) : null}
          {listOpen ? ordered.map(renderSession) : null}
        </Group>
      ) : null}

      <Text style={ui.footnote}>
        {`Bars show each account's share of the load${plan ? " after the moves" : ""}; the tick marks its target.`}
        {reasons.length ? ` ${reasons.join(" ")}` : ""}
        {health.data?.guessed && reasons.length ? " Some conversations are guessed from their titles until you press Balance." : ""}
      </Text>
      {error ? <Text style={ui.danger}>{error instanceof Error ? error.message : String(error)}</Text> : null}
    </View>
  );
}

function Toggle({ theme, label, hint, value, onChange }: { theme: Theme; label: string; hint?: string; value: boolean; onChange: (value: boolean) => void }) {
  const ui = useUi(theme);
  const c = theme.colors;
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: value }} accessibilityLabel={label} onPress={() => onChange(!value)} style={[ui.row, CLICKABLE]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={ui.primary}>{label}</Text>
        {hint ? <Text style={ui.secondary}>{hint}</Text> : null}
      </View>
      <View style={{ width: 34, height: 20, borderRadius: 10, padding: 2, backgroundColor: value ? BRAND.openai.accent : c.surface2, alignItems: value ? "flex-end" : "flex-start" }}>
        <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: "#FFFFFF" }} />
      </View>
    </Pressable>
  );
}
