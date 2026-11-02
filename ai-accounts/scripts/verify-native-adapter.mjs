import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.ok(process.env.OPENCODE_SOURCE, "Set OPENCODE_SOURCE to the pinned upstream checkout (see OVERVIEW.md)");
const scratch = await mkdtemp(join(tmpdir(), "ai-accounts-adapter-"));
process.env.XDG_DATA_HOME = scratch;
delete process.env.PASEO_AGENT_ID;
const natives = [];
let backend;
try {
  const store = await import("../server/account-store.ts");
  const { default: broker } = await import("../opencode-codex-plugin.ts");
  const { CodexAuthPlugin } = await import(pathToFileURL(resolve(process.env.OPENCODE_SOURCE, "packages/opencode/src/plugin/openai/codex.ts")).href);
  const accounts = await Promise.all(["first", "second"].map((name) => store.saveAccount("openai", {
    email: `${name}@example.invalid`, access: `synthetic-${name}`, refresh: `synthetic-refresh-${name}`,
    expires: Date.now() + 3_600_000, externalAccountId: name,
  })));
  await store.withStore((current) => {
    current.assignments["openai:one"] = accounts[0].id;
    current.assignments["openai:two"] = accounts[1].id;
  });
  const authPath = join(scratch, "opencode/auth.json");
  const authBefore = await readFile(authPath, "utf8");
  const records = [];
  let sockets = 0;
  let fallbackAttempts = 0;
  function record(transport, headers, body, socket) {
    records.push({ transport, identity: headers.get("chatgpt-account-id"), authorization: headers.get("authorization"),
      internal: headers.has("x-paseo-opencode-session") || headers.has("x-opencode-title"),
      session: headers.get("session-id"), affinity: headers.get("x-session-affinity"), body, socket });
  }
  backend = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (request.headers.get("upgrade") === "websocket") {
        if (url.pathname.startsWith("/fallback/")) {
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
        setTimeout(() => socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_fixture" } })), 25);
      },
    },
  });
  const input = { directory: scratch, capabilities: { authLoaderMiddleware: true }, client: {
    session: { get: async () => ({ data: {} }) },
    auth: { set: async () => { throw new Error("Native auth must not be written"); } },
  } };
  const hooks = await broker(input);
  const body = JSON.stringify({ model: "gpt-5.5", stream: true, background: false, store: false,
    instructions: "Native instructions unchanged.\nAGENTS fixture sentinel preserved.",
    tools: [{ type: "function", name: "skill", description: "fixture skill", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }, strict: true }],
    input: [{ role: "user", content: [{ type: "input_text", text: "native smoke check" }] }],
    tool_choice: "auto", parallel_tool_calls: true, reasoning: { effort: "low" }, include: ["reasoning.encrypted_content"] });
  async function compose(websockets, path = "/backend-api/codex/responses") {
    const native = await CodexAuthPlugin(input, { codexApiEndpoint: new URL(path, backend.url).href, experimentalWebSockets: websockets });
    natives.push(native);
    const bootstrap = JSON.parse(await readFile(authPath, "utf8")).openai;
    assert.equal(bootstrap.access, "");
    assert.equal(bootstrap.refresh, "");
    const models = await native.provider.models({ models: {
      "gpt-5.5": { id: "gpt-5.5", api: { id: "gpt-5.5" }, options: {} },
    } }, { auth: bootstrap });
    assert.ok(models["gpt-5.5"], "Empty OAuth sentinel must activate native subscription models without a plan JWT");
    const output = { loader: native.auth.loader };
    await hooks["auth.loader"]({ providerID: "openai" }, output);
    return output.loader(async () => JSON.parse(await readFile(authPath, "utf8")).openai, {});
  }
  async function send(loaded, owner, title = false) {
    const headers = { "session-id": "shared-session", "x-session-affinity": "shared-affinity", authorization: "Bearer must-be-replaced", ...(title ? { "x-opencode-title": "true" } : {}) };
    await hooks["chat.headers"]({ sessionID: owner, model: { providerID: "openai" } }, { headers });
    const response = await loaded.fetch("https://api.openai.com/v1/responses", { method: "POST", headers, body });
    assert.equal(response.status, 200);
    return response.text();
  }
  const http = await compose(false);
  await Promise.all([send(http, "one"), send(http, "two")]);
  assert.equal(records.length, 2);
  assert.ok(records.every((entry) => entry.transport === "http" && entry.body === body));
  const ws = await compose(true);
  const start = records.length;
  await Promise.all([send(ws, "one"), send(ws, "two")]);
  await Promise.all([send(ws, "one"), send(ws, "two")]);
  const websocketRecords = records.slice(start);
  assert.equal(websocketRecords.length, 4);
  assert.ok(websocketRecords.every((entry) => entry.transport === "ws"));
  assert.equal(new Set(websocketRecords.map((entry) => entry.socket)).size, 2);
  const { stream, background, ...payload } = JSON.parse(body);
  for (const entry of websocketRecords) assert.deepEqual(JSON.parse(entry.body), { type: "response.create", ...payload });
  for (const identity of ["first", "second"]) assert.equal(new Set(websocketRecords.filter((entry) => entry.identity === identity).map((entry) => entry.socket)).size, 1);
  await store.withStore((current) => { current.assignments["openai:one"] = accounts[1].id; });
  await send(ws, "one");
  assert.equal(records.at(-1).identity, "second");
  assert.equal(records.at(-1).socket, websocketRecords.find((entry) => entry.identity === "second").socket);
  await send(ws, "two", true);
  assert.equal(records.at(-1).transport, "http");
  assert.equal(records.at(-1).body, body);
  const fallback = await compose(true, "/fallback/responses");
  for (let attempt = 0; attempt < 5; attempt += 1) await assert.rejects(send(fallback, "two"));
  await send(fallback, "two");
  assert.equal(fallbackAttempts, 6);
  assert.equal(records.at(-1).transport, "http");
  assert.equal(records.at(-1).body, body);
  await send(fallback, "two");
  assert.equal(fallbackAttempts, 6);
  for (const entry of records) {
    assert.ok(entry.identity === "first" || entry.identity === "second");
    assert.equal(entry.authorization, `Bearer synthetic-${entry.identity}`);
    assert.equal(entry.internal, false);
    assert.equal(entry.session, "shared-session");
    assert.equal(entry.affinity, "shared-affinity");
  }
  assert.equal(await readFile(authPath, "utf8"), authBefore);
  console.log("Native adapter verification passed: real HTTP/WebSockets, unchanged instructions/tools, credential isolation/reuse, account switch, title/failure HTTP fallback, native auth unchanged.");
} finally {
  for (const native of natives) await native.dispose?.();
  await backend?.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
