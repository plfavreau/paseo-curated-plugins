import type { PluginClientContext } from "@getpaseo/plugin/client";
import { NotionCardItem } from "./client/notion-card";
import { NOTION_CARD_KIND, NOTION_CARD_VERSION, findNotionMentions, notionCardSchema } from "./shared/notion";

/** The replaced row's output rides along, capped to stay far under the 64 KiB item limit. */
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

/** Claude reports a failed command's exit code only as the first line of its error text. */
function exitCodeOf(text: string): number | null {
  const match = /^Exit code (\d+)/.exec(text);
  return match ? Number(match[1]) : null;
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addTimelineTransformer({
      id: "notion-card-ntn-commands",
      query: { itemType: "tool_call" },
      transform({ item }) {
        const detail = item.detail;
        if (detail.type !== "shell" || typeof detail.command !== "string") return undefined;
        if (!/\bntn\s+(pages|api)\b/.test(detail.command)) return undefined;
        const output = typeof detail.output === "string" && detail.output ? detail.output : failureText(item.error);
        const mentions = findNotionMentions(detail.command, output);
        if (mentions.length === 0) return undefined;
        const clipped = output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)` : output;
        return {
          items: mentions.map((mention, index) => ({
            type: "plugin" as const,
            ...(index > 0 ? { id: `notion-${mention.pageId}` } : {}),
            kind: NOTION_CARD_KIND,
            version: NOTION_CARD_VERSION,
            data: {
              pageId: mention.pageId,
              action: mention.action,
              status: item.status,
              command: detail.command,
              output: index === 0 ? clipped : "",
              exitCode: detail.exitCode ?? exitCodeOf(output),
              showCommand: index === 0,
            },
          })),
        };
      },
    }),
    client.addTimelineRenderer({
      kind: NOTION_CARD_KIND,
      version: NOTION_CARD_VERSION,
      schema: notionCardSchema,
      Component: NotionCardItem,
    }),
  ];

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
