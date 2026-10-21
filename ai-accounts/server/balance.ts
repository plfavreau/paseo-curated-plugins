import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { RpcInput } from "@getpaseo/plugin";
import { balancePlanRpc, balanceStartRpc, healthRpc, sessionsRpc, setTierRpc, USABILITY_CEILING, type Tier } from "../shared/contracts";
import { harnessFor } from "../shared/harness";
import {
  DEFAULT_BALANCE_SETTINGS,
  assignmentKey,
  readStore,
  refreshStaleUsage,
  refreshUsage,
  resolveAccount,
  withStore,
  type AccountProvider,
  type Store,
  type StoredAccount,
} from "./account-store";
import { createDaemonClient, providerModel } from "./accounts";
import { OPENCODE_DB, PLUGIN_ID, sqlitePath } from "./environment";
import {
  LIVE_STATUSES,
  isJobRunning,
  launchJob,
  message,
  moveAgent,
  providerName,
  runPool,
  targetBlocker,
  withDaemon,
  type Candidate,
  type Job,
} from "./force-account";
import { cachedClassification, classifierModel, classifyWithLlm } from "./classify";
import { normalizeUsage } from "./recommendation";

const execFileAsync = promisify(execFile);
const CONCURRENCY = 4;

/** Quota a conversation is expected to burn. A dormant conversation is almost free until someone writes to it. */
const LOAD_RUNNING = 1;
const LOAD_RECENT = 0.35;
const LOAD_DORMANT = 0.05;
const RECENT_MS = 30 * 60_000;

/** Stop shuffling once every account is within this much load of its ideal. */
const BALANCE_TOLERANCE = 0.3;
/** A move must improve the spread by at least this much, otherwise it is churn. */
const MIN_IMPROVEMENT = 0.05;
/** Interrupting a running conversation costs a little more than quietly re-pinning an idle one. */
const RUNNING_MOVE_PENALTY = 0.1;
const MIN_WINDOW_HOURS = 0.5;

type LiveAgent = Awaited<ReturnType<ReturnType<typeof createDaemonClient>["fetchAgents"]>>["entries"][number]["agent"];

const HOUSEKEEPING_TITLE =
  /\b(disk|clean[- ]?up|housekeep\w*|chores?|bump|rebase|monitor\w*|archive|sync|summar\w+|dependabot|renovate|prune|lint|format\w*|typo)\b/i;
const HOUSEKEEPING_MODES = new Set(["tech-debt"]);

interface Session {
  agentId: string;
  title: string;
  running: boolean;
  mode: string | null;
  harness: "opencode" | "claude" | "codex" | "other";
  model: string | null;
  rawProvider: string;
  provider: AccountProvider;
  account: StoredAccount;
  tier: Tier;
  tierSource: "manual" | "ai" | "auto";
  tierReason: string | null;
  canUse: AccountProvider[];
  load: number;
  workspace: string | null;
  workspaceId: string | null;
  updatedAt: string | null;
  owners: string[];
}

interface AccountView {
  account: StoredAccount;
  /** Percent of the plan that can be spent per hour without hitting any window before it resets. */
  pace: number;
  usable: boolean;
  note: string | null;
}

function keywordTier(agent: LiveAgent): { tier: Tier; reason: string } {
  if (agent.currentModeId && HOUSEKEEPING_MODES.has(agent.currentModeId)) return { tier: "housekeeping", reason: `${agent.currentModeId} mode` };
  const match = HOUSEKEEPING_TITLE.exec(agent.title ?? "");
  return match ? { tier: "housekeeping", reason: `title mentions "${match[0].toLowerCase()}"` } : { tier: "careful", reason: "no housekeeping signal in the title" };
}

/** Manual choice, then the last model verdict, then keywords. Reading it never spends an inference. */
function tierOf(agent: LiveAgent, store: Store): { tier: Tier; source: Session["tierSource"]; reason: string | null } {
  const manual = store.sessionTiers?.[agent.id];
  if (manual) return { tier: manual, source: "manual", reason: "set by you" };
  const judged = cachedClassification(agent.id);
  if (judged) return { tier: judged.tier, source: "ai", reason: judged.reason };
  const guess = keywordTier(agent);
  return { tier: guess.tier, source: "auto", reason: guess.reason };
}

function harnessKind(provider: string): Session["harness"] {
  if (provider.startsWith("opencode")) return "opencode";
  if (provider.startsWith("claude")) return "claude";
  if (provider.startsWith("codex")) return "codex";
  return "other";
}

function loadOf(agent: LiveAgent, now: number): number {
  if (agent.status === "running" || agent.status === "initializing") return LOAD_RUNNING;
  const touched = Date.parse(agent.updatedAt ?? "");
  return Number.isFinite(touched) && now - touched < RECENT_MS ? LOAD_RECENT : LOAD_DORMANT;
}

function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.round(hours / 24)}d`;
}

function viewOf(account: StoredAccount, now: number): AccountView {
  if (account.needsReauth && account.expires <= now + 60_000) {
    return { account, pace: 0, usable: false, note: "Needs to sign in again" };
  }
  const windows = normalizeUsage(account.provider, account.usage);
  let pace = Number.POSITIVE_INFINITY;
  let note: string | null = null;
  for (const window of windows) {
    const resetAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (!Number.isFinite(resetAt) || resetAt <= now) continue;
    const hours = Math.max(MIN_WINDOW_HOURS, (resetAt - now) / 3_600_000);
    const room = window.blocked ? 0 : Math.max(0, USABILITY_CEILING - window.utilization);
    const rate = room / hours;
    if (rate < pace) {
      pace = rate;
      note = rate <= 0 ? `${window.label} window is full, frees up in ${duration(resetAt - now)}` : null;
    }
  }
  if (!Number.isFinite(pace)) return { account, pace: 0, usable: false, note: "Usage unknown" };
  return { account, pace, usable: pace > 0, note };
}

async function liveAgents(): Promise<LiveAgent[]> {
  return withDaemon(async (daemon) => {
    const agents: LiveAgent[] = [];
    let cursor: string | undefined;
    do {
      const page = await daemon.fetchAgents({
        filter: { statuses: [...LIVE_STATUSES], includeArchived: false },
        page: { limit: 200, cursor },
      });
      for (const { agent } of page.entries) agents.push(agent);
      cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
    } while (cursor);
    return agents;
  });
}

function buildSession(agent: LiveAgent, store: Store, now: number): Session | null {
  const harness = harnessFor({ provider: agent.provider, model: agent.model ?? null });
  if (!harness.current) return null;
  const sessionId = agent.runtimeInfo?.sessionId ?? undefined;
  const owners = [sessionId, agent.id].filter((owner): owner is string => Boolean(owner));
  const account = resolveAccount(store, harness.current, owners);
  if (!account) return null;
  const judged = tierOf(agent, store);
  return {
    agentId: agent.id,
    title: agent.title?.trim() || agent.id.slice(0, 8),
    running: agent.status === "running" || agent.status === "initializing",
    mode: agent.currentModeId ?? null,
    harness: harnessKind(agent.provider),
    model: agent.model ?? null,
    rawProvider: agent.provider,
    provider: harness.current,
    account,
    tier: judged.tier,
    tierSource: judged.source,
    tierReason: judged.reason,
    canUse: harness.providers,
    load: loadOf(agent, now),
    workspace: agent.cwd ? basename(agent.cwd) : null,
    workspaceId: agent.workspaceId ?? null,
    updatedAt: agent.updatedAt ?? null,
    owners,
  };
}

async function collect() {
  // Fresh numbers matter more here than anywhere: the plan is only as good as the usage it reads.
  let store = await readStore();
  await refreshStaleUsage(store.accounts);
  store = await readStore();
  const now = Date.now();
  const agents = await liveAgents();
  const sessions = agents.map((agent) => buildSession(agent, store, now)).filter((session): session is Session => session !== null);
  const views = store.accounts.map((account) => viewOf(account, now));
  return { store, sessions, views, agents };
}

function summarize(views: AccountView[], sessions: Session[], accountOf: (session: Session) => string) {
  const totals: Record<AccountProvider, number> = { anthropic: 0, openai: 0 };
  const paces: Record<AccountProvider, number> = { anthropic: 0, openai: 0 };
  for (const view of views) paces[view.account.provider] += view.usable ? view.pace : 0;
  const rows = views.map((view) => {
    const mine = sessions.filter((session) => accountOf(session) === view.account.id);
    const load = mine.reduce((sum, session) => sum + session.load, 0);
    totals[view.account.provider] += load;
    return { view, mine, load };
  });
  return rows.map(({ view, mine, load }) => {
    const provider = view.account.provider;
    const running = mine.filter((session) => session.running).length;
    return {
      accountId: view.account.id,
      provider,
      email: view.account.email,
      running,
      idle: mine.length - running,
      load: Math.round(load * 100) / 100,
      share: totals[provider] > 0 ? load / totals[provider] : 0,
      idealShare: view.usable && paces[provider] > 0 ? view.pace / paces[provider] : 0,
      pace: Math.round(view.pace * 100) / 100,
      usable: view.usable,
      note: view.note,
    };
  });
}

/** Workspace id -> the title the Paseo sidebar shows. Failing to read it only costs nicer names. */
async function workspaceTitles(): Promise<Map<string, string>> {
  try {
    return await withDaemon(async (daemon) => {
      const titles = new Map<string, string>();
      let cursor: string | undefined;
      do {
        const page = await daemon.fetchWorkspaces({ page: { limit: 200, cursor } });
        for (const entry of page.entries) {
          const title = (entry.title ?? entry.name ?? "").trim();
          if (title) titles.set(entry.id, title);
        }
        cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
      } while (cursor);
      return titles;
    });
  } catch {
    return new Map();
  }
}

export async function getSessions(_input: RpcInput<typeof sessionsRpc>) {
  const [{ store, sessions, views }, titles] = await Promise.all([collect(), workspaceTitles()]);
  const perWorkspace = new Map<string, number>();
  for (const session of sessions) if (session.workspaceId) perWorkspace.set(session.workspaceId, (perWorkspace.get(session.workspaceId) ?? 0) + 1);
  return {
    sessions: sessions
      .map((session) => ({
        agentId: session.agentId,
        title: session.title,
        running: session.running,
        mode: session.mode,
        harness: session.harness,
        model: session.model,
        provider: session.provider,
        accountId: session.account.id,
        email: session.account.email,
        tier: session.tier,
        tierSource: session.tierSource,
        tierReason: session.tierReason,
        canUse: session.canUse,
        load: session.load,
        workspace: session.workspace,
        workspaceTitle: (session.workspaceId && titles.get(session.workspaceId)) || null,
        workspaceSessions: session.workspaceId ? (perWorkspace.get(session.workspaceId) ?? 1) : 1,
        updatedAt: session.updatedAt,
      }))
      .sort((a, b) => Number(b.running) - Number(a.running) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
    accounts: summarize(views, sessions, (session) => session.account.id),
    forced: Object.fromEntries(Object.entries(store.preferredAccountIds ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1]))),
  };
}

interface PlacementResult {
  placement: Map<string, string>;
  notes: string[];
}

/**
 * Decides which account every conversation should end up on.
 *
 * 1. Tier decides the provider: careful work stays on Claude, housekeeping goes to Codex when it can.
 * 2. Within a provider, load is shared in proportion to each account's sustainable pace (quota left
 *    over time left, per window), so every subscription burns down at the same rate and none is
 *    left holding unused quota when its window resets.
 * 3. Starting from where conversations already are, the fewest moves that close the gap are chosen.
 */
function placeSessions(sessions: Session[], views: AccountView[], housekeepingToCodex: boolean): PlacementResult {
  const notes: string[] = [];
  const usable = (provider: AccountProvider) => views.filter((view) => view.account.provider === provider && view.usable);
  const placement = new Map<string, string>();
  const desired = new Map<string, AccountProvider>();
  let stranded = 0;
  let pinnedToClaude = 0;

  for (const session of sessions) {
    let want: AccountProvider;
    if (session.canUse.length === 1) {
      want = session.canUse[0];
      if (session.tier === "housekeeping" && want === "anthropic" && housekeepingToCodex) pinnedToClaude += 1;
    } else if (session.tier === "housekeeping" && housekeepingToCodex && usable("openai").length > 0) {
      want = "openai";
    } else {
      want = "anthropic";
    }
    if (usable(want).length === 0 && want !== session.provider) {
      stranded += 1;
      want = session.provider;
    }
    desired.set(session.agentId, want);
    if (want === session.provider) placement.set(session.agentId, session.account.id);
  }
  if (stranded > 0) notes.push(`${stranded} conversation${stranded === 1 ? "" : "s"} would change provider, but the other provider has no usable account right now, so they stay put.`);
  if (pinnedToClaude > 0) notes.push(`${pinnedToClaude} housekeeping conversation${pinnedToClaude === 1 ? " runs" : "s run"} on the Claude harness, which cannot use Codex, so they stay on Claude.`);

  for (const provider of ["anthropic", "openai"] as const) {
    const accounts = views.filter((view) => view.account.provider === provider);
    const live = accounts.filter((view) => view.usable);
    const members = sessions.filter((session) => desired.get(session.agentId) === provider);
    const totalPace = live.reduce((sum, view) => sum + view.pace, 0);
    if (members.length === 0 || totalPace <= 0) {
      if (members.length > 0 && accounts.length > 0) notes.push(`No ${providerName(provider)} account has headroom, so ${providerName(provider)} conversations stay where they are.`);
      continue;
    }
    const total = members.reduce((sum, session) => sum + session.load, 0);
    const target = new Map(accounts.map((view) => [view.account.id, view.usable ? (total * view.pace) / totalPace : 0]));
    const load = new Map(accounts.map((view) => [view.account.id, 0]));
    const at = (session: Session) => placement.get(session.agentId);
    for (const session of members) {
      const id = at(session);
      if (id) load.set(id, (load.get(id) ?? 0) + session.load);
    }
    // Conversations arriving from the other provider go where there is the most room.
    for (const session of members.filter((candidate) => !at(candidate)).sort((a, b) => b.load - a.load)) {
      const best = live.reduce((top, view) =>
        (target.get(view.account.id) ?? 0) - (load.get(view.account.id) ?? 0) > (target.get(top.account.id) ?? 0) - (load.get(top.account.id) ?? 0) ? view : top,
      );
      placement.set(session.agentId, best.account.id);
      load.set(best.account.id, (load.get(best.account.id) ?? 0) + session.load);
    }
    for (let iteration = 0; iteration < 200; iteration += 1) {
      const dev = (id: string) => (load.get(id) ?? 0) - (target.get(id) ?? 0);
      const sources = accounts.filter((view) => members.some((session) => at(session) === view.account.id)).sort((a, b) => dev(b.account.id) - dev(a.account.id));
      const destination = live.reduce((low, view) => (dev(view.account.id) < dev(low.account.id) ? view : low));
      let moved = false;
      for (const source of sources) {
        if (source.account.id === destination.account.id || dev(source.account.id) < BALANCE_TOLERANCE) break;
        const before = Math.abs(dev(source.account.id)) + Math.abs(dev(destination.account.id));
        let best: { session: Session; cost: number } | null = null;
        for (const session of members) {
          if (at(session) !== source.account.id) continue;
          const after = Math.abs(dev(source.account.id) - session.load) + Math.abs(dev(destination.account.id) + session.load);
          if (after > before - MIN_IMPROVEMENT) continue;
          const cost = after + (session.running ? RUNNING_MOVE_PENALTY : 0);
          if (!best || cost < best.cost) best = { session, cost };
        }
        if (!best) continue;
        placement.set(best.session.agentId, destination.account.id);
        load.set(source.account.id, (load.get(source.account.id) ?? 0) - best.session.load);
        load.set(destination.account.id, (load.get(destination.account.id) ?? 0) + best.session.load);
        moved = true;
        break;
      }
      if (!moved) break;
    }
  }
  for (const view of views) if (!view.usable && view.note) notes.push(`${view.account.email}: ${view.note}, so it takes no new load until then.`);
  return { placement, notes };
}

/** One light Codex call per Balance press, covering only conversations the user has not settled by hand. */
async function classifySessions(sessions: Session[]): Promise<string | null> {
  const open = sessions.filter((session) => session.tierSource !== "manual" && session.canUse.length > 1);
  if (open.length === 0) return null;
  const model = await classifierModel().catch(() => undefined);
  if (!model) return "No Codex model is available to sort conversations, so housekeeping is guessed from titles.";
  const outcome = await classifyWithLlm(
    open.map((session) => ({
      agentId: session.agentId,
      sessionId: session.owners.find((owner) => owner.startsWith("ses_")) ?? null,
      title: session.title,
      mode: session.mode,
      workspace: session.workspace,
      running: session.running,
    })),
    model,
  );
  for (const session of open) {
    const verdict = outcome.results.get(session.agentId);
    if (!verdict) continue;
    session.tier = verdict.tier;
    session.tierSource = "ai";
    session.tierReason = verdict.reason;
  }
  if (outcome.error) return `${model.label} could not be reached (${outcome.error}), so housekeeping is guessed from titles.`;
  const seconds = (outcome.ms / 1000).toFixed(1);
  return `${model.label} sorted ${outcome.called} conversation${outcome.called === 1 ? "" : "s"} into careful or housekeeping in ${seconds}s${outcome.reused > 0 ? ` (${outcome.reused} reused from the last run)` : ""}.`;
}

export async function planBalance(input: RpcInput<typeof balancePlanRpc>) {
  const settings = await withStore((store) => {
    const next = { ...DEFAULT_BALANCE_SETTINGS, ...store.balanceSettings };
    if (input.housekeepingToCodex !== undefined) next.housekeepingToCodex = input.housekeepingToCodex;
    if (input.aiSort !== undefined) next.aiSort = input.aiSort;
    store.balanceSettings = next;
    return next;
  });
  const { store, sessions, views } = await collect();
  const classifierNote = settings.aiSort ? await classifySessions(sessions) : null;
  const { placement, notes: placementNotes } = placeSessions(sessions, views, settings.housekeepingToCodex);
  const notes = [...(classifierNote ? [classifierNote] : []), ...placementNotes];
  const viewById = new Map(views.map((view) => [view.account.id, view]));
  const moves = sessions.flatMap((session) => {
    const toId = placement.get(session.agentId);
    const to = toId ? viewById.get(toId)?.account : undefined;
    if (!to || to.id === session.account.id) return [];
    const crossProvider = to.provider !== session.provider;
    const reason = crossProvider
      ? to.provider === "openai"
        ? "Housekeeping belongs on Codex"
        : "Careful work belongs on Claude"
      : `Evens out ${providerName(to.provider)} load toward its pace`;
    return [
      {
        agentId: session.agentId,
        title: session.title,
        running: session.running,
        tier: session.tier,
        tierSource: session.tierSource,
        tierReason: session.tierReason,
        fromAccountId: session.account.id,
        fromEmail: session.account.email,
        toAccountId: to.id,
        toEmail: to.email,
        toProvider: to.provider,
        crossProvider,
        reason,
      },
    ];
  });
  moves.sort((a, b) => Number(b.crossProvider) - Number(a.crossProvider) || Number(b.running) - Number(a.running));
  const finalAccount = (session: Session) => placement.get(session.agentId) ?? session.account.id;
  return {
    settings,
    moves,
    accounts: summarize(views, sessions, finalAccount),
    notes,
    busy: isJobRunning(),
    releasesForce: Object.values(store.preferredAccountIds ?? {}).some(Boolean),
  };
}

/** Beyond this much load (about two running conversations) sitting on the wrong account is worth acting on now. */
const RED_MOVED_LOAD = 2;

/**
 * Green: nothing would move. Orange: moves exist but nothing is at risk. Red: work is stuck on an account
 * that cannot serve it, careful work sits on Codex, or a lot of load is in the wrong place.
 */
export async function getHealth(_input: RpcInput<typeof healthRpc>) {
  const { store, sessions, views } = await collect();
  const { housekeepingToCodex } = { ...DEFAULT_BALANCE_SETTINGS, ...store.balanceSettings };
  const { placement } = placeSessions(sessions, views, housekeepingToCodex);
  const viewById = new Map(views.map((view) => [view.account.id, view]));
  const red: string[] = [];
  const orange: string[] = [];
  let movedLoad = 0;
  let moves = 0;
  let guessed = false;

  const blocked = new Map<string, { runningCount: number; idleCount: number }>();
  let carefulOnCodex = { running: 0, idle: 0 };
  let housekeepingOnClaude = 0;
  let housekeepingRunningOnClaude = 0;
  for (const session of sessions) {
    const toId = placement.get(session.agentId);
    const to = toId ? viewById.get(toId)?.account : undefined;
    if (!to || to.id === session.account.id) continue;
    moves += 1;
    movedLoad += session.load;
    if (session.tierSource === "auto") guessed = true;
    const from = viewById.get(session.account.id);
    if (from && !from.usable) {
      const entry = blocked.get(from.account.email) ?? { runningCount: 0, idleCount: 0 };
      if (session.running) entry.runningCount += 1;
      else entry.idleCount += 1;
      blocked.set(from.account.email, entry);
    } else if (session.provider === "openai" && to.provider === "anthropic") {
      if (session.running) carefulOnCodex.running += 1;
      else carefulOnCodex.idle += 1;
    } else if (session.provider === "anthropic" && to.provider === "openai") {
      housekeepingOnClaude += 1;
      if (session.running) housekeepingRunningOnClaude += 1;
    }
  }
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const sit = (count: number) => (count === 1 ? "sits" : "sit");
  for (const [email, entry] of blocked) {
    const view = views.find((candidate) => candidate.account.email === email && !candidate.usable);
    const why = view?.note ?? "unavailable";
    if (entry.runningCount > 0) red.push(`${plural(entry.runningCount, "running conversation")} ${sit(entry.runningCount)} on ${email}: ${why}.`);
    else if (entry.idleCount > 0) orange.push(`${plural(entry.idleCount, "idle conversation")} ${entry.idleCount === 1 ? "is" : "are"} pinned to ${email}: ${why}.`);
  }
  if (carefulOnCodex.running > 0) red.push(`${plural(carefulOnCodex.running, "running careful conversation")} run on Codex, which is meant for housekeeping.`);
  else if (carefulOnCodex.idle > 0) orange.push(`${plural(carefulOnCodex.idle, "careful conversation")} ${sit(carefulOnCodex.idle)} on Codex, which is meant for housekeeping.`);
  if (housekeepingRunningOnClaude > 0 && movedLoad >= RED_MOVED_LOAD) {
    red.push(`${plural(housekeepingRunningOnClaude, "running housekeeping conversation")} ${housekeepingRunningOnClaude === 1 ? "is" : "are"} spending Claude quota that Codex could take.`);
  } else if (housekeepingOnClaude > 0) orange.push(`${plural(housekeepingOnClaude, "housekeeping conversation")} still use${housekeepingOnClaude === 1 ? "s" : ""} Claude quota that Codex could take.`);
  for (const provider of ["anthropic", "openai"] as const) {
    const pool = views.filter((view) => view.account.provider === provider);
    if (pool.length === 0 || pool.some((view) => view.usable)) continue;
    const stuck = sessions.filter((session) => session.provider === provider && session.running).length;
    if (stuck > 0) red.push(`Every ${providerName(provider)} account is at its limit with ${plural(stuck, "conversation")} running.`);
  }
  if (red.length === 0 && orange.length === 0 && moves > 0) {
    (movedLoad >= RED_MOVED_LOAD ? red : orange).push(
      movedLoad >= RED_MOVED_LOAD ? "Load is far from the pace each account can sustain." : "Load is slightly off the pace each account can sustain.",
    );
  }

  const level = red.length > 0 ? "red" : orange.length > 0 ? "orange" : "green";
  const headline =
    level === "green" ? "Balanced: nothing to move" : level === "orange" ? "Could be better" : "Rebalance now";
  return { level, headline, reasons: [...red, ...orange].slice(0, 3), moves, guessed } as const;
}

export async function setSessionTier({ agentId, tier }: RpcInput<typeof setTierRpc>) {
  const agents = await liveAgents();
  const agent = agents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error("Conversation not found");
  // Back to what the model (or keywords) said means the override is no longer needed.
  const judged = cachedClassification(agentId) ?? keywordTier(agent);
  const source = cachedClassification(agentId) ? ("ai" as const) : ("auto" as const);
  await withStore((store) => {
    store.sessionTiers ??= {};
    if (tier === judged.tier) delete store.sessionTiers[agentId];
    else store.sessionTiers[agentId] = tier;
  });
  return { tier, tierSource: tier === judged.tier ? source : ("manual" as const) };
}

/** Every OpenCode session under the given roots, roots included. */
async function descendantSessions(rootIds: string[]): Promise<{ ids: string[]; warning: string | null }> {
  const safe = rootIds.filter((id) => /^ses_[A-Za-z0-9]+$/.test(id));
  if (safe.length === 0) return { ids: [], warning: null };
  const list = safe.map((id) => `'${id}'`).join(",");
  const sql = `WITH RECURSIVE t(id) AS (SELECT id FROM session WHERE id IN (${list}) UNION SELECT s.id FROM session s JOIN t ON s.parent_id = t.id) SELECT id FROM t;`;
  try {
    const { stdout } = await execFileAsync(sqlitePath(), ["-readonly", OPENCODE_DB, sql], { timeout: 15_000, maxBuffer: 4_000_000 });
    return { ids: stdout.split("\n").map((line) => line.trim()).filter(Boolean), warning: null };
  } catch (error) {
    return { ids: [], warning: `Could not look up sub-sessions (${message(error).slice(0, 80)}); they follow their parent's account from their next call` };
  }
}


async function runBalance(job: Job, moves: { agentId: string; account: StoredAccount }[], releaseForced: boolean): Promise<void> {
  const targets = [...new Map(moves.map((move) => [move.account.id, move.account])).values()];
  for (const target of targets) {
    await refreshUsage(target.id);
  }
  let store = await readStore();
  for (const target of targets) {
    const fresh = store.accounts.find((account) => account.id === target.id);
    if (!fresh) throw new Error(`${target.email} was removed`);
    if (fresh.usageError && /\((401|403)\)/.test(fresh.usageError)) {
      throw new Error(`${fresh.email} rejected its credentials (${fresh.usageError}). Reconnect it first; nothing was changed.`);
    }
  }
  const now = Date.now();
  const agents = new Map((await liveAgents()).map((agent) => [agent.id, agent]));
  const plan = moves.flatMap(({ agentId, account }) => {
    const agent = agents.get(agentId);
    const session = agent ? buildSession(agent, store, now) : null;
    return agent && session ? [{ agent, session, target: store.accounts.find((candidate) => candidate.id === account.id) ?? account }] : [];
  });
  job.total = plan.length;
  job.phase = "applying";

  // Sub-sessions (subagents) carry their own pins, so they move with their parent.
  const families: { target: StoredAccount; owners: string[] }[] = [];
  let lookupWarning: string | null = null;
  for (const { session, target } of plan) {
    const subs = await descendantSessions(session.owners.filter((owner) => owner.startsWith("ses_")));
    lookupWarning ??= subs.warning;
    families.push({ target, owners: [...new Set([...session.owners, ...subs.ids])] });
  }
  job.assignments = await withStore((fresh) => {
    let pins = 0;
    for (const { target, owners } of families) {
      for (const owner of owners) {
        fresh.assignments[assignmentKey(target.provider, owner)] = target.id;
        pins += 1;
      }
    }
    if (releaseForced) fresh.preferredAccountIds = {};
    return pins;
  });
  if (lookupWarning) console.error(`[${PLUGIN_ID}] ${lookupWarning}`);

  store = await readStore();
  const models: Record<AccountProvider, string | null> = {
    anthropic: await providerModel("anthropic", store.preferredModelIds?.anthropic),
    openai: await providerModel("openai", store.preferredModelIds?.openai),
  };
  const candidates = plan.map(({ agent, session, target }) => {
    const candidate: Candidate = {
      agentId: agent.id,
      provider: agent.provider,
      title: session.title,
      running: session.running,
      fromEmail: session.account.email,
      owners: session.owners,
    };
    return { candidate, target, newModel: target.provider !== session.provider ? models[target.provider] : null };
  });
  await runPool(candidates, CONCURRENCY, ({ candidate, target, newModel }) => moveAgent(job, target, candidate, newModel));
}

export async function startBalance({ moves, releaseForced }: RpcInput<typeof balanceStartRpc>) {
  if (isJobRunning()) throw new Error("A switch is already running");
  const store = await readStore();
  const agents = new Map((await liveAgents()).map((agent) => [agent.id, agent]));
  const resolved = moves.map((move) => {
    const account = store.accounts.find((candidate) => candidate.id === move.accountId);
    if (!account) throw new Error("A target account no longer exists");
    const blocker = targetBlocker(account);
    if (blocker) throw new Error(blocker);
    const agent = agents.get(move.agentId);
    if (!agent) throw new Error("A conversation in the plan is no longer open; plan again");
    const harness = harnessFor({ provider: agent.provider, model: agent.model ?? null });
    if (!harness.providers.includes(account.provider)) {
      throw new Error(`"${agent.title ?? agent.id}" runs on a harness that cannot use ${providerName(account.provider)}`);
    }
    return { agentId: move.agentId, account };
  });

  const job: Job = {
    id: randomUUID(),
    kind: "balance",
    provider: null,
    accountId: "",
    email: "balanced accounts",
    phase: "preparing",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    total: resolved.length,
    completed: 0,
    assignments: 0,
    results: [],
  };
  launchJob(job, () => runBalance(job, resolved, releaseForced));
  return { jobId: job.id };
}
