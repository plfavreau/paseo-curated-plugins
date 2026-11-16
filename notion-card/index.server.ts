import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadPage } from "./server/notion";
import { notionPageRpc } from "./shared/notion";

export default function contribute(server: PluginServerContext) {
  server.handle(notionPageRpc, async (input) => {
    const result = await loadPage(input);
    if (result.error) console.log(`[notion-card] page ${input.pageId} -> error: ${result.error}`);
    return result;
  });
  return () => {};
}
