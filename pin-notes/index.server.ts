import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPinTools } from "./server/agent-tools";
import { createPinService } from "./server/pins";
import { listPinsRpc, removePinRpc, savePinRpc } from "./shared/pins";

export default function contribute(server: PluginServerContext) {
  const pins = createPinService();
  const tools = createPinTools(pins);

  server.handle(listPinsRpc, async () => ({ pins: await pins.list() }));
  server.handle(savePinRpc, (input) => pins.create({ ...input, createdBy: "user" }));
  server.handle(removePinRpc, async ({ id }) => ({ removed: await pins.remove(id) }));
  server.addHook("agent.open.before", async ({ request }) => ({
    ...request,
    tools: [...request.tools, ...tools],
  }));
  return () => {};
}
