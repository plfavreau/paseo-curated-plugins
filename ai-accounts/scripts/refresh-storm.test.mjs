import assert from "node:assert/strict";
import { afterAll, beforeEach, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test starts real, separate processes against one shared store, as Paseo does with `opencode serve`.
const scratch = await mkdtemp(join(tmpdir(), "ai-accounts-storm-"));
const storePath = join(scratch, "ai-accounts/accounts.json");
const accountStore = new URL("../server/account-store.ts", import.meta.url).pathname;
const startScript = join(scratch, "opencode-start.mjs");
await writeFile(startScript, `
const fake = process.env.FAKE_VENDOR;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.hostname !== "platform.claude.com" && url.hostname !== "api.anthropic.com") throw new Error("unexpected host " + url.hostname);
  return realFetch(fake + url.pathname, init);
};
const { ensureFreshAccount } = await import(${JSON.stringify(accountStore)});
try {
  const account = await ensureFreshAccount("anthropic", [process.env.OWNER]);
  console.log(JSON.stringify({ access: account?.access }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`);

let tokenCalls = 0;
let tokenResponse = () => Response.json({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 });
const vendor = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/v1/oauth/token") {
      tokenCalls += 1;
      await Bun.sleep(100);
      return tokenResponse(await request.json());
    }
    if (pathname === "/api/oauth/usage") return Response.json({});
    return new Response("not found", { status: 404 });
  },
});

const account = (id, expiresInMs) => ({
  id,
  provider: "anthropic",
  email: `${id}@example.invalid`,
  access: `access-${id}`,
  refresh: `refresh-${id}`,
  expires: Date.now() + expiresInMs,
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
});

async function seed(accounts, assignments = {}) {
  await mkdir(join(scratch, "ai-accounts"), { recursive: true });
  await writeFile(storePath, JSON.stringify({ version: 2, accounts, assignments, defaultAccountIds: {}, preferredAccountIds: {} }));
}

async function startOpenCode(count, owner = "ses_owner") {
  const runs = Array.from({ length: count }, async () => {
    const child = Bun.spawn(["bun", startScript], {
      env: { ...process.env, XDG_DATA_HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), FAKE_VENDOR: vendor.url.origin, OWNER: owner },
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(child.stdout).text();
    await child.exited;
    return JSON.parse(output.trim().split("\n").at(-1));
  });
  return Promise.all(runs);
}

const storedAccount = async (id) => JSON.parse(await readFile(storePath, "utf8")).accounts.find((candidate) => candidate.id === id);

beforeEach(() => {
  tokenCalls = 0;
  tokenResponse = () => Response.json({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 });
});

afterAll(async () => {
  vendor.stop(true);
  await rm(scratch, { recursive: true, force: true });
});

test("a valid stored token is reused by every process without renewing it", async () => {
  await seed([account("a", 3_600_000), account("b", 3_600_000)]);
  const results = await startOpenCode(6);
  assert.equal(tokenCalls, 0);
  for (const result of results) assert.match(result.access, /^access-/);
});

test("concurrent processes renew an expired login once and all use the renewed token", async () => {
  await seed([account("a", -1_000)]);
  const results = await startOpenCode(8);
  assert.equal(tokenCalls, 1);
  assert.deepEqual(results, Array(8).fill({ access: "renewed" }));
});

test("a token close to expiry is renewed ahead of time", async () => {
  await seed([account("a", 2 * 60_000)]);
  assert.deepEqual(await startOpenCode(1), [{ access: "renewed" }]);
  assert.equal(tokenCalls, 1);
});

test("a throttled renewal of another account backs off for every process and does not fail their start", async () => {
  tokenResponse = () => new Response("rate limited", { status: 429, headers: { "retry-after": "120" } });
  await seed([account("valid", 3_600_000), account("expired", -1_000)]);
  const results = await startOpenCode(8);
  assert.equal(tokenCalls, 1);
  assert.deepEqual(results, Array(8).fill({ access: "access-valid" }));
  const expired = await storedAccount("expired");
  assert.ok(Date.parse(expired.refreshRetryAt) >= Date.now() + 110_000);
  assert.equal(expired.needsReauth, undefined);
});

test("a throttled renewal keeps using the current token while it is still valid", async () => {
  tokenResponse = () => new Response("rate limited", { status: 429, headers: { "retry-after": "60" } });
  await seed([account("a", 2 * 60_000)]);
  assert.deepEqual(await startOpenCode(5), Array(5).fill({ access: "access-a" }));
  assert.equal(tokenCalls, 1);
});

test("a throttled renewal of the only expired login fails fast until the backoff ends, then renews", async () => {
  tokenResponse = () => new Response("rate limited", { status: 429, headers: { "retry-after": "120" } });
  await seed([account("a", -1_000)]);
  const throttled = await startOpenCode(5);
  assert.equal(tokenCalls, 1);
  for (const result of throttled) assert.match(result.error, /backing off until/);

  const stored = await storedAccount("a");
  await seed([{ ...stored, refreshRetryAt: new Date(Date.now() - 1_000).toISOString() }]);
  tokenResponse = () => Response.json({ access_token: "renewed", refresh_token: "rotated", expires_in: 28800 });
  assert.deepEqual(await startOpenCode(3), Array(3).fill({ access: "renewed" }));
  assert.equal(tokenCalls, 2);
  const renewed = await storedAccount("a");
  assert.equal(renewed.refreshRetryAt, undefined);
  assert.equal(renewed.refreshFailures, undefined);
});

test("a refused refresh token is tried once and every process asks for a new sign-in", async () => {
  tokenResponse = () => Response.json({ error: "invalid_grant" }, { status: 400 });
  await seed([account("a", -1_000)]);
  const results = await startOpenCode(6);
  assert.equal(tokenCalls, 1);
  for (const result of results) assert.match(result.error, /sign in again/);
  const stored = await storedAccount("a");
  assert.ok(stored.needsReauth);
  assert.ok(Date.parse(stored.refreshRetryAt) > Date.now() + 50 * 60_000);
});
