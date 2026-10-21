import { USABILITY_CEILING } from "../shared/contracts";
import type { AccountProvider, StoredAccount } from "./account-store";

export interface UsageWindow {
  label: string;
  utilization: number;
  resetsAt: string | null;
  blocked: boolean;
}

export interface RecommendationAccount {
  id: string;
  provider: AccountProvider;
  email: string;
  usage: UsageWindow[];
}

export function normalizeUsage(provider: AccountProvider, value: unknown): UsageWindow[] {
  if (!value || typeof value !== "object") return [];
  const source = value as Record<string, unknown>;
  if (provider === "anthropic") {
    const labels: Record<string, string> = {
      five_hour: "5-hour",
      seven_day: "7-day",
      seven_day_opus: "7-day Opus",
      seven_day_sonnet: "7-day Sonnet",
    };
    return Object.entries(labels).flatMap(([key, label]) => {
      const window = source[key];
      if (!window || typeof window !== "object") return [];
      const record = window as Record<string, unknown>;
      if (typeof record.utilization !== "number") return [];
      return [
        {
          label,
          utilization: record.utilization,
          resetsAt: typeof record.resets_at === "string" ? record.resets_at : null,
          blocked: record.locked_reason != null,
        },
      ];
    });
  }
  const rateLimit = source.rate_limit as Record<string, unknown> | undefined;
  if (!rateLimit) return [];
  const limitReached = rateLimit.limit_reached === true || rateLimit.allowed === false;
  const windows = [rateLimit.primary_window, rateLimit.secondary_window].flatMap((window, index) => {
    if (!window || typeof window !== "object") return [];
    const record = window as Record<string, unknown>;
    if (typeof record.used_percent !== "number") return [];
    const seconds = typeof record.limit_window_seconds === "number" ? record.limit_window_seconds : 0;
    const label = seconds >= 6 * 24 * 60 * 60 ? "7-day" : seconds > 0 ? `${Math.round(seconds / 3600)}-hour` : index === 0 ? "Primary" : "Secondary";
    const reset = typeof record.reset_at === "number" ? new Date(record.reset_at * 1000).toISOString() : null;
    return [{ label, utilization: record.used_percent, resetsAt: reset, blocked: false }];
  });
  if (limitReached && windows.length > 0) {
    const peak = windows.reduce((worst, window) => (window.utilization > worst.utilization ? window : worst));
    peak.blocked = true;
  }
  return windows;
}

export function toRecommendationAccount(account: StoredAccount): RecommendationAccount {
  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    usage: normalizeUsage(account.provider, account.usage),
  };
}

function windowDuration(label: string): number | null {
  if (label.toLowerCase().includes("7-day")) return 7 * 24 * 60 * 60_000;
  const hours = label.match(/(\d+)-hour/i)?.[1];
  return hours ? Number(hours) * 60 * 60_000 : null;
}

function windowIsActive(window: UsageWindow, now: number): boolean {
  if (!window.resetsAt) return true;
  const resetsAt = Date.parse(window.resetsAt);
  return !Number.isFinite(resetsAt) || resetsAt > now;
}

export function bindingWindow(account: RecommendationAccount, now = Date.now()): UsageWindow | null {
  let binding: UsageWindow | null = null;
  for (const window of account.usage) {
    if (!windowIsActive(window, now) || (!window.blocked && window.utilization < USABILITY_CEILING)) continue;
    const current = window.resetsAt ? Date.parse(window.resetsAt) : Number.POSITIVE_INFINITY;
    const best = binding?.resetsAt ? Date.parse(binding.resetsAt) : Number.POSITIVE_INFINITY;
    if (!binding || current < best) binding = window;
  }
  return binding;
}

export function isUsable(account: RecommendationAccount, now = Date.now()): boolean {
  return account.usage.length > 0 && bindingWindow(account, now) === null;
}

export interface Recovery {
  account: RecommendationAccount;
  window: UsageWindow;
}

export function nextRecovery(accounts: RecommendationAccount[], now = Date.now()): Recovery | null {
  let recovery: Recovery | null = null;
  for (const account of accounts) {
    const window = bindingWindow(account, now);
    if (!window) continue;
    const current = window.resetsAt ? Date.parse(window.resetsAt) : Number.POSITIVE_INFINITY;
    const best = recovery?.window.resetsAt ? Date.parse(recovery.window.resetsAt) : Number.POSITIVE_INFINITY;
    if (!recovery || current < best) recovery = { account, window };
  }
  return recovery;
}

const IMMINENT_RESET_MS = 2 * 60 * 60_000;

// An account can only spend what its scarcest limit allows, so rank on that limit
// rather than on an average: averaging let a 5-hour window minutes from resetting
// outvote a weekly window at 86%. Headroom is forgiven only for a window that
// refreshes within the next couple of hours, measured in absolute time -- 25 hours
// left of a 7-day window is "85% elapsed" yet still a real constraint.
export function recommendationScore(account: RecommendationAccount, now: number): number {
  if (account.usage.length === 0) return Number.NEGATIVE_INFINITY;
  let binding = 1;
  let total = 0;
  for (const window of account.usage) {
    const utilization = Math.min(100, Math.max(0, window.utilization)) / 100;
    const headroom = 1 - utilization;
    const resetAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    const remaining = Number.isFinite(resetAt) ? Math.max(0, resetAt - now) : Number.POSITIVE_INFINITY;
    const relief = Math.min(1, Math.max(0, 1 - remaining / IMMINENT_RESET_MS));
    binding = Math.min(binding, headroom + (1 - headroom) * relief);
    total += headroom;
  }
  return binding + (total / account.usage.length) * 0.001;
}

export function recommendAccount(accounts: RecommendationAccount[], now = Date.now()): RecommendationAccount | null {
  let best: RecommendationAccount | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const account of accounts) {
    if (!isUsable(account, now)) continue;
    const score = recommendationScore(account, now);
    if (best === null || score > bestScore) {
      best = account;
      bestScore = score;
    }
  }
  return bestScore === Number.NEGATIVE_INFINITY ? null : best;
}
