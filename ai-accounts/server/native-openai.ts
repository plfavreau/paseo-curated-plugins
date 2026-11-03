import { readFile } from "node:fs/promises";
import { OPENCODE_AUTH_PATH } from "./environment";

export const NATIVE_OPENAI_MESSAGE = "OpenAI uses one native OpenCode account. Before native login or inference, the operator must drain and fully retire affected old OpenCode processes, including idle servers: they retain broker refresh ownership. Then run opencode auth login and choose OpenAI / ChatGPT on this host. Stored ai-accounts records are inactive and never restored automatically. Do not restart Paseo or automatically stop any process.";

export function requireManagedProvider(provider: string): void {
  if (provider === "openai") throw new Error(NATIVE_OPENAI_MESSAGE);
}

/** Read-only readiness, not a remote token validation or refresh. Never return credentials. */
export async function nativeOpenAIStatus() {
  let auth: unknown;
  try {
    auth = JSON.parse(await readFile(OPENCODE_AUTH_PATH, "utf8"));
  } catch (error) {
    return { ownershipVersion: 1 as const, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "native-login-required" as const : "unreadable" as const, message: NATIVE_OPENAI_MESSAGE };
  }
  const login = (auth as { openai?: { type?: string; access?: string; refresh?: string; expires?: number; accountId?: string; key?: string } } | null)?.openai;
  const ready = login?.accountId !== "ai-accounts-broker-bootstrap" && (
    (login?.type === "api" && typeof login.key === "string" && !!login.key.trim()) ||
    (login?.type === "oauth" && typeof login.access === "string" && !!login.access.trim() && typeof login.refresh === "string" && !!login.refresh.trim() && Number.isFinite(login.expires) && login.expires! > 0)
  );
  return {
    ownershipVersion: 1 as const,
    status: ready ? "native-auth-present" as const : "native-login-required" as const,
    message: ready ? "Native OpenCode auth is present (not remotely validated). This plugin runtime does not import or refresh OpenAI credentials. Old OpenCode processes may still own broker refresh: drain and retire them before native inference. Auth presence and this attestation do not prove process retirement. Existing credentials were not changed." : NATIVE_OPENAI_MESSAGE,
  };
}
