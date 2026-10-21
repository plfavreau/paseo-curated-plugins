import { AsyncLocalStorage } from "node:async_hooks";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { ensureFreshAccount, forceRefreshAccount, type AccountProvider, withStore } from "./server/account-store";

const SESSION_HEADER = "x-paseo-opencode-session";
const MAX_ANCESTRY_DEPTH = 8;
const MAX_CACHED_CHAINS = 500;
const sessionContext = new AsyncLocalStorage<string>();
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
  const sessionId = sessionContext.getStore();
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

export function wrapAuthPlugin(plugin: Plugin, provider: AccountProvider): Plugin {
  return async (input: PluginInput) => {
    const client = new Proxy(input.client, {
      get(target, property, receiver) {
        if (property !== "auth") return Reflect.get(target, property, receiver);
        return new Proxy(target.auth, {
          get(authTarget, authProperty, authReceiver) {
            if (authProperty !== "set") return Reflect.get(authTarget, authProperty, authReceiver);
            return async (request: { body: { type: string; access?: string; refresh?: string; expires?: number } }) => {
              const selected = await ensureFreshAccount(provider, await ownerChain(input.client, input.directory));
              if (!selected || request.body.type !== "oauth") return authTarget.set(request as never);
              await withStore((store) => {
                const account = store.accounts.find((candidate) => candidate.id === selected.id);
                if (!account) return;
                if (request.body.access) account.access = request.body.access;
                if (request.body.refresh) account.refresh = request.body.refresh;
                if (request.body.expires) account.expires = request.body.expires;
                // The harness just refreshed this login successfully, so a re-login flag is stale.
                delete account.needsReauth;
                account.updatedAt = new Date().toISOString();
              });
            };
          },
        });
      },
    });
    const hooks = await plugin({ ...input, client });
    if (!hooks.auth?.loader) return hooks;
    const loader = hooks.auth.loader;
    hooks.auth.loader = async (getAuth, providerConfig) => {
      const loaded = await loader(async () => {
        const account = await ensureFreshAccount(provider, await ownerChain(input.client, input.directory));
        return account ? { type: "oauth", access: account.access, refresh: account.refresh, expires: account.expires } : getAuth();
      }, providerConfig);
      if (!loaded || typeof loaded !== "object" || typeof loaded.fetch !== "function") return loaded;
      const providerFetch = loaded.fetch;
      loaded.fetch = async (requestInput: RequestInfo | URL, requestInit?: RequestInit) => {
        const sessionId = requestSession(requestInput, requestInit);
        const [sanitizedInput, sanitizedInit] = withoutSessionHeader(requestInput, requestInit);
        return sessionContext.run(sessionId ?? "", async () => {
          const response = await providerFetch(sanitizedInput, sanitizedInit);
          if (response.status !== 401) return response;
          // The vendor rejected the token outright, regardless of what our locally recorded
          // `expires` claims (server-side revocation, a plan change, clock skew). Force a real
          // refresh and retry exactly once -- `providerFetch` re-reads auth via `getAuth` on
          // every call, so it will pick up the new credentials automatically.
          await forceRefreshAccount(provider, await ownerChain(input.client, input.directory));
          return providerFetch(sanitizedInput, sanitizedInit);
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
