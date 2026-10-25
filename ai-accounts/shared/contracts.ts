import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export { USABILITY_CEILING } from "./limits";

export const providerSchema = z.enum(["anthropic", "openai"]);

const usageWindowSchema = z.object({
  label: z.string(),
  utilization: z.number(),
  resetsAt: z.string().nullable(),
  blocked: z.boolean(),
});

const accountSchema = z.object({
  id: z.string(),
  provider: providerSchema,
  email: z.string(),
  plan: z.string().nullable(),
  isDefault: z.boolean(),
  isAssigned: z.boolean(),
  usage: z.array(usageWindowSchema),
  usageFetchedAt: z.string().nullable(),
  usageError: z.string().nullable(),
  needsReauth: z.boolean(),
});

export const accountStateRpc = defineRpc({
  name: "ai-accounts.state",
  input: z.object({ provider: providerSchema, agentId: z.string().optional(), refreshUsage: z.boolean().default(false) }),
  output: z.object({
    accounts: z.array(accountSchema),
    activeAccountId: z.string().nullable(),
    /** The account a Claude Code conversation's running process was started with; null when it predates the plugin. */
    launchedAccountId: z.string().nullable(),
    recommendedAccountId: z.string().nullable(),
    recommendedProvider: providerSchema.nullable(),
    recommendationReason: z.string().nullable(),
    preferredAccountId: z.string().nullable(),
    /** Set for a day after ai-accounts removed this provider's original auth plugin from the OpenCode config. */
    openCodeHandover: z.object({ plugin: z.string(), config: z.string(), at: z.string() }).nullable(),
    exhausted: z.boolean(),
    recovery: z
      .object({ accountId: z.string(), email: z.string(), label: z.string(), resetsAt: z.string().nullable() })
      .nullable(),
  }),
});

export const beginLoginRpc = defineRpc({
  name: "ai-accounts.login.begin",
  input: z.object({ provider: providerSchema }),
  output: z.object({ flowId: z.string(), url: z.string().url(), browserOpened: z.boolean() }),
});

export const reopenLoginRpc = defineRpc({
  name: "ai-accounts.login.reopen",
  input: z.object({ flowId: z.string() }),
  output: z.object({ browserOpened: z.boolean() }),
});

export const completeLoginRpc = defineRpc({
  name: "ai-accounts.login.complete",
  input: z.object({ flowId: z.string(), callback: z.string().min(1) }),
  output: z.object({ accountId: z.string(), email: z.string() }),
});

export const switchAccountRpc = defineRpc({
  name: "ai-accounts.switch",
  input: z.object({ provider: providerSchema, agentId: z.string(), accountId: z.string() }),
  output: z.object({ activeAccountId: z.string(), modelId: z.string().nullable(), reloaded: z.boolean() }),
});

export const setPreferredAccountRpc = defineRpc({
  name: "ai-accounts.preferred.set",
  input: z.object({ provider: providerSchema, accountId: z.string().nullable() }),
  output: z.object({ preferredAccountId: z.string().nullable() }),
});

export const modelCatalogRpc = defineRpc({
  name: "ai-accounts.models",
  input: z.object({ provider: providerSchema }),
  output: z.object({
    models: z.array(z.object({ id: z.string(), label: z.string() })),
    preferredModelId: z.string().nullable(),
  }),
});

export const setPreferredModelRpc = defineRpc({
  name: "ai-accounts.models.preferred.set",
  input: z.object({ provider: providerSchema, modelId: z.string().min(1) }),
  output: z.object({ preferredModelId: z.string() }),
});

const forceTargetInput = z.object({ provider: providerSchema, accountId: z.string() });

export const forcePlanRpc = defineRpc({
  name: "ai-accounts.force.plan",
  input: forceTargetInput,
  output: z.object({
    email: z.string(),
    /** Conversations that would leave their current account. `running` ones get paused, then continued. */
    agents: z.array(z.object({ agentId: z.string(), title: z.string(), running: z.boolean(), fromEmail: z.string().nullable() })),
    /** Stored pins (conversations, sub-sessions) that would be re-pointed at the target. */
    assignments: z.number(),
    busy: z.boolean(),
    blocker: z.string().nullable(),
  }),
});

export const forceStartRpc = defineRpc({
  name: "ai-accounts.force.start",
  input: forceTargetInput,
  output: z.object({ jobId: z.string() }),
});

export const forceOutcomeSchema = z.enum(["reassigned", "resumed", "failed"]);

export const forceJobSchema = z.object({
  id: z.string(),
  /** "force" moves everything to one account; "balance" applies a set of per-conversation moves. */
  kind: z.enum(["force", "balance"]),
  provider: providerSchema.nullable(),
  accountId: z.string(),
  email: z.string(),
  phase: z.enum(["preparing", "applying", "done", "failed"]),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
  total: z.number(),
  completed: z.number(),
  assignments: z.number(),
  results: z.array(z.object({ agentId: z.string(), title: z.string(), outcome: forceOutcomeSchema, detail: z.string().nullable() })),
});

export type ForceJob = z.infer<typeof forceJobSchema>;

export const forceStatusRpc = defineRpc({
  name: "ai-accounts.force.status",
  input: z.object({}),
  output: z.object({ job: forceJobSchema.nullable() }),
});

/** `careful` work (implementation, testing, reasoning) belongs on Claude; `housekeeping` is admin and chores that Codex can take. */
export const tierSchema = z.enum(["careful", "housekeeping"]);
export type Tier = z.infer<typeof tierSchema>;
/** `manual` was chosen by the user, `ai` by the classifier model, `auto` is the keyword fallback. */
export const tierSourceSchema = z.enum(["manual", "ai", "auto"]);

const sessionSchema = z.object({
  agentId: z.string(),
  title: z.string(),
  running: z.boolean(),
  mode: z.string().nullable(),
  harness: z.enum(["opencode", "claude", "codex", "other"]),
  model: z.string().nullable(),
  provider: providerSchema.nullable(),
  accountId: z.string().nullable(),
  email: z.string().nullable(),
  tier: tierSchema,
  tierSource: tierSourceSchema,
  tierReason: z.string().nullable(),
  /** Providers this conversation can run on: only the OpenCode harness spans both. */
  canUse: z.array(providerSchema),
  /** How much of the account's quota it is expected to burn: running 1, recently active 0.35, dormant 0.05. */
  load: z.number(),
  workspace: z.string().nullable(),
  /** The name Paseo's sidebar shows for the conversation's workspace. */
  workspaceTitle: z.string().nullable(),
  /** How many open conversations share that workspace, so a shared name can be told apart. */
  workspaceSessions: z.number(),
  updatedAt: z.string().nullable(),
});

const balanceAccountSchema = z.object({
  accountId: z.string(),
  provider: providerSchema,
  email: z.string(),
  running: z.number(),
  idle: z.number(),
  load: z.number(),
  /** Share of this provider's load, 0..1, now and after the proposed moves / ideal. */
  share: z.number(),
  idealShare: z.number(),
  /** Quota that can be spent per hour without hitting any window before it resets, in percent of the plan. */
  pace: z.number(),
  usable: z.boolean(),
  note: z.string().nullable(),
});

export const sessionsRpc = defineRpc({
  name: "ai-accounts.sessions",
  input: z.object({}),
  output: z.object({
    sessions: z.array(sessionSchema),
    accounts: z.array(balanceAccountSchema),
    forced: z.record(z.string(), z.string()),
  }),
});

const moveSchema = z.object({
  agentId: z.string(),
  title: z.string(),
  running: z.boolean(),
  tier: tierSchema,
  tierSource: tierSourceSchema,
  tierReason: z.string().nullable(),
  fromAccountId: z.string().nullable(),
  fromEmail: z.string().nullable(),
  toAccountId: z.string(),
  toEmail: z.string(),
  toProvider: providerSchema,
  crossProvider: z.boolean(),
  reason: z.string(),
});

export const balancePlanRpc = defineRpc({
  name: "ai-accounts.balance.plan",
  input: z.object({ housekeepingToCodex: z.boolean().optional(), aiSort: z.boolean().optional() }),
  output: z.object({
    settings: z.object({ housekeepingToCodex: z.boolean(), aiSort: z.boolean() }),
    moves: z.array(moveSchema),
    /** Same shape as `sessions.accounts`, but `share` is where each account lands after every move. */
    accounts: z.array(balanceAccountSchema),
    notes: z.array(z.string()),
    busy: z.boolean(),
    releasesForce: z.boolean(),
  }),
});

export const balanceStartRpc = defineRpc({
  name: "ai-accounts.balance.start",
  input: z.object({
    moves: z.array(z.object({ agentId: z.string(), accountId: z.string() })).min(1),
    releaseForced: z.boolean().default(true),
  }),
  output: z.object({ jobId: z.string() }),
});

export const healthLevelSchema = z.enum(["green", "orange", "red"]);
export type HealthLevel = z.infer<typeof healthLevelSchema>;

/** Is the current spread of conversations the best one available? Cheap and model-free, so it can refresh by itself. */
export const healthRpc = defineRpc({
  name: "ai-accounts.health",
  input: z.object({}),
  output: z.object({
    level: healthLevelSchema,
    headline: z.string(),
    /** The few things that explain the verdict, worst first. */
    reasons: z.array(z.string()),
    moves: z.number(),
    /** True when part of the verdict rests on title keywords because Balance has not judged those conversations yet. */
    guessed: z.boolean(),
  }),
});

export const setTierRpc = defineRpc({
  name: "ai-accounts.session.tier",
  input: z.object({ agentId: z.string(), tier: tierSchema }),
  output: z.object({ tier: tierSchema, tierSource: tierSourceSchema }),
});

export const removeAccountRpc = defineRpc({
  name: "ai-accounts.remove",
  input: z.object({ provider: providerSchema, accountId: z.string() }),
  output: z.object({ removed: z.boolean() }),
});
