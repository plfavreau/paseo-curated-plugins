import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Pin } from "../shared/pins.ts";
import { addPin, readPins, removePin } from "./pins-store.ts";

function pin(id: string): Pin {
  return {
    id,
    agentId: "agent-1",
    title: `Pin ${id}`,
    body: "body",
    url: null,
    faviconUrl: null,
    createdAt: "2026-10-28T00:00:00.000Z",
  };
}

async function storePath() {
  return join(await mkdtemp(join(tmpdir(), "pins-")), "nested", "pins.json");
}

test("concurrent saves are all kept", async () => {
  const path = await storePath();
  await Promise.all(["a", "b", "c", "d", "e"].map((id) => addPin(path, pin(id))));

  assert.deepEqual(
    (await readPins(path)).map((saved) => saved.id).sort(),
    ["a", "b", "c", "d", "e"],
  );
});

test("removing a pin keeps the others and reports unknown ids", async () => {
  const path = await storePath();
  await addPin(path, pin("a"));
  await addPin(path, pin("b"));

  assert.equal(await removePin(path, "a"), true);
  assert.equal(await removePin(path, "missing"), false);
  assert.deepEqual((await readPins(path)).map((saved) => saved.id), ["b"]);
});

test("a missing store reads as no pins", async () => {
  assert.deepEqual(await readPins(await storePath()), []);
});
