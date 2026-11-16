import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadStatus, rerunFailed } from "./server/pr";
import { prStatusRpc, rerunFailedRpc } from "./shared/pr";

export default function contribute(server: PluginServerContext) {
  server.handle(prStatusRpc, async (input) => {
    const result = await loadStatus(input);
    if (result.error) console.log(`[pr-card] status ${JSON.stringify(input)} -> error: ${result.error}`);
    return result;
  });
  server.handle(rerunFailedRpc, async (input) => {
    const result = await rerunFailed(input);
    console.log(`[pr-card] rerun ${input.owner}/${input.repo} ${input.runIds.join(",")} -> ${result.rerun} ${result.error ?? ""}`);
    return result;
  });
  return () => {};
}
