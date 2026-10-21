import { randomUUID } from "node:crypto";
import type { RpcInput } from "@getpaseo/plugin";
import type { z } from "zod";
import { forceJobSchema, forcePlanRpc, forceStartRpc, forceStatusRpc } from "../shared/contracts";
import { harnessFor } from "../shared/harness";
import {
  assignmentKey,
  readStore,
  refreshUsage,
  resolveAccount,
  withStore,
  type AccountProvider,
  type Store,
  type StoredAccount,
} from "./account-store";
import { createDaemonClient, reloadAgent } from "./accounts";

export type Job = z.infer<typeof forceJobSchema>;

const CONCURRENCY = 4;
const PAUSE_TIMEOUT_MS = 20_000;
export const LIVE_STATUSES = ["idle", "running", "initializing", "error"] as const;

let currentJob: Job | null = null;
let jobRunning = false;

export interface Candidate {
  agentId: string;
  provider: string;
  title: string;
  running: boolean;
  fromEmail: string | null;
  owners: string[];
}

export function providerName(provider: AccountProvider): string {
  return provider === "anthropic" ? "Claude" : "Codex";
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function findTarget(store: Store, provider: AccountProvider, accountId: string): StoredAccount {
  const target = store.accounts.find((account) => account.id === accountId && account.provider === provider);
  if (!target) throw new Error(`${providerName(provider)} account not found`);
  return target;
}

/** `needsReauth` can linger after a healthy refresh, so only an expired token makes the account unusable. */
export function targetBlocker(target: StoredAccount): string | null {
  if (target.needsReauth && target.expires <= Date.now() + 60_000) {
    return `${target.email} needs to sign in again before it can take over.`;
  }
  return null;
}

function assignmentsToMove(store: Store, provider: AccountProvider, targetId: string): string[] {
  return Object.entries(store.assignments)
    .filter(([, accountId]) => {
      if (accountId === targetId) return false;
      return store.accounts.find((account) => account.id === accountId)?.provider === provider;
    })
    .map(([key]) => key);
}

async function listCandidates(provider: AccountProvider, target: StoredAccount, store: Store): Promise<Candidate[]> {
  const daemon = createDaemonClient();
  const candidates: Candidate[] = [];
  try {
    await daemon.connect();
    let cursor: string | undefined;
    do {
      const page = await daemon.fetchAgents({
        filter: { statuses: [...LIVE_STATUSES], includeArchived: false },
        page: { limit: 200, cursor },
      });
      for (const { agent } of page.entries) {
        if (harnessFor({ provider: agent.provider, model: agent.model ?? null }).current !== provider) continue;
        const sessionId = agent.runtimeInfo?.sessionId ?? undefined;
        const owners = [sessionId, agent.id].filter((owner): owner is string => Boolean(owner));
        const before = resolveAccount(store, provider, owners);
        if (before?.id === target.id) continue;
        candidates.push({
          agentId: agent.id,
          provider: agent.provider,
          title: agent.title?.trim() || agent.id.slice(0, 8),
          running: agent.status === "running" || agent.status === "initializing",
          fromEmail: before?.email ?? null,
          owners,
        });
      }
      cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
    } while (cursor);
  } finally {
    if (daemon.isConnected) await daemon.close();
  }
  return candidates;
}

export async function planForce({ provider, accountId }: RpcInput<typeof forcePlanRpc>) {
  const store = await readStore();
  const target = findTarget(store, provider, accountId);
  const agents = await listCandidates(provider, target, store);
  return {
    email: target.email,
    agents: agents.map(({ agentId, title, running, fromEmail }) => ({ agentId, title, running, fromEmail })),
    assignments: assignmentsToMove(store, provider, target.id).length,
    busy: jobRunning,
    blocker: targetBlocker(target),
  };
}

function resumePrompt(provider: AccountProvider, fromEmail: string | null, toEmail: string, newModel: string | null): string {
  const from = fromEmail ? ` from ${fromEmail}` : "";
  const model = newModel ? ` The conversation now runs on ${newModel}, so a different model is reading this.` : "";
  return [
    `[AI account picker] Your ${providerName(provider)} account was switched${from} to ${toEmail}, and the turn you were in the middle of was paused for the switch.${model}`,
    "Continue the task from where you left off. Re-check the current state (files, git status, running processes) before repeating any step, since the last tool call may have been cut short.",
  ].join(" ");
}

export async function withDaemon<T>(work: (daemon: ReturnType<typeof createDaemonClient>) => Promise<T>): Promise<T> {
  const daemon = createDaemonClient();
  try {
    await daemon.connect();
    return await work(daemon);
  } finally {
    if (daemon.isConnected) await daemon.close();
  }
}

export async function moveAgent(job: Job, target: StoredAccount, candidate: Candidate, newModel: string | null = null): Promise<void> {
  const provider = target.provider;
  try {
    const result = await withDaemon(async (daemon) => {
      // The snapshot is a few seconds old: a conversation may have started or finished a turn since.
      const live = await daemon.fetchAgent(candidate.agentId);
      const wasRunning = live?.agent.status === "running" || live?.agent.status === "initializing";
      if (wasRunning) {
        await daemon.cancelAgent(candidate.agentId);
        const settled = await daemon.waitForFinish(candidate.agentId, PAUSE_TIMEOUT_MS);
        if (settled.status === "timeout") {
          throw new Error(`Did not stop within ${PAUSE_TIMEOUT_MS / 1000}s; ${target.email} applies from its next turn`);
        }
      }
      // Crossing providers swaps the model too, so the conversation does not keep asking the old vendor.
      if (newModel) await daemon.setAgentModel(candidate.agentId, newModel);
      // Only the Claude harness needs the restart: it bakes the account into the process environment.
      // OpenCode re-reads the account on every request, so a stuck reload must not fail the switch.
      let note: string | null = null;
      try {
        await reloadAgent(candidate.agentId, 2);
      } catch (error) {
        if (!candidate.provider.startsWith("opencode")) throw error;
        note = `Reload failed (${message(error)}); ${target.email} applies from its next request`;
      }
      if (!wasRunning) return { outcome: "reassigned" as const, note };
      const prompt = resumePrompt(provider, candidate.fromEmail, target.email, newModel);
      try {
        await daemon.sendAgentMessage(candidate.agentId, prompt);
      } catch {
        // A freshly reloaded agent can take a moment to accept input.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await daemon.sendAgentMessage(candidate.agentId, prompt);
      }
      return { outcome: "resumed" as const, note };
    });
    job.results.push({ agentId: candidate.agentId, title: candidate.title, outcome: result.outcome, detail: result.note });
  } catch (error) {
    job.results.push({ agentId: candidate.agentId, title: candidate.title, outcome: "failed", detail: message(error) });
  } finally {
    job.completed += 1;
  }
}

export async function runPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  });
  await Promise.all(workers);
}

async function runForce(job: Job, provider: AccountProvider, targetId: string): Promise<void> {
  // Prove the target can actually serve before anything is paused.
  await refreshUsage(targetId);
  const store = await readStore();
  const target = findTarget(store, provider, targetId);
  if (target.usageError && /\((401|403)\)/.test(target.usageError)) {
    throw new Error(`${target.email} rejected its credentials (${target.usageError}). Reconnect it first; nothing was changed.`);
  }
  const candidates = await listCandidates(provider, target, store);
  job.total = candidates.length;
  job.phase = "applying";

  // One atomic write: every stored pin moves, new conversations follow, and each affected
  // conversation is pinned explicitly so it keeps the account if the force is released later.
  job.assignments = await withStore((fresh) => {
    const moving = assignmentsToMove(fresh, provider, target.id);
    for (const key of moving) fresh.assignments[key] = target.id;
    for (const candidate of candidates) {
      for (const owner of candidate.owners) fresh.assignments[assignmentKey(provider, owner)] = target.id;
    }
    (fresh.preferredAccountIds ??= {})[provider] = target.id;
    return moving.length;
  });

  await runPool(candidates, CONCURRENCY, (candidate) => moveAgent(job, target, candidate));
}

export function isJobRunning(): boolean {
  return jobRunning;
}

/** Only one switch at a time: it rewrites pins and reloads agents, so two would trample each other. */
export function launchJob(job: Job, work: () => Promise<void>): void {
  currentJob = job;
  jobRunning = true;
  void work()
    .then(() => {
      job.phase = "done";
    })
    .catch((error: unknown) => {
      job.phase = "failed";
      job.error = message(error);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      jobRunning = false;
    });
}

export async function startForce({ provider, accountId }: RpcInput<typeof forceStartRpc>) {
  if (jobRunning) throw new Error("A force switch is already running");
  const store = await readStore();
  const target = findTarget(store, provider, accountId);
  const blocker = targetBlocker(target);
  if (blocker) throw new Error(blocker);

  const job: Job = {
    id: randomUUID(),
    kind: "force",
    provider,
    accountId: target.id,
    email: target.email,
    phase: "preparing",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    total: 0,
    completed: 0,
    assignments: 0,
    results: [],
  };
  launchJob(job, () => runForce(job, provider, target.id));
  return { jobId: job.id };
}

export async function getForceStatus(_input: RpcInput<typeof forceStatusRpc>) {
  return { job: currentJob ? structuredClone(currentJob) : null };
}
