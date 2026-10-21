import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DATA_DIR, PLUGIN_ID, paseoCliPath } from "./environment";

const execFileAsync = promisify(execFile);

export const OPENCODE_SHIM_DIR = join(DATA_DIR, "opencode");
const SHIMS = { "anthropic.ts": "opencode-plugin.ts", "codex.ts": "opencode-codex-plugin.ts" };

/** Git installs live in a per-install directory, so OpenCode is pointed at these stable re-exports instead. */
export async function writeOpenCodeShims(): Promise<void> {
  const root = await installedDirectory();
  if (!root || !existsSync(join(root, SHIMS["anthropic.ts"]))) return;
  await mkdir(OPENCODE_SHIM_DIR, { recursive: true, mode: 0o700 });
  for (const [shim, target] of Object.entries(SHIMS)) {
    const path = join(OPENCODE_SHIM_DIR, shim);
    const content = `export { default } from ${JSON.stringify(pathToFileURL(join(root, target)).href)};\n`;
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== content) await writeFile(path, content);
  }
}

/** The plugin runs from a bundle, so its source directory comes from Paseo itself. */
async function installedDirectory(): Promise<string | undefined> {
  const { stdout } = await execFileAsync(paseoCliPath(), ["plugin", "ls", "--json"], { cwd: homedir(), timeout: 30_000, maxBuffer: 4_000_000 });
  const plugins = JSON.parse(stdout) as { id: string; path?: string }[];
  return plugins.find((plugin) => plugin.id === PLUGIN_ID)?.path;
}
