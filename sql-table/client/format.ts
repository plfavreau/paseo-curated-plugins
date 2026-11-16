import type { SqlTable } from "../shared/sql";

function csvCell(value: string | null): string {
  if (value === null) return "";
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(table: SqlTable): string {
  return [table.columns, ...table.rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function markdownCell(value: string | null): string {
  if (value === null) return "NULL";
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

export function toMarkdown(table: SqlTable): string {
  const header = `| ${table.columns.map(markdownCell).join(" | ")} |`;
  const rule = `| ${table.columns.map((_, index) => (table.numeric[index] ? "---:" : "---")).join(" | ")} |`;
  const rows = table.rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`);
  return [header, rule, ...rows].join("\n");
}

function jsonValue(value: string | null, numeric: boolean): unknown {
  if (value === null) return null;
  if (numeric && value.trim() !== "") return Number(value);
  if (/^[[{]/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function toJson(table: SqlTable): string {
  const records = table.rows.map((row) =>
    Object.fromEntries(table.columns.map((column, index) => [column, jsonValue(row[index] ?? null, table.numeric[index] ?? false)])),
  );
  return JSON.stringify(records, null, 2);
}
