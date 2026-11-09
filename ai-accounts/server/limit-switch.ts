import type { PluginHookContext, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { DEFAULT_AUTO_SWITCH, failOver, readStore, refreshUsage, resolveAccount, withStore } from "./account-store";
import { reloadAgent } from "./accounts";
import { isClaudeHarness } from "./claude-session";
import { bindingWindow, toRecommendationAccount } from "./recommendation";
import { SWITCH_NOTE_KIND, SWITCH_NOTE_VERSION, type SwitchNote } from "../shared/contracts";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

const CONTINUE_PROMPT =
  "[AI account picker] Your Claude account hit its usage limit, so this conversation moved to another account and the interrupted turn stopped. Continue the task from where you left off. Re-check the current state (files, git status, running processes) before repeating any step.";
// Only a trigger: the account's own usage reading decides whether it really is at its limit.
const LIMIT_NOTICE = /you['’]ve (?:hit|reached) your [\w\s'’.-]{0,40}limit|usage limit reached/i;
const FAILOVER_WINDOW_MS = 10 * 60_000;
const MAX_FAILOVERS_PER_WINDOW = 4;
const recent = new Map<string, number[]>();

function allowFailover(agentId: string, now = Date.now()): boolean {
  const moves = (recent.get(agentId) ?? []).filter((at) => now - at < FAILOVER_WINDOW_MS);
  if (moves.length >= MAX_FAILOVERS_PER_WINDOW) return false;
  recent.set(agentId, [...moves, now]);
  return true;
}

async function turnNotices(event: TurnEnded, context: PluginHookContext): Promise<string[]> {
  const notices = event.outcome.kind === "failed" ? [event.outcome.error.message] : [];
  try {
    const page = await context.paseo.agents.ref(event.agent.id).timeline.refetch({ direction: "tail", limit: 12 });
    let replies = 0;
    for (const { item } of [...page.entries].reverse()) {
      if (item.type === "user_message") break;
      if (item.type === "error") notices.push(item.message);
      if (item.type === "assistant_message" && replies++ < 2) notices.push(item.text);
    }
  } catch {}
  return notices;
}

async function note(context: PluginHookContext, agentId: string, data: SwitchNote): Promise<void> {
  try {
    await context.paseo.agents.ref(agentId).timeline.append({ type: "plugin", id: `account-switch-${Date.parse(data.at)}`, kind: SWITCH_NOTE_KIND, version: SWITCH_NOTE_VERSION, data });
  } catch {}
}

/** A Claude Code process keeps the login it started with, so moving it means a restart on the new account. */
async function switchClaudeConversation(event: TurnEnded, context: PluginHookContext): Promise<void> {
  const notices = await turnNotices(event, context);
  if (!notices.some((text) => LIMIT_NOTICE.test(text))) return;
  const store = await readStore();
  const settings = { ...DEFAULT_AUTO_SWITCH, ...store.autoSwitch };
  const agentId = event.agent.id;
  const launchedId = store.claudeLaunches?.[agentId] ?? resolveAccount(store, "anthropic", agentId)?.id;
  if (!launchedId || !settings.onLimit) return;
  await refreshUsage(launchedId);
  const launched = (await readStore()).accounts.find((account) => account.id === launchedId);
  const binding = launched && bindingWindow(toRecommendationAccount(launched));
  if (!launched || !binding || !allowFailover(agentId)) return;
  const liftsAt = binding.resetsAt ?? new Date(Date.now() + 60 * 60_000).toISOString();
  const target = await failOver("anthropic", agentId, launched.id, liftsAt);
  if (!target) return;
  await reloadAgent(agentId, 2);
  await withStore((current) => {
    for (const failover of current.failovers ?? []) if (failover.owner === agentId) failover.announced = true;
  });
  await note(context, agentId, { from: launched.email, to: target.email, liftsAt, at: new Date().toISOString() });
  if (settings.continueAfter) await context.paseo.agents.ref(agentId).send(CONTINUE_PROMPT);
}

/** OpenCode moves accounts inside its own process, mid-request; its conversation hears about it here. */
async function announceFailovers(event: TurnEnded, context: PluginHookContext): Promise<void> {
  const sessionId = (await context.paseo.agents.ref(event.agent.id).refresh())?.agent.runtimeInfo?.sessionId;
  const owners = new Set([event.agent.id, sessionId].filter((owner): owner is string => Boolean(owner)));
  const pending = await withStore((store) => {
    const mine = (store.failovers ?? []).filter((failover) => !failover.announced && owners.has(failover.owner));
    for (const failover of mine) failover.announced = true;
    const email = (id: string) => store.accounts.find((account) => account.id === id)?.email ?? null;
    return mine.map((failover) => ({ from: email(failover.fromAccountId), to: email(failover.toAccountId) ?? "another account", liftsAt: failover.limitedUntil, at: failover.at }));
  });
  for (const data of pending) await note(context, event.agent.id, data);
}

export async function onTurnEnded(event: TurnEnded, context: PluginHookContext): Promise<void> {
  try {
    if (isClaudeHarness(event.agent.provider)) await switchClaudeConversation(event, context);
    else if (event.agent.provider.startsWith("opencode")) await announceFailovers(event, context);
  } catch (error) {
    console.error(`[ai-accounts] limit switch failed for ${event.agent.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
