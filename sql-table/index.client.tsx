import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SqlTableItem } from "./client/sql-table";
import {
  SQL_TABLE_KIND,
  SQL_TABLE_VERSION,
  buildSqlCard,
  isSqlCommand,
  isSqlToolName,
  sqlTableSchema,
} from "./shared/sql";

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  // MCP results are often `{ content: [{ type: "text", text }] }`.
  if (typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    return (value as { content: Array<{ text?: unknown }> }).content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** A failed call carries its output in `item.error` (Claude: `{ content }`), not in the detail. */
function failureText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const content = (error as { content?: unknown }).content;
    if (typeof content === "string") return content;
    return asText(error);
  }
  return "";
}

function sqlFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const sql = record.query ?? record.sql ?? record.statement;
  return typeof sql === "string" ? sql : null;
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addTimelineTransformer({
      id: "sql-table-results",
      query: { itemType: "tool_call" },
      transform({ item }) {
        const detail = item.detail;
        let card = null;
        if (detail.type === "shell" && typeof detail.command === "string" && isSqlCommand(detail.command)) {
          card = buildSqlCard({
            command: detail.command,
            output: typeof detail.output === "string" && detail.output ? detail.output : failureText(item.error),
            status: item.status,
            exitCode: detail.exitCode ?? null,
          });
        } else if (detail.type === "unknown" && isSqlToolName(item.name)) {
          const sql = sqlFromInput(detail.input);
          if (!sql) return undefined;
          card = buildSqlCard({
            command: item.name,
            sql,
            output: asText(detail.output) || failureText(item.error),
            status: item.status,
            exitCode: null,
          });
        }
        if (!card) return undefined;
        return {
          items: [{ type: "plugin" as const, kind: SQL_TABLE_KIND, version: SQL_TABLE_VERSION, data: card }],
        };
      },
    }),
    client.addTimelineRenderer({
      kind: SQL_TABLE_KIND,
      version: SQL_TABLE_VERSION,
      schema: sqlTableSchema,
      Component: SqlTableItem,
    }),
  ];

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
