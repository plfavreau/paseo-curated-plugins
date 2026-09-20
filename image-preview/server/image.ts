import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  SHARE_EXPIRY_HOURS,
  basename,
  isPreviewableImage,
  loadImageRpc,
  shareImageRpc,
} from "../shared/image";

type Input = RpcInput<typeof loadImageRpc>;
type Output = RpcOutput<typeof loadImageRpc>;
type ShareInput = RpcInput<typeof shareImageRpc>;
type ShareOutput = RpcOutput<typeof shareImageRpc>;

/** Hard ceiling on the source file we are willing to decode. */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_WIDTH = 1024;
const PROCESS_TIMEOUT_MS = 20_000;

function fail(error: string): Output {
  return { dataUri: null, width: null, height: null, bytes: null, error };
}

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

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${PROCESS_TIMEOUT_MS}ms`));
    }, PROCESS_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(new Error(`${command} produced more than ${maxBytes} bytes`));
        }
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

async function probeSize(filePath: string): Promise<{ width: number; height: number } | null> {
  try {
    const result = await run(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0:s=x",
        filePath,
      ],
      64 * 1024,
    );
    if (result.code !== 0) return null;
    const match = /(\d+)x(\d+)/.exec(result.stdout.toString("utf8"));
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    return null;
  }
}

/** Shared validation for both RPCs. Returns an error message, or null if the file is usable. */
async function guard(filePath: string): Promise<string | null> {
  if (!filePath.startsWith("/")) return "Only absolute paths can be previewed.";
  if (!isPreviewableImage(filePath)) return "Not an image file.";
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return "Not a regular file.";
    if (info.size === 0) return "File is empty.";
    if (info.size > MAX_SOURCE_BYTES) return "File is too large to preview.";
  } catch {
    return "File no longer exists on the daemon.";
  }
  return null;
}

export async function loadImage({ filePath, maxWidth }: Input): Promise<Output> {
  const invalid = await guard(filePath);
  if (invalid) return fail(invalid);

  const target = maxWidth ?? DEFAULT_MAX_WIDTH;
  const source = await probeSize(filePath);

  let encoded: RunResult;
  try {
    encoded = await run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        filePath,
        "-frames:v",
        "1",
        "-vf",
        `scale='min(${target},iw)':-2:flags=lanczos`,
        "-c:v",
        "mjpeg",
        "-q:v",
        "6",
        "-f",
        "image2",
        "pipe:1",
      ],
      12 * 1024 * 1024,
    );
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Failed to decode image.");
  }

  if (encoded.code !== 0 || encoded.stdout.length === 0) {
    const detail = encoded.stderr.trim().split("\n").pop() ?? "unknown error";
    return fail(`ffmpeg failed: ${detail}`);
  }

  const width = source ? Math.min(target, source.width) : null;
  const height = source && width ? Math.round((source.height * width) / source.width) : null;

  return {
    dataUri: `data:image/jpeg;base64,${encoded.stdout.toString("base64")}`,
    width,
    height,
    bytes: encoded.stdout.length,
    error: null,
  };
}

/**
 * External helper that publishes a file at a URL the phone can reach.
 *
 * Contract: called as `<command> <file> <hours> --name <name>` and expected to
 * print an https URL on its first line. Override with the env var below.
 */
const SHARE_COMMAND = process.env.PASEO_IMAGE_PREVIEW_SHARE_COMMAND ?? "/var/www/scratchpad-share.py";

export async function shareImage({ filePath }: ShareInput): Promise<ShareOutput> {
  const invalid = await guard(filePath);
  if (invalid) return { url: null, error: invalid };

  try {
    await stat(SHARE_COMMAND);
  } catch {
    return {
      url: null,
      error: "Downloads are not configured on this daemon. See the plugin README.",
    };
  }

  let result: RunResult;
  try {
    result = await run(
      SHARE_COMMAND,
      [filePath, String(SHARE_EXPIRY_HOURS), "--name", basename(filePath)],
      256 * 1024,
    );
  } catch (err) {
    return { url: null, error: err instanceof Error ? err.message : "Failed to share file." };
  }

  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n").pop() ?? "unknown error";
    return { url: null, error: `Share failed: ${detail}` };
  }

  // The script prints the URL on its first line, then indented metadata.
  const url = result.stdout.toString("utf8").trim().split("\n")[0]?.trim() ?? "";
  if (!url.startsWith("https://")) {
    return { url: null, error: "Share script returned no URL." };
  }
  return { url, error: null };
}
