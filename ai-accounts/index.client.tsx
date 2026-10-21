import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginButton, PluginButtonIconProps, PluginButtonRegistration, PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { View } from "react-native";
import { HealthPill, useHealth } from "./client/health-pill";
import { AccountsPanel, AccountsPopover, AccountsScreen, countdown, subscribeAccountSwitches } from "./client/accounts-panel";
import { type AccountProvider, harnessFor } from "./client/harness";
import { accountStateRpc, setPreferredAccountRpc, USABILITY_CEILING } from "./shared/contracts";

function providerName(provider: AccountProvider): string {
  return provider === "anthropic" ? "Claude" : "Codex";
}

function compactEmail(email: string): string {
  return email.split("@", 1)[0] || email;
}

function percent(account: { usage: { utilization: number }[] }): string {
  if (!account.usage.length) return "";
  return ` ${Math.round(Math.max(...account.usage.map((window) => window.utilization)))}%`;
}

function GoodDot({ size, theme }: PluginButtonIconProps) {
  const diameter = Math.max(8, Math.round(size * 0.48));
  return <View style={{ width: diameter, height: diameter, borderRadius: diameter / 2, backgroundColor: theme.colors.statusSuccess }} />;
}

function BadDot({ size, theme }: PluginButtonIconProps) {
  const diameter = Math.max(8, Math.round(size * 0.48));
  return <View style={{ width: diameter, height: diameter, borderRadius: diameter / 2, backgroundColor: theme.colors.statusDanger }} />;
}

function SettingsSidebarItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const health = useHealth();
  return (
    <SidebarRow
      icon="UsersRound"
      active={currentScreen?.screenId === "settings"}
      onPress={() => openScreen({ screenId: "settings" })}
      trailing={<HealthPill theme={theme} level={health.data?.level} compact />}
    />
  );
}

const PILL_BEHAVIOR = { kind: "popover" as const, Content: AccountsPopover };

type PillPresentation = { title: string; label: string; icon: PluginButton["icon"] };

export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, { registration: PluginButtonRegistration; presentation: PillPresentation }>();
  const providerOverrides = new Map<string, AccountProvider>();

  client.addWorkspacePanel({
    id: "accounts",
    title: "AI accounts",
    icon: "UsersRound",
    context: "agent",
    Component: AccountsPanel,
  });
  client.addScreen({ id: "settings", title: "AI accounts", Component: AccountsScreen });
  client.addSidebarHeaderItem({ id: "settings", title: "AI accounts", Component: SettingsSidebarItem });
  client.addCommandCenterItem({
    id: "open-provider-settings",
    title: "AI accounts (all sessions)",
    icon: "UsersRound",
    keywords: ["anthropic", "openai", "claude", "codex", "account", "force", "switch", "all sessions", "subscription"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: "settings" });
    },
  });
  client.addCommandCenterItem({
    id: "open-accounts",
    title: "Claude & Codex accounts",
    icon: "UsersRound",
    keywords: ["anthropic", "openai", "usage", "subscription", "switch"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("accounts");
    },
  });

  // The new-workspace composer has no workspace or agent yet, so no pill can live there.
  // Asking for state without an agentId resolves the same way a first request will.
  let defaults: { signature: string; cleanups: PluginCleanup[] } | undefined;

  async function defaultItems() {
    const items: { id: string; title: string; icon: string; onSelect: () => void }[] = [];
    const summaries: string[] = [];

    for (const provider of ["anthropic", "openai"] as const) {
      const state = await client.rpc(accountStateRpc, { provider, refreshUsage: false });
      const name = providerName(provider);
      const active = state.accounts.find((candidate) => candidate.id === state.activeAccountId);
      if (active) summaries.push(`${name} ${compactEmail(active.email)}${percent(active)}${state.preferredAccountId ? " (forced)" : ""}`);

      for (const account of state.accounts) {
        const forced = account.id === state.preferredAccountId;
        items.push({
          id: `prefer-${account.id}`,
          title: `New sessions → ${name} ${account.email}${percent(account)}${forced ? " ✓ forced" : ""}`,
          icon: forced ? "UserRoundCheck" : "UserRound",
          onSelect: () => preferAccount(provider, forced ? null : account.id),
        });
      }

      if (state.preferredAccountId) {
        items.push({
          id: `prefer-clear-${provider}`,
          title: `New sessions → ${name}: follow the recommendation`,
          icon: "RotateCcw",
          onSelect: () => preferAccount(provider, null),
        });
      }
    }

    items.unshift({
      id: "default-accounts",
      title: summaries.length ? `A new session uses ${summaries.join(" · ")}` : "No accounts configured yet",
      icon: "UsersRound",
      onSelect: () => void syncDefaults().catch(console.error),
    });
    return items;
  }

  function preferAccount(provider: AccountProvider, accountId: string | null) {
    void client
      .rpc(setPreferredAccountRpc, { provider, accountId })
      .then(() => syncDefaults())
      .catch(console.error);
  }

  async function syncDefaults() {
    const items = await defaultItems();
    const signature = items.map((item) => `${item.id}|${item.title}|${item.icon}`).join("\n");
    if (defaults?.signature === signature) return;
    for (const cleanup of defaults?.cleanups ?? []) cleanup();
    defaults = {
      signature,
      cleanups: items.map((item) =>
        client.addCommandCenterItem({
          id: item.id,
          title: item.title,
          icon: item.icon,
          keywords: ["account", "default", "recommended", "subscription", "claude", "codex", "new session"],
          context: "global",
          onSelect: item.onSelect,
        }),
      ),
    };
  }

  async function syncPills() {
    const result = await client.paseo.agents.list();
    const seen = new Set<string>();
    await Promise.all(
      result.entries.map(async ({ agent }) => {
        const inferredProvider = harnessFor(agent).current;
        const overrideProvider = providerOverrides.get(agent.id);
        const provider = overrideProvider ?? inferredProvider;
        if (!agent.workspaceId || !provider || agent.status === "closed") return;
        if (overrideProvider === inferredProvider) providerOverrides.delete(agent.id);
        seen.add(agent.id);
        const state = await client.rpc(accountStateRpc, { provider, agentId: agent.id, refreshUsage: true });
        const active = state.accounts.find((account) => account.id === state.activeAccountId);
        const peakUtilization = active?.usage.length ? Math.max(...active.usage.map((window) => window.utilization)) : null;
        const utilization = peakUtilization !== null ? `${Math.round(peakUtilization)}%` : "—%";
        const isRecommended = active && active.id === state.recommendedAccountId;
        const blocked = peakUtilization !== null && peakUtilization >= USABILITY_CEILING;
        const showRecommendationStatus = peakUtilization !== null && peakUtilization > 40 && state.recommendedAccountId;
        const indicator = blocked ? BadDot : showRecommendationStatus ? (isRecommended ? GoodDot : BadDot) : "Gauge";
        const name = providerName(provider);
        const status = blocked
          ? ` · limit reached${state.recovery ? `, ${state.recovery.email} frees up ${countdown(state.recovery.resetsAt) ?? "soon"}` : ""}`
          : showRecommendationStatus
            ? isRecommended
              ? " · Recommended"
              : " · Better account available"
            : "";
        const presentation: PillPresentation = {
          title: active ? `${name} account: ${active.email} (${utilization} peak usage)${status}` : `Add ${name} account`,
          label: active ? `${utilization} · ${compactEmail(active.email)}` : `Add ${name} account`,
          icon: indicator,
        };
        const pill = pills.get(agent.id);
        if (!pill) {
          const registration = client.addComposerPill({
            id: `ai-account-${agent.id}`,
            workspaceId: agent.workspaceId,
            agentId: agent.id,
            button: { ...presentation, behavior: PILL_BEHAVIOR },
          });
          pills.set(agent.id, { registration, presentation });
          return;
        }
        const unchanged = pill.presentation.title === presentation.title && pill.presentation.label === presentation.label && pill.presentation.icon === presentation.icon;
        if (unchanged) return;
        pill.presentation = presentation;
        pill.registration.update(presentation);
      }),
    );
    for (const [agentId, pill] of pills) {
      if (!seen.has(agentId)) {
        pill.registration.remove();
        pills.delete(agentId);
        providerOverrides.delete(agentId);
      }
    }
  }

  function syncAll() {
    void syncPills().catch(console.error);
    void syncDefaults().catch(console.error);
  }

  syncAll();
  const unsubscribeAccountSwitches = subscribeAccountSwitches(({ agentId, provider }) => {
    providerOverrides.set(agentId, provider);
    void syncPills().catch(console.error);
  });
  const unsubscribe = client.paseo.agents.subscribe(syncAll);
  const interval = setInterval(syncAll, 60_000);
  return () => {
    clearInterval(interval);
    unsubscribeAccountSwitches();
    unsubscribe();
    for (const cleanup of defaults?.cleanups ?? []) cleanup();
    for (const pill of pills.values()) pill.registration.remove();
  };
}
