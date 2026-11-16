import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { readChunkRpc } from "../shared/pdf";
import { base64ToBytes } from "./download";

type ReadChunk = (input: RpcInput<typeof readChunkRpc>) => Promise<RpcOutput<typeof readChunkRpc>>;

function decodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length * 3) / 4 - padding;
}

/** Pulls the original file in bounded chunks, because one oversized frame kills the relay socket. */
export async function readOriginal(
  readChunk: ReadChunk,
  filePath: string,
  onProgress?: (fraction: number) => void,
): Promise<{ parts: Uint8Array[]; mimeType: string }> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const result = await readChunk({ filePath, offset });
    if (result.error || result.base64 === null) throw new Error(result.error ?? "Read failed.");
    const length = decodedLength(result.base64);
    if (length === 0 && !result.eof) throw new Error("Read stalled.");
    parts.push(base64ToBytes(result.base64));
    offset += length;
    if (result.totalBytes) onProgress?.(Math.min(1, offset / result.totalBytes));
    if (result.eof) return { parts, mimeType: result.mimeType ?? "application/pdf" };
  }
}
