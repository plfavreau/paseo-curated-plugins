import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withStore, type AccountProvider } from "./account-store";
import { OPENCODE_CONFIG_DIR, PLUGIN_ID } from "./environment";

/**
 * The auth plugins ai-accounts already loads, wrapped, for each provider. Left in the user's own
 * OpenCode config, they keep refreshing OpenCode's copy of the imported login, and since both
 * providers rotate the refresh token on every use, whichever copy refreshes second gets
 * invalid_grant.
 */
export const ORIGINAL_AUTH_PLUGINS: Record<AccountProvider, string> = {
  anthropic: "@ex-machina/opencode-anthropic-auth",
  openai: "opencode-openai-codex-auth",
};
const CONFIG_FILES = ["opencode.json", "opencode.jsonc"];

function entryPattern(pkg: string): string {
  return `"${pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:@[^"]*)?"`;
}

/** Edits the text instead of re-serialising it, so JSONC comments and formatting survive. */
export function withoutPluginEntry(text: string, pkg: string): string {
  const entry = entryPattern(pkg);
  const notFirst = new RegExp(`,\\s*${entry}`);
  const first = new RegExp(`${entry}\\s*,?\\s*`);
  let next = text;
  for (;;) {
    const stripped = notFirst.test(next) ? next.replace(notFirst, "") : next.replace(first, "");
    if (stripped === next) return next;
    next = stripped;
  }
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Takes each signed-in provider's original auth plugin out of the global OpenCode config, after a backup. */
export async function releaseOriginalAuthPlugins(providers: AccountProvider[]): Promise<void> {
  if (providers.length === 0) return;
  for (const name of CONFIG_FILES) {
    const path = join(OPENCODE_CONFIG_DIR, name);
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    let next = text;
    const released: AccountProvider[] = [];
    for (const provider of providers) {
      const stripped = withoutPluginEntry(next, ORIGINAL_AUTH_PLUGINS[provider]);
      if (stripped === next) continue;
      released.push(provider);
      next = stripped;
    }
    if (released.length === 0) continue;
    if (parses(text) && !parses(next)) {
      console.error(`[${PLUGIN_ID}] left ${path} alone: removing the original auth plugins would break it`);
      continue;
    }
    await copyFile(path, `${path}.bak-${PLUGIN_ID}-${Date.now()}`);
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, next);
    await rename(tempPath, path);
    const at = new Date().toISOString();
    await withStore((store) => {
      const handovers = (store.openCodeHandovers ??= {});
      for (const provider of released) handovers[provider] = { plugin: ORIGINAL_AUTH_PLUGINS[provider], config: path, at };
    });
  }
}
