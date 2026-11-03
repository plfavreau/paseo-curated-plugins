import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

// Anthropic prompt-cache TTL policy for opencode sessions.
//
// - Main conversation (root session, no parentID): 1-hour cache TTL.
//   Keeps the cache warm across 5-60 minute pauses between supervisor turns.
// - Subagents (sessions with a parentID): left at opencode's default 5-minute
//   TTL. Their writes are short and rarely reused after a long gap, so the 2x
//   1-hour write premium does not pay off for them.
// - Non-Anthropic providers are never touched.
// - If the session lookup fails, the default (5 minutes) is left in place.
//
// Cost note: a 1-hour cache write costs 2x base input, versus 1.25x for 5
// minutes. It pays off when a cached prefix is reused after a 5-60 minute gap.
// Bursty loops that never idle past 5 minutes are slightly more expensive with
// 1 hour; disable this plugin for those workloads.
//
export const CacheTtlPolicy: Plugin = async ({ client, directory }) => {
  // A project that ships its own copy (the Minitap umbrella does) keeps it; don't apply the policy twice.
  if (existsSync(join(directory, ".opencode", "plugins", "cache-ttl-policy.ts"))) return {};
  const isSubagentCache = new Map<string, boolean>();
  const isSubagent = async (sessionID: string): Promise<boolean | undefined> => {
    const cached = isSubagentCache.get(sessionID);
    if (cached !== undefined) return cached;
    try {
      const res = await client.session.get({ path: { id: sessionID } });
      if (!res.data || res.error) return undefined;
      const subagent = Boolean(res.data.parentID);
      isSubagentCache.set(sessionID, subagent);
      return subagent;
    } catch {
      return undefined;
    }
  };

  return {
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "anthropic") return;
      const subagent = await isSubagent(input.sessionID);
      if (subagent !== false) return; // subagent or unknown: keep the 5m default
      output.options.cacheControl = { type: "ephemeral", ttl: "1h" };
    },
  };
};

export default CacheTtlPolicy;
