import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PrCardItem } from "./client/pr-card";
import { PR_CARD_KIND, PR_CARD_VERSION, findPrMention, prCardSchema } from "./shared/pr";

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

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addTimelineTransformer({
      id: "pr-card-gh-commands",
      query: { itemType: "tool_call" },
      transform({ item }) {
        const detail = item.detail;
        if (detail.type !== "shell" || typeof detail.command !== "string") return undefined;
        if (!/\bgh\s+pr\s+/.test(detail.command)) return undefined;
        const output = typeof detail.output === "string" && detail.output ? detail.output : failureText(item.error);
        const mention = findPrMention(detail.command, detail.cwd, output);
        if (!mention) return undefined;
        return {
          items: [
            {
              type: "plugin" as const,
              kind: PR_CARD_KIND,
              version: PR_CARD_VERSION,
              data: {
                subcommand: mention.subcommand,
                ref: mention.ref,
                status: item.status,
                command: detail.command,
                output: output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)` : output,
                exitCode: detail.exitCode ?? null,
              },
            },
          ],
        };
      },
    }),
    client.addTimelineRenderer({
      kind: PR_CARD_KIND,
      version: PR_CARD_VERSION,
      schema: prCardSchema,
      Component: PrCardItem,
    }),
  ];

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
