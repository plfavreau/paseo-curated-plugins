import assert from "node:assert/strict";
import { beforeEach, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Server modules freeze these paths on import; a real dir here would let tests rewrite the user's accounts.
const scratch = await mkdtemp(join(tmpdir(), "ai-accounts-failover-"));
process.env.XDG_DATA_HOME = scratch;
process.env.XDG_CONFIG_HOME = join(scratch, "config");
const { wrapAuthPlugin } = await import("../opencode-auth-wrapper.ts");

const storePath = join(scratch, "ai-accounts", "accounts.json");
const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
const usage = (utilization) => ({ five_hour: { utilization, resets_at: inAnHour }, seven_day: { utilization, resets_at: inAnHour } });
const account = (id, utilization) => ({
  id,
  provider: "anthropic",
  email: `${id}@test`,
  access: `token-${id}`,
  refresh: `refresh-${id}`,
  expires: Date.now() + 3_600_000,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  usage: usage(utilization),
  usageFetchedAt: new Date().toISOString(),
});

async function writeStore(extra = {}) {
  await mkdir(join(scratch, "ai-accounts"), { recursive: true });
  const store = {
    version: 2,
    accounts: [account("full", 40), account("roomy", 10), account("busy", 60)],
    assignments: { "anthropic:ses_1": "full" },
    defaultAccountIds: { anthropic: "full" },
    ...extra,
  };
  await writeFile(storePath, JSON.stringify(store));
}

const readStoreFile = async () => JSON.parse(await readFile(storePath, "utf8"));

/** Stands in for the Anthropic auth plugin: the vendor refuses `full` for its plan limit and serves the rest. */
const seen = [];
const vendorPlugin = async () => ({
  auth: {
    async loader(getAuth) {
      return {
        async fetch() {
          const auth = await getAuth();
          seen.push(auth.access);
          if (auth.access !== "token-full") return new Response("{}", { status: 200 });
          return new Response("{}", {
            status: 429,
            headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 7200) },
          });
        },
      };
    },
  },
});

async function send() {
  const client = { auth: {}, session: { get: async () => ({ data: { parentID: undefined } }) } };
  const hooks = await wrapAuthPlugin(vendorPlugin, "anthropic")({ client, directory: scratch });
  const loaded = await hooks.auth.loader(async () => ({ type: "oauth" }), {});
  return loaded.fetch("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}", headers: { "x-paseo-opencode-session": "ses_1" } });
}

beforeEach(() => {
  seen.length = 0;
});

test("a request refused for the plan limit is retried on the account with the most room, and the conversation stays there", async () => {
  await writeStore();
  const response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["token-full", "token-roomy"]);
  const store = await readStoreFile();
  assert.equal(store.assignments["anthropic:ses_1"], "roomy");
  assert.ok(Date.parse(store.accounts.find((a) => a.id === "full").limitedUntil) > Date.now() + 3_600_000);
  assert.deepEqual(store.failovers.map(({ owner, fromAccountId, toAccountId }) => ({ owner, fromAccountId, toAccountId })), [{ owner: "ses_1", fromAccountId: "full", toAccountId: "roomy" }]);
});

test("with automatic switching off the refusal reaches OpenCode and the pin stays", async () => {
  await writeStore({ autoSwitch: { onLimit: false, continueAfter: true } });
  const response = await send();
  assert.equal(response.status, 429);
  assert.equal((await readStoreFile()).assignments["anthropic:ses_1"], "full");
});
