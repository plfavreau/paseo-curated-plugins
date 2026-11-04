import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listPins, removePin, savePin } from "./server/pins";
import { listPinsRpc, removePinRpc, savePinRpc } from "./shared/pins";

export default function contribute(server: PluginServerContext) {
  server.handle(listPinsRpc, () => listPins());
  server.handle(savePinRpc, (input) => savePin(input));
  server.handle(removePinRpc, ({ id }) => removePin(id));
  return () => {};
}
