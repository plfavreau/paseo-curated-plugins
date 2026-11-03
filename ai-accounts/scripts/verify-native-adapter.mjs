import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.ok(process.env.OPENCODE_SOURCE, "Set OPENCODE_SOURCE to stock OpenCode v1.18.26 with Bun dependencies installed");
const source = resolve(process.env.OPENCODE_SOURCE);
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim(), "774cc7c1914e4329eefde5a669f938b0cf566661");
execFileSync("git", ["diff", "--exit-code", "HEAD", "--", "packages/opencode/src", "packages/plugin/src"], { cwd: source });
const scratch = await mkdtemp(join(tmpdir(), "ai-accounts-stock-"));
process.env.XDG_DATA_HOME = scratch;
process.env.XDG_CONFIG_HOME = join(scratch, "config");
const instances = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.hostname, "127.0.0.1", "Native fixture must never contact a real provider");
  return originalFetch(input, init);
};
let backend;
try {
  const { default: retired } = await import("../opencode-codex-plugin.ts");
  // The old manual entry must be safe on a completely stock PluginInput, without capabilities.
  assert.deepEqual(await retired({ directory: scratch, client: {} }), {});
  const { CodexAuthPlugin } = await import(pathToFileURL(join(source, "packages/opencode/src/plugin/openai/codex.ts")).href);
  const records = [];
  let sockets = 0;
  let refreshes = 0;
  let fallbackAttempts = 0;
  function record(transport, headers, body, socket) {
    records.push({ transport, authorization: headers.get("authorization"), identity: headers.get("chatgpt-account-id"), session: headers.get("session-id"), body, socket });
  }
  backend = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/oauth/token") {
        refreshes += 1;
        const body = new URLSearchParams(await request.text());
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), "synthetic-native-refresh");
        return Response.json({ access_token: "synthetic-native-refreshed", refresh_token: "synthetic-rotated", expires_in: 3600 });
      }
      if (request.headers.get("upgrade") === "websocket") {
        if (url.pathname === "/fallback/responses") {
          fallbackAttempts += 1;
          return new Response("Fixture rejects WebSocket upgrade", { status: 426 });
        }
        if (server.upgrade(request, { data: { headers: request.headers, socket: ++sockets } })) return;
        return new Response(null, { status: 400 });
      }
      record("http", request.headers, await request.text());
      return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_fixture"}}\n\n', { headers: { "content-type": "text/event-stream" } });
    },
    websocket: {
      message(socket, message) {
        record("ws", socket.data.headers, String(message), socket.data.socket);
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_fixture" } }));
      },
    },
  });
  let auth = { type: "oauth", access: "synthetic-native", refresh: "synthetic-native-refresh", expires: Date.now() + 3600000, accountId: "single-native-account" };
  let nativeWrites = 0;
  const input = { directory: scratch, client: { auth: { set: async ({ path, body }) => {
    assert.equal(path.id, "openai");
    nativeWrites += 1;
    auth = body;
  } } } };
  const body = JSON.stringify({ model: "gpt-5.5", stream: true, background: false, store: false,
    instructions: "Native instructions unchanged.\nAGENTS and skill guidance preserved.",
    tools: [{ type: "function", name: "fixture", description: "unchanged tool", parameters: { type: "object", properties: {}, additionalProperties: false }, strict: true }],
    input: [{ role: "user", content: [{ type: "input_text", text: "native smoke" }] }],
    reasoning: { effort: "low" } });
  async function load(websockets, path = "/backend-api/codex/responses") {
    const native = await CodexAuthPlugin(input, { issuer: backend.url.origin, codexApiEndpoint: new URL(path, backend.url).href, experimentalWebSockets: websockets });
    instances.push(native);
    assert.ok(native.auth.methods.some((method) => method.type === "oauth"), "Native login methods remain available");
    const models = { "gpt-5.5": { id: "gpt-5.5", api: { id: "gpt-5.5" }, options: {} } };
    assert.ok((await native.provider.models({ models }, { auth }))["gpt-5.5"]);
    return native.auth.loader(async () => structuredClone(auth), {});
  }
  async function send(loaded, title = false) {
    const response = await loaded.fetch("https://api.openai.com/v1/responses", {
      method: "POST", headers: { "session-id": "native-session", authorization: "Bearer placeholder", ...(title ? { "x-opencode-title": "true" } : {}) }, body,
    });
    assert.equal(response.status, 200);
    return response.text();
  }
  const http = await load(false);
  await send(http);
  assert.equal(records.at(-1).body, body);
  assert.equal(records.at(-1).authorization, "Bearer synthetic-native");
  assert.equal(nativeWrites, 0);
  const ws = await load(true);
  const start = records.length;
  await send(ws);
  await send(ws);
  const wsRecords = records.slice(start);
  assert.equal(wsRecords.length, 2);
  assert.ok(wsRecords.every((entry) => entry.transport === "ws"));
  assert.equal(new Set(wsRecords.map((entry) => entry.socket)).size, 1, "Native session pool is reused for the one native account");
  const { stream, background, ...payload } = JSON.parse(body);
  for (const record of wsRecords) assert.deepEqual(JSON.parse(record.body), { type: "response.create", ...payload });
  await send(ws, true);
  assert.equal(records.at(-1).transport, "http");
  assert.equal(records.at(-1).body, body);
  const fallback = await load(true, "/fallback/responses");
  for (let attempt = 0; attempt < 5; attempt += 1) await assert.rejects(send(fallback));
  await send(fallback);
  assert.equal(fallbackAttempts, 6);
  assert.equal(records.at(-1).transport, "http");
  assert.equal(records.at(-1).body, body);
  for (const record of records) {
    assert.equal(record.identity, "single-native-account");
    assert.equal(record.session, "native-session");
  }
  // Only stock OpenCode owns refresh and writes back the rotated credential in this fixture.
  auth.expires = 0;
  await Promise.all([send(http), send(http)]);
  assert.equal(refreshes, 1);
  assert.equal(nativeWrites, 1);
  assert.equal(auth.refresh, "synthetic-rotated");
  assert.equal(records.at(-1).authorization, "Bearer synthetic-native-refreshed");

  auth = { type: "api", key: "synthetic-api-key" };
  const api = await CodexAuthPlugin(input, { experimentalWebSockets: false });
  instances.push(api);
  assert.deepEqual(await api.auth.loader(async () => auth, {}), {});
  const models = { fixture: {} };
  assert.equal(await api.provider.models({ models }, { auth }), models);
  assert.equal(refreshes, 1);
  console.log("Stock v1.18.26 native integration passed: no middleware or broker hooks, native login/models, unchanged instructions/tools over HTTP and WebSocket, single-account pool reuse, title/failure HTTP fallback, and native-only refresh/writeback. Synthetic loopback data only.");
} finally {
  for (const native of instances) await native.dispose?.();
  await backend?.stop(true);
  globalThis.fetch = originalFetch;
  await rm(scratch, { recursive: true, force: true });
}
