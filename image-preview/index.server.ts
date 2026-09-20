import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadImage, shareImage } from "./server/image";
import { loadImageRpc, shareImageRpc } from "./shared/image";

export default function contribute(server: PluginServerContext) {
  server.handle(loadImageRpc, async (input) => {
    const result = await loadImage(input);
    console.log(
      `[image-preview] load ${input.filePath} -> ${
        result.error ? `error: ${result.error}` : `${result.width}x${result.height} ${result.bytes}B`
      }`,
    );
    return result;
  });
  server.handle(shareImageRpc, async (input) => {
    const result = await shareImage(input);
    console.log(
      `[image-preview] share ${input.filePath} -> ${result.error ? `error: ${result.error}` : "ok"}`,
    );
    return result;
  });
  return () => {};
}
