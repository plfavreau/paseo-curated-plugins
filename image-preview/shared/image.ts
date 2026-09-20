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
 * Daemon-side publish: copies the original file to an expiring, unguessable
 * scratchpad capability URL so the phone can actually download it. The app
 * sandbox has no filesystem access, so a real HTTP URL is the only route.
 */
export const shareImageRpc = defineRpc({
  name: "image-preview.share",
  input: z.object({
    filePath: z.string().min(1),
  }),
  output: z.object({
    url: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

/** Share links expire quickly: they are bearer credentials. */
export const SHARE_EXPIRY_HOURS = 6;
