import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentToolContext, AgentToolDefinition } from "@getpaseo/plugin/server";
import { createPinTools } from "./agent-tools.ts";
import { createPinService } from "./pins.ts";

async function setup() {
  const pins = createPinService(join(await mkdtemp(join(tmpdir(), "pin-tools-")), "pins.json"));
  const tools = new Map(createPinTools(pins).map((tool) => [tool.name, tool]));
  function call(name: string, agentId: string, input: unknown) {
    const tool = tools.get(name) as AgentToolDefinition;
    return tool.execute(input, { agent: { id: agentId } } as AgentToolContext);
  }
  return { pins, call };
}

test("an agent creates a note pin and updates it by id", async () => {
  const { pins, call } = await setup();

  await call("pin_set", "agent-1", { body: "Deploy after the migration" });
  const [created] = await pins.list();
  await call("pin_set", "agent-1", { id: created.id, body: "Deploy after review" });

  const [updated] = await pins.list();
  assert.equal(updated.agentId, "agent-1");
  assert.equal(updated.createdBy, "agent");
  assert.equal(updated.body, "Deploy after review");
  assert.equal(updated.title, "Deploy after review");
});

test("an agent cannot see or remove another conversation's pins", async () => {
  const { pins, call } = await setup();
  const other = await pins.create({ agentId: "agent-2", title: "", body: "theirs", createdBy: "user" });

  const listed = await call("pins_list", "agent-1", {});
  const removed = await call("pin_remove", "agent-1", { id: other.id });

  assert.equal(listed.text, "No pins in this conversation.");
  assert.equal(removed.isError, true);
  assert.deepEqual((await pins.list()).map((pin) => pin.id), [other.id]);
});

test("creating a pin without a body is refused", async () => {
  const { pins, call } = await setup();

  const result = await call("pin_set", "agent-1", { title: "empty" });

  assert.equal(result.isError, true);
  assert.deepEqual(await pins.list(), []);
});
