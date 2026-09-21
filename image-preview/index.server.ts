import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadImage, readChunk } from "./server/image";
import { loadImageRpc, readChunkRpc } from "./shared/image";

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
  server.handle(readChunkRpc, async (input) => {
    const result = await readChunk(input);
    console.log(
      `[image-preview] chunk ${input.filePath} @${input.offset} -> ${
        result.error
          ? `error: ${result.error}`
          : `${result.base64?.length ?? 0}b64 of ${result.totalBytes}B eof=${result.eof}`
      }`,
    );
    return result;
  });
  return () => {};
}
