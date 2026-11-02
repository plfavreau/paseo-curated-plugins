import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { AuthHook, Hooks, PluginInput } from "@opencode-ai/plugin";
import { assertNativeOpenAIOAuth, ensureFreshAccountById, forceRefreshAccountById, selectedOpenAIAccount, type StoredAccount } from "./server/account-store";

type Loader = NonNullable<AuthHook["loader"]>;
type NativeHooks = Hooks & {
  "auth.loader"?: (input: { providerID: string }, output: { loader: Loader }) => Promise<void>;
};
const SESSION_HEADER = "x-paseo-opencode-session";

export async function nativeOpenAIAccountBroker(input: PluginInput & { capabilities?: { authLoaderMiddleware: true } }): Promise<NativeHooks> {
  if (!input.capabilities?.authLoaderMiddleware) {
    // OpenCode swallows initialization errors; reject inference instead of losing routing.
    const rejectUnsupportedOpenAI = async (chat: { model: { providerID: string } }) => {
      if (chat.model.providerID === "openai") {
        throw new Error("AI accounts blocked OpenAI inference: this OpenCode build lacks native auth.loader middleware support. Run `make opencode-native` from the Minitap umbrella, then restart ONLY affected idle OpenCode processes. Do not restart the Paseo daemon.");
      }
    };
    return {
      "chat.params": rejectUnsupportedOpenAI,
      "chat.headers": rejectUnsupportedOpenAI,
    };
  }
  const context = new AsyncLocalStorage<StoredAccount>();

  async function owners(sessionId?: string): Promise<string[]> {
    if (!sessionId) return process.env.PASEO_AGENT_ID ? [process.env.PASEO_AGENT_ID] : [];
    const chain = [sessionId];
    for (let depth = 0; depth < 8; depth += 1) {
      const response = await input.client.session.get({ path: { id: chain[chain.length - 1] }, query: { directory: input.directory } });
      const parent = response.data?.parentID;
      if (!parent || chain.includes(parent)) break;
      chain.push(parent);
    }
    return chain;
  }

  return {
    "chat.params": async (chat) => {
      if (chat.model.providerID === "openai") await assertNativeOpenAIOAuth();
    },
    "chat.headers": async (chat, output) => {
      if (chat.model.providerID === "openai") {
        await assertNativeOpenAIOAuth();
        output.headers[SESSION_HEADER] = chat.sessionID;
      }
    },
    "auth.loader": async ({ providerID }, output) => {
      if (providerID !== "openai") return;
      const nativeLoader = output.loader;
      output.loader = async (getAuth, provider) => {
        await assertNativeOpenAIOAuth(await getAuth());
        const loaders = new Map<string, ReturnType<Loader>>();
        const brokerAuth = async () => {
          const account = context.getStore();
          if (!account) throw new Error("Missing AI account request context");
          if (account.expires <= Date.now() + 1_000) throw new Error("Selected AI account credentials expired before native fetch");
          return { type: "oauth" as const, access: account.access, refresh: account.refresh, expires: account.expires, accountId: account.externalAccountId };
        };
        const load = (account: StoredAccount) => {
          const fingerprint = createHash("sha256").update(JSON.stringify([account.id, account.access, account.externalAccountId])).digest("hex");
          let loaded = loaders.get(fingerprint);
          if (!loaded) {
            loaded = context.run(account, () => nativeLoader(brokerAuth, provider));
            loaders.set(fingerprint, loaded);
            void loaded.catch(() => loaders.delete(fingerprint));
          }
          return loaded;
        };
        const initialLoaded = await nativeLoader(getAuth, provider);
        return {
          ...initialLoaded,
          fetch: async (requestInput: RequestInfo | URL, requestInit?: RequestInit) => {
            await assertNativeOpenAIOAuth(await getAuth());
            await assertNativeOpenAIOAuth();
            const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined);
            new Headers(requestInit?.headers).forEach((value, key) => headers.set(key, value));
            const sessionId = headers.get(SESSION_HEADER) ?? undefined;
            headers.delete(SESSION_HEADER);
            const sanitizedInput = requestInput instanceof Request
              ? new Request(requestInput, { headers })
              : requestInput;
            const sanitizedInit = { ...requestInit, headers };
            const selected = await selectedOpenAIAccount(await owners(sessionId));
            if (!selected) throw new Error("No OpenAI broker account is available");
            let account = await ensureFreshAccountById("openai", selected.id);
            const send = async () => {
              const loaded = await load(account);
              if (typeof loaded.fetch !== "function") throw new Error("Native OpenAI OAuth fetch is unavailable");
              return context.run(account, () => loaded.fetch(sanitizedInput, { ...sanitizedInit, headers: new Headers(headers) }) as Promise<Response>);
            };
            const response = await send();
            if (response.status !== 401) return response;
            await response.body?.cancel();
            account = await forceRefreshAccountById("openai", selected.id, account.access);
            return send();
          },
        };
      };
    },
  };
}
