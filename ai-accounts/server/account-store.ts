import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasNamespace, readClaudeCredentials, writeClaudeCredentials } from "./claude-keychain";
import { DATA_DIR, OPENCODE_AUTH_PATH, claudeCodeUserAgent } from "./environment";
import { nextRecovery, recommendAccount, toRecommendationAccount } from "./recommendation";

const STORE_PATH = join(DATA_DIR, "accounts.json");
const LOCK_PATH = join(DATA_DIR, "accounts.lock");
const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
function anthropicHeaders() {
  return { "anthropic-beta": "oauth-2025-04-20", Accept: "application/json", "User-Agent": claudeCodeUserAgent() };
}

export type AccountProvider = "anthropic" | "openai";

export interface StoredAccount {
  id: string;
  provider: AccountProvider;
  email: string;
  access: string;
  refresh: string;
  expires: number;
  externalAccountId?: string;
  plan?: string;
  createdAt: string;
  updatedAt: string;
  usage?: unknown;
  usageFetchedAt?: string;
  usageError?: string;
  needsReauth?: string;
}

export interface Store {
  version: 2;
  accounts: StoredAccount[];
  assignments: Record<string, string>;
  defaultAccountIds: Partial<Record<AccountProvider, string>>;
  preferredAccountIds?: Partial<Record<AccountProvider, string>>;
  preferredModelIds?: Partial<Record<AccountProvider, string>>;
  /** Manual overrides of a conversation's tier; absent means it is classified automatically. */
  sessionTiers?: Record<string, "careful" | "housekeeping">;
  balanceSettings?: BalanceSettings;
}

export interface BalanceSettings {
  housekeepingToCodex: boolean;
  aiSort: boolean;
}

export const DEFAULT_BALANCE_SETTINGS: BalanceSettings = { housekeepingToCodex: false, aiSort: false };

const EMPTY_STORE: Store = { version: 2, accounts: [], assignments: {}, defaultAccountIds: {}, preferredAccountIds: {} };
const USAGE_TTL_MS = 120_000;

let usageRefresh: Promise<void> | undefined;

async function acquireLock(): Promise<() => Promise<void>> {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(LOCK_PATH, { mode: 0o700 });
      return () => rm(LOCK_PATH, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = Date.now() - (await stat(LOCK_PATH)).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (age > 30_000) await rm(LOCK_PATH, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("AI account store is busy");
}

function migrateStore(value: unknown): Store {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STORE);
  const source = value as Record<string, unknown>;
  const accounts = Array.isArray(source.accounts)
    ? source.accounts.map((account) => ({ provider: "anthropic" as const, ...(account as Omit<StoredAccount, "provider">) }))
    : [];
  if (source.version === 2) return source as unknown as Store;
  const defaultAccountId = typeof source.defaultAccountId === "string" ? source.defaultAccountId : undefined;
  return {
    version: 2,
    accounts,
    assignments: (source.assignments as Record<string, string> | undefined) ?? {},
    defaultAccountIds: defaultAccountId ? { anthropic: defaultAccountId } : {},
  };
}

async function readStoreFile(): Promise<Store> {
  try {
    return migrateStore(JSON.parse(await readFile(STORE_PATH, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STORE);
    throw error;
  }
}

async function writeStoreFile(store: Store): Promise<void> {
  const tempPath = `${STORE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(tempPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(store, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tempPath, STORE_PATH);
}

export async function withStore<T>(mutate: (store: Store) => Promise<T> | T): Promise<T> {
  const release = await acquireLock();
  try {
    const store = await readStoreFile();
    const result = await mutate(store);
    await writeStoreFile(store);
    return result;
  } finally {
    await release();
  }
}

export async function readStore(): Promise<Store> {
  await mkdir(dirname(STORE_PATH), { recursive: true, mode: 0o700 });
  return readStoreFile();
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// OpenAI access tokens are JWTs carrying their own `exp` claim; Anthropic's are opaque
// (`decodeJwt` returns {} for those, so this is a no-op there). Used to make sure the
// locally recorded `expires` is never more optimistic than what the token itself declares.
function jwtExpiryMs(token: string): number | undefined {
  const exp = decodeJwt(token).exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

function openAiIdentity(access: string): { email?: string; externalAccountId?: string; plan?: string } {
  const payload = decodeJwt(access);
  const profile = payload["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
  const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return {
    email: typeof profile?.email === "string" ? profile.email : undefined,
    externalAccountId: typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
    plan: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
  };
}

async function anthropicEmail(access: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/api/oauth/profile", {
    headers: { ...anthropicHeaders(), Authorization: `Bearer ${access}` },
  });
  if (!response.ok) throw new Error(`Claude profile request failed (${response.status})`);
  const body = (await response.json()) as { account?: { email?: string; email_address?: string } };
  const email = body.account?.email ?? body.account?.email_address;
  if (!email) throw new Error("Claude did not return an account email");
  return email;
}

export async function migrateOpenCodeAccounts(): Promise<void> {
  let auth: Record<string, unknown>;
  try {
    auth = JSON.parse(await readFile(OPENCODE_AUTH_PATH, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("Could not read OpenCode accounts:", error);
    return;
  }
  const store = await readStore();
  for (const provider of ["anthropic", "openai"] as const) {
    if (store.accounts.some((account) => account.provider === provider)) continue;
    const credential = auth[provider] as { type?: string; access?: string; refresh?: string; expires?: number; accountId?: string };
    if (credential?.type !== "oauth" || !credential.access || !credential.refresh) continue;
    try {
      await saveAccount(provider, {
        access: credential.access,
        refresh: credential.refresh,
        expires: credential.expires ?? 0,
        externalAccountId: credential.accountId,
      });
    } catch (error) {
      console.error(`Could not import the current ${provider} account:`, error);
    }
  }
}

export async function saveAccount(
  provider: AccountProvider,
  credentials: { access: string; refresh: string; expires: number; email?: string; externalAccountId?: string; plan?: string },
): Promise<StoredAccount> {
  const identity = provider === "openai" ? openAiIdentity(credentials.access) : {};
  const email = credentials.email ?? identity.email ?? (provider === "anthropic" ? await anthropicEmail(credentials.access) : undefined);
  if (!email) throw new Error("The account login did not include an email address");
  const externalAccountId = credentials.externalAccountId ?? identity.externalAccountId;
  const plan = credentials.plan ?? identity.plan;
  return withStore(async (store) => {
    const now = new Date().toISOString();
    const existing = store.accounts.find(
      (account) => account.provider === provider && account.email.toLowerCase() === email.toLowerCase() && (!externalAccountId || account.externalAccountId === externalAccountId),
    );
    const account: StoredAccount = existing ?? {
      id: randomUUID(),
      provider,
      email,
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      createdAt: now,
      updatedAt: now,
    };
    Object.assign(account, credentials, { provider, email, externalAccountId, plan, updatedAt: now });
    delete account.needsReauth;
    if (!existing) store.accounts.push(account);
    store.defaultAccountIds[provider] ??= account.id;
    if (provider === "anthropic" && (await hasNamespace(account.id))) await writeClaudeCredentials(account);
    return account;
  });
}

export type OwnerKeys = string | string[] | undefined;

export function assignmentKey(provider: AccountProvider, owner: string): string {
  return `${provider}:${owner}`;
}

function ownerChain(keys: OwnerKeys): string[] {
  const chain = typeof keys === "string" ? [keys] : (keys ?? []);
  return chain.filter((key) => key.length > 0);
}

function assignedAccount(store: Store, provider: AccountProvider, keys: OwnerKeys): StoredAccount | undefined {
  const matching = (id: string | undefined) => store.accounts.find((account) => account.id === id && account.provider === provider);
  for (const owner of ownerChain(keys)) {
    const scoped = matching(store.assignments[assignmentKey(provider, owner)]);
    if (scoped) return scoped;
    const legacy = matching(store.assignments[owner]);
    if (legacy) return legacy;
  }
  return undefined;
}

export function resolveAccount(store: Store, provider: AccountProvider, keys?: OwnerKeys): StoredAccount | undefined {
  const explicit = assignedAccount(store, provider, keys);
  if (explicit) return explicit;
  const candidates = store.accounts.filter((account) => account.provider === provider);
  if (candidates.length <= 1) return candidates[0];
  const byId = (id: string | undefined) => candidates.find((account) => account.id === id);
  // A forced account outranks the recommendation on purpose: the point is to override it.
  const forced = byId(store.preferredAccountIds?.[provider]);
  if (forced) return forced;
  const ranked = candidates.map(toRecommendationAccount);
  const healthy = byId(recommendAccount(ranked)?.id);
  if (healthy) return healthy;
  const recovering = byId(nextRecovery(ranked)?.account.id);
  if (recovering) return recovering;
  return byId(store.defaultAccountIds[provider]) ?? candidates[0];
}

export async function setPreferredAccount(provider: AccountProvider, accountId: string | null): Promise<void> {
  await withStore((store) => {
    const preferred = (store.preferredAccountIds ??= {});
    if (accountId) preferred[provider] = accountId;
    else delete preferred[provider];
  });
}

export async function setPreferredModel(provider: AccountProvider, modelId: string): Promise<void> {
  await withStore((store) => {
    (store.preferredModelIds ??= {})[provider] = modelId;
  });
}

async function pinAccount(provider: AccountProvider, owner: string, accountId: string): Promise<StoredAccount | undefined> {
  return withStore((store) => {
    const existing = assignedAccount(store, provider, owner);
    if (existing) return existing;
    const account = store.accounts.find((candidate) => candidate.id === accountId && candidate.provider === provider);
    if (account) store.assignments[assignmentKey(provider, owner)] = account.id;
    return account;
  });
}

export function usageIsStale(account: StoredAccount, now = Date.now()): boolean {
  return !account.usageFetchedAt || now - Date.parse(account.usageFetchedAt) >= USAGE_TTL_MS;
}

export async function refreshStaleUsage(accounts: StoredAccount[]): Promise<void> {
  const staleIds = accounts.filter((account) => usageIsStale(account)).map((account) => account.id);
  if (staleIds.length === 0) return;
  usageRefresh ??= Promise.all(staleIds.map(refreshUsage))
    .then(() => undefined)
    .finally(() => {
      usageRefresh = undefined;
    });
  await usageRefresh;
}

export async function selectedAccount(provider: AccountProvider, keys?: OwnerKeys): Promise<StoredAccount | undefined> {
  let store = await readStore();
  const candidates = store.accounts.filter((account) => account.provider === provider);
  if (candidates.length <= 1) return candidates[0];
  const explicit = assignedAccount(store, provider, keys);
  if (explicit) return explicit;
  await refreshStaleUsage(candidates);
  store = await readStore();
  const resolved = resolveAccount(store, provider, keys);
  const owner = ownerChain(keys)[0];
  return resolved && owner ? await pinAccount(provider, owner, resolved.id) : resolved;
}

/**
 * Claude Code rotates the refresh token when it renews inside its own keychain namespace, which would
 * strand our copy. Adopting its newer credentials before we renew keeps a single live token per account.
 */
export async function adoptClaudeRotation(account: StoredAccount): Promise<boolean> {
  if (account.provider !== "anthropic") return false;
  const external = await readClaudeCredentials(account.id);
  if (!external || external.expires <= account.expires) return false;
  account.access = external.access;
  account.refresh = external.refresh;
  account.expires = external.expires;
  account.updatedAt = new Date().toISOString();
  delete account.needsReauth;
  return true;
}

async function refreshCredentials(account: StoredAccount): Promise<void> {
  const label = account.provider === "anthropic" ? "Claude" : "Codex";
  if (await adoptClaudeRotation(account)) return;
  const response =
    account.provider === "anthropic"
      ? await fetch(ANTHROPIC_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", refresh_token: account.refresh, client_id: ANTHROPIC_CLIENT_ID }),
        })
      : await fetch(OPENAI_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: account.refresh, client_id: OPENAI_CLIENT_ID }),
        });
  if (!response.ok) {
    // A rejected refresh token never recovers on its own, so record it for the UI instead of throwing
    // and losing the flag: `withStore` only persists when the mutation returns. A rate limit (429) or
    // request timeout (408) says nothing about the token, so those stay transient errors.
    if (response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 408) {
      account.needsReauth = new Date().toISOString();
      return;
    }
    throw new Error(`${label} token refresh failed (${response.status})`);
  }
  const body = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  account.access = body.access_token;
  account.refresh = body.refresh_token ?? account.refresh;
  account.expires = Date.now() + body.expires_in * 1000;
  if (account.provider === "openai") {
    Object.assign(account, openAiIdentity(account.access));
    // Never trust `expires_in` math to be more generous than what the access token itself
    // encodes: if the two disagree, the JWT's own claim is the more authoritative one.
    const jwtExpires = jwtExpiryMs(account.access);
    if (jwtExpires) account.expires = Math.min(account.expires, jwtExpires);
  }
  account.updatedAt = new Date().toISOString();
  delete account.needsReauth;
  if (account.provider === "anthropic" && (await hasNamespace(account.id))) await writeClaudeCredentials(account);
}

/**
 * Bypasses the `expires` freshness gate entirely. Call this only when something outside the
 * locally recorded expiry already proved the token is dead -- a live 401 from the vendor, or a
 * failed usage probe -- because local `expires` can be optimistic (server-side revocation, a
 * plan change, clock skew) and `ensureFreshAccount` would otherwise never refresh in that case.
 */
export async function forceRefreshAccount(provider: AccountProvider, keys?: OwnerKeys): Promise<StoredAccount | undefined> {
  return withStore(async (store) => {
    const account = resolveAccount(store, provider, keys);
    if (!account) return account;
    // Another concurrent request may have just forced the same refresh moments ago; don't
    // rotate the vendor's refresh token again for nothing (OpenAI rotates it on every use).
    const justRefreshed = Date.now() - Date.parse(account.updatedAt) < 5_000;
    if (justRefreshed && account.expires > Date.now() + 60_000) return account;
    await refreshCredentials(account);
    return account;
  });
}

export async function ensureFreshAccount(provider: AccountProvider, keys?: OwnerKeys): Promise<StoredAccount | undefined> {
  const current = await selectedAccount(provider, keys);
  if (!current || current.expires > Date.now() + 60_000) return current;
  return withStore(async (store) => {
    const account = resolveAccount(store, provider, keys);
    if (!account || account.expires > Date.now() + 60_000) return account;
    await refreshCredentials(account);
    return account;
  });
}

export async function refreshUsage(accountId: string): Promise<void> {
  const account = await withStore(async (store) => {
    const found = store.accounts.find((candidate) => candidate.id === accountId);
    if (!found) throw new Error("AI account not found");
    if (found.expires <= Date.now() + 60_000) await refreshCredentials(found);
    return { id: found.id, provider: found.provider, access: found.access, externalAccountId: found.externalAccountId };
  });
  try {
    const response = await fetch(
      account.provider === "anthropic" ? "https://api.anthropic.com/api/oauth/usage" : "https://chatgpt.com/backend-api/wham/usage",
      {
        headers:
          account.provider === "anthropic"
            ? { ...anthropicHeaders(), Authorization: `Bearer ${account.access}` }
            : {
                Accept: "application/json",
                Authorization: `Bearer ${account.access}`,
                ...(account.externalAccountId ? { "ChatGPT-Account-Id": account.externalAccountId } : {}),
                originator: "codex_cli_rs",
              },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) {
      const authExpired = response.status === 401;
      await withStore((store) => {
        const found = store.accounts.find((candidate) => candidate.id === account.id);
        if (found) {
          found.usageFetchedAt = new Date().toISOString();
          found.usageError = `Usage request failed (${response.status})`;
          // A 401 here means the vendor already rejected this exact token: our locally
          // recorded `expires` is optimistic, so clamp it to force a real refresh on the
          // next request instead of silently repeating the same dead token forever.
          if (authExpired) found.expires = 0;
        }
      });
      return;
    }
    const usage = await response.json();
    await withStore((store) => {
      const found = store.accounts.find((candidate) => candidate.id === account.id);
      if (found) {
        found.usage = usage;
        found.usageFetchedAt = new Date().toISOString();
        delete found.usageError;
        // The vendor just accepted this exact token, so a leftover re-login flag is stale.
        delete found.needsReauth;
      }
    });
  } catch (error) {
    await withStore((store) => {
      const found = store.accounts.find((candidate) => candidate.id === account.id);
      if (found) {
        found.usageFetchedAt = new Date().toISOString();
        found.usageError = error instanceof Error ? error.message : String(error);
      }
    });
  }
}
