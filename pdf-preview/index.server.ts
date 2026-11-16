import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readChunk, renderPage } from "./server/pdf";
import { readChunkRpc, renderPageRpc } from "./shared/pdf";

export default function contribute(server: PluginServerContext) {
  server.handle(renderPageRpc, async (input) => {
    const result = await renderPage(input);
    if (result.error) console.log(`[pdf-preview] page ${input.page} of ${input.filePath}: ${result.error}`);
    return result;
  });
  server.handle(readChunkRpc, readChunk);
  return () => {};
}
