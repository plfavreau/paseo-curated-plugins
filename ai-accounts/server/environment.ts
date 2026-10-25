import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const PLUGIN_ID = "ai-accounts";

function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

/** Installs from before the rename keep their store, because Claude keychain entries are keyed by this path. */
function resolveDataDir(): string {
  const current = join(xdgDataHome(), PLUGIN_ID);
  const legacy = join(xdgDataHome(), "claude-accounts");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export const DATA_DIR = resolveDataDir();
export const OPENCODE_DATA_DIR = join(xdgDataHome(), "opencode");
export const OPENCODE_DB = join(OPENCODE_DATA_DIR, "opencode.db");
export const OPENCODE_AUTH_PATH = join(OPENCODE_DATA_DIR, "auth.json");
export const OPENCODE_CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");

function findOnPath(name: string, fallbacks: string[] = []): string | undefined {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const candidate of [...dirs.map((dir) => join(dir, name)), ...fallbacks]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/** The app ships its CLI inside the bundle the daemon runs from, whether or not it was ever added to PATH. */
function bundledPaseoCli(): string[] {
  const bundle = process.execPath.match(/^(.*?\.app)\/Contents\//)?.[1];
  return [
    ...(bundle ? [join(bundle, "Contents", "Resources", "bin", "paseo")] : []),
    "/Applications/Paseo.app/Contents/Resources/bin/paseo",
    join(homedir(), "Applications", "Paseo.app", "Contents", "Resources", "bin", "paseo"),
  ];
}

let paseoCli: string | undefined;
export function paseoCliPath(): string {
  paseoCli ??=
    findOnPath("paseo", [join(homedir(), ".local", "bin", "paseo"), "/opt/homebrew/bin/paseo", "/usr/local/bin/paseo", ...bundledPaseoCli()]) ?? "paseo";
  return paseoCli;
}

let sqlite: string | undefined;
export function sqlitePath(): string {
  sqlite ??= findOnPath("sqlite3", ["/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3"]) ?? "sqlite3";
  return sqlite;
}

function paseoHome(): string {
  return process.env.PASEO_HOME || join(homedir(), ".paseo");
}

/** The daemon's `listen` setting, as written in ~/.paseo/config.json. */
export function daemonUrl(): string {
  let listen = process.env.PASEO_LISTEN || "127.0.0.1:6767";
  try {
    const config = JSON.parse(readFileSync(join(paseoHome(), "config.json"), "utf8")) as { daemon?: { listen?: unknown } };
    if (typeof config.daemon?.listen === "string" && config.daemon.listen) listen = config.daemon.listen;
  } catch {
    /* default listen address */
  }
  if (/^wss?:\/\//.test(listen)) return listen;
  const host = listen.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "127.0.0.1:");
  return `ws://${host}/ws`;
}

let claudeUserAgent: string | undefined;
export function claudeCodeUserAgent(): string {
  if (claudeUserAgent) return claudeUserAgent;
  let version = "2.1.0";
  const binary = findOnPath("claude", [join(homedir(), ".local", "bin", "claude")]);
  if (binary) {
    try {
      version = execFileSync(binary, ["--version"], { timeout: 5_000, encoding: "utf8" }).match(/\d+\.\d+\.\d+/)?.[0] ?? version;
    } catch {
      /* keep the fallback version */
    }
  }
  claudeUserAgent = `claude-code/${version}`;
  return claudeUserAgent;
}
