import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPinTools } from "./server/agent-tools";
import { createPinService } from "./server/pins";
import { listPinsRpc, removePinRpc, savePinRpc } from "./shared/pins";

const PIN_GUIDANCE = [
  "# Pins",
  "The user sees this conversation's pins as one-click pills above the composer. Keep them current with the pins_list, pin_set and pin_remove tools (load them through tool search if they are deferred), even in short tasks:",
  "- At the start of a task, check pins_list: the user often pins the ticket or PR the work is about.",
  "- Whenever a ticket, PR, commit to review or preview URL comes up, from the user or from you, pin it with pin_set in the same turn.",
  "- When a pinned target moves, such as a preview changing port, update its pin.",
  "- Remove the pins you created once they are stale. Ask before removing a pin the user created.",
].join("\n");

export default function contribute(server: PluginServerContext) {
  const pins = createPinService();
  const tools = createPinTools(pins);

  server.handle(listPinsRpc, async () => ({ pins: await pins.list() }));
  server.handle(savePinRpc, (input) => pins.create({ ...input, createdBy: "user" }));
  server.handle(removePinRpc, async ({ id }) => ({ removed: await pins.remove(id) }));
  server.addHook("agent.create.before", async ({ request }) => ({
    ...request,
    config: {
      ...request.config,
      systemPrompt: [request.config.systemPrompt, PIN_GUIDANCE].filter(Boolean).join("\n\n"),
    },
  }));
  server.addHook("agent.open.before", async ({ request }) => ({
    ...request,
    tools: [...request.tools, ...tools],
  }));
  return () => {};
}
