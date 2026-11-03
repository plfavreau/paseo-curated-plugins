import assert from "node:assert/strict";
import { afterAll, beforeEach, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";

const scratch = await mkdtemp(join(tmpdir(), "ai-accounts-native-"));
process.env.XDG_DATA_HOME = scratch;
process.env.XDG_CONFIG_HOME = join(scratch, "config");
delete process.env.PASEO_AGENT_ID;
const originalFetch = globalThis.fetch;
const keychainWrites = [];
mock.module("../server/claude-keychain", () => ({
  hasNamespace: async () => false,
  readClaudeCredentials: async () => undefined,
  writeClaudeCredentials: async (account) => { keychainWrites.push(account.id); },
  createNamespace: async (id) => `/synthetic/claude/${id}`,
  removeNamespace: async () => {},
}));
let agents = [];
let rpcCalls = [];
let rpcResult;
mock.module("@getpaseo/client/internal/daemon-client", () => ({
  DaemonClient: class {
    isConnected = false;
    async connect() { this.isConnected = true; }
    async close() { this.isConnected = false; }
    async fetchAgents() { return { entries: agents.map((agent) => ({ agent })), pageInfo: {} }; }
    async fetchWorkspaces() { return { entries: [], pageInfo: {} }; }
    async listProviderModels() { return { models: [] }; }
    async invokePluginRpc(...args) { rpcCalls.push(args); return rpcResult; }
  },
}));
const store = await import("../server/account-store.ts");
const accounts = await import("../server/accounts.ts");
const balance = await import("../server/balance.ts");
const force = await import("../server/force-account.ts");
const { syncOpenCodePlugins } = await import("../server/opencode-shims.ts");
const { withoutPluginEntry } = await import("../server/opencode-handover.ts");
const { nativeOpenAIStatus } = await import("../server/native-openai.ts");
const { liveNativeOwnership, nativeHandoffReadiness, openCodeProcessIds } = await import("../server/native-handoff.ts");
const { prepareClaudeSession } = await import("../server/claude-session.ts");
const { wrapAuthPlugin } = await import("../opencode-auth-wrapper.ts");
const { accountStateRpc, nativeOwnershipRpc } = await import("../shared/contracts.ts");
const configDir = join(scratch, "config/opencode");
const authPath = join(scratch, "opencode/auth.json");
const storePath = join(scratch, "ai-accounts/accounts.json");
const marker = "// Written by the ai-accounts Paseo plugin; removed when its last account is.";
const legacy = (provider, id = provider) => ({ id, provider, email: `${id}@example.invalid`, access: `synthetic-${id}`, refresh: `synthetic-refresh-${id}`, expires: Date.now() + 3600000, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
const native = { type: "oauth", access: "synthetic-native", refresh: "synthetic-native-refresh", expires: Date.now() + 3600000 };
const sentinel = { type: "oauth", access: "", refresh: "", expires: 0, accountId: "ai-accounts-broker-bootstrap" };
let calls = [];
beforeEach(async () => {
  await rm(configDir, { recursive: true, force: true });
  await mkdir(join(configDir, "plugins"), { recursive: true });
  await mkdir(join(scratch, "opencode"), { recursive: true });
  await rm(authPath, { force: true });
  await store.withStore((current) => {
    for (const key of Object.keys(current)) delete current[key];
    Object.assign(current, { version: 2, accounts: [legacy("openai")], assignments: { "openai:agent": "openai" }, defaultAccountIds: { openai: "openai" }, preferredAccountIds: { openai: "openai" }, balanceSettings: { aiSort: true, housekeepingToCodex: true } });
  });
  agents = [];
  calls = [];
  rpcCalls = [];
  rpcResult = undefined;
  keychainWrites.length = 0;
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("Unexpected network request"); };
});
afterAll(async () => {
  globalThis.fetch = originalFetch;
  mock.restore();
  await rm(scratch, { recursive: true, force: true });
});

test("OpenAI UI refresh never imports, rotates, writes auth, or mutates old records", async () => {
  await writeFile(authPath, JSON.stringify({ openai: native }));
  const beforeStore = await readFile(storePath, "utf8");
  const beforeAuth = await readFile(authPath, "utf8");
  const state = await accounts.getAccountState({ provider: "openai", agentId: "agent", refreshUsage: true }, {});
  accountStateRpc.output.parse(state);
  assert.deepEqual(state.accounts, []);
  assert.equal(state.nativeOpenAI.status, "native-auth-present");
  assert.equal(state.nativeOpenAI.ownershipVersion, 1);
  assert.equal(state.activeAccountId, null);
  assert.equal(store.resolveAccount(await store.readStore(), "openai", "agent"), undefined);
  await store.migrateOpenCodeAccounts();
  await store.refreshStaleUsage((await store.readStore()).accounts);
  await store.refreshUsage("openai");
  assert.equal(await readFile(storePath, "utf8"), beforeStore);
  assert.equal(await readFile(authPath, "utf8"), beforeAuth);
  assert.deepEqual(calls, []);
  assert.deepEqual(keychainWrites, []);
});

test("sentinel, empty, missing and malformed native auth require action without restoration", async () => {
  assert.equal((await nativeOpenAIStatus()).status, "native-login-required");
  for (const value of [sentinel, { ...sentinel, access: "not-empty" }, {}, { type: "oauth", access: "", refresh: "x", expires: 1 }, { type: "api", key: "" }]) {
    const text = JSON.stringify({ openai: value, anthropic: { type: "oauth", access: "untouched" } });
    await writeFile(authPath, text);
    const status = await nativeOpenAIStatus();
    assert.equal(status.status, "native-login-required");
    assert.match(status.message, /opencode auth login/);
    assert.equal(await readFile(authPath, "utf8"), text);
  }
  await writeFile(authPath, "not JSON");
  assert.equal((await nativeOpenAIStatus()).status, "unreadable");
  assert.deepEqual(calls, []);
});

test("independent OAuth (including expired but refreshable) and API auth are preserved", async () => {
  for (const login of [native, { ...native, expires: 1 }, { type: "api", key: "synthetic-key" }]) {
    const text = JSON.stringify({ openai: login, another: { key: "synthetic-other" } });
    await writeFile(authPath, text);
    assert.equal((await nativeOpenAIStatus()).status, "native-auth-present");
    await accounts.getAccountState({ provider: "openai", refreshUsage: true }, {});
    assert.equal(await readFile(authPath, "utf8"), text);
  }
});

test("handoff CLI cannot claim readiness from disk auth without explicit retirement confirmation", async () => {
  for (const login of [sentinel, native]) {
    const text = JSON.stringify({ openai: login });
    await writeFile(authPath, text);
    const child = Bun.spawn([process.execPath, "scripts/native-handoff.mjs"], { cwd: new URL("..", import.meta.url).pathname, env: process.env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    assert.equal(await child.exited, 2);
    assert.equal(JSON.parse(output).reason, "legacy-retirement-unconfirmed");
    assert.ok(!output.includes("synthetic-native"));
    assert.equal(await readFile(authPath, "utf8"), text);
  }
});

test("Claude UI refresh polls only Claude and leaves old OpenAI records intact", async () => {
  const original = (await store.readStore()).accounts[0];
  await store.withStore((current) => current.accounts.push(legacy("anthropic")));
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    return Response.json({ five_hour: { utilization: 10, resets_at: "2026-12-01T00:00:00Z" } });
  };
  const state = await accounts.getAccountState({ provider: "anthropic", refreshUsage: true }, {});
  accountStateRpc.output.parse(state);
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].provider, "anthropic");
  assert.equal(state.nativeOpenAI, null);
  assert.equal(calls.length, 1);
  assert.deepEqual((await store.readStore()).accounts.find((account) => account.id === original.id), original);
});

test("all old OpenAI mutation and credential entry points refuse before side effects", async () => {
  const before = await readFile(storePath, "utf8");
  for (const run of [
    () => accounts.beginLogin({ provider: "openai" }),
    () => accounts.switchAccount({ provider: "openai", agentId: "agent", accountId: "openai" }),
    () => accounts.removeAccount({ provider: "openai", accountId: "openai" }),
    () => accounts.setPreferred({ provider: "openai", accountId: "openai" }),
    () => accounts.setModelPreference({ provider: "openai", modelId: "openai/gpt-5" }),
    () => store.saveAccount("openai", native),
    () => store.ensureFreshAccount("openai"),
    () => store.forceRefreshAccount("openai"),
    () => store.selectedAccount("openai"),
    () => force.planForce({ provider: "openai", accountId: "openai" }),
    () => force.startForce({ provider: "openai", accountId: "openai" }),
    () => balance.planBalance({ aiSort: true }),
    () => balance.planBalance({ housekeepingToCodex: true }),
    () => balance.startBalance({ moves: [{ agentId: "agent", accountId: "openai" }] }),
  ]) await assert.rejects(run, /native|OpenAI/);
  assert.equal(await readFile(storePath, "utf8"), before);
  assert.deepEqual(calls, []);
});

test("health, sessions and Balance exclude legacy OpenAI despite persisted old settings", async () => {
  agents = [{ id: "agent", provider: "opencode", model: "openai/gpt-5", status: "idle" }];
  const before = await readFile(storePath, "utf8");
  assert.deepEqual((await balance.getSessions({})).accounts, []);
  assert.deepEqual((await balance.getSessions({})).sessions, []);
  const plan = await balance.planBalance({});
  assert.deepEqual(plan.settings, { housekeepingToCodex: false, aiSort: false });
  assert.deepEqual(plan.moves, []);
  assert.equal((await balance.getHealth({})).moves, 0);
  assert.equal(await readFile(storePath, "utf8"), before);
  assert.deepEqual(calls, []);
});

test("startup removes only owned Codex shim, even without an installed source", async () => {
  await writeFile(authPath, JSON.stringify({ openai: native }));
  const shim = join(configDir, "plugins/ai-accounts-codex.ts");
  const claude = join(configDir, "plugins/ai-accounts-anthropic.ts");
  await writeFile(shim, `${marker}\nexport { default } from 'old';\n`);
  await writeFile(claude, "unowned Claude shim");
  await syncOpenCodePlugins(async () => undefined);
  await assert.rejects(readFile(shim), { code: "ENOENT" });
  assert.equal(await readFile(claude, "utf8"), "unowned Claude shim");
  await writeFile(shim, "// user-owned file\n");
  await syncOpenCodePlugins(async () => undefined);
  assert.equal(await readFile(shim, "utf8"), "// user-owned file\n");
});

test("startup explicitly reports a sentinel as native-login-required, without repairing it", async () => {
  const text = JSON.stringify({ openai: sentinel });
  await writeFile(authPath, text);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await syncOpenCodePlugins(async () => undefined);
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((line) => line.includes("native-login-required") && line.includes("opencode auth login")));
  assert.equal(await readFile(authPath, "utf8"), text);
  assert.deepEqual(calls, []);
});

test("sync never recreates Codex shim and preserves Claude install and records", async () => {
  await store.withStore((current) => current.accounts.push(legacy("anthropic")));
  const before = await readFile(storePath, "utf8");
  const source = join(scratch, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "opencode-plugin.ts"), "// fixture");
  await syncOpenCodePlugins(async () => source);
  assert.match(await readFile(join(configDir, "plugins/ai-accounts-anthropic.ts"), "utf8"), /opencode-plugin\.ts/);
  await assert.rejects(readFile(join(configDir, "plugins/ai-accounts-codex.ts")), { code: "ENOENT" });
  assert.equal(await readFile(storePath, "utf8"), before);
});

test("handover removes only matching plugin entries, with backup and JSONC comments intact", async () => {
  await writeFile(authPath, JSON.stringify({ openai: native }));
  const text = '{\n// opencode-openai-codex-auth is retired\n"plugin": ["other", "opencode-openai-codex-auth@1.2.3", "file:///x/ai-accounts/opencode-codex-plugin.ts", "@ex-machina/opencode-anthropic-auth"],\n"description": "opencode-openai-codex-auth",\n}';
  const path = join(configDir, "opencode.jsonc");
  await writeFile(path, text);
  await syncOpenCodePlugins(async () => undefined);
  const after = await readFile(path, "utf8");
  assert.deepEqual(parse(after).plugin, ["other", "@ex-machina/opencode-anthropic-auth"]);
  assert.equal(parse(after).description, "opencode-openai-codex-auth");
  assert.match(after, /\/\/ opencode-openai-codex-auth is retired/);
  const backups = (await readdir(configDir)).filter((name) => name.includes(".bak-ai-accounts-"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(configDir, backups[0]), "utf8"), text);
  await syncOpenCodePlugins(async () => undefined);
  assert.equal((await readdir(configDir)).filter((name) => name.includes(".bak-ai-accounts-")).length, 1);
  for (const invalid of ['{"plugin": ["opencode-openai-codex-auth"', '{"plugin":[],"plugin":["opencode-openai-codex-auth"]}']) {
    assert.equal(withoutPluginEntry(invalid, "opencode-openai-codex-auth"), invalid);
  }
});

test("missing, sentinel and unreadable auth preserve OpenAI shim/config while Claude synchronization continues", async () => {
  const shim = join(configDir, "plugins/ai-accounts-codex.ts");
  const owned = `${marker}\nexport { default } from ${JSON.stringify(new URL("../opencode-codex-plugin.ts", import.meta.url).href)};\n`;
  const path = join(configDir, "opencode.json");
  const plugins = ["other", "opencode-openai-codex-auth", "file:///x/ai-accounts/opencode-codex-plugin.ts", "@ex-machina/opencode-anthropic-auth"];
  const source = join(scratch, "claude-source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "opencode-plugin.ts"), "// fixture");
  await store.withStore((current) => current.accounts.push(legacy("anthropic")));
  const originalOpenAI = (await store.readStore()).accounts.find((account) => account.id === "openai");
  for (const auth of [undefined, JSON.stringify({ openai: sentinel }), "malformed JSON"]) {
    if (auth === undefined) await rm(authPath, { force: true });
    else await writeFile(authPath, auth);
    await writeFile(shim, owned);
    await writeFile(path, JSON.stringify({ plugin: plugins, keep: true }));
    await syncOpenCodePlugins(async () => undefined);
    assert.equal(await readFile(shim, "utf8"), owned);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).plugin, plugins);
    await syncOpenCodePlugins(async () => source);
    assert.equal(await readFile(shim, "utf8"), owned);
    // Load the actual preserved shim as a newly launched stock OpenCode process would.
    const { default: retainedEntry } = await import(pathToFileURL(shim).href);
    const hooks = await retainedEntry({ directory: scratch, client: {} });
    for (const name of ["chat.params", "chat.headers"]) {
      await assert.rejects(() => hooks[name]({ model: { providerID: "openai" } }, {}), /handoff pending/);
      const output = { headers: { keep: "unchanged" } };
      await hooks[name]({ model: { providerID: "anthropic" } }, output);
      assert.deepEqual(output, { headers: { keep: "unchanged" } });
    }
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).plugin, plugins.slice(0, -1));
    assert.match(await readFile(join(configDir, "plugins/ai-accounts-anthropic.ts"), "utf8"), /opencode-plugin\.ts/);
    if (auth !== undefined) assert.equal(await readFile(authPath, "utf8"), auth);
    assert.deepEqual((await store.readStore()).accounts.find((account) => account.id === "openai"), originalOpenAI);
  }
  assert.deepEqual(calls, []);
});

test("live ownership probe invokes only the dedicated read-only RPC and rejects older runtimes", async () => {
  await writeFile(authPath, JSON.stringify({ openai: native }));
  rpcResult = await nativeOpenAIStatus();
  const before = await readFile(storePath, "utf8");
  const result = await liveNativeOwnership();
  assert.equal(result.ownershipVersion, 1);
  assert.deepEqual(rpcCalls, [["ai-accounts", "ai-accounts.native-ownership", {}]]);
  assert.equal(nativeOwnershipRpc.name, "ai-accounts.native-ownership");
  rpcResult = { status: "native-auth-present", message: "old runtime" };
  await assert.rejects(liveNativeOwnership);
  rpcResult = { ownershipVersion: 2, status: "native-auth-present", message: "unknown version" };
  await assert.rejects(liveNativeOwnership);
  assert.equal(await readFile(storePath, "utf8"), before);
  assert.deepEqual(calls, []);
});

test("retained shim blocks fresh OpenAI until explicit post-login synchronization removes references", async () => {
  const shim = join(configDir, "plugins/ai-accounts-codex.ts");
  const entry = new URL("../opencode-codex-plugin.ts", import.meta.url).href;
  const owned = `${marker}\nexport { default } from ${JSON.stringify(entry)};\n`;
  const config = join(configDir, "opencode.json");
  await writeFile(authPath, JSON.stringify({ openai: sentinel }));
  await writeFile(shim, owned);
  await writeFile(config, JSON.stringify({ plugin: [entry, "keep"] }));
  const beforeStore = await readFile(storePath, "utf8");
  await syncOpenCodePlugins(async () => undefined);
  const { default: retained } = await import(pathToFileURL(shim).href);
  const hooks = await retained({});
  await assert.rejects(() => hooks["chat.params"]({ model: { providerID: "openai" } }, {}), /handoff pending/);
  await assert.rejects(() => hooks["chat.headers"]({ model: { providerID: "openai" } }, {}), /handoff pending/);
  // Synthetic native login does not by itself remove any references.
  const nativeText = JSON.stringify({ openai: native });
  await writeFile(authPath, nativeText);
  await nativeOpenAIStatus();
  assert.equal(await readFile(shim, "utf8"), owned);
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")).plugin, [entry, "keep"]);
  await syncOpenCodePlugins(async () => undefined);
  await assert.rejects(readFile(shim), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")).plugin, ["keep"]);
  assert.equal(await readFile(authPath, "utf8"), nativeText);
  assert.equal(await readFile(storePath, "utf8"), beforeStore);
  // An already loaded process is still guarded; cleanup does not mutate its hooks in memory.
  await assert.rejects(() => hooks["chat.params"]({ model: { providerID: "openai" } }, {}), /handoff pending/);
  assert.deepEqual(calls, []);
});

test("handoff fails closed for unconfirmed retirement, live servers, failed inventory or stale plugin", async () => {
  const ownership = { ownershipVersion: 1, status: "native-auth-present", message: "fixture" };
  let probes = 0;
  const attest = async () => { probes++; return ownership; };
  assert.equal((await nativeHandoffReadiness(false, async () => [], attest)).reason, "legacy-retirement-unconfirmed");
  assert.equal((await nativeHandoffReadiness(true, async () => [123], attest)).reason, "opencode-processes-present");
  assert.equal((await nativeHandoffReadiness(true, async () => { throw new Error("ps failed"); }, attest)).reason, "process-inspection-unavailable");
  assert.equal(probes, 0);
  for (const bad of [{ status: "native-auth-present", message: "no version" }, { ownershipVersion: 2, status: "native-auth-present", message: "future" }]) {
    assert.equal((await nativeHandoffReadiness(true, async () => [], async () => bad)).reason, "live-ownership-unattested");
  }
  assert.equal((await nativeHandoffReadiness(true, async () => [], async () => { throw new Error("unknown RPC"); })).ready, false);
  for (const status of ["native-login-required", "unreadable"]) {
    assert.equal((await nativeHandoffReadiness(true, async () => [], async () => ({ ...ownership, status }))).ready, false);
  }
  assert.equal((await nativeHandoffReadiness(true, async () => [], attest)).ready, true);
});

test("process gate detects OpenCode executables and wrappers, not opencode directories, and returns no argv", async () => {
  const pids = await openCodeProcessIds(async () => `123 /owned/bin/opencode /owned/bin/opencode serve --token secret\n124 node node /pkg/opencode/bin/opencode.js serve\n125 /opt/opencode-custom /opt/opencode-custom run\n126 /usr/bin/bun bun scripts/native-handoff.mjs\n127 node node /var/folders/T/opencode/inbox-local-control.mjs serve\n${process.pid} opencode opencode\n`);
  assert.deepEqual(pids, [123, 124, 125]);
  assert.ok(!JSON.stringify(pids).includes("secret"));
  await assert.rejects(() => openCodeProcessIds(async () => ""));
  await assert.rejects(() => openCodeProcessIds(async () => "unparseable inventory"));
});

test("scoped JSONC cleanup removes first, middle, final and duplicate entries without corrupting JSON", () => {
  for (const plugins of [
    ["opencode-openai-codex-auth"],
    ["opencode-openai-codex-auth", "keep"],
    ["keep", "opencode-openai-codex-auth"],
    ["before", "opencode-openai-codex-auth", "after"],
    ["opencode-openai-codex-auth", "opencode-openai-codex-auth"],
  ]) {
    const cleaned = withoutPluginEntry(JSON.stringify({ plugin: plugins, keep: true }), "opencode-openai-codex-auth");
    assert.deepEqual(JSON.parse(cleaned), { plugin: plugins.filter((item) => item !== "opencode-openai-codex-auth"), keep: true });
  }
  const commented = '{"plugin": ["keep", /* keep comment */ "opencode-openai-codex-auth",], "keep": true}';
  const cleaned = withoutPluginEntry(commented, "opencode-openai-codex-auth");
  assert.deepEqual(parse(cleaned), { plugin: ["keep"], keep: true });
  assert.match(cleaned, /keep comment/);
});

test("retained Codex entry initializes on stock OpenCode but blocks only OpenAI inference", async () => {
  const { default: retired } = await import("../opencode-codex-plugin.ts");
  const hooks = await retired({});
  assert.deepEqual(Object.keys(hooks).sort(), ["chat.headers", "chat.params"]);
  for (const name of ["chat.params", "chat.headers"]) {
    const output = { headers: { keep: "unchanged" }, temperature: 0.3 };
    await assert.rejects(() => hooks[name]({ model: { providerID: "openai" } }, output), /handoff pending.*reload the ai-accounts/);
    assert.deepEqual(output, { headers: { keep: "unchanged" }, temperature: 0.3 });
    for (const providerID of ["anthropic", "openrouter", "other"]) await hooks[name]({ model: { providerID } }, output);
    assert.deepEqual(output, { headers: { keep: "unchanged" }, temperature: 0.3 });
  }
  assert.deepEqual(calls, []);
});

test("Claude account selection, refresh and session preparation still use the assigned account", async () => {
  const originalOpenAI = (await store.readStore()).accounts.find((account) => account.id === "openai");
  const a = legacy("anthropic", "claude-a");
  const b = legacy("anthropic", "claude-b");
  b.expires = 0;
  await store.withStore((current) => {
    current.accounts.push(a, b);
    current.assignments["anthropic:agent"] = b.id;
  });
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(url, "https://platform.claude.com/v1/oauth/token");
    assert.equal(JSON.parse(init.body).refresh_token, b.refresh);
    return Response.json({ access_token: "synthetic-new-claude", refresh_token: "synthetic-new-refresh", expires_in: 3600 });
  };
  const request = { provider: "claude", purpose: "interactive", agentId: "agent", env: { KEEP: "yes" } };
  const prepared = await prepareClaudeSession(request);
  assert.deepEqual(prepared.env, { KEEP: "yes", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/synthetic/claude/claude-b" });
  assert.deepEqual(keychainWrites, [b.id]);
  const current = await store.readStore();
  assert.equal(current.claudeLaunches.agent, b.id);
  assert.equal(current.accounts.find((account) => account.id === b.id).access, "synthetic-new-claude");
  assert.deepEqual(current.accounts.find((account) => account.id === "openai"), originalOpenAI);
});

test("Claude wrapper still substitutes assigned auth and leaves native OpenAI session prep alone", async () => {
  const a = legacy("anthropic");
  await store.withStore((current) => { current.accounts.push(a); current.assignments["anthropic:ses_test"] = a.id; });
  let seen;
  const plugin = wrapAuthPlugin(async () => ({ auth: { loader: async (getAuth) => ({ fetch: async () => { seen = await getAuth(); return new Response("ok"); } }) } }), "anthropic");
  const hooks = await plugin({ directory: scratch, client: { session: { get: async () => ({ data: {} }) }, auth: { set: async () => { throw new Error("must stay in broker store"); } } } });
  const loaded = await hooks.auth.loader(async () => { throw new Error("must use assigned Claude account"); }, {});
  await loaded.fetch("https://example.invalid", { headers: { "x-paseo-opencode-session": "ses_test" } });
  assert.equal(seen.access, a.access);
  assert.equal(await prepareClaudeSession({ provider: "opencode", purpose: "interactive", agentId: "agent" }), undefined);
});
