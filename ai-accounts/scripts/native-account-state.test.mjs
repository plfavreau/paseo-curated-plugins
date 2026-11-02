import assert from "node:assert/strict";
import { afterAll, beforeEach, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = await mkdtemp(join(tmpdir(), "ai-accounts-state-"));
process.env.XDG_DATA_HOME = scratch;
process.env.XDG_CONFIG_HOME = join(scratch, "config");
delete process.env.PASEO_AGENT_ID;
const originalFetch = globalThis.fetch;
// Exercise the real remove handler without touching Paseo or installed provider shims.
mock.module("../server/opencode-shims", () => ({ syncOpenCodePluginsInBackground() {} }));
const store = await import("../server/account-store.ts");
const { getAccountState, removeAccount } = await import("../server/accounts.ts");
const { nativeOpenAIAccountBroker } = await import("../opencode-native-openai.ts");
const authPath = join(scratch, "opencode/auth.json");
const jwt = (email, id, generation = "initial") => `synthetic.${Buffer.from(JSON.stringify({
  generation,
  "https://api.openai.com/profile": { email },
  "https://api.openai.com/auth": { chatgpt_account_id: id, chatgpt_plan_type: "plus" },
})).toString("base64url")}.unsigned`;
const credentials = (id = "first", email = `${id}@example.invalid`) => ({
  access: jwt(email, id), refresh: `synthetic-refresh-${id}`, expires: Date.now() + 3_600_000,
});
const writeAuth = (openai) => writeFile(authPath, JSON.stringify({ openai, unrelated: { type: "api", key: "synthetic-unrelated" } }));
const readAuth = async () => JSON.parse(await readFile(authPath, "utf8"));

beforeEach(async () => {
  await mkdir(join(scratch, "opencode"), { recursive: true });
  await rm(authPath, { force: true });
  await store.withStore((current) => {
    current.accounts = [];
    current.assignments = {};
    current.defaultAccountIds = {};
    current.preferredAccountIds = {};
    delete current.dismissedNativeProviders;
  });
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  await rm(scratch, { recursive: true, force: true });
});

test("bootstrap contains no real tokens and cannot be reimported", async () => {
  await store.saveAccount("openai", credentials());
  const bootstrap = (await readAuth()).openai;
  assert.equal(bootstrap.type, "oauth");
  assert.equal(bootstrap.access, "");
  assert.equal(bootstrap.refresh, "");
  assert.equal(bootstrap.expires, 0);
  assert.equal(bootstrap.accountId, "ai-accounts-broker-bootstrap");
  await store.withStore((current) => { current.accounts = []; });
  assert.deepEqual(await store.migrateOpenCodeAccounts(), []);
  assert.equal((await store.readStore()).accounts.length, 0);
});

test("remove last broker account then migrate does not resurrect it", async () => {
  const account = await store.saveAccount("openai", credentials());
  await writeAuth((await readAuth()).openai);
  assert.deepEqual(await removeAccount({ provider: "openai", accountId: account.id }), { removed: true });
  assert.deepEqual(await store.migrateOpenCodeAccounts(), []);
  assert.equal((await store.readStore()).accounts.length, 0);
  assert.equal((await readAuth()).openai, undefined);
  assert.deepEqual((await readAuth()).unrelated, { type: "api", key: "synthetic-unrelated" });
});

test("removing one of several broker accounts retains non-secret activation", async () => {
  const first = await store.saveAccount("openai", credentials());
  const second = await store.saveAccount("openai", credentials("second"));
  await removeAccount({ provider: "openai", accountId: first.id });
  assert.equal((await readAuth()).openai.accountId, "ai-accounts-broker-bootstrap");
  await store.migrateOpenCodeAccounts();
  assert.deepEqual((await store.readStore()).accounts.map((account) => account.id), [second.id]);
});

test("saving and removing broker accounts preserves independent native credentials", async () => {
  for (const native of [{ type: "oauth", ...credentials("independent") }, { type: "api", key: "synthetic-native-key" }]) {
    await writeAuth(native);
    const before = await readFile(authPath, "utf8");
    const account = await store.saveAccount("openai", credentials());
    assert.equal(await readFile(authPath, "utf8"), before);
    await removeAccount({ provider: "openai", accountId: account.id });
    assert.equal(await readFile(authPath, "utf8"), before);
  }
});

test("native login replacing the sentinel is preserved when the last broker account is removed", async () => {
  const account = await store.saveAccount("openai", credentials());
  await writeAuth({ type: "oauth", ...credentials("independent") });
  const before = await readFile(authPath, "utf8");
  await removeAccount({ provider: "openai", accountId: account.id });
  assert.equal(await readFile(authPath, "utf8"), before);
});

test("migration still imports a genuine native OAuth login without overwriting it", async () => {
  await writeAuth({ type: "oauth", ...credentials("independent") });
  const before = await readFile(authPath, "utf8");
  assert.deepEqual(await store.migrateOpenCodeAccounts(), ["openai"]);
  assert.equal((await store.readStore()).accounts[0].externalAccountId, "independent");
  assert.equal(await readFile(authPath, "utf8"), before);
});

test("removing an imported native account survives accountState migration until explicit sign-in", async () => {
  const native = { type: "oauth", ...credentials("independent") };
  await writeAuth(native);
  const before = await readFile(authPath, "utf8");
  const state = () => getAccountState({ provider: "openai", refreshUsage: false }, {});
  const imported = await state();
  assert.equal(imported.accounts.length, 1);
  let sends = 0;
  const hooks = await nativeOpenAIAccountBroker({ directory: scratch, capabilities: { authLoaderMiddleware: true },
    client: { session: { get: async () => ({ data: {} }) } },
  });
  const output = { loader: async (getAuth) => ({ fetch: async () => {
    assert.equal((await getAuth()).access, native.access);
    sends += 1;
    return new Response("synthetic-native-response");
  } }) };
  await hooks["auth.loader"]({ providerID: "openai" }, output);
  const loaded = await output.loader(async () => (await readAuth()).openai, {});
  const send = () => loaded.fetch("https://example.invalid/v1/responses");
  assert.equal((await send()).status, 200);
  await removeAccount({ provider: "openai", accountId: imported.accounts[0].id });
  for (const snapshot of await Promise.all(Array.from({ length: 4 }, state))) {
    assert.deepEqual(snapshot.accounts, []);
    assert.equal(snapshot.activeAccountId, null);
  }
  assert.deepEqual(await store.migrateOpenCodeAccounts(), []);
  await assert.rejects(send(), /No OpenAI broker account/);
  assert.equal(sends, 1, "Removed identity must not reach native fetch");
  assert.equal(await readFile(authPath, "utf8"), before);
  assert.deepEqual((await store.readStore()).dismissedNativeProviders, ["openai"]);
  const signedIn = await store.saveAccount("openai", credentials("independent"));
  assert.ok(!(await store.readStore()).dismissedNativeProviders?.includes("openai"));
  assert.deepEqual((await state()).accounts.map((account) => account.id), [signedIn.id]);
  assert.equal((await send()).status, 200);
  assert.equal(sends, 2);
  await Promise.all([removeAccount({ provider: "openai", accountId: signedIn.id }), state(), state()]);
  assert.deepEqual((await state()).accounts, []);
  await assert.rejects(send(), /No OpenAI broker account/);
  assert.equal(sends, 2);
  assert.equal(await readFile(authPath, "utf8"), before);
});

test("API-mode native login rejects OpenAI hooks and fetch before any network", async () => {
  await writeAuth({ type: "api", key: "synthetic-native-key" });
  await store.saveAccount("openai", credentials());
  const before = await readFile(authPath, "utf8");
  const hooks = await nativeOpenAIAccountBroker({ directory: scratch, capabilities: { authLoaderMiddleware: true },
    client: { session: { get: async () => { throw new Error("Session lookup must not run"); } } },
  });
  for (const hook of ["chat.params", "chat.headers"]) {
    const output = { headers: { untouched: "true" } };
    assert.equal(typeof hooks[hook], "function");
    await assert.rejects(hooks[hook]({ model: { providerID: "openai" } }, output), /native ChatGPT OAuth login/);
    await hooks[hook]({ model: { providerID: "anthropic" } }, output);
    assert.deepEqual(output, { headers: { untouched: "true" } });
  }
  const nativeOptions = { apiKey: "synthetic-native-key", headers: { native: "preserved" }, fetch: async () => { throw new Error("Native fetch must not run"); } };
  const output = { loader: async () => nativeOptions };
  await hooks["auth.loader"]({ providerID: "openai" }, output);
  const apiLoaded = await output.loader(async () => ({ type: "api", key: "synthetic-native-key" }), {});
  assert.equal(apiLoaded.apiKey, nativeOptions.apiKey);
  assert.equal(apiLoaded.headers, nativeOptions.headers);
  await assert.rejects(apiLoaded.fetch("https://example.invalid/v1/responses"), /native ChatGPT OAuth login/);
  // Shared provider initialization must continue past OpenAI to Anthropic without a catch.
  const anthropicOptions = { apiKey: "synthetic-anthropic-key" };
  const anthropicLoader = async () => anthropicOptions;
  const anthropic = { loader: anthropicLoader };
  await hooks["auth.loader"]({ providerID: "anthropic" }, anthropic);
  assert.equal(anthropic.loader, anthropicLoader);
  assert.equal(await anthropic.loader(async () => ({ type: "api", key: anthropicOptions.apiKey }), {}), anthropicOptions);
  // A previously loaded OAuth adapter must still refuse if the native file switches to API mode.
  const loaded = await output.loader(async () => ({ type: "oauth", ...credentials() }), {});
  await assert.rejects(loaded.fetch("https://example.invalid/v1/responses"), /native ChatGPT OAuth login/);
  assert.equal(await readFile(authPath, "utf8"), before);
});

test("rejected broker refresh recovers only the same native identity", async () => {
  const account = await store.saveAccount("openai", credentials());
  const native = { type: "oauth", ...credentials(), access: jwt(account.email, "first", "newer-native"), refresh: "synthetic-newer-native" };
  await writeAuth(native);
  const before = await readFile(authPath, "utf8");
  const refreshes = [];
  globalThis.fetch = async (_url, init) => {
    const refresh = init.body.get("refresh_token");
    refreshes.push(refresh);
    return refresh === account.refresh ? new Response(null, { status: 400 }) : Response.json({
      access_token: jwt(account.email, "first", "recovered"), refresh_token: "synthetic-recovered", expires_in: 3600,
    });
  };
  const recovered = await store.forceRefreshAccountById("openai", account.id, account.access);
  assert.equal(recovered.id, account.id);
  assert.equal(recovered.externalAccountId, "first");
  assert.equal(recovered.refresh, "synthetic-recovered");
  assert.equal(recovered.needsReauth, undefined);
  assert.deepEqual(refreshes, [account.refresh, native.refresh]);
  assert.equal(await readFile(authPath, "utf8"), before);
});

test("different or unproven native identities cannot recover a broker account", async () => {
  const account = await store.saveAccount("openai", credentials());
  for (const access of [jwt(account.email, "other-workspace"), jwt("other@example.invalid", "first"), "synthetic-no-identity"]) {
    await store.withStore((current) => { delete current.accounts[0].needsReauth; });
    await writeAuth({ type: "oauth", access, refresh: "synthetic-other-native", expires: Date.now() + 7_200_000 });
    const before = await readFile(authPath, "utf8");
    let refreshes = 0;
    globalThis.fetch = async () => { refreshes += 1; return new Response(null, { status: 400 }); };
    await assert.rejects(store.forceRefreshAccountById("openai", account.id, account.access), /requires sign-in/);
    assert.equal(refreshes, 1, "Do not rotate a different or unproven native identity");
    const current = (await store.readStore()).accounts[0];
    assert.equal(current.access, account.access);
    assert.equal(current.externalAccountId, "first");
    assert.equal(await readFile(authPath, "utf8"), before);
  }
});

test("native recovery validates the refreshed identity, including same-email workspace changes", async () => {
  const account = await store.saveAccount("openai", credentials());
  await writeAuth({ type: "oauth", ...credentials(), refresh: "synthetic-newer-native" });
  const before = await readFile(authPath, "utf8");
  let refreshes = 0;
  globalThis.fetch = async () => {
    refreshes += 1;
    return refreshes === 1 ? new Response(null, { status: 400 }) : Response.json({
      access_token: jwt(account.email, "other-workspace", "refreshed"), refresh_token: "synthetic-other-workspace", expires_in: 3600,
    });
  };
  await assert.rejects(store.forceRefreshAccountById("openai", account.id, account.access), /requires sign-in/);
  assert.equal(refreshes, 2);
  assert.equal((await store.readStore()).accounts[0].externalAccountId, "first");
  assert.equal(await readFile(authPath, "utf8"), before);
});
