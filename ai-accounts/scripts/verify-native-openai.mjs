import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = await mkdtemp(join(tmpdir(), "ai-accounts-native-"));
process.env.XDG_DATA_HOME = scratch;
delete process.env.PASEO_AGENT_ID;
const originalFetch = globalThis.fetch;
const originalError = console.error;
const errors = [];
console.error = (...values) => errors.push(values.join(" "));

try {
  const store = await import("../server/account-store.ts");
  const { nativeOpenAIAccountBroker } = await import("../opencode-native-openai.ts");
  const authPath = join(scratch, "opencode", "auth.json");
  const credentials = (name) => ({ email: `${name}@example.invalid`, access: `synthetic-${name}`, refresh: `refresh-${name}`, expires: Date.now() + 3_600_000, externalAccountId: name });
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
  const first = await store.saveAccount("openai", credentials("first"));
  const bootstrap = await readFile(authPath, "utf8");
  const second = await store.saveAccount("openai", credentials("second"));
  assert.equal(await readFile(authPath, "utf8"), bootstrap);
  await rm(authPath);
  await store.migrateOpenCodeAccounts();
  assert.equal(await readFile(authPath, "utf8"), bootstrap);
  await store.withStore((current) => {
    current.assignments["openai:one"] = first.id;
    current.assignments["openai:two"] = second.id;
  });

  const client = { session: { get: async () => ({ data: {} }) } };
  for (const capabilities of [undefined, {}, { authLoaderMiddleware: false }]) {
    const unsupported = await nativeOpenAIAccountBroker({ client, directory: scratch, capabilities });
    assert.equal(unsupported.auth, undefined);
    assert.equal(unsupported["auth.loader"], undefined);
    for (const hook of ["chat.params", "chat.headers"]) {
      const output = { headers: { sentinel: "unchanged" }, temperature: 0.5 };
      await assert.rejects(unsupported[hook]({ model: { providerID: "openai" } }, output), /make opencode-native.*ONLY affected idle OpenCode processes.*Do not restart the Paseo daemon/);
      await unsupported[hook]({ model: { providerID: "anthropic" } }, output);
      assert.deepEqual(output, { headers: { sentinel: "unchanged" }, temperature: 0.5 });
    }
  }
  const hooks = await nativeOpenAIAccountBroker({ client, directory: scratch, capabilities: { authLoaderMiddleware: true } });
  assert.equal(hooks.auth, undefined);
  assert.equal(hooks.provider, undefined);
  const calls = [];
  let rejectOnce = false;
  let loaderCount = 0;
  const nativeLoader = async (getAuth) => {
    loaderCount += 1;
    await getAuth();
    const sockets = new Map();
    return {
      apiKey: "native-dummy",
      fetch: async (_url, init) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        const auth = await getAuth();
        assert.equal(auth.type, "oauth");
        assert.ok(auth.expires > Date.now());
        const session = init.headers.get("session-id");
        const affinity = init.headers.get("x-session-affinity");
        const socketKey = affinity ?? session;
        const connectedAs = sockets.get(socketKey) ?? auth.access;
        sockets.set(socketKey, connectedAs);
        assert.equal(connectedAs, auth.access, "Socket reused across credentials");
        assert.equal(init.headers.has("x-paseo-opencode-session"), false);
        calls.push({ access: auth.access, accountId: auth.accountId, body: init.body, session, affinity });
        if (rejectOnce) {
          rejectOnce = false;
          await store.withStore((current) => { current.assignments["openai:one"] = second.id; });
          return new Response(null, { status: 401 });
        }
        return new Response("ok");
      },
    };
  };
  const other = { loader: nativeLoader };
  await hooks["auth.loader"]({ providerID: "anthropic" }, other);
  assert.equal(other.loader, nativeLoader);
  const output = { loader: nativeLoader };
  await hooks["auth.loader"]({ providerID: "openai" }, output);
  const loaded = await output.loader(async () => ({ type: "oauth", ...credentials("native") }), {});
  assert.equal(loaded.apiKey, "native-dummy");
  const body = JSON.stringify({ instructions: "verbatim native instructions", tools: [{ type: "function", name: "unchanged" }], input: "hello", model: "gpt-5.5" });
  const send = (owner, session = "shared-session", affinity = "shared-affinity") => loaded.fetch("https://example.invalid/v1/responses", {
    method: "POST", body, headers: { "x-paseo-opencode-session": owner, "session-id": session, "x-session-affinity": affinity },
  });
  await Promise.all([send("one"), send("two")]);
  assert.deepEqual(new Set(calls.map((call) => call.access)), new Set([first.access, second.access]));
  assert.ok(calls.every((call) => call.body === body && call.session === "shared-session" && call.affinity === "shared-affinity"));
  assert.deepEqual(new Set(calls.map((call) => call.accountId)), new Set(["first", "second"]));
  await store.withStore((current) => { current.assignments["openai:one"] = second.id; });
  await send("one");
  assert.equal(calls.at(-1).access, second.access);
  assert.equal(loaderCount, 3);

  await store.withStore((current) => { current.assignments["openai:one"] = first.id; });
  let refreshes = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://auth.openai.com/oauth/token");
    assert.equal(init.body.get("refresh_token"), first.refresh);
    refreshes += 1;
    return Response.json({ access_token: "synthetic-first-renewed", refresh_token: "refresh-first-renewed", expires_in: 3600 });
  };
  rejectOnce = true;
  await send("one");
  assert.equal(refreshes, 1, "Freshly saved but rejected credentials must really refresh");
  assert.equal(calls.at(-2).access, first.access);
  assert.equal(calls.at(-1).access, "synthetic-first-renewed");
  assert.equal(calls.at(-1).accountId, "first");
  assert.equal((await store.readStore()).assignments["openai:one"], second.id);
  assert.equal(loaderCount, 4);
  assert.equal(await readFile(authPath, "utf8"), bootstrap, "Requests must not swap native auth");

  await store.withStore((current) => {
    current.assignments["openai:one"] = first.id;
    for (const account of current.accounts) account.expires = 0;
  });
  const renewals = new Set();
  globalThis.fetch = async (_url, init) => {
    const refresh = init.body.get("refresh_token");
    renewals.add(refresh);
    return Response.json({ access_token: `synthetic-renewed-${refresh}`, refresh_token: `${refresh}-next`, expires_in: 3600 });
  };
  await Promise.all([send("one"), send("two"), send("one")]);
  assert.equal(renewals.size, 2);
  assert.equal(calls.at(-1).body, body);
  const snapshot = await store.ensureFreshAccountById("openai", first.id);
  let forcedRefreshes = 0;
  globalThis.fetch = async () => {
    forcedRefreshes += 1;
    return Response.json({ access_token: "synthetic-deduplicated", expires_in: 3600 });
  };
  const deduplicated = await Promise.all([
    store.forceRefreshAccountById("openai", first.id, snapshot.access),
    store.forceRefreshAccountById("openai", first.id, snapshot.access),
  ]);
  assert.equal(forcedRefreshes, 1);
  assert.ok(deduplicated.every((account) => account.access === "synthetic-deduplicated"));

  const beforeFailure = calls.length;
  await store.withStore((current) => {
    current.assignments["openai:one"] = "missing";
    current.accounts.find((account) => account.id === second.id).needsReauth = "required";
  });
  await assert.rejects(send("one"), /unavailable/);
  await assert.rejects(send("two"), /requires sign-in/);
  await assert.rejects(store.ensureFreshAccountById("openai", "deleted"), /unavailable/);
  const inheritedHooks = await nativeOpenAIAccountBroker({
    client: { session: { get: async ({ path }) => ({ data: path.id === "child" ? { parentID: "one" } : {} }) } },
    directory: scratch, capabilities: { authLoaderMiddleware: true },
  });
  const inheritedOutput = { loader: nativeLoader };
  await inheritedHooks["auth.loader"]({ providerID: "openai" }, inheritedOutput);
  const inherited = await inheritedOutput.loader(async () => ({ type: "oauth", ...credentials("native") }), {});
  await assert.rejects(inherited.fetch("https://example.invalid/v1/responses", { headers: { "x-paseo-opencode-session": "child" } }), /unavailable/);
  assert.equal(calls.length, beforeFailure);
  await store.withStore((current) => {
    current.assignments["openai:one"] = first.id;
    current.accounts.find((account) => account.id === first.id).expires = 0;
  });
  globalThis.fetch = async () => new Response(null, { status: 400 });
  await assert.rejects(send("one"), /requires sign-in/);
  assert.ok((await store.readStore()).accounts.find((account) => account.id === first.id).needsReauth);
  assert.equal(calls.length, beforeFailure);
  assert.equal(errors.length, 0);
  console.log("Native broker offline verification passed: unsupported OpenAI inference blocked, Anthropic unaffected, concurrency, payload preservation, credential-isolated pools, pinned 401, fail-closed accounts, bootstrap, no credential logging.");
} finally {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  await rm(scratch, { recursive: true, force: true });
}
