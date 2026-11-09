import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Server modules freeze these paths on import; a real config dir here would let tests rewrite the user's OpenCode plugins.
const scratch = await mkdtemp(join(tmpdir(), "ai-accounts-balance-"));
process.env.XDG_DATA_HOME = scratch;
process.env.XDG_CONFIG_HOME = join(scratch, "config");
const { placeSessions } = await import("../server/balance.ts");

const view = (id, pace, usable = true) => ({ account: { id, email: `${id}@test`, provider: "anthropic" }, pace, usable, note: null });
const session = (agentId, accountId, load, rewriteTokens, running = false) => ({
  agentId,
  account: { id: accountId, email: `${accountId}@test`, provider: "anthropic" },
  provider: "anthropic",
  canUse: ["anthropic"],
  tier: "careful",
  running,
  load,
  rewriteTokens,
});

test("moves a cold conversation and keeps warm ones whose rewrite costs more than the balance gained", () => {
  const sessions = [
    session("running-warm", "a", 1, 300_000, true),
    session("dormant-warm", "a", 0.05, 300_000),
    session("dormant-cold", "a", 0.05, 0),
  ];
  const { placement } = placeSessions(sessions, [view("a", 1), view("b", 1)], false);
  assert.equal(placement.get("running-warm"), "a");
  assert.equal(placement.get("dormant-warm"), "a");
  assert.equal(placement.get("dormant-cold"), "b");
});

test("still moves a warm conversation off an account that cannot serve it", () => {
  const { placement } = placeSessions([session("stuck", "full", 1, 400_000, true)], [view("full", 0, false), view("b", 1)], false);
  assert.equal(placement.get("stuck"), "b");
});
