import { execFile } from "node:child_process";
import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
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
import {
  assignmentKey,
  migrateOpenCodeAccounts,
  readStore,
  refreshStaleUsage,
  resolveAccount,
  saveAccount,
  setPreferredAccount,
  setPreferredModel,
  type AccountProvider,
  withStore,
} from "./account-store";
import { removeNamespace } from "./claude-keychain";
import { syncOpenCodePluginsInBackground } from "./opencode-shims";
import { PLUGIN_ID, daemonUrl, paseoCliPath } from "./environment";
import { nextRecovery, normalizeUsage, recommendAccount, toRecommendationAccount } from "./recommendation";

const SESSION_ID_TTL_MS = 15_000;
const sessionIds = new Map<string, { sessionId?: string; fetchedAt: number }>();

async function agentSessionId(context: PluginHandlerContext, agentId?: string): Promise<string | undefined> {
  if (!agentId) return undefined;
  const cached = sessionIds.get(agentId);
  if (cached && Date.now() - cached.fetchedAt < SESSION_ID_TTL_MS) return cached.sessionId;
  try {
    const handle = context.paseo.agents.ref(agentId);
    await handle.refresh();
    const sessionId = handle.runtimeInfo?.sessionId ?? undefined;
    sessionIds.set(agentId, { sessionId, fetchedAt: Date.now() });
    return sessionId;
  } catch {
    return cached?.sessionId;
  }
}

const execFileAsync = promisify(execFile);
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const STABLE_CWD = homedir();
const FLAGSHIP: Record<AccountProvider, RegExp> = { anthropic: /opus/i, openai: /^openai\/gpt-\d/i };
const SMALL = /mini|nano|spark|luna|haiku|flash/i;
/** Speed tiers and dated snapshots of a model that is also listed plainly. */
const VARIANT = /-(fast|flex|ultrafast|\d{8})$/i;

function versionKey(id: string): number[] {
  return (id.match(/\d+/g) ?? []).map(Number);
}

function newerFirst(a: string, b: string): number {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (y[i] ?? -1) - (x[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/** The newest model of the wanted size in the live catalog, used until the user picks one. */
export function pickDefaultModel(provider: AccountProvider, models: { id: string }[], size: "flagship" | "small" = "flagship"): string | undefined {
  const plain = models.map((model) => model.id).filter((id) => !VARIANT.test(id));
  const sized = plain.filter((id) => (size === "small" ? SMALL.test(id) : FLAGSHIP[provider].test(id) && !SMALL.test(id)));
  return [...(sized.length > 0 ? sized : plain)].sort(newerFirst)[0];
}

export async function providerModel(provider: AccountProvider, preferred?: string): Promise<string | null> {
  if (preferred) return preferred;
  try {
    return pickDefaultModel(provider, await availableProviderModels(provider)) ?? null;
  } catch {
    return null;
  }
}

export async function availableProviderModels(provider: AccountProvider): Promise<{ id: string; label: string }[]> {
  const daemon = createDaemonClient();
  try {
    await daemon.connect();
    const result = await daemon.listProviderModels("opencode", { cwd: STABLE_CWD });
    if (result.error) throw new Error(result.error);
    return (result.models ?? [])
      .filter((model) => model.isSelectable !== false && model.id.startsWith(`${provider}/`))
      .map((model) => ({ id: model.id, label: model.label }));
  } finally {
    if (daemon.isConnected) await daemon.close();
  }
}
const pendingLogins = new Map<
  string,
  { provider: AccountProvider; verifier: string; state: string; url: string; redirectUri: string; createdAt: number }
>();

export function createDaemonClient(): DaemonClient {
  return new DaemonClient({
    url: daemonUrl(),
    clientId: `${PLUGIN_ID}-${randomUUID()}`,
    clientType: "cli",
    reconnect: { enabled: false },
  });
}

/** The CLI prints `{ error: { message } }` as JSON on failure; surface that instead of "Command failed". */
function describeCliFailure(error: unknown): string {
  const failure = error as { stdout?: string; stderr?: string; message?: string };
  for (const text of [failure.stdout, failure.stderr]) {
    if (!text) continue;
    try {
      const message = (JSON.parse(text) as { error?: { message?: string } }).error?.message;
      if (message) return message;
    } catch {
      /* not JSON */
    }
  }
  return (failure.stderr || failure.stdout || failure.message || String(error)).toString().trim().slice(0, 300);
}

/** Restarts the agent's underlying process so a Claude harness re-reads its per-account credentials. */
export async function reloadAgent(agentId: string, attempts = 1): Promise<void> {
  let failure: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await execFileAsync(paseoCliPath(), ["agent", "reload", agentId, "--json"], { cwd: STABLE_CWD, timeout: 30_000 });
      return;
    } catch (error) {
      failure = new Error(describeCliFailure(error));
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 3_000 * attempt));
    }
  }
  throw failure ?? new Error("Reload failed");
}

async function restoreAgentModel(agentId: string, modelId: string | null): Promise<void> {
  const daemon = createDaemonClient();
  try {
    await daemon.connect();
    await daemon.setAgentModel(agentId, modelId);
  } finally {
    if (daemon.isConnected) await daemon.close();
  }
}

function providerName(provider: AccountProvider): string {
  return provider === "anthropic" ? "Claude" : "Codex";
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function parseCallback(input: string): { code: string; state?: string } {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? undefined;
    if (code) return { code, state };
  } catch {}
  const [code, state] = trimmed.split("#");
  if (!code) throw new Error("Paste the full callback URL or code#state value");
  return { code, state };
}

export async function getAccountState(
  { provider, agentId, refreshUsage: shouldRefresh }: RpcInput<typeof accountStateRpc>,
  context: PluginHandlerContext,
) {
  await migrateOpenCodeAccounts();
  let store = await readStore();
  if (shouldRefresh) {
    await refreshStaleUsage(store.accounts);
    store = await readStore();
  }
  const recommended = recommendAccount(store.accounts.map(toRecommendationAccount));
  const providerAccounts = store.accounts.filter((account) => account.provider === provider);
  const ranked = providerAccounts.map(toRecommendationAccount);
  const recovery = recommendAccount(ranked) ? null : nextRecovery(ranked);
  const owners = [await agentSessionId(context, agentId), agentId].filter((key): key is string => Boolean(key));
  const activeAccountId = resolveAccount(store, provider, owners)?.id ?? null;
  const accounts = providerAccounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    email: account.email,
    plan: account.plan ?? null,
    isDefault: account.id === store.defaultAccountIds[provider],
    isAssigned: account.id === activeAccountId,
    usage: normalizeUsage(provider, account.usage),
    usageFetchedAt: account.usageFetchedAt ?? null,
    usageError: account.usageError ?? null,
    needsReauth: Boolean(account.needsReauth),
  }));
  return {
    accounts,
    activeAccountId,
    recommendedAccountId: recommended?.id ?? null,
    recommendedProvider: recommended?.provider ?? null,
    recommendationReason: recommended
      ? `${recommended.email} is furthest behind its ideal usage pace across short and weekly limits.`
      : null,
    preferredAccountId: store.preferredAccountIds?.[provider] ?? null,
    exhausted: providerAccounts.length > 0 && recovery !== null,
    recovery: recovery
      ? {
          accountId: recovery.account.id,
          email: recovery.account.email,
          label: recovery.window.label,
          resetsAt: recovery.window.resetsAt,
        }
      : null,
  };
}

export async function beginLogin({ provider }: RpcInput<typeof beginLoginRpc>) {
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(new Uint8Array(await webcrypto.subtle.digest("SHA-256", Buffer.from(verifier))));
  const state = randomUUID().replaceAll("-", "");
  const flowId = randomUUID();
  const isClaude = provider === "anthropic";
  const redirectUri = isClaude ? "https://platform.claude.com/oauth/code/callback" : "http://localhost:1455/auth/callback";
  const url = new URL(isClaude ? "https://claude.ai/oauth/authorize" : "https://auth.openai.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", isClaude ? ANTHROPIC_CLIENT_ID : OPENAI_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set(
    "scope",
    isClaude
      ? "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
      : "openid profile email offline_access",
  );
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (!isClaude) {
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", "codex_cli_rs");
  } else {
    url.searchParams.set("code", "true");
  }
  const loginUrl = url.toString();
  pendingLogins.set(flowId, { provider, verifier, state, url: loginUrl, redirectUri, createdAt: Date.now() });
  return { flowId, url: loginUrl, browserOpened: await openDefaultBrowser(loginUrl) };
}

async function openDefaultBrowser(url: string): Promise<boolean> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    await execFileAsync(command, args, { cwd: STABLE_CWD, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function reopenLogin({ flowId }: RpcInput<typeof reopenLoginRpc>) {
  const pending = pendingLogins.get(flowId);
  if (!pending || Date.now() - pending.createdAt > 10 * 60_000) throw new Error("Login expired. Start again.");
  return { browserOpened: await openDefaultBrowser(pending.url) };
}

export async function completeLogin({ flowId, callback }: RpcInput<typeof completeLoginRpc>) {
  const pending = pendingLogins.get(flowId);
  pendingLogins.delete(flowId);
  if (!pending || Date.now() - pending.createdAt > 10 * 60_000) throw new Error("Login expired. Start again.");
  const parsed = parseCallback(callback);
  if (parsed.state && parsed.state !== pending.state) throw new Error("Login state did not match");
  if (pending.provider === "anthropic" && !parsed.state) throw new Error("Claude login requires the code#state value");
  const isClaude = pending.provider === "anthropic";
  const response = await fetch(isClaude ? "https://platform.claude.com/v1/oauth/token" : "https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": isClaude ? "application/json" : "application/x-www-form-urlencoded", Accept: "application/json" },
    body: isClaude
      ? JSON.stringify({
          code: parsed.code,
          state: parsed.state,
          grant_type: "authorization_code",
          client_id: ANTHROPIC_CLIENT_ID,
          redirect_uri: pending.redirectUri,
          code_verifier: pending.verifier,
        })
      : new URLSearchParams({
          grant_type: "authorization_code",
          client_id: OPENAI_CLIENT_ID,
          code: parsed.code,
          code_verifier: pending.verifier,
          redirect_uri: pending.redirectUri,
        }),
  });
  if (!response.ok) throw new Error(`${providerName(pending.provider)} login failed (${response.status})`);
  const body = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    account?: { email?: string; email_address?: string };
  };
  const account = await saveAccount(pending.provider, {
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000,
    email: body.account?.email ?? body.account?.email_address,
  });
  syncOpenCodePluginsInBackground();
  return { accountId: account.id, email: account.email };
}

export async function switchAccount({ provider, agentId, accountId }: RpcInput<typeof switchAccountRpc>) {
  const daemon = createDaemonClient();
  let previousModelId: string | null = null;
  const store = await readStore();
  let modelId: string | null = null;
  let previousAccountId: string | undefined;
  let sessionId: string | undefined;
  let assignmentChanged = false;
  let modelChanged = false;
  try {
    await daemon.connect();
    const current = await daemon.fetchAgent(agentId);
    if (!current) throw new Error("Conversation not found");
    if (current.agent.status === "running" || current.agent.status === "initializing") {
      throw new Error("Wait for the current response to finish before switching accounts");
    }
    previousModelId = current.agent.model ?? null;
    sessionId = current.agent.runtimeInfo?.sessionId ?? undefined;
    // Only the OpenCode harness spans providers; a Claude or Codex harness keeps whatever model it runs.
    const multiProvider = (current.agent.provider ?? "").startsWith("opencode");
    modelId = multiProvider ? await providerModel(provider, store.preferredModelIds?.[provider]) : previousModelId;
    if (multiProvider && !modelId) throw new Error(`No ${providerName(provider)} model is available in OpenCode`);
    previousAccountId = await withStore((store) => {
      if (!store.accounts.some((account) => account.id === accountId && account.provider === provider)) {
        throw new Error(`${providerName(provider)} account not found`);
      }
      const previous = store.assignments[assignmentKey(provider, agentId)];
      for (const owner of [agentId, sessionId]) {
        if (owner) store.assignments[assignmentKey(provider, owner)] = accountId;
      }
      return previous;
    });
    assignmentChanged = true;
    if (modelId && previousModelId !== modelId) {
      await daemon.setAgentModel(agentId, modelId);
      modelChanged = true;
    }
    await daemon.close();
    await reloadAgent(agentId);
    return { activeAccountId: accountId, modelId, reloaded: true };
  } catch (error) {
    try {
      if (daemon.isConnected) await daemon.close();
    } catch {}
    if (assignmentChanged || modelChanged) {
      await Promise.allSettled([
        modelChanged ? restoreAgentModel(agentId, previousModelId) : Promise.resolve(),
        assignmentChanged
          ? withStore((store) => {
              for (const owner of [agentId, sessionId]) {
                if (!owner) continue;
                if (previousAccountId) store.assignments[assignmentKey(provider, owner)] = previousAccountId;
                else delete store.assignments[assignmentKey(provider, owner)];
              }
            })
          : Promise.resolve(),
      ]);
    }
    throw new Error(`Conversation switch was rolled back: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function removeAccount({ provider, accountId }: RpcInput<typeof removeAccountRpc>) {
  const result = await withStore((store) => {
    const before = store.accounts.length;
    store.accounts = store.accounts.filter((account) => account.id !== accountId || account.provider !== provider);
    for (const [agentId, assignedId] of Object.entries(store.assignments)) {
      if (assignedId === accountId) delete store.assignments[agentId];
    }
    if (store.defaultAccountIds[provider] === accountId) {
      store.defaultAccountIds[provider] = store.accounts.find((account) => account.provider === provider)?.id;
    }
    if (store.preferredAccountIds?.[provider] === accountId) delete store.preferredAccountIds[provider];
    return { removed: store.accounts.length !== before };
  });
  if (result.removed && provider === "anthropic") await removeNamespace(accountId);
  syncOpenCodePluginsInBackground();
  return result;
}

export async function setPreferred({ provider, accountId }: RpcInput<typeof setPreferredAccountRpc>) {
  await setPreferredAccount(provider, accountId);
  return { preferredAccountId: accountId };
}

export async function getModelCatalog({ provider }: RpcInput<typeof modelCatalogRpc>) {
  // A broken or missing OpenCode only hides the model picker; accounts work without it.
  const [models, store] = await Promise.all([availableProviderModels(provider).catch(() => []), readStore()]);
  const preferred = store.preferredModelIds?.[provider];
  return {
    models,
    preferredModelId: preferred && models.some((model) => model.id === preferred) ? preferred : (pickDefaultModel(provider, models) ?? null),
  };
}

export async function setModelPreference({ provider, modelId }: RpcInput<typeof setPreferredModelRpc>) {
  const models = await availableProviderModels(provider);
  if (!models.some((model) => model.id === modelId)) throw new Error(`${providerName(provider)} model not found`);
  await setPreferredModel(provider, modelId);
  return { preferredModelId: modelId };
}
