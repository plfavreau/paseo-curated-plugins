import { z } from "zod";

// NOTE: the app validates kinds with /^[a-z][a-z0-9-]*$/.
export const SQL_TABLE_KIND = "sql-table-result";
export const SQL_TABLE_VERSION = 1;

/** Rows kept per table on the timeline item. The item is capped at 64 KiB, so the rest is only in the raw output. */
export const MAX_ROWS = 200;
const MAX_CELL_CHARS = 400;
/** Budget for all cells of all tables, leaving room for the SQL, the raw output and JSON overhead. */
const MAX_TABLE_CHARS = 36_000;
const MAX_RAW_CHARS = 6_000;
const MAX_SQL_CHARS = 4_000;

const tableSchema = z.object({
  columns: z.array(z.string()),
  /** `null` is a real SQL NULL (JSON output only); psql tables print NULL and '' the same way. */
  rows: z.array(z.array(z.string().nullable())),
  /** Row count reported by the tool, or the parsed count when it reports none. */
  totalRows: z.number(),
  numeric: z.array(z.boolean()),
});

export const sqlTableSchema = z.object({
  status: z.enum(["running", "completed", "failed", "canceled"]),
  command: z.string(),
  sql: z.string().nullable(),
  env: z.string().nullable(),
  format: z.enum(["box", "ascii", "json", "csv"]).nullable(),
  tables: z.array(tableSchema),
  error: z.string().nullable(),
  raw: z.string(),
  exitCode: z.number().nullable(),
});

export type SqlTable = z.output<typeof tableSchema>;
export type SqlTableData = z.output<typeof sqlTableSchema>;
type Format = NonNullable<SqlTableData["format"]>;

/** Commands whose output is a query result. Matched anywhere so `cd x && psql …` and absolute paths work. */
const SQL_COMMAND =
  /(?:^|[\s/;&|(])(?:psql|pgcli|sb-query(?:\.sh)?|sb-write(?:\.sh)?|supabase\s+db\s+query|sqlite3|duckdb|mysql|mariadb|clickhouse(?:-client)?)(?=\s|$)/;

export function isSqlCommand(command: string): boolean {
  return SQL_COMMAND.test(command);
}

/** MCP database tools (Supabase `execute_sql`, Postgres MCP `query`, …) reach the timeline as unknown tool calls. */
export function isSqlToolName(name: string): boolean {
  return /execute_sql|run_sql|sql_query|(?:^|[_.-])query$/i.test(name);
}

// ---------------------------------------------------------------------------
// Display width. psql pads cells by terminal columns, so a CJK character or an
// emoji takes two columns while being one or two UTF-16 units. Splitting a row
// at the border's string indexes would cut those rows in the wrong place.

function charWidth(code: number): number {
  if (code === 0) return 0;
  if ((code >= 0x0300 && code <= 0x036f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Splits a line into cells at the given display columns (the positions of the column separators). */
function sliceByColumns(line: string, separators: number[]): string[] {
  const cells: string[] = [];
  let current = "";
  let column = 0;
  let next = 0;
  for (const char of line) {
    if (next < separators.length && column === separators[next]) {
      cells.push(current);
      current = "";
      next++;
    } else {
      current += char;
    }
    column += charWidth(char.codePointAt(0) ?? 0);
  }
  cells.push(current);
  return cells;
}

function positionsOf(line: string, chars: string): number[] {
  const positions: number[] = [];
  let column = 0;
  for (const char of line) {
    if (chars.includes(char)) positions.push(column);
    column += charWidth(char.codePointAt(0) ?? 0);
  }
  return positions;
}

// ---------------------------------------------------------------------------
// psql tables

type Parsed = { format: Format; tables: Array<{ columns: string[]; rows: Array<Array<string | null>>; reported: number | null }> };

const ROW_COUNT = /^\((\d+) rows?\)$/;

/**
 * Turns the physical lines of one table body into rows. A cell ending in the
 * continuation marker (`↵` in unicode, `+` in ascii) carries on in the same
 * column on the next physical line.
 */
function collectRows(lines: string[][], marker: string): string[][] {
  const rows: string[][] = [];
  let pending: string[] | null = null;
  let open: boolean[] = [];
  for (const cells of lines) {
    const trimmed = cells.map((cell) => cell.trim());
    const continues = trimmed.map((cell) => cell.endsWith(marker));
    const values = trimmed.map((cell, index) => (continues[index] ? cell.slice(0, -marker.length).trimEnd() : cell));
    pending = pending
      ? pending.map((value, index) => (open[index] ? `${value}\n${values[index] ?? ""}` : value))
      : values;
    open = continues;
    if (!continues.some(Boolean)) {
      rows.push(pending);
      pending = null;
    }
  }
  if (pending) rows.push(pending);
  return rows;
}

function parseBox(lines: string[]): Parsed | null {
  const tables: Parsed["tables"] = [];
  for (let index = 0; index < lines.length; index++) {
    const top = lines[index]!;
    if (!top.startsWith("┌") || !top.trimEnd().endsWith("┐")) continue;
    const separators = positionsOf(top, "┌┬┐");
    const split = (line: string) => sliceByColumns(line, separators).slice(1, -1);
    const header = lines[index + 1];
    const rule = lines[index + 2];
    if (!header?.startsWith("│") || !rule?.startsWith("├")) continue;
    const columns = split(header).map((cell) => cell.trim());
    const body: string[][] = [];
    let cursor = index + 3;
    for (; cursor < lines.length; cursor++) {
      const line = lines[cursor]!;
      if (line.startsWith("└")) break;
      if (line.startsWith("│")) body.push(split(line));
    }
    const count = ROW_COUNT.exec((lines[cursor + 1] ?? "").trim());
    tables.push({ columns, rows: collectRows(body, "↵"), reported: count ? Number(count[1]) : null });
    index = cursor;
  }
  return tables.length > 0 ? { format: "box", tables } : null;
}

/** psql's default `aligned` format with border 1: ` id | name` over `----+------`. */
function parseAscii(lines: string[]): Parsed | null {
  const tables: Parsed["tables"] = [];
  for (let index = 1; index < lines.length; index++) {
    const rule = lines[index]!;
    if (!/^-+(\+-+)*$/.test(rule.trimEnd())) continue;
    const header = lines[index - 1]!;
    const separators = positionsOf(rule, "+");
    // The header must have a `|` (or nothing, for one column) exactly where the rule has `+`.
    const headerCells = sliceByColumns(header, separators);
    if (headerCells.length !== separators.length + 1) continue;
    if (separators.some((position) => positionsOf(header, "|").indexOf(position) === -1)) continue;
    const body: string[][] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor++) {
      const line = lines[cursor]!;
      if (ROW_COUNT.test(line.trim()) || line.trim() === "") break;
      body.push(sliceByColumns(line, separators));
    }
    const count = ROW_COUNT.exec((lines[cursor] ?? "").trim());
    if (body.length === 0 && !count) continue;
    tables.push({
      columns: headerCells.map((cell) => cell.trim()),
      rows: collectRows(body, "+"),
      reported: count ? Number(count[1]) : null,
    });
    index = cursor;
  }
  return tables.length > 0 ? { format: "ascii", tables } : null;
}

// ---------------------------------------------------------------------------
// JSON and CSV

function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function tableFromObjects(records: unknown[]): Parsed["tables"][number] | null {
  if (!records.every((record) => record !== null && typeof record === "object" && !Array.isArray(record))) return null;
  const columns: string[] = [];
  for (const record of records as Array<Record<string, unknown>>) {
    for (const key of Object.keys(record)) if (!columns.includes(key)) columns.push(key);
  }
  if (columns.length === 0) return null;
  const rows = (records as Array<Record<string, unknown>>).map((record) => columns.map((column) => stringify(record[column])));
  return { columns, rows, reported: null };
}

/**
 * Finds a JSON array of row objects in the output. Tools often wrap it in prose
 * (the Supabase MCP server puts it inside `<untrusted-data-…>` tags), so try the
 * whole text, then every `[` that starts a line.
 */
function parseJson(text: string): Parsed | null {
  const candidates = [text.trim()];
  const starts = [...text.matchAll(/(^|\n)\s*\[/g)].map((match) => match.index! + match[0].length - 1);
  const end = text.lastIndexOf("]");
  for (const start of starts) if (end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate.startsWith("[")) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (!Array.isArray(value)) continue;
      if (value.length === 0) return { format: "json", tables: [{ columns: [], rows: [], reported: 0 }] };
      const table = tableFromObjects(value);
      if (table) return { format: "json", tables: [table] };
    } catch {
      // Not this one.
    }
  }
  return null;
}

function parseCsvLine(text: string, start: number): { cells: string[]; next: number } {
  const cells: string[] = [];
  let cell = "";
  let index = start;
  let quoted = false;
  for (; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else if (char === "\n") {
      break;
    } else if (char !== "\r") {
      cell += char;
    }
  }
  cells.push(cell);
  return { cells, next: index + 1 };
}

function parseCsv(text: string): Parsed | null {
  const body = text.replace(/^\s*\n/, "").replace(/\s+$/, "");
  if (!body) return null;
  const records: string[][] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const { cells, next } = parseCsvLine(body, cursor);
    records.push(cells);
    cursor = next;
  }
  const [columns, ...rows] = records;
  if (!columns || columns.length < 1 || rows.some((row) => row.length !== columns.length)) return null;
  return { format: "csv", tables: [{ columns, rows, reported: null }] };
}

// ---------------------------------------------------------------------------
// Command metadata

const SQL_START = /^\s*(?:select|with|insert|update|delete|explain|show|table|values|create|alter|drop|truncate|begin|copy|grant|revoke|set|\\d)/i;

/** The SQL text, when the command passes it inline: a quoted argument, `-c "…"`, or a heredoc. */
export function extractSql(command: string): string | null {
  const heredoc = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*?)\n\s*\1\s*$/m.exec(command);
  if (heredoc && SQL_START.test(heredoc[2]!)) return heredoc[2]!.trim();
  const quoted = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\$\$([\s\S]*?)\$\$/g;
  for (const match of command.matchAll(quoted)) {
    const value = match[1] !== undefined ? match[1].replace(/\\(["\\$`])/g, "$1") : (match[2] ?? match[3] ?? "");
    if (SQL_START.test(value)) return value.trim();
  }
  const file = /(?:^|\s)(?:-f|--file)\s+(\S+\.sql)\b/.exec(command);
  return file ? `-- ${file[1]}` : null;
}

export function extractEnv(command: string): string | null {
  const flag = /--env[=\s]+([\w-]+)/.exec(command);
  if (flag) return flag[1]!;
  return /\bprod(?:uction)?\b/i.test(command) && /sb-query|sb-write|supabase/.test(command) ? "prod" : null;
}

function wantsFormat(command: string): Format | null {
  if (/(?:--out|-o)[=\s]+json\b|--json\b/.test(command)) return "json";
  if (/(?:--out|-o)[=\s]+csv\b|--csv\b/.test(command)) return "csv";
  return null;
}

function firstError(text: string): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^(?:psql:.*?)?(?:ERROR|FATAL|error):/.test(line.trim()) || /^Error:/.test(line.trim()));
  if (start === -1) return null;
  return lines.slice(start, start + 6).join("\n").trimEnd();
}

function isNumeric(values: Array<string | null>): boolean {
  const present = values.filter((value): value is string => value !== null && value.trim() !== "");
  return present.length > 0 && present.every((value) => /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim()));
}

/** Caps rows and cell length so the timeline item stays far under 64 KiB. */
function fitTables(parsed: Parsed): SqlTable[] {
  let budget = MAX_TABLE_CHARS;
  return parsed.tables.map((table) => {
    const rows: Array<Array<string | null>> = [];
    for (const row of table.rows) {
      if (rows.length >= MAX_ROWS) break;
      const fitted = row.map((cell) =>
        cell !== null && cell.length > MAX_CELL_CHARS ? `${cell.slice(0, MAX_CELL_CHARS)}…` : cell,
      );
      const size = fitted.reduce((sum, cell) => sum + (cell?.length ?? 4) + 4, 0);
      if (size > budget) break;
      budget -= size;
      rows.push(fitted);
    }
    return {
      columns: table.columns,
      rows,
      totalRows: table.reported ?? table.rows.length,
      numeric: table.columns.map((_, index) => isNumeric(table.rows.map((row) => row[index] ?? null))),
    };
  });
}

export function parseOutput(output: string, command: string): Parsed | null {
  const wanted = wantsFormat(command);
  if (wanted === "json") return parseJson(output);
  if (wanted === "csv") return parseCsv(output);
  const lines = output.split("\n");
  return parseBox(lines) ?? parseAscii(lines) ?? parseJson(output);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated)` : text;
}

/**
 * Builds the card data, or null when there is nothing worth a card: a SQL
 * command still gets a card for a recognised error, but never for output that
 * is neither a table nor an error (a `\copy`, an `INSERT 0 1`, help text…).
 */
export function buildSqlCard(input: {
  command: string;
  sql?: string | null;
  output: string;
  status: SqlTableData["status"];
  exitCode: number | null;
}): SqlTableData | null {
  const parsed = input.output ? parseOutput(input.output, input.command) : null;
  const error = parsed ? null : firstError(input.output);
  const sql = input.sql ?? extractSql(input.command);
  // While running there is no output yet: only claim commands that clearly carry a query.
  if (!parsed && !error && (input.status !== "running" || !sql)) return null;
  return {
    status: input.status,
    command: input.command,
    sql: sql ? truncate(sql, MAX_SQL_CHARS) : null,
    env: extractEnv(input.command),
    format: parsed?.format ?? null,
    tables: parsed ? fitTables(parsed) : [],
    error,
    raw: truncate(input.output, MAX_RAW_CHARS),
    exitCode: input.exitCode,
  };
}
