import { AsyncLocalStorage } from "node:async_hooks";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { ensureFreshAccount, failOver, forceRefreshAccount, readStore, resolveAccount, type AccountProvider } from "./server/account-store";

const SESSION_HEADER = "x-paseo-opencode-session";
const MAX_ANCESTRY_DEPTH = 8;
const MAX_CACHED_CHAINS = 500;
const FAILOVER_WINDOW_MS = 10 * 60_000;
const MAX_FAILOVERS_PER_WINDOW = 4;
const DEFAULT_LIMIT_MS = 60 * 60_000;
const sessionContext = new AsyncLocalStorage<{ sessionId?: string; managed: boolean }>();
const recentFailovers = new Map<string, number[]>();
const ancestryCache = new Map<string, string[]>();

type SessionReader = Pick<PluginInput["client"], "session">;

async function parentSession(client: SessionReader, directory: string, sessionId: string): Promise<string | undefined> {
  try {
    const response = await client.session.get({ path: { id: sessionId }, query: { directory } });
    return response.data?.parentID ?? undefined;
  } catch {
    return undefined;
  }
}

async function ownerChain(client: SessionReader, directory: string): Promise<string[]> {
  const sessionId = sessionContext.getStore()?.sessionId;
  if (!sessionId) return process.env.PASEO_AGENT_ID ? [process.env.PASEO_AGENT_ID] : [];
  const cached = ancestryCache.get(sessionId);
  if (cached) return cached;
  const chain = [sessionId];
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth += 1) {
    const parent = await parentSession(client, directory, chain[chain.length - 1]);
    if (!parent || chain.includes(parent)) break;
    chain.push(parent);
  }
  if (ancestryCache.size >= MAX_CACHED_CHAINS) ancestryCache.clear();
  ancestryCache.set(sessionId, chain);
  return chain;
}

function requestSession(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers.get(SESSION_HEADER) ?? undefined;
}

function withoutSessionHeader(input: RequestInfo | URL, init?: RequestInit): [RequestInfo | URL, RequestInit | undefined] {
  const nextInit = { ...init, headers: new Headers(init?.headers) };
  nextInit.headers.delete(SESSION_HEADER);
  if (!(input instanceof Request) || !input.headers.has(SESSION_HEADER)) return [input, nextInit];
  const headers = new Headers(input.headers);
  headers.delete(SESSION_HEADER);
  return [new Request(input, { headers }), nextInit];
}

/**
 * When the plan limit is what refused the request, the time it lifts. Anthropic marks those with
 * `unified-status: rejected`; a plain rate limit leaves it unset and is better retried in place.
 */
export function planLimitLiftsAt(response: Response, now = Date.now()): string | undefined {
  if (response.status !== 429 || response.headers.get("anthropic-ratelimit-unified-status") !== "rejected") return undefined;
  const reset = Number(response.headers.get("anthropic-ratelimit-unified-reset"));
  return new Date(Number.isFinite(reset) && reset * 1000 > now ? reset * 1000 : now + DEFAULT_LIMIT_MS).toISOString();
}

function allowFailover(owner: string, now = Date.now()): boolean {
  const recent = (recentFailovers.get(owner) ?? []).filter((at) => now - at < FAILOVER_WINDOW_MS);
  if (recent.length >= MAX_FAILOVERS_PER_WINDOW) return false;
  recentFailovers.set(owner, [...recent, now]);
  return true;
}

export function wrapAuthPlugin(plugin: Plugin, provider: AccountProvider): Plugin {
  return async (input: PluginInput) => {
    const hooks = await plugin(input);
    if (!hooks.auth?.loader) return hooks;
    const loader = hooks.auth.loader;
    hooks.auth.loader = async (getAuth, providerConfig) => {
      const hasManagedAccount = async () => (await readStore()).accounts.some((account) => account.provider === provider);
      const managedAtLoad = await hasManagedAccount();
      // The vendor loader needs the OAuth type to configure its fetch adapter. OpenCode also
      // runs it during provider discovery, where no renewal or account pin should occur.
      const discoveryAuth = { type: "oauth" as const, access: "", refresh: "", expires: 0 };
      const loaded = await loader(async () => {
        const context = sessionContext.getStore();
        if (!context) return managedAtLoad ? discoveryAuth : getAuth();
        if (!context.managed) return getAuth();
        const account = await ensureFreshAccount(provider, await ownerChain(input.client, input.directory));
        if (!account || !account.access) throw new Error("The managed Claude login is no longer available");
        return { type: "oauth", access: account.access, refresh: account.refresh, expires: account.expires };
      }, providerConfig);
      if (!loaded || typeof loaded !== "object" || typeof loaded.fetch !== "function") return loaded;
      const providerFetch = loaded.fetch;
      loaded.fetch = async (requestInput: RequestInfo | URL, requestInit?: RequestInit) => {
        const sessionId = requestSession(requestInput, requestInit);
        const [sanitizedInput, sanitizedInit] = withoutSessionHeader(requestInput, requestInit);
        const managed = managedAtLoad || await hasManagedAccount();
        return sessionContext.run({ sessionId, managed }, async () => {
          let response = await providerFetch(sanitizedInput, sanitizedInit);
          if (!managed) return response;
          if (response.status === 401) {
            // The vendor rejected the token outright, regardless of what our locally recorded
            // `expires` claims (server-side revocation, a plan change, clock skew). Force a real
            // refresh and retry exactly once -- `providerFetch` re-reads auth via `getAuth` on
            // every call, so it will pick up the new credentials automatically.
            await forceRefreshAccount(provider, await ownerChain(input.client, input.directory));
            response = await providerFetch(sanitizedInput, sanitizedInit);
          }
          // Each retry goes out on the next account, so the turn carries on instead of failing.
          for (let liftsAt = planLimitLiftsAt(response); liftsAt && provider === "anthropic"; liftsAt = planLimitLiftsAt(response)) {
            const chain = await ownerChain(input.client, input.directory);
            const limited = resolveAccount(await readStore(), provider, chain);
            if (!limited || !chain[0] || !allowFailover(chain[0])) break;
            if (!(await failOver(provider, chain, limited.id, liftsAt))) break;
            await response.body?.cancel();
            response = await providerFetch(sanitizedInput, sanitizedInit);
          }
          return response;
        });
      };
      return loaded;
    };
    const chatHeaders = hooks["chat.headers"];
    hooks["chat.headers"] = async (chatInput, output) => {
      await chatHeaders?.(chatInput, output);
      output.headers[SESSION_HEADER] = chatInput.sessionID;
    };
    return hooks;
  };
}
