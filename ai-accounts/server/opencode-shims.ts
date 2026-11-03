import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readStore, type AccountProvider } from "./account-store";
import { OPENCODE_CONFIG_DIR, PLUGIN_ID, paseoCliPath } from "./environment";
import { releaseOriginalAuthPlugins } from "./opencode-handover";
import { nativeOpenAIStatus } from "./native-openai";

const execFileAsync = promisify(execFile);
const MARKER = "// Written by the ai-accounts Paseo plugin; removed when its last account is.";
const PLUGINS_DIR = join(OPENCODE_CONFIG_DIR, "plugins");
const SHIMS: Record<AccountProvider, { file: string; entry: string }> = {
  anthropic: { file: "ai-accounts-anthropic.ts", entry: "opencode-plugin.ts" },
  openai: { file: "ai-accounts-codex.ts", entry: "opencode-codex-plugin.ts" },
};

/** The plugin runs from a bundle, so its source directory comes from Paseo itself. */
async function installedDirectory(): Promise<string | undefined> {
  const { stdout } = await execFileAsync(paseoCliPath(), ["plugin", "ls", "--json"], { cwd: homedir(), timeout: 30_000, maxBuffer: 4_000_000 });
  const plugins = JSON.parse(stdout) as { id: string; path?: string }[];
  return plugins.find((plugin) => plugin.id === PLUGIN_ID)?.path;
}

/** Someone who already lists our entry points by hand would get every request wrapped twice. */
async function listedByHand(): Promise<boolean> {
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const text = await readFile(join(OPENCODE_CONFIG_DIR, name), "utf8").catch(() => "");
    if (/ai-accounts\/opencode-plugin\.ts|ai-accounts\/opencode\//.test(text)) return true;
  }
  return false;
}

/**
 * OpenCode loads every file in its global plugins directory, so each provider with a signed-in
 * account gets a one-line re-export there, and loses it when its last account goes. That provider's
 * original auth plugin then comes out of the user's config, so only one copy renews the login.
 */
export async function syncOpenCodePlugins(resolveDirectory = installedDirectory): Promise<void> {
  const native = await nativeOpenAIStatus();
  if (native.status !== "native-auth-present") console.error(`[${PLUGIN_ID}] OpenAI ${native.status}: ${native.message}`);
  // Cleanup must not depend on finding an installed source directory or any signed-in account.
  if (native.status === "native-auth-present") {
    const retired = join(PLUGINS_DIR, SHIMS.openai.file);
    if ((await readFile(retired, "utf8").catch(() => "")).startsWith(MARKER)) await rm(retired, { force: true });
    await releaseOriginalAuthPlugins(["openai"]);
  }
  const root = await resolveDirectory();
  if (!root || !existsSync(join(root, SHIMS.anthropic.entry))) return;
  const handListed = await listedByHand();
  const store = await readStore();
  const signedIn = (["anthropic"] as AccountProvider[]).filter((provider) => store.accounts.some((account) => account.provider === provider));
  for (const provider of ["anthropic"] as const) {
    const { file, entry } = SHIMS[provider];
    const path = join(PLUGINS_DIR, file);
    const current = await readFile(path, "utf8").catch(() => undefined);
    const wanted = !handListed && signedIn.includes(provider);
    if (!wanted) {
      if (current?.startsWith(MARKER)) await rm(path, { force: true });
      continue;
    }
    if (current !== undefined && !current.startsWith(MARKER)) continue;
    const content = `${MARKER}\nexport { default } from ${JSON.stringify(pathToFileURL(join(root, entry)).href)};\n`;
    if (current === content) continue;
    await mkdir(PLUGINS_DIR, { recursive: true });
    await writeFile(path, content);
  }
  await releaseOriginalAuthPlugins(signedIn);
}

export function syncOpenCodePluginsInBackground(): void {
  void syncOpenCodePlugins().catch((error) => console.error(`[${PLUGIN_ID}] could not update OpenCode plugins: ${error}`));
}
