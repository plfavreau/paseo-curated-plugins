import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StoredAccount } from "./account-store";
import { DATA_DIR } from "./environment";

const execFileAsync = promisify(execFile);
const NAMESPACE_ROOT = join(DATA_DIR, "claude-code");

export interface ClaudeCredentials {
  access: string;
  refresh: string;
  expires: number;
}

export function namespaceDir(accountId: string): string {
  return join(NAMESPACE_ROOT, accountId);
}

/** Mirrors Claude Code's own service name: `Claude Code-credentials-${sha256(NFC(dir)).slice(0, 8)}`. */
function serviceName(accountId: string): string {
  const hash = createHash("sha256").update(namespaceDir(accountId).normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

function keychainUser(): string {
  const name = process.env.USER || userInfo().username;
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : "claude-code-user";
}

export async function hasNamespace(accountId: string): Promise<boolean> {
  try {
    await stat(namespaceDir(accountId));
    return true;
  } catch {
    return false;
  }
}

export async function createNamespace(accountId: string): Promise<string> {
  const dir = namespaceDir(accountId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function readClaudeCredentials(accountId: string): Promise<ClaudeCredentials | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-a", keychainUser(), "-w", "-s", serviceName(accountId)],
      { cwd: homedir(), timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    const oauth = (JSON.parse(stdout.trim()) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
    const access = oauth?.accessToken;
    const refresh = oauth?.refreshToken;
    const expires = oauth?.expiresAt;
    if (typeof access !== "string" || typeof refresh !== "string" || typeof expires !== "number") return undefined;
    return { access, refresh, expires };
  } catch {
    return undefined;
  }
}

export async function writeClaudeCredentials(account: StoredAccount): Promise<void> {
  const blob = JSON.stringify({
    claudeAiOauth: {
      accessToken: account.access,
      refreshToken: account.refresh,
      expiresAt: account.expires,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: account.plan ?? "max",
    },
  });
  // `security` only accepts the secret as an argument; it is visible to this user's own processes for an instant.
  await execFileAsync(
    "/usr/bin/security",
    ["add-generic-password", "-U", "-a", keychainUser(), "-s", serviceName(account.id), "-w", blob],
    { cwd: homedir(), timeout: 5_000 },
  );
}

export async function deleteClaudeCredentials(accountId: string): Promise<void> {
  try {
    await execFileAsync(
      "/usr/bin/security",
      ["delete-generic-password", "-a", keychainUser(), "-s", serviceName(accountId)],
      { cwd: homedir(), timeout: 5_000 },
    );
  } catch {
    /* nothing stored for this account */
  }
}

export async function removeNamespace(accountId: string): Promise<void> {
  await deleteClaudeCredentials(accountId);
  await rm(namespaceDir(accountId), { recursive: true, force: true });
}
