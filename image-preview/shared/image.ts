import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Timeline item kind emitted by the transformer and drawn by the renderer. */
// NOTE: the app validates contribution ids/kinds with /^[a-z][a-z0-9-]*$/.
// Dots are rejected and make the whole client bundle fail to evaluate.
export const IMAGE_PREVIEW_KIND = "image-preview-read";
export const IMAGE_PREVIEW_VERSION = 1;

/** File extensions we treat as previewable images. */
export const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".avif",
  ".heic",
  ".heif",
] as const;

export function isPreviewableImage(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

/** Data carried on the plugin timeline row. Kept tiny: just a pointer. */
export const imagePreviewSchema = z.object({
  filePath: z.string(),
  fileName: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
});

export type ImagePreviewData = z.output<typeof imagePreviewSchema>;

/** Daemon-side fetch: reads the file, downscales it, returns a base64 data URI. */
export const loadImageRpc = defineRpc({
  name: "image-preview.load",
  input: z.object({
    filePath: z.string().min(1),
    maxWidth: z.number().int().min(64).max(2048).optional(),
  }),
  output: z.object({
    dataUri: z.string().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    bytes: z.number().nullable(),
    error: z.string().nullable(),
  }),
});

/**
 * Daemon-side chunked read of the ORIGINAL file, used by the download button.
 *
 * The daemon's own /api/files/download route is unreachable from a phone: the
 * relay is a WebSocket-only frame pump, and the app refuses to build a download
 * URL unless the host has a directTcp connection. So the bytes have to travel
 * over the same WebSocket as everything else, which means base64 in JSON.
 *
 * Chunking is required. A relay frame is capped at 1 MiB by Cloudflare and
 * nothing in the transport splits large messages, so an oversized response
 * kills the socket rather than returning an error. CHUNK_BYTES is picked to
 * stay well under that after base64 expansion.
 */
export const readChunkRpc = defineRpc({
  name: "image-preview.chunk",
  input: z.object({
    filePath: z.string().min(1),
    offset: z.number().int().min(0),
  }),
  output: z.object({
    base64: z.string().nullable(),
    totalBytes: z.number().nullable(),
    mimeType: z.string().nullable(),
    eof: z.boolean(),
    error: z.string().nullable(),
  }),
});

/** Raw bytes per chunk. 384 KiB becomes 512 KiB of base64, against a ~768 KiB budget. */
export const CHUNK_BYTES = 384 * 1024;

/** Refuse absurd loops. 64 MiB at 384 KiB per round trip is already 170 requests. */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

export function mimeTypeFor(filePath: string): string {
  const lower = filePath.toLowerCase();
  const ext = IMAGE_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  return (ext && MIME_TYPES[ext]) || "application/octet-stream";
}
