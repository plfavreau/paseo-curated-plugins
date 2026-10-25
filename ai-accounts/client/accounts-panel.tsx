import type { PluginAgentPanelProps, PluginButtonContentProps, PluginScreenProps } from "@getpaseo/plugin/client";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { TextStyle, ViewStyle } from "react-native";
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  accountStateRpc,
  beginLoginRpc,
  completeLoginRpc,
  modelCatalogRpc,
  removeAccountRpc,
  reopenLoginRpc,
  setPreferredAccountRpc,
  setPreferredModelRpc,
  switchAccountRpc,
} from "../shared/contracts";
import { ForceProgressCard, useForceJob } from "./force-controls";
import { type AccountProvider, type Harness, harnessFor } from "./harness";
import { SessionsOverview } from "./sessions-overview";
import { AccountSheet } from "./account-sheet";
import { BRAND, ProviderLogo } from "./brand";
import { Button, CLICKABLE, Dropdown, FloatingLayer, Group, MenuItem, MenuSearch, Meter, SectionHead, TABULAR, Tag, useUi } from "./ui";

export { BRAND, ProviderLogo };

type AgentInfo = { id: string; status: string | null | undefined; provider: string | null | undefined; model: string | null | undefined };
/** `agent: null` is the all-sessions scope: choosing an account forces it onto every conversation. */
type AccountsViewProps = {
  theme: PluginAgentPanelProps["theme"];
  layout: PluginAgentPanelProps["layout"];
  agent: AgentInfo | null;
  variant?: "panel" | "popover";
  onCompleted?: () => void;
};
type AccountSwitchEvent = { agentId: string; provider: AccountProvider };
const accountSwitchListeners = new Set<(event: AccountSwitchEvent) => void>();

export function subscribeAccountSwitches(listener: (event: AccountSwitchEvent) => void) {
  accountSwitchListeners.add(listener);
  return () => {
    accountSwitchListeners.delete(listener);
  };
}

function notifyAccountSwitch(event: AccountSwitchEvent) {
  for (const listener of accountSwitchListeners) listener(event);
}

const LOCKED_STYLE = { opacity: 0.45, cursor: "not-allowed" } as unknown as ViewStyle;

export function shortWindow(label: string) {
  const match = /^(\d+)-(hour|day|week|month)$/.exec(label);
  if (!match) return label;
  return `${match[1]}${match[2][0]}`;
}

export function countdown(resetsAt: string | null | undefined) {
  if (!resetsAt) return null;
  const remaining = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(remaining)) return null;
  if (remaining <= 0) return "resetting";
  const minutes = Math.round(remaining / 60_000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}

// The relative "2h left" is easy to misjudge across a long response; pair it with
// the actual clock time so the reset moment is unambiguous.
export function resetClock(resetsAt: string | null | undefined) {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000);
  if (dayDiff === 0) return time;
  if (dayDiff === 1) return `tomorrow ${time}`;
  if (dayDiff === -1) return `yesterday ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

/** Fits under a 60px meter: "4pm", "2:40pm", "Tmrw 7am", "Wed 10am". */
function shortReset(resetsAt: string | null | undefined) {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const time = `${hours % 12 || 12}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}${hours < 12 ? "am" : "pm"}`;
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `Tmrw ${time}`;
  return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

function useAgentInfo(agentId: string): AgentInfo {
  const status = useAgent(agentId, (agent) => agent.status);
  const provider = useAgent(agentId, (agent) => agent.provider);
  const model = useAgent(agentId, (agent) => agent.model);
  return { id: agentId, status, provider, model };
}

export function AccountsPanel(props: PluginAgentPanelProps) {
  const agent = useAgentInfo(props.agentId);
  return <AccountsView agent={agent} layout={props.layout} theme={props.theme} onCompleted={() => props.navigation?.openAgent({ agentId: props.agentId })} />;
}

/** The sidebar screen: the same UI as the composer pill, but scoped to every session. */
export function AccountsScreen(props: PluginScreenProps) {
  return <AccountsView agent={null} layout={props.layout} theme={props.theme} />;
}

export function AccountsPopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return <AgentPopover {...props} agentId={props.agentId} />;
}

function AgentPopover(props: PluginButtonContentProps & { agentId: string }) {
  const agent = useAgentInfo(props.agentId);
  return <AccountsView agent={agent} layout={props.layout} onCompleted={props.close} theme={props.theme} variant="popover" />;
}

function AccountsView({ theme, layout, agent, variant = "panel", onCompleted }: AccountsViewProps) {
  const getState = useRpc(accountStateRpc);
  const beginLogin = useRpc(beginLoginRpc);
  const completeLogin = useRpc(completeLoginRpc);
  const switchAccount = useRpc(switchAccountRpc);
  const removeAccount = useRpc(removeAccountRpc);
  const reopenLogin = useRpc(reopenLoginRpc);
  const getModelCatalog = useRpc(modelCatalogRpc);
  const setPreferredModel = useRpc(setPreferredModelRpc);
  const setPreferredAccount = useRpc(setPreferredAccountRpc);
  const queryClient = useQueryClient();
  const agentId = agent?.id;
  const scopeKey = agentId ?? "all";
  const allSessions = agent === null;
  const harness: Harness = agent ? harnessFor({ provider: agent.provider ?? "", model: agent.model ?? null }) : { providers: ["anthropic", "openai"], current: null };
  const currentProvider = harness.current;
  // The default model only applies when an OpenCode conversation switches provider.
  const usesModelCatalog = !agent || (agent.provider ?? "").startsWith("opencode");
  const isTurnActive = agent?.status === "running" || agent?.status === "initializing";
  const popover = variant === "popover";
  const compact = layout.compact || popover;
  const [login, setLogin] = useState<{ provider: AccountProvider; flowId: string; url: string; browserOpened: boolean } | null>(null);
  const [callback, setCallback] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [reauthEmail, setReauthEmail] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const anthropicState = useQuery({
    queryKey: ["ai-accounts", "anthropic", scopeKey],
    queryFn: () => getState({ provider: "anthropic", agentId, refreshUsage: true }),
    enabled: harness.providers.includes("anthropic"),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const openaiState = useQuery({
    queryKey: ["ai-accounts", "openai", scopeKey],
    queryFn: () => getState({ provider: "openai", agentId, refreshUsage: true }),
    enabled: harness.providers.includes("openai"),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const anthropicModels = useQuery({
    queryKey: ["ai-account-models", "anthropic"],
    queryFn: () => getModelCatalog({ provider: "anthropic" }),
    enabled: usesModelCatalog && harness.providers.includes("anthropic"),
    staleTime: 5 * 60_000,
  });
  const openaiModels = useQuery({
    queryKey: ["ai-account-models", "openai"],
    queryFn: () => getModelCatalog({ provider: "openai" }),
    enabled: usesModelCatalog && harness.providers.includes("openai"),
    staleTime: 5 * 60_000,
  });
  const { running: forceRunning, visibleJob: forceJob, dismiss: dismissForceJob } = useForceJob();
  const states = { anthropic: anthropicState, openai: openaiState };
  const modelCatalogs = { anthropic: anthropicModels, openai: openaiModels };
  const refresh = (provider: AccountProvider) => queryClient.invalidateQueries({ queryKey: ["ai-accounts", provider, scopeKey] });
  const startLogin = useMutation({
    mutationFn: beginLogin,
    onSuccess: (result, variables) => {
      setLogin({ provider: variables.provider, ...result });
      setNotice(result.browserOpened ? `${BRAND[variables.provider].name} login opened in your browser.` : "Could not open your default browser. Try reopening the login.");
    },
  });
  const finishLogin = useMutation({
    mutationFn: completeLogin,
    onSuccess: (account) => {
      const provider = login?.provider;
      setLogin(null);
      setCallback("");
      setNotice(reauthEmail ? `Signed back in as ${account.email}` : `Added ${account.email}`);
      setReauthEmail(null);
      if (provider) void refresh(provider);
    },
  });
  const switcher = useMutation({
    mutationFn: switchAccount,
    onSuccess: (result, variables) => {
      const catalog = modelCatalogs[variables.provider].data;
      const model = catalog?.models.find((candidate) => candidate.id === result.modelId);
      if (result.modelId) setNotice(`Now using ${model?.label ?? result.modelId}.`);
      void Promise.all([refresh("anthropic"), refresh("openai")]);
      notifyAccountSwitch({ agentId: variables.agentId, provider: variables.provider });
      onCompleted?.();
    },
  });
  const modelSetter = useMutation({
    mutationFn: setPreferredModel,
    onSuccess: (result, variables) => {
      const catalog = modelCatalogs[variables.provider].data;
      const model = catalog?.models.find((candidate) => candidate.id === result.preferredModelId);
      queryClient.setQueryData(["ai-account-models", variables.provider], (current: typeof catalog) =>
        current ? { ...current, preferredModelId: result.preferredModelId } : current,
      );
      setNotice(`${BRAND[variables.provider].name} switches will use ${model?.label ?? result.preferredModelId}.`);
    },
  });
  const remover = useMutation({
    mutationFn: removeAccount,
    onSuccess: (_, variables) => void refresh(variables.provider),
  });
  const releaser = useMutation({
    mutationFn: setPreferredAccount,
    onSuccess: (_, variables) => void refresh(variables.provider),
  });
  const ui = useUi(theme, compact);
  const error = anthropicState.error ?? openaiState.error ?? anthropicModels.error ?? openaiModels.error ?? startLogin.error ?? finishLogin.error ?? switcher.error ?? modelSetter.error ?? remover.error ?? releaser.error;
  const busy = startLogin.isPending || finishLogin.isPending || switcher.isPending || modelSetter.isPending || remover.isPending || releaser.isPending || forceRunning;
  const pendingAccountId = switcher.isPending ? switcher.variables?.accountId : undefined;

  const c = theme.colors;

  const renderAccount = (provider: AccountProvider, account: NonNullable<(typeof states)[AccountProvider]["data"]>["accounts"][number]) => {
    const brand = BRAND[provider];
    const state = states[provider].data;
    const isCurrentProvider = currentProvider === provider;
    const isRecommended = account.id === state?.recommendedAccountId;
    const isDefault = account.id === state?.preferredAccountId;
    const isActive = !allSessions && account.isAssigned && isCurrentProvider;
    // A Claude Code process keeps the login it started with, so a pin it never restarted on does nothing yet.
    const needsRestart = isActive && (agent?.provider ?? "").startsWith("claude") && state?.launchedAccountId !== account.id;
    const canSwitch = !allSessions && (!isActive || needsRestart) && !busy && !isTurnActive;
    const reconnect = () => {
      setReauthEmail(account.email);
      startLogin.mutate({ provider });
    };
    const sheet = (close: () => void) => (
      <AccountSheet
        theme={theme}
        provider={provider}
        account={account}
        isDefault={isDefault}
        isRecommended={isRecommended}
        busy={busy}
        onClose={close}
        onRemove={() => remover.mutate({ provider, accountId: account.id })}
        onReconnect={() => {
          close();
          reconnect();
        }}
      />
    );
    const more = (open: boolean, pressed: boolean) => (
      <View style={[{ width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center" }, pressed || open ? { backgroundColor: c.surface2 } : null]}>
        <Text style={{ color: c.foregroundMuted, fontSize: 15, lineHeight: 16, fontWeight: "700" }}>⋯</Text>
      </View>
    );
    const content = (pressed: boolean, sheetOpen: boolean) => (
      <View
        style={[
          ui.row,
          !isActive && isTurnActive ? LOCKED_STYLE : null,
          !canSwitch && !allSessions && !isActive && busy ? ui.disabled : null,
          pressed || sheetOpen ? { backgroundColor: c.surface1 } : null,
        ]}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Text numberOfLines={1} style={[ui.primary, isActive ? { fontWeight: "600" } : null]}>
            {account.email}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 8, rowGap: 2 }}>
            {account.needsReauth ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Reconnect ${account.email}: its sign-in expired, this opens a login page`}
                disabled={busy}
                onPress={(event) => {
                  event.stopPropagation();
                  reconnect();
                }}
                style={[CLICKABLE, busy && ui.disabled]}
              >
                <Tag color={c.statusDanger}>Reconnect</Tag>
              </Pressable>
            ) : null}
            {needsRestart ? <Tag color={c.statusDanger}>Tap to restart on this account</Tag> : isActive ? <Tag color={c.foreground}>In use</Tag> : null}
            {isDefault ? <Tag color={c.foreground}>Default</Tag> : null}
            {isRecommended ? <Tag color={c.foregroundMuted}>Recommended</Tag> : null}
            <Text numberOfLines={1} style={[ui.secondary, { flexShrink: 1 }]}>
              {account.usage.length === 0 ? "Usage unavailable" : ""}
            </Text>
          </View>
          {account.usageError ? <Text style={ui.danger}>{account.usageError}</Text> : null}
        </View>
        {account.usage.map((window) => (
          <View key={window.label} style={{ width: compact ? 58 : 66, gap: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
              <Text style={[ui.secondary, { fontSize: 11 }]}>{shortWindow(window.label)}</Text>
              <Text style={[ui.primary, TABULAR, { fontSize: 12, color: window.utilization >= 85 ? c.statusDanger : c.foreground }]}>{`${Math.round(window.utilization)}%`}</Text>
            </View>
            <Meter theme={theme} value={window.utilization / 100} color={window.utilization >= 85 ? c.statusDanger : brand.accent} />
            <Text numberOfLines={1} style={[ui.secondary, TABULAR, { fontSize: 10, lineHeight: 12, opacity: 0.75 }]}>
              {shortReset(window.resetsAt) ?? "\u00a0"}
            </Text>
          </View>
        ))}
        {pendingAccountId === account.id || (isTurnActive && isActive) ? <ActivityIndicator color={c.foregroundMuted} size="small" /> : null}
        {allSessions ? (
          more(sheetOpen, false)
        ) : (
          <Dropdown theme={theme} width={360} maxHeight={560} accessibilityLabel={`Details for ${account.email}`} renderTrigger={more}>
            {sheet}
          </Dropdown>
        )}
      </View>
    );

    if (allSessions) {
      return (
        <Dropdown key={account.id} theme={theme} width={360} maxHeight={560} accessibilityLabel={`Details for ${account.email}`} renderTrigger={(open, pressed) => content(pressed, open)}>
          {sheet}
        </Dropdown>
      );
    }
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSwitch, selected: isActive }}
        accessibilityLabel={
          needsRestart ? `Restart this conversation on ${account.email}` : isActive ? `${account.email} is active` : isTurnActive ? "Switching is locked while this conversation is responding" : `Switch this conversation to ${brand.name} with ${account.email}`
        }
        key={account.id}
        onPress={() => {
          // Not `disabled`: that stops the row swallowing presses on some renderers,
          // which also swallows the reconnect and details buttons nested inside it.
          if (!canSwitch || !agent) return;
          switcher.mutate({ provider, agentId: agent.id, accountId: account.id });
        }}
        style={canSwitch ? CLICKABLE : null}
      >
        {({ pressed }) => content(pressed && canSwitch, false)}
      </Pressable>
    );
  };

  const body = (
    <>
      {popover ? (
        <Text style={ui.pageTitle}>Accounts</Text>
      ) : (
        <View style={{ gap: 6 }}>
          <Text style={ui.pageTitle}>AI accounts</Text>
          <Text style={ui.pageSubtitle}>
            {allSessions
              ? "Balance conversations across your subscriptions. Picking an account forces every conversation onto it: running ones are paused, switched and resumed."
              : "Each conversation keeps its own account. Pick one to switch this conversation."}
          </Text>
        </View>
      )}

      {isTurnActive ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator color={c.foregroundMuted} size="small" />
          <Text style={[ui.footnote, { paddingHorizontal: 0 }]}>Responding. Switching unlocks when this turn ends.</Text>
        </View>
      ) : null}

      {forceJob ? <ForceProgressCard theme={theme} dense={compact} job={forceJob} running={forceRunning} onDismiss={dismissForceJob} /> : null}

      {allSessions ? <SessionsOverview theme={theme} layout={layout} locked={forceRunning} /> : null}

      {harness.providers.map((provider) => {
        const brand = BRAND[provider];
        const state = states[provider];
        const modelCatalog = modelCatalogs[provider];
        const preferredModel = modelCatalog.data?.models.find((model) => model.id === modelCatalog.data.preferredModelId);
        const forcedEmail = state.data?.preferredAccountId ? state.data.accounts.find((account) => account.id === state.data?.preferredAccountId)?.email : undefined;
        return (
          <View key={provider} style={{ gap: 8 }}>
            <SectionHead theme={theme} dense={compact} title={brand.name} leading={<ProviderLogo provider={provider} size={compact ? 18 : 22} />}>
              {currentProvider === provider ? <Tag color={c.foregroundMuted}>Current</Tag> : null}
              {modelCatalog.data?.models.length ? (
              <Dropdown
                theme={theme}
                width={270}
                accessibilityLabel={`Choose the default ${brand.name} model`}
                onClose={() => setModelQuery("")}
                header={
                  <>
                    <MenuSearch theme={theme} value={modelQuery} onChange={setModelQuery} placeholder="Search models" />
                    <Text style={[ui.secondary, { fontSize: 11, paddingHorizontal: 14, paddingBottom: 5 }]}>{`Used when a conversation switches to ${brand.name}`}</Text>
                  </>
                }
                renderTrigger={(open, pressed) => (
                  <View style={[{ flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999 }, pressed || open ? { backgroundColor: c.surface2 } : null]}>
                    <Text style={[ui.label, { color: c.foreground }]}>{preferredModel?.label ?? "Choose model"}</Text>
                    <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>▾</Text>
                  </View>
                )}
              >
                {(close) => {
                  const query = modelQuery.trim().toLowerCase();
                  const models = (modelCatalog.data?.models ?? []).filter((model) => !query || `${model.label} ${model.id}`.toLowerCase().includes(query));
                  return (
                    <>
                      {modelCatalog.isLoading ? <ActivityIndicator color={brand.accent} size="small" /> : null}
                      {models.map((model) => (
                        <MenuItem
                          key={model.id}
                          theme={theme}
                          title={model.label}
                          selected={model.id === modelCatalog.data?.preferredModelId}
                          disabled={modelSetter.isPending}
                          onPress={() => {
                            close();
                            modelSetter.mutate({ provider, modelId: model.id });
                          }}
                        />
                      ))}
                      {modelCatalog.data && models.length === 0 ? <Text style={[ui.secondary, { paddingHorizontal: 14, paddingVertical: 8 }]}>No matching model</Text> : null}
                    </>
                  );
                }}
              </Dropdown>
              ) : null}
            </SectionHead>



            <Group theme={theme} dense={compact}>
              {state.isLoading ? (
                <View key="loading" style={ui.row}>
                  <ActivityIndicator color={brand.accent} size="small" />
                </View>
              ) : null}
              {(state.data?.accounts ?? []).map((account) => renderAccount(provider, account))}
            </Group>

            {state.data?.openCodeHandover ? (
              <Text style={[ui.footnote, { paddingHorizontal: 2 }]}>
                {`ai-accounts now handles your OpenCode ${brand.name} login, so it removed ${state.data.openCodeHandover.plugin} from ${state.data.openCodeHandover.config} (a backup sits next to it). Restart open OpenCode conversations.`}
              </Text>
            ) : null}
            {state.data?.exhausted && state.data.recovery ? (
              <Text style={[ui.danger, { paddingHorizontal: 2 }]}>
                {`Every ${brand.name} account is at its limit. ${state.data.recovery.email} frees up ${countdown(state.data.recovery.resetsAt) ?? "soon"}${
                  resetClock(state.data.recovery.resetsAt) ? ` (${resetClock(state.data.recovery.resetsAt)})` : ""
                }, ${state.data.recovery.label} window.`}
              </Text>
            ) : null}
<View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 2 }}>
              <Text style={[ui.footnote, { flex: 1, paddingHorizontal: 0 }]}>
                {state.data?.preferredAccountId ? `New ${brand.name} conversations start on ${forcedEmail ?? "one account"}.` : ""}
              </Text>
              {state.data?.preferredAccountId ? (
                <Button theme={theme} kind="plain" title="Release" disabled={busy} onPress={() => releaser.mutate({ provider, accountId: null })} />
              ) : null}
              <Button
                theme={theme}
                kind="secondary"
                title="Add account"
                accessibilityLabel={`Add ${brand.name} account`}
                disabled={busy}
                onPress={() => {
                  setReauthEmail(null);
                  startLogin.mutate({ provider });
                }}
              />
            </View>
          </View>
        );
      })}

      {login ? (
        <Group theme={theme} dense={compact}>
          <View key="head" style={[ui.row, { alignItems: "flex-start" }]}>
            <ProviderLogo provider={login.provider} size={22} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[ui.primary, { fontWeight: "600" }]}>{reauthEmail ? `Sign in again as ${reauthEmail}` : `Finish ${BRAND[login.provider].name} sign-in`}</Text>
              <Text style={ui.secondary}>
                {reauthEmail
                  ? "This replaces the stored tokens. The account and its conversations stay as they are."
                  : login.provider === "openai"
                    ? "After approving in ChatGPT, paste the full localhost URL from your address bar."
                    : "After approving in Claude, paste the callback URL or code#state value."}
              </Text>
              <Text style={ui.secondary}>
                {login.browserOpened ? "Opened in your Mac's browser. On your phone? Open it here instead." : "Could not open a browser on your Mac. Open it here, or copy the link."}
              </Text>
            </View>
          </View>
          <View key="routes" style={[ui.row, { gap: 14 }]}>
            <Button theme={theme} kind="secondary" title="Open here" onPress={() => void Linking.openURL(login.url)} />
            <Button theme={theme} kind="plain" title="Reopen on Mac" onPress={() => void reopenLogin({ flowId: login.flowId })} />
          </View>
          <View key="url" style={ui.row}>
            <Text selectable numberOfLines={2} style={[ui.secondary, { flex: 1 }]}>
              {login.url}
            </Text>
          </View>
          <View key="input" style={ui.row}>
            <TextInput
              accessibilityLabel={`${BRAND[login.provider].name} authorization result`}
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setCallback}
              placeholder="Paste the authorization callback"
              placeholderTextColor={c.foregroundMuted}
              style={[ui.primary, { flex: 1, paddingVertical: 4, outlineStyle: "none" } as unknown as TextStyle]}
              value={callback}
            />
          </View>
          <View key="actions" style={[ui.row, { justifyContent: "flex-end", gap: 14 }]}>
            <Button
              theme={theme}
              kind="plain"
              color={c.foregroundMuted}
              title="Cancel"
              onPress={() => {
                setLogin(null);
                setReauthEmail(null);
                setCallback("");
              }}
            />
            <Button
              theme={theme}
              kind="primary"
              title={reauthEmail ? "Restore access" : "Save account"}
              disabled={!callback.trim() || finishLogin.isPending}
              loading={finishLogin.isPending}
              onPress={() => finishLogin.mutate({ flowId: login.flowId, callback })}
            />
          </View>
        </Group>
      ) : null}

      {notice ? <Text style={[ui.footnote, { color: c.statusSuccess }]}>{notice}</Text> : null}
      {error ? <Text style={[ui.danger, { paddingHorizontal: 2 }]}>{error instanceof Error ? error.message : String(error)}</Text> : null}
    </>
  );

  const content = {
    padding: compact ? 14 : 28,
    gap: compact ? 16 : 28,
    width: popover && !layout.compact ? 400 : ("100%" as const),
    maxWidth: popover ? 400 : 720,
    alignSelf: "center" as const,
  };
  if (popover) return <FloatingLayer style={content}>{body}</FloatingLayer>;
  return (
    <ScrollView contentContainerStyle={content} style={{ flex: 1, backgroundColor: c.surface0 }}>
      {body}
    </ScrollView>
  );
}
