import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";
import { open, stat } from "node:fs/promises";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { CHUNK_BYTES, MAX_SOURCE_BYTES, isPdfPath, readChunkRpc, renderPageRpc } from "../shared/pdf";

type PageInput = RpcInput<typeof renderPageRpc>;
type PageOutput = RpcOutput<typeof renderPageRpc>;
type ChunkInput = RpcInput<typeof readChunkRpc>;
type ChunkOutput = RpcOutput<typeof readChunkRpc>;

const DEFAULT_MAX_WIDTH = 1024;
const PROCESS_TIMEOUT_MS = 20_000;
const POPPLER_HINT = "Install poppler on the daemon machine (brew install poppler).";

interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

function run(command: string, args: string[], maxBytes: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = "";
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error(`${command} timed out after ${PROCESS_TIMEOUT_MS}ms`));
      });
    }, PROCESS_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(() => {
          child.kill("SIGKILL");
          reject(new Error(`${command} produced more than ${maxBytes} bytes`));
        });
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(() => reject(err.code === "ENOENT" ? new Error(`${command} not found. ${POPPLER_HINT}`) : err));
    });
    child.on("close", (code) => {
      finish(() => resolve({ code, stdout: Buffer.concat(chunks), stderr }));
    });
  });
}

async function guard(filePath: string): Promise<{ error: string } | { mtimeMs: number; size: number }> {
  if (!filePath.startsWith("/")) return { error: "Only absolute paths can be previewed." };
  if (!isPdfPath(filePath)) return { error: "Not a PDF file." };
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { error: "Not a regular file." };
    if (info.size === 0) return { error: "File is empty." };
    if (info.size > MAX_SOURCE_BYTES) return { error: "File is too large to preview." };
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return { error: "File does not exist on the daemon." };
  }
}

interface PdfInfo {
  pages: number;
  width: number;
  height: number;
}

const infoCache = new Map<string, PdfInfo>();

async function pdfInfo(filePath: string, mtimeMs: number): Promise<PdfInfo | null> {
  const key = `${filePath}:${mtimeMs}`;
  const cached = infoCache.get(key);
  if (cached) return cached;
  const result = await run("pdfinfo", [filePath], 256 * 1024);
  if (result.code !== 0) return null;
  const text = result.stdout.toString("utf8");
  const pages = Number(/^Pages:\s+(\d+)/m.exec(text)?.[1] ?? NaN);
  const size = /^Page size:\s+([\d.]+) x ([\d.]+)/m.exec(text);
  if (!Number.isFinite(pages)) return null;
  const info = { pages, width: Number(size?.[1] ?? 612), height: Number(size?.[2] ?? 792) };
  if (infoCache.size > 200) infoCache.clear();
  infoCache.set(key, info);
  return info;
}

function pageFail(error: string, pageCount: number | null = null): PageOutput {
  return { dataUri: null, width: null, height: null, pageCount, bytes: null, error };
}

export async function renderPage({ filePath, page, maxWidth }: PageInput): Promise<PageOutput> {
  const checked = await guard(filePath);
  if ("error" in checked) return pageFail(checked.error);

  let info: PdfInfo | null;
  try {
    info = await pdfInfo(filePath, checked.mtimeMs);
  } catch (err) {
    return pageFail(err instanceof Error ? err.message : "pdfinfo failed.");
  }
  if (!info) return pageFail("The PDF could not be parsed.");
  if (page > info.pages) return pageFail(`Page ${page} is past the end (${info.pages} pages).`, info.pages);

  const width = maxWidth ?? DEFAULT_MAX_WIDTH;
  let rendered: RunResult;
  try {
    rendered = await run(
      "pdftoppm",
      [
        "-f", String(page),
        "-l", String(page),
        "-singlefile",
        "-scale-to-x", String(width),
        "-scale-to-y", "-1",
        "-jpeg",
        "-jpegopt", "quality=78",
        filePath,
      ],
      12 * 1024 * 1024,
    );
  } catch (err) {
    return pageFail(err instanceof Error ? err.message : "Failed to render the page.", info.pages);
  }
  if (rendered.code !== 0 || rendered.stdout.length === 0) {
    const detail = rendered.stderr.trim().split("\n").pop() ?? "unknown error";
    return pageFail(`pdftoppm failed: ${detail}`, info.pages);
  }

  return {
    dataUri: `data:image/jpeg;base64,${rendered.stdout.toString("base64")}`,
    width,
    height: Math.round((info.height * width) / info.width),
    pageCount: info.pages,
    bytes: rendered.stdout.length,
    error: null,
  };
}

function chunkFail(error: string): ChunkOutput {
  return { base64: null, totalBytes: null, mimeType: null, eof: true, error };
}

export async function readChunk({ filePath, offset }: ChunkInput): Promise<ChunkOutput> {
  const checked = await guard(filePath);
  if ("error" in checked) return chunkFail(checked.error);
  const totalBytes = checked.size;
  if (offset > totalBytes) return chunkFail("Read past end of file.");

  const length = Math.min(CHUNK_BYTES, totalBytes - offset);
  const buffer = Buffer.allocUnsafe(length);
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, "r");
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return {
      base64: buffer.subarray(0, filled).toString("base64"),
      totalBytes,
      mimeType: "application/pdf",
      eof: offset + filled >= totalBytes,
      error: null,
    };
  } catch (err) {
    return chunkFail(err instanceof Error ? err.message : "Failed to read file.");
  } finally {
    await handle?.close();
  }
}
