import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPinTools } from "./server/agent-tools";
import { createPinService } from "./server/pins";
import { listPinsRpc, removePinRpc, savePinRpc } from "./shared/pins";

const PIN_GUIDANCE =
  "This conversation has pins: links and notes shown to the user above the composer, managed with the " +
  "pins_list, pin_set and pin_remove tools (load them through tool search if they are deferred). " +
  "Call pins_list when you start a task. Pin the ticket, the PRs and the preview URLs you work with as soon as they exist, " +
  "and remove the pins you created once they are stale.";

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
