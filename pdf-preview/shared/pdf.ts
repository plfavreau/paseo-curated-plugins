import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// The app validates contribution ids/kinds with /^[a-z][a-z0-9-]*$/.
export const PDF_PREVIEW_KIND = "pdf-preview-file";
export const PDF_PREVIEW_VERSION = 1;

export function isPdfPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}

export function basename(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

export function resolvePath(filePath: string, cwd: string | undefined): string | null {
  if (filePath.startsWith("/")) return filePath;
  if (filePath.startsWith("~")) return null;
  if (!cwd || !cwd.startsWith("/")) return null;
  const segments = `${cwd}/${filePath}`.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return `/${resolved.join("/")}`;
}

// Quoted paths first, then bare tokens. A bare token stops at shell syntax and
// must not contain glob characters: `ls *.pdf` names no particular file.
const PDF_TOKEN = /"([^"\n]+?\.pdf)"|'([^'\n]+?\.pdf)'|((?:\\ |[^\s"'`;|&<>(){}=*?[\]])+\.pdf)(?![\w.-])/gi;

/**
 * PDFs a shell command touches. Codex reads PDFs with `pdftotext`, not the Read
 * tool, so the path in the command line is the only reliable signal.
 */
export function pdfPathsInCommand(command: string, cwd: string | undefined): string[] {
  const found = new Set<string>();
  for (const match of command.matchAll(PDF_TOKEN)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\\ /g, " ");
    if (!raw || raw.includes("$") || /^[a-z]+:\/\//i.test(raw)) continue;
    const resolved = resolvePath(raw, cwd);
    if (resolved) found.add(resolved);
    if (found.size >= 4) break;
  }
  return [...found];
}

export const pdfPreviewSchema = z.object({
  filePath: z.string(),
  fileName: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  callId: z.string().optional(),
  /** Set when the PDF was found in a shell command rather than a Read call. */
  command: z.string().optional(),
  output: z.string().optional(),
  exitCode: z.number().nullable().optional(),
});

export type PdfPreviewData = z.output<typeof pdfPreviewSchema>;

/** Renders one page on the daemon with poppler and returns a JPEG data URI. */
export const renderPageRpc = defineRpc({
  name: "pdf-preview.page",
  input: z.object({
    filePath: z.string().min(1),
    page: z.number().int().min(1),
    maxWidth: z.number().int().min(64).max(2048).optional(),
  }),
  output: z.object({
    dataUri: z.string().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    pageCount: z.number().nullable(),
    bytes: z.number().nullable(),
    error: z.string().nullable(),
  }),
});

/**
 * Chunked read of the original file for the download button. A relay frame is
 * capped at 1 MiB and an oversized response kills the socket, so the bytes
 * travel in bounded base64 slices.
 */
export const readChunkRpc = defineRpc({
  name: "pdf-preview.chunk",
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

/** 384 KiB becomes 512 KiB of base64. Must stay a multiple of 3 so chunks concatenate. */
export const CHUNK_BYTES = 384 * 1024;
export const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
