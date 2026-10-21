import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readStore, type AccountProvider } from "./account-store";
import { PLUGIN_ID, paseoCliPath } from "./environment";

const execFileAsync = promisify(execFile);
const MARKER = "// Written by the ai-accounts Paseo plugin; removed when its last account is.";
const OPENCODE_CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
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
    if (/ai-accounts\/(opencode-plugin|opencode-codex-plugin)\.ts|ai-accounts\/opencode\//.test(text)) return true;
  }
  return false;
}

/**
 * OpenCode loads every file in its global plugins directory, so each provider with a signed-in
 * account gets a one-line re-export there, and loses it when its last account goes.
 */
export async function syncOpenCodePlugins(): Promise<void> {
  const root = await installedDirectory();
  if (!root || !existsSync(join(root, SHIMS.anthropic.entry))) return;
  const handListed = await listedByHand();
  const store = await readStore();
  for (const provider of Object.keys(SHIMS) as AccountProvider[]) {
    const { file, entry } = SHIMS[provider];
    const path = join(PLUGINS_DIR, file);
    const current = await readFile(path, "utf8").catch(() => undefined);
    const wanted = !handListed && store.accounts.some((account) => account.provider === provider);
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
}

export function syncOpenCodePluginsInBackground(): void {
  void syncOpenCodePlugins().catch((error) => console.error(`[${PLUGIN_ID}] could not update OpenCode plugins: ${error}`));
}
