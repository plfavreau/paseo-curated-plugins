import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readStats } from "./server/stats";
import { cleanRpc, DEFAULT_PROMPT, preferences, sessionsRpc, statsRpc, type Session } from "./shared/contracts";

type Group = Session["group"];
const GROUP_ORDER: Group[] = ["Pinned", "Working", "Needs input", "Failed", "Done"];

function groupFor(status: string, pinnedAt: string | null | undefined): Group {
  if (pinnedAt) return "Pinned";
  if (status === "running") return "Working";
  if (status === "needs_input" || status === "attention") return "Needs input";
  if (status === "failed") return "Failed";
  return "Done";
}

/** Workspaces as the sidebar lists them: pinned first, then by status, newest status change first. */
async function listSessions(paseo: PaseoApi): Promise<Session[]> {
  const { entries } = await paseo.workspaces.list();
  const rows = entries
    .filter((w) => !w.background && !w.internal && !w.archivingAt)
    .map((w) => ({
      id: w.id,
      title: w.title || w.name,
      group: groupFor(w.status, w.pinnedAt),
      sortKey: w.pinnedAt ? w.pinnedAt : (w.statusEnteredAt ?? w.activityAt ?? ""),
    }));
  rows.sort((a, b) => {
    const g = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (g !== 0) return g;
    // Pinned keep pin order; other groups show the most recent first.
    return a.group === "Pinned" ? a.sortKey.localeCompare(b.sortKey) : b.sortKey.localeCompare(a.sortKey);
  });
  return rows.map(({ id, title, group }) => ({ id, title, group }));
}

/** The agent of a workspace that a message should go to: its most recently active one. */
async function latestAgent(paseo: PaseoApi, workspaceId: string): Promise<string> {
  const { entries } = await paseo.agents.list();
  const candidates = entries
    .map(({ agent }) => agent as { id: string; workspaceId?: string | null; updatedAt?: string; archivedAt?: string | null; status?: string })
    .filter((a) => a.workspaceId === workspaceId && !a.archivedAt && a.status !== "closed")
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  if (!candidates.length) throw new Error("That session has no active agent anymore. Pick another one.");
  return candidates[0].id;
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);

  server.handle(statsRpc, () => readStats());

  server.handle(sessionsRpc, async (_input, { paseo }) => ({ sessions: await listSessions(paseo) }));

  server.handle(cleanRpc, async ({ stats }, { paseo }) => {
    const current = await settings.read();
    if (current.status !== "ready" || !current.values.targetWorkspaceId) {
      throw new Error("Pick a session to send the cleanup to first.");
    }
    const agentId = await latestAgent(paseo, current.values.targetWorkspaceId);
    const template = current.values.prompt.trim() || DEFAULT_PROMPT;
    const text = template.includes("{stats}") ? template.replaceAll("{stats}", stats) : `${template}\n\nCurrent state: ${stats}`;
    await paseo.agents.ref(agentId).send(text);
    return { agentId };
  });

  return () => {};
}
