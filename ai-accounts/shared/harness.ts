export type AccountProvider = "anthropic" | "openai";

export interface Harness {
  /** Providers this conversation can actually run on, in display order. */
  providers: AccountProvider[];
  /** The provider serving this conversation right now. */
  current: AccountProvider | null;
}

const NONE: Harness = { providers: [], current: null };

export function harnessFor(agent: { provider: string; model: string | null }): Harness {
  const provider = agent.provider;
  if (provider.startsWith("claude")) return { providers: ["anthropic"], current: "anthropic" };
  // The Codex CLI keeps its own login, so a conversation there cannot be moved between accounts.
  if (provider.startsWith("codex")) return NONE;
  if (!provider.startsWith("opencode")) return NONE;
  const identity = `${provider}/${agent.model ?? ""}`;
  // OpenRouter bills through an API key, so none of our subscriptions apply to it.
  if (identity.includes("openrouter")) return NONE;
  const current = identity.includes("anthropic") ? "anthropic" : identity.includes("openai") ? "openai" : null;
  return { providers: ["anthropic", "openai"], current };
}
