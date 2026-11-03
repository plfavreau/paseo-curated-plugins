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
// Never set the request-level `cacheControl` option: OpenCode then drops its
// inline breakpoints on the system prompt, so any history rewrite (compaction,
// pruning) loses the whole cache. Root requests are tagged with a header
// instead, and the fetch hook below only raises the TTL of the inline markers.
// See docs/anthropic-cache-ttl.md in the Minitap umbrella.

const TTL_HEADER = "x-minitap-cache-ttl";
const wrappedFetchKey = Symbol.for("minitap.cache-ttl-policy.inline-ttl");

type CacheControl = { type?: string; ttl?: string };
type Block = { cache_control?: CacheControl; content?: unknown };

function raiseInlineTtl(body: { system?: unknown; tools?: unknown; messages?: unknown }): void {
  const blocks: Block[] = [];
  for (const list of [body.system, body.tools, body.messages]) {
    if (!Array.isArray(list)) continue;
    for (const item of list as Block[]) {
      blocks.push(item);
      if (Array.isArray(item?.content)) blocks.push(...(item.content as Block[]));
    }
  }
  for (const block of blocks) {
    if (block?.cache_control?.type === "ephemeral") block.cache_control.ttl = "1h";
  }
}

function takeTtlHeader(headers: HeadersInit | undefined): { ttl: string | null; headers: HeadersInit | undefined } {
  if (!headers) return { ttl: null, headers };
  const copy = new Headers(headers);
  const ttl = copy.get(TTL_HEADER);
  if (ttl === null) return { ttl, headers };
  copy.delete(TTL_HEADER);
  return { ttl, headers: copy };
}

function wrapFetch(original: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const { ttl, headers } = takeTtlHeader(init?.headers);
    if (ttl === null) return original(input, init);
    if (ttl !== "1h" || typeof init?.body !== "string") return original(input, { ...init, headers });
    try {
      const body = JSON.parse(init.body);
      raiseInlineTtl(body);
      return original(input, { ...init, headers, body: JSON.stringify(body) });
    } catch {
      return original(input, { ...init, headers });
    }
  }) as typeof fetch;
}

function installFetchWrapper(): void {
  if (Reflect.get(globalThis, wrappedFetchKey)) return;
  globalThis.fetch = wrapFetch(globalThis.fetch);
  Reflect.set(globalThis, wrappedFetchKey, true);
}

export const CacheTtlPolicy: Plugin = async ({ client, directory }) => {
  // A project that ships its own copy (the Minitap umbrella does) keeps it; don't apply the policy twice.
  if (existsSync(join(directory, ".opencode", "plugins", "cache-ttl-policy.ts"))) return {};
  installFetchWrapper();
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
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "anthropic") return;
      const subagent = await isSubagent(input.sessionID);
      if (subagent !== false) return; // subagent or unknown: keep the 5m default
      output.headers[TTL_HEADER] = "1h";
    },
  };
};

export default CacheTtlPolicy;
