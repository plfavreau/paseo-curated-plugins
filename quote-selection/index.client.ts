import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Notebook } from "./client/notes";
import { installPills } from "./client/pill";
import { installWeb } from "./client/web";

export default function contribute(client: PluginClientContext) {
  const notebook = new Notebook(client.paseo);
  const workspaces = new Map<string, string>();
  const pills = installPills(client, notebook, (agentId) => workspaces.get(agentId) ?? null);
  const removeWeb = installWeb(notebook);

  const lifetime = new AbortController();
  const observe = (agent: { id: string; workspaceId?: string | null; metadata?: unknown }) => {
    if (agent.workspaceId) workspaces.set(agent.id, agent.workspaceId);
    notebook.observe(agent.id, agent.metadata);
  };
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const { agent } of entries) observe(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") observe(update.agent);
          else {
            workspaces.delete(update.agentId);
            notebook.forget(update.agentId);
          }
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.error("[quote-selection] could not watch agents", error);
    });

  return () => {
    lifetime.abort();
    removeWeb();
    pills.dispose();
  };
}
