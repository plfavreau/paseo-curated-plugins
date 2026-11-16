import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PdfPreviewItem } from "./client/pdf-preview";
import {
  PDF_PREVIEW_KIND,
  PDF_PREVIEW_VERSION,
  basename,
  isPdfPath,
  pdfPathsInCommand,
  pdfPreviewSchema,
} from "./shared/pdf";

/** Shell output rides along so the replaced row loses nothing; capped to stay far under the 64 KiB item limit. */
const MAX_OUTPUT_CHARS = 6000;

/** A failed call carries its output in `item.error` (Claude: `{ content }`), not in the detail. */
function failureText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const content = (error as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  return "";
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addTimelineTransformer({
      id: "pdf-preview-tool-calls",
      query: { itemType: "tool_call" },
      transform({ item }) {
        const detail = item.detail;
        if (detail.type === "read") {
          if (typeof detail.filePath !== "string" || !isPdfPath(detail.filePath)) return undefined;
          return {
            items: [
              {
                type: "plugin" as const,
                kind: PDF_PREVIEW_KIND,
                version: PDF_PREVIEW_VERSION,
                data: {
                  filePath: detail.filePath,
                  fileName: basename(detail.filePath),
                  status: item.status,
                  callId: item.callId,
                },
              },
            ],
          };
        }
        if (detail.type === "shell") {
          if (typeof detail.command !== "string" || !/\.pdf/i.test(detail.command)) return undefined;
          const paths = pdfPathsInCommand(detail.command, detail.cwd);
          if (paths.length === 0) return undefined;
          const text = typeof detail.output === "string" && detail.output ? detail.output : failureText(item.error);
          const output =
            text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)` : text || undefined;
          return {
            items: paths.map((filePath, index) => ({
              type: "plugin" as const,
              id: `${item.callId}-pdf-${index}`,
              kind: PDF_PREVIEW_KIND,
              version: PDF_PREVIEW_VERSION,
              data: {
                filePath,
                fileName: basename(filePath),
                status: item.status,
                callId: item.callId,
                // Only the first card carries the command, so it is shown once.
                ...(index === 0
                  ? { command: detail.command, output: output ?? "", exitCode: detail.exitCode ?? null }
                  : {}),
              },
            })),
          };
        }
        return undefined;
      },
    }),
    client.addTimelineRenderer({
      kind: PDF_PREVIEW_KIND,
      version: PDF_PREVIEW_VERSION,
      schema: pdfPreviewSchema,
      Component: PdfPreviewItem,
    }),
  ];

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
