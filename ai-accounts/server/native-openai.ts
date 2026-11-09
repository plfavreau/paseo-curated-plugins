import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { OPENCODE_AUTH_PATH } from "./environment";

export const NATIVE_OPENAI_MESSAGE = "OpenAI uses one native OpenCode account. Before native login or inference, the operator must drain and fully retire affected old OpenCode processes, including idle servers: they retain broker refresh ownership. Then run opencode auth login and choose OpenAI / ChatGPT on this host. Stored ai-accounts records are inactive and never restored automatically. Do not restart Paseo or automatically stop any process.";

/** The one OpenAI account: whatever login native OpenCode holds. Never a stored ai-accounts record. */
export const NATIVE_OPENAI_ACCOUNT_ID = "native-openai";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
// The endpoints behind Codex CLI's `/usage` → reset, called with the token native OpenCode holds, never refreshed.
const RESETS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CONSUME_RESET_URL = `${RESETS_URL}/consume`;
const USAGE_TTL_MS = 60_000;

export function requireManagedProvider(provider: string): void {
  if (provider === "openai") throw new Error(NATIVE_OPENAI_MESSAGE);
}

type NativeLogin = { type?: string; access?: string; refresh?: string; expires?: number; accountId?: string; key?: string };

async function readNativeLogin(): Promise<{ login: NativeLogin | undefined } | { error: "native-login-required" | "unreadable" }> {
  try {
    const auth = JSON.parse(await readFile(OPENCODE_AUTH_PATH, "utf8")) as { openai?: NativeLogin } | null;
    return { login: auth?.openai };
  } catch (error) {
    return { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "native-login-required" : "unreadable" };
  }
}

function isReady(login: NativeLogin | undefined): login is NativeLogin {
  return login?.accountId !== "ai-accounts-broker-bootstrap" && (
    (login?.type === "api" && typeof login.key === "string" && !!login.key.trim()) ||
    (login?.type === "oauth" && typeof login.access === "string" && !!login.access.trim() && typeof login.refresh === "string" && !!login.refresh.trim() && Number.isFinite(login.expires) && login.expires! > 0)
  );
}

/** Read-only readiness, not a remote token validation or refresh. Never return credentials. */
export async function nativeOpenAIStatus() {
  const read = await readNativeLogin();
  if ("error" in read) return { ownershipVersion: 1 as const, status: read.error, message: NATIVE_OPENAI_MESSAGE };
  const ready = isReady(read.login);
  return {
    ownershipVersion: 1 as const,
    status: ready ? "native-auth-present" as const : "native-login-required" as const,
    message: ready ? "Native OpenCode auth is present (not remotely validated). This plugin runtime does not import or refresh OpenAI credentials. Old OpenCode processes may still own broker refresh: drain and retire them before native inference. Auth presence and this attestation do not prove process retirement. Existing credentials were not changed." : NATIVE_OPENAI_MESSAGE,
  };
}

/** Identity claims ChatGPT puts in its access token, decoded locally. The token itself never leaves this module. */
function tokenClaims(access: string): { email: string | null; plan: string | null; chatgptAccountId: string | null } {
  try {
    const claims = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
    const profile = (claims["https://api.openai.com/profile"] ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    return { email: text(profile.email) ?? text(claims.email), plan: text(auth.chatgpt_plan_type), chatgptAccountId: text(auth.chatgpt_account_id) };
  } catch {
    return { email: null, plan: null, chatgptAccountId: null };
  }
}

export interface NativeOpenAIAccount {
  email: string;
  plan: string | null;
  /** Raw usage payload, normalized like any other OpenAI usage. */
  usage: unknown;
  usageFetchedAt: string | null;
  usageError: string | null;
  /** Banked full resets of the usage windows; null when unknown. */
  resets: { available: number; expiresAt: string | null } | null;
}

export type ResetOutcome = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

let cache: { fingerprint: string; at: number; account: NativeOpenAIAccount } | null = null;

/**
 * The native login as an account row: identity from its token claims, usage from a read-only GET
 * with the token native OpenCode holds right now. Nothing is refreshed, stored or written: an
 * expired or rejected token is reported, and native OpenCode renews it on its next OpenAI request.
 */
export async function nativeOpenAIAccount(refresh: boolean): Promise<NativeOpenAIAccount | null> {
  const read = await readNativeLogin();
  if ("error" in read || !isReady(read.login)) return null;
  const login = read.login;
  if (login.type === "api") {
    return { email: "OpenAI API key", plan: null, usage: null, usageFetchedAt: null, usageError: "Usage limits apply to ChatGPT sign-ins, not API keys.", resets: null };
  }
  const access = login.access!;
  const claims = tokenClaims(access);
  const fingerprint = createHash("sha256").update(access).digest("hex");
  if (cache?.fingerprint === fingerprint && (!refresh || Date.now() - cache.at < USAGE_TTL_MS)) return cache.account;
  const base = { email: claims.email ?? cache?.account.email ?? "ChatGPT account", plan: claims.plan };
  let account: NativeOpenAIAccount;
  if (login.expires! <= Date.now() + 60_000) {
    account = { ...base, usage: cache?.account.usage ?? null, usageFetchedAt: cache?.account.usageFetchedAt ?? null, usageError: "Native sign-in token expired. OpenCode renews it on its next OpenAI request; ai-accounts never refreshes it.", resets: cache?.account.resets ?? null };
  } else {
    account = await fetchUsage(access, claims.chatgptAccountId, base);
  }
  cache = { fingerprint, at: Date.now(), account };
  return account;
}

function chatgptHeaders(access: string, chatgptAccountId: string | null): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${access}`,
    ...(chatgptAccountId ? { "ChatGPT-Account-Id": chatgptAccountId } : {}),
    originator: "codex_cli_rs",
  };
}

async function fetchResets(access: string, chatgptAccountId: string | null, usage: unknown): Promise<NativeOpenAIAccount["resets"]> {
  const summary = (usage as { rate_limit_reset_credits?: { available_count?: unknown } } | null)?.rate_limit_reset_credits;
  if (typeof summary?.available_count !== "number") return null;
  if (summary.available_count <= 0) return { available: 0, expiresAt: null };
  try {
    const response = await fetch(RESETS_URL, { headers: chatgptHeaders(access, chatgptAccountId), signal: AbortSignal.timeout(8_000) });
    const body = (await response.json()) as { credits?: { status?: string; expires_at?: string | null }[] };
    const expiries = (body.credits ?? []).filter((credit) => credit.status === "available" && credit.expires_at).map((credit) => credit.expires_at!).sort();
    return { available: summary.available_count, expiresAt: expiries[0] ?? null };
  } catch {
    return { available: summary.available_count, expiresAt: null };
  }
}

async function fetchUsage(access: string, chatgptAccountId: string | null, base: { email: string; plan: string | null }): Promise<NativeOpenAIAccount> {
  const fetchedAt = new Date().toISOString();
  try {
    const response = await fetch(USAGE_URL, {
      method: "GET",
      headers: chatgptHeaders(access, chatgptAccountId),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      const rejected = response.status === 401 || response.status === 403;
      return {
        ...base,
        usage: null,
        usageFetchedAt: fetchedAt,
        usageError: rejected
          ? `OpenAI rejected the native sign-in (${response.status}). If it persists, run opencode auth login again; ai-accounts never refreshes it.`
          : `Usage request failed (${response.status})`,
        resets: null,
      };
    }
    const usage = (await response.json()) as { email?: unknown; plan_type?: unknown };
    return {
      email: typeof usage.email === "string" && usage.email ? usage.email : base.email,
      plan: typeof usage.plan_type === "string" && usage.plan_type ? usage.plan_type : base.plan,
      usage,
      usageFetchedAt: fetchedAt,
      usageError: null,
      resets: await fetchResets(access, chatgptAccountId, usage),
    };
  } catch (error) {
    return { ...base, usage: null, usageFetchedAt: fetchedAt, usageError: error instanceof Error ? error.message : String(error), resets: null };
  }
}

export function resetNativeOpenAIUsageCache(): void {
  cache = null;
}

/** Spends one banked reset, which refills every usage window at once. It cannot be undone. */
export async function redeemNativeOpenAIReset(): Promise<{ outcome: ResetOutcome; windowsReset: number }> {
  const read = await readNativeLogin();
  if ("error" in read || !isReady(read.login) || read.login.type !== "oauth") throw new Error("Resets need a ChatGPT sign-in in OpenCode.");
  if (read.login.expires! <= Date.now() + 60_000) throw new Error("The native sign-in token expired. Send any OpenAI message so OpenCode renews it, then try again.");
  const access = read.login.access!;
  const response = await fetch(CONSUME_RESET_URL, {
    method: "POST",
    headers: { ...chatgptHeaders(access, tokenClaims(access).chatgptAccountId), "Content-Type": "application/json" },
    body: JSON.stringify({ redeem_request_id: randomUUID() }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`OpenAI refused the reset (${response.status}).`);
  const body = (await response.json()) as { code?: string; windows_reset?: number };
  cache = null;
  const outcomes: ResetOutcome[] = ["reset", "nothing_to_reset", "no_credit", "already_redeemed"];
  const outcome = outcomes.find((candidate) => candidate === body.code);
  if (!outcome) throw new Error(`Unexpected reset answer: ${String(body.code)}`);
  return { outcome, windowsReset: body.windows_reset ?? 0 };
}
