import { z } from "zod";

export const STOPWATCH_KIND = "tool-stopwatch";
export const STOPWATCH_VERSION = 1;

export const stopwatchSchema = z.object({
  callId: z.string(),
  label: z.string(),
  summary: z.string(),
  icon: z.string(),
});

export type StopwatchData = z.output<typeof stopwatchSchema>;

type Detail = { type: string } & Record<string, unknown>;

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif|tiff?)$/i;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * Image reads are claimed by the image-preview plugin and finish instantly,
 * so leave them alone instead of racing that transformer.
 */
export function shouldTrack(detail: Detail): boolean {
  if (detail.type === "read") {
    const filePath = str(detail.filePath);
    if (filePath && IMAGE_EXTENSION.test(filePath)) return false;
  }
  return true;
}

export function describe(name: string, detail: Detail): Omit<StopwatchData, "callId"> {
  switch (detail.type) {
    case "shell":
      return { label: "Shell", summary: firstLine(str(detail.command) ?? ""), icon: "SquareTerminal" };
    case "read":
      return { label: "Read", summary: str(detail.filePath) ?? "", icon: "Eye" };
    case "edit":
      return { label: "Edit", summary: str(detail.filePath) ?? "", icon: "Pencil" };
    case "write":
      return { label: "Write", summary: str(detail.filePath) ?? "", icon: "Pencil" };
    case "search":
      return { label: "Search", summary: firstLine(str(detail.query) ?? ""), icon: "Search" };
    case "fetch":
      return { label: "Fetch", summary: str(detail.url) ?? "", icon: "Globe" };
    case "sub_agent":
      return {
        label: str(detail.subAgentType) ?? "Agent",
        summary: firstLine(str(detail.description) ?? ""),
        icon: "Bot",
      };
    case "plain_text":
      return { label: str(detail.label) ?? name, summary: firstLine(str(detail.text) ?? ""), icon: "Wrench" };
    default:
      return { label: name, summary: "", icon: "Wrench" };
  }
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}
