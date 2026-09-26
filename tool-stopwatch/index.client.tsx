import type { PluginClientContext } from "@getpaseo/plugin/client";
import { StopwatchItem } from "./client/stopwatch";
import {
  STOPWATCH_KIND,
  STOPWATCH_VERSION,
  describe,
  detailBody,
  shouldTrack,
  stopwatchSchema,
} from "./shared/stopwatch";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    // Only running calls are replaced. Once the call finishes the transformer
    // returns undefined, so Paseo's native row (and its detail sheet) comes back.
    client.addTimelineTransformer({
      id: "tool-stopwatch-running-calls",
      query: { itemType: "tool_call" },
      transform({ item }) {
        if (item.status !== "running") return undefined;
        const detail = item.detail as { type: string } & Record<string, unknown>;
        if (!shouldTrack(detail)) return undefined;
        return {
          items: [
            {
              type: "plugin" as const,
              kind: STOPWATCH_KIND,
              version: STOPWATCH_VERSION,
              data: { callId: item.callId, ...describe(item.name, detail), body: detailBody(detail) },
            },
          ],
        };
      },
    }),
    client.addTimelineRenderer({
      kind: STOPWATCH_KIND,
      version: STOPWATCH_VERSION,
      schema: stopwatchSchema,
      Component: StopwatchItem,
    }),
  ];

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
