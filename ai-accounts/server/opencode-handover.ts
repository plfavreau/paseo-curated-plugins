import { chmod, copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withStore, type AccountProvider } from "./account-store";
import { OPENCODE_CONFIG_DIR, PLUGIN_ID } from "./environment";
import { applyEdits, createScanner, parseTree, SyntaxKind, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { nativeOpenAIStatus } from "./native-openai";

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

/** Edits the text instead of re-serialising it, so JSONC comments and formatting survive. */
export function withoutPluginEntry(text: string, pkg: string): string {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || root?.type !== "object") return text;
  const properties = root.children?.filter((node) => node.children?.[0]?.value === "plugin") ?? [];
  if (properties.length !== 1) return text;
  const array = properties[0].children?.[1];
  if (array?.type !== "array") return text;
  let next = text;
  const entries = array.children ?? [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const value = entries[i].value;
    if (typeof value !== "string") continue;
    const matches = pkg === "ai-accounts/opencode-codex-plugin.ts"
      ? /(?:^|[/\\])ai-accounts[/\\]opencode-codex-plugin\.ts$/.test(value)
      : value === pkg || value.startsWith(`${pkg}@`);
    if (!matches) continue;
    const node = entries[i];
    const scanner = createScanner(next, true);
    scanner.setPosition(i > 0 ? entries[i - 1].offset + entries[i - 1].length : node.offset + node.length);
    const comma = scanner.scan() === SyntaxKind.CommaToken ? scanner.getTokenOffset() : undefined;
    const edits = [{ offset: node.offset, length: node.length, content: "" }];
    if (comma !== undefined) edits.push({ offset: comma, length: 1, content: "" });
    next = applyEdits(next, edits);
  }
  return next;
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
  // Enforce the gate here too: Claude sync must never indirectly retire OpenAI entries.
  const allowed: AccountProvider[] = providers.filter((provider) => provider === "anthropic");
  if (providers.includes("openai") && (await nativeOpenAIStatus()).status === "native-auth-present") allowed.push("openai");
  if (allowed.length === 0) return;
  for (const name of CONFIG_FILES) {
    const path = join(OPENCODE_CONFIG_DIR, name);
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    let next = text;
    if (allowed.includes("openai")) next = withoutPluginEntry(next, "ai-accounts/opencode-codex-plugin.ts");
    const released: AccountProvider[] = [];
    for (const provider of allowed) {
      const stripped = withoutPluginEntry(next, ORIGINAL_AUTH_PLUGINS[provider]);
      if (stripped === next) continue;
      if (provider === "anthropic") released.push(provider);
      next = stripped;
    }
    if (next === text) continue;
    if (parses(text) && !parses(next)) {
      console.error(`[${PLUGIN_ID}] left ${path} alone: removing the original auth plugins would break it`);
      continue;
    }
    const backup = `${path}.bak-${PLUGIN_ID}-${Date.now()}-${randomUUID()}`;
    await copyFile(path, backup, constants.COPYFILE_EXCL);
    await chmod(backup, 0o600);
    const tempPath = `${path}.${process.pid}.tmp`;
    await writeFile(tempPath, next, { mode: 0o600 });
    await rename(tempPath, path);
    const at = new Date().toISOString();
    if (released.length > 0) {
      await withStore((store) => {
        const handovers = (store.openCodeHandovers ??= {});
        for (const provider of released) handovers[provider] = { plugin: ORIGINAL_AUTH_PLUGINS[provider], config: path, at };
      });
    }
  }
}
