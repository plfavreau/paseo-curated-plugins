import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export type Level = "green" | "orange" | "red";

/** Green below 80%, orange from 80%, red above 95%. */
export function levelFor(percent: number): Level {
  if (percent > 95) return "red";
  if (percent >= 80) return "orange";
  return "green";
}

export const DEFAULT_PROMPT =
  "New cleanup round from the System health sidebar item. Current state: {stats}. " +
  "Measure what takes space and memory on this machine, show me what we can free now ranked by risk, " +
  "and wait for my go before deleting anything.";

export const preferences = defineSettings({
  id: "cleanup",
  scope: "host",
  version: 2,
  schema: z.object({
    /** Workspace (sidebar session) whose latest agent receives the Clean message. Empty until picked. */
    targetWorkspaceId: z.string().default(""),
    /** Message sent on Clean. `{stats}` is replaced with the current readings. */
    prompt: z.string().default(DEFAULT_PROMPT),
  }),
  migrate: (values) => {
    const old = (values ?? {}) as { prompt?: string };
    return { targetWorkspaceId: "", prompt: old.prompt ?? DEFAULT_PROMPT };
  },
});

const metric = z.object({
  percent: z.number(),
  detail: z.string(),
});

export const statsRpc = defineRpc({
  name: "system.stats",
  input: z.object({}),
  output: z.object({ cpu: metric, ram: metric, disk: metric }),
});

/** A sidebar entry: one workspace, titled and grouped like the Paseo sidebar. */
export const session = z.object({
  id: z.string(),
  title: z.string(),
  group: z.enum(["Pinned", "Working", "Needs input", "Failed", "Done"]),
});
export type Session = z.infer<typeof session>;

export const sessionsRpc = defineRpc({
  name: "system.sessions",
  input: z.object({}),
  output: z.object({ sessions: z.array(session) }),
});

export const cleanRpc = defineRpc({
  name: "system.clean",
  input: z.object({ stats: z.string() }),
  output: z.object({ agentId: z.string() }),
});
