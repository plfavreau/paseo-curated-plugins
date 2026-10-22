import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { ensureFreshAccount, withStore } from "./account-store";
import { createNamespace, writeClaudeCredentials } from "./claude-keychain";

export function isClaudeHarness(provider: string): boolean {
  return provider === "claude" || provider.startsWith("claude/");
}

/**
 * The Claude harness runs one `claude` process per agent, so pointing it at a per-account keychain
 * namespace gives each conversation its own subscription while `~/.claude` history stays shared.
 */
export async function prepareClaudeSession(request: PluginSessionOpenRequest): Promise<PluginSessionOpenRequest | undefined> {
  if (!isClaudeHarness(request.provider) || request.purpose !== "interactive") return undefined;
  const account = await ensureFreshAccount("anthropic", request.agentId);
  if (!account) return undefined;
  const dir = await createNamespace(account.id);
  await writeClaudeCredentials(account);
  await withStore((store) => {
    store.claudeLaunches = { ...store.claudeLaunches, [request.agentId]: account.id };
  });
  return { ...request, env: { ...request.env, CLAUDE_SECURESTORAGE_CONFIG_DIR: dir } };
}
