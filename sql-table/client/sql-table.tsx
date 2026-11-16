import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { SqlTable, SqlTableData } from "../shared/sql";
import { toCsv, toJson, toMarkdown } from "./format";

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
const PREVIEW_ROWS = 10;
const CHAR_WIDTH = 7.4;
const MIN_COLUMN = 44;
const MAX_COLUMN = 300;
const SCROLL_HEIGHT = 440;

type Styles = ReturnType<typeof makeStyles>;

function makeStyles(theme: PluginTheme, compact: boolean) {
  const small = compact ? 11 : 12;
  return {
    card: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 10,
      backgroundColor: theme.colors.surface1,
      overflow: "hidden" as const,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    sql: { flex: 1, color: theme.colors.foreground, fontFamily: MONO, fontSize: small },
    summary: { color: theme.colors.foregroundMuted, fontSize: small },
    badge: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, borderWidth: 1 },
    badgeText: { fontSize: 10, fontWeight: "600" as const },
    section: { borderTopWidth: 1, borderTopColor: theme.colors.border },
    label: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      paddingHorizontal: 10,
      paddingTop: 6,
      paddingBottom: 4,
    },
    headRow: {
      flexDirection: "row" as const,
      backgroundColor: theme.colors.surface2,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
    },
    row: { flexDirection: "row" as const },
    rowAlt: { flexDirection: "row" as const, backgroundColor: theme.colors.surface0 },
    rowSelected: { flexDirection: "row" as const, backgroundColor: theme.colors.surface2 },
    cell: { paddingHorizontal: 8, paddingVertical: 4 },
    headText: { color: theme.colors.foreground, fontFamily: MONO, fontSize: small, fontWeight: "600" as const },
    cellText: { color: theme.colors.foreground, fontFamily: MONO, fontSize: small },
    nullText: { color: theme.colors.foregroundMuted, fontFamily: MONO, fontSize: small, fontStyle: "italic" as const },
    detail: {
      paddingHorizontal: 10,
      paddingVertical: 8,
      gap: 6,
      backgroundColor: theme.colors.surface0,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    detailKey: { color: theme.colors.foregroundMuted, fontFamily: MONO, fontSize: 11 },
    detailValue: { color: theme.colors.foreground, fontFamily: MONO, fontSize: small },
    toolbar: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      alignItems: "center" as const,
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    button: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    buttonText: { color: theme.colors.foreground, fontSize: 11, fontWeight: "500" as const },
    note: { color: theme.colors.foregroundMuted, fontSize: 11 },
    error: {
      color: theme.colors.statusDanger,
      fontFamily: MONO,
      fontSize: small,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    raw: {
      color: theme.colors.foregroundMuted,
      fontFamily: MONO,
      fontSize: 11,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    muted: { color: theme.colors.foregroundMuted, fontSize: small },
  };
}

function rowLabel(count: number): string {
  return `${count} row${count === 1 ? "" : "s"}`;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function columnWidths(table: SqlTable, rows: SqlTable["rows"]): number[] {
  return table.columns.map((column, index) => {
    let longest = column.length;
    for (const row of rows) {
      const value = row[index];
      const shown = value === null ? 4 : value.includes("\n") ? firstLine(value).length + 3 : value.length;
      if (shown > longest) longest = shown;
    }
    return Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, Math.ceil(longest * CHAR_WIDTH) + 18));
  });
}

function SmallButton({ styles, icon, label, onPress, color }: {
  styles: Styles;
  icon: string;
  label: string;
  onPress: () => void;
  color: string;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.button}>
      <Icon name={icon} size={12} color={color} />
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function ResultTable({ table, index, count, styles, theme }: {
  table: SqlTable;
  index: number;
  count: number;
  styles: Styles;
  theme: PluginTheme;
}) {
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const toast = useToast();
  const rows = showAll ? table.rows : table.rows.slice(0, PREVIEW_ROWS);
  const widths = useMemo(() => columnWidths(table, rows), [table, rows]);
  const hidden = table.rows.length - rows.length;
  const dropped = table.totalRows - table.rows.length;

  const copy = async (label: string, text: string) => {
    await copyText(text);
    toast.show(`Copied ${label}`, { variant: "success" });
  };

  const grid = (
    <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
      <View>
        <View style={styles.headRow}>
          {table.columns.map((column, col) => (
            <View key={col} style={[styles.cell, { width: widths[col] }]}>
              <Text
                numberOfLines={1}
                style={[styles.headText, table.numeric[col] ? { textAlign: "right" as const } : null]}
              >
                {column}
              </Text>
            </View>
          ))}
        </View>
        {rows.map((row, rowIndex) => (
          <Pressable
            key={rowIndex}
            accessibilityRole="button"
            accessibilityLabel={`Row ${rowIndex + 1}, show details`}
            onPress={() => setSelected(selected === rowIndex ? null : rowIndex)}
            style={selected === rowIndex ? styles.rowSelected : rowIndex % 2 ? styles.rowAlt : styles.row}
          >
            {row.map((value, col) => (
              <View key={col} style={[styles.cell, { width: widths[col] }]}>
                <Text
                  numberOfLines={1}
                  style={[
                    value === null ? styles.nullText : styles.cellText,
                    table.numeric[col] ? { textAlign: "right" as const } : null,
                  ]}
                >
                  {value === null ? "NULL" : value.includes("\n") ? `${firstLine(value)} ⏎…` : value}
                </Text>
              </View>
            ))}
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );

  const record = selected !== null ? table.rows[selected] : undefined;

  return (
    <View style={styles.section}>
      {count > 1 ? (
        <Text style={styles.label}>
          Result {index + 1} of {count} · {rowLabel(table.totalRows)}
        </Text>
      ) : null}
      {table.columns.length === 0 ? (
        <Text style={styles.raw}>No rows.</Text>
      ) : showAll && rows.length > 20 ? (
        <ScrollView style={{ maxHeight: SCROLL_HEIGHT }} nestedScrollEnabled>
          {grid}
        </ScrollView>
      ) : (
        grid
      )}
      {record ? (
        <View style={styles.detail}>
          {table.columns.map((column, col) => (
            <View key={col}>
              <Text style={styles.detailKey}>{column}</Text>
              <Text selectable style={record[col] === null ? styles.nullText : styles.detailValue}>
                {record[col] === null ? "NULL" : record[col] || " "}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {table.columns.length > 0 ? (
        <View style={styles.toolbar}>
          {hidden > 0 ? (
            <SmallButton
              styles={styles}
              icon="ChevronsDown"
              label={`Show all ${table.rows.length} rows`}
              onPress={() => setShowAll(true)}
              color={theme.colors.foreground}
            />
          ) : null}
          <SmallButton styles={styles} icon="Copy" label="CSV" onPress={() => void copy("CSV", toCsv(table))} color={theme.colors.foreground} />
          <SmallButton styles={styles} icon="Copy" label="Markdown" onPress={() => void copy("Markdown", toMarkdown(table))} color={theme.colors.foreground} />
          <SmallButton styles={styles} icon="Copy" label="JSON" onPress={() => void copy("JSON", toJson(table))} color={theme.colors.foreground} />
          {dropped > 0 ? <Text style={styles.note}>First {table.rows.length} of {table.totalRows} rows kept here</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

export function SqlTableItem({ theme, layout, item }: PluginTimelineItemProps<SqlTableData>) {
  const { status, command, sql, env, tables, error, raw, exitCode } = item.data;
  const [showSql, setShowSql] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);

  const running = status === "running";
  const failed = error !== null || (exitCode !== null && exitCode !== 0) || status === "failed";
  const title = sql ?? command;
  const isProd = env !== null && /^prod/i.test(env);
  const envColor = isProd ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  const total = tables.reduce((sum, table) => sum + table.totalRows, 0);
  const summary = running
    ? null
    : error
      ? "Error"
      : tables.length > 1
        ? `${tables.length} results`
        : rowLabel(total);

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={showSql ? "Collapse query" : "Expand query"}
        onPress={() => setShowSql((value) => !value)}
        style={styles.header}
      >
        <Icon
          name="Database"
          size={14}
          color={failed ? theme.colors.statusDanger : theme.colors.foregroundMuted}
        />
        <Text style={styles.sql} numberOfLines={showSql ? undefined : 1} selectable={showSql}>
          {showSql ? title : title.replace(/\s+/g, " ")}
        </Text>
        {env ? (
          <View style={[styles.badge, { borderColor: envColor }]}>
            <Text style={[styles.badgeText, { color: envColor }]}>{env}</Text>
          </View>
        ) : null}
        {running ? (
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
        ) : (
          <Text style={[styles.summary, error ? { color: theme.colors.statusDanger } : null]}>{summary}</Text>
        )}
      </Pressable>
      {showSql && sql ? (
        <Text selectable style={[styles.raw, styles.section]}>
          $ {command}
        </Text>
      ) : null}
      {running ? (
        <View style={[styles.section, styles.toolbar]}>
          <Text style={styles.muted}>Running query…</Text>
        </View>
      ) : null}
      {error ? (
        <Text selectable style={[styles.error, styles.section]}>
          {error}
        </Text>
      ) : null}
      {tables.map((table, index) => (
        <ResultTable key={index} table={table} index={index} count={tables.length} styles={styles} theme={theme} />
      ))}
      {raw && !running ? (
        <View style={styles.section}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showRaw ? "Hide raw output" : "Show raw output"}
            onPress={() => setShowRaw((value) => !value)}
            style={styles.toolbar}
          >
            <Icon name={showRaw ? "ChevronDown" : "ChevronRight"} size={12} color={theme.colors.foregroundMuted} />
            <Text style={styles.note}>Raw output</Text>
          </Pressable>
          {showRaw ? (
            <ScrollView horizontal nestedScrollEnabled>
              <Text selectable style={styles.raw}>
                {raw}
              </Text>
            </ScrollView>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
