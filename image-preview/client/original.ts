import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { readChunkRpc } from "../shared/image";

type ReadChunk = (input: RpcInput<typeof readChunkRpc>) => Promise<RpcOutput<typeof readChunkRpc>>;

export interface OriginalFile {
  base64Parts: string[];
  mimeType: string;
  totalBytes: number;
}

/** Formats every browser and React Native decode natively; HEIC, TIFF and friends keep the JPEG preview. */
const DISPLAYABLE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

export const MAX_DISPLAY_BYTES = 16 * 1024 * 1024;

export function canDisplayOriginal(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return DISPLAYABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function decodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length * 3) / 4 - padding;
}

/** Pulls the original file in bounded chunks, because one oversized frame silently kills the relay socket. */
export async function readOriginal(
  readChunk: ReadChunk,
  filePath: string,
  options: { maxBytes?: number; onProgress?: (fraction: number) => void } = {},
): Promise<OriginalFile> {
  const base64Parts: string[] = [];
  let offset = 0;
  for (;;) {
    const result = await readChunk({ filePath, offset });
    if (result.error || result.base64 === null) throw new Error(result.error ?? "Read failed.");
    if (options.maxBytes && result.totalBytes && result.totalBytes > options.maxBytes) {
      throw new Error("File is too large to display.");
    }
    const length = decodedLength(result.base64);
    if (length === 0 && !result.eof) throw new Error("Read stalled.");
    base64Parts.push(result.base64);
    offset += length;
    if (result.totalBytes) options.onProgress?.(Math.min(1, offset / result.totalBytes));
    if (result.eof) {
      return {
        base64Parts,
        mimeType: result.mimeType ?? "application/octet-stream",
        totalBytes: result.totalBytes ?? offset,
      };
    }
  }
}

/** Valid only because CHUNK_BYTES is a multiple of 3, so no chunk but the last carries padding. */
export function toDataUri(file: OriginalFile): string {
  return `data:${file.mimeType};base64,${file.base64Parts.join("")}`;
}
