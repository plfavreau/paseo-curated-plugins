import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { Pin } from "../shared/pins.ts";
import type { PinService } from "./pins.ts";

function describe(pin: Pin) {
  const target = pin.url ?? pin.body.replace(/\s+/g, " ").slice(0, 200);
  return `- ${pin.id} · ${pin.title} · ${target} · pinned by ${pin.createdBy}`;
}

function missing(id: string) {
  return { isError: true, text: `No pin ${id} in this conversation.` };
}

export function createPinTools(pins: PinService) {
  async function conversationPin(agentId: string, id: string) {
    return (await pins.list()).find((pin) => pin.id === id && pin.agentId === agentId);
  }

  const list = defineAgentTool({
    name: "pins_list",
    description:
      "List this conversation's pins: links and notes the user sees as pills above the composer. " +
      "The user often pins the ticket, PR or preview URL the work is about, so check them when you start a task.",
    input: z.object({}),
    async execute(_input, { agent }) {
      const own = (await pins.list()).filter((pin) => pin.agentId === agent.id);
      return { text: own.length ? own.map(describe).join("\n") : "No pins in this conversation." };
    },
  });

  const set = defineAgentTool({
    name: "pin_set",
    description:
      "Pin a link or a note to this conversation, shown to the user as a pill above the composer, or update a pin by id. " +
      "Pin what the user will want one click away: the ticket you work on, PRs you open or review, preview URLs you start. " +
      "Update a pin when its target changes, such as a preview moving to another port.",
    input: z.object({
      id: z.string().optional().describe("Pin to update; omit to create a pin"),
      body: z.string().optional().describe("A URL or a note; required when creating"),
      title: z
        .string()
        .optional()
        .describe("Pill label; omit it for links, whose page title is fetched"),
    }),
    async execute({ id, body, title }, { agent }) {
      if (id) {
        if (!(await conversationPin(agent.id, id))) return missing(id);
        const pin = await pins.update(id, { body: body?.trim() || undefined, title });
        return pin ? { text: `Updated ${describe(pin)}` } : missing(id);
      }
      if (!body?.trim()) return { isError: true, text: "body is required to create a pin." };
      const pin = await pins.create({
        agentId: agent.id,
        title: title ?? "",
        body: body.trim(),
        createdBy: "agent",
      });
      return { text: `Pinned ${describe(pin)}` };
    },
  });

  const remove = defineAgentTool({
    name: "pin_remove",
    description:
      "Remove a pin from this conversation. Remove pins you created once they are stale, such as a merged PR " +
      "or a stopped preview. Ask the user before removing a pin they created.",
    input: z.object({ id: z.string().describe("Pin to remove") }),
    async execute({ id }, { agent }) {
      if (!(await conversationPin(agent.id, id))) return missing(id);
      await pins.remove(id);
      return { text: `Removed pin ${id}.` };
    },
  });

  return [list, set, remove];
}
