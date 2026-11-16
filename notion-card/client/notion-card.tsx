import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { NotionAction, NotionCardData, NotionChecklist, NotionPage } from "../shared/notion";
import { notionPageRpc } from "../shared/notion";

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

/** Notion's own tag colors, readable on light and dark surfaces. */
const NOTION_COLORS: Record<string, string> = {
  gray: "#8a8a85",
  brown: "#a27763",
  orange: "#d9730d",
  yellow: "#cb912f",
  green: "#448361",
  blue: "#337ea9",
  purple: "#9065b0",
  pink: "#c14c8a",
  red: "#d44c47",
};

const ACTION_LABEL: Record<NotionAction, string> = {
  get: "Read",
  edit: "Edited",
  create: "Created",
  trash: "Trashed",
  update: "Updated properties",
  append: "Added content",
};

function notionColor(color: string | null, theme: PluginTheme): string {
  return (color && NOTION_COLORS[color]) || theme.colors.foregroundMuted;
}

function ago(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(seconds)) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The QA checklist is the one that says whether a ticket can close, so it leads. */
function headlineChecklist(page: NotionPage): NotionChecklist | null {
  return page.checklists.find((list) => /\bqa\b/i.test(list.heading ?? "")) ?? page.checklists[0] ?? null;
}

function shortHeading(heading: string | null): string {
  if (!heading) return "To-dos";
  return heading.replace(/^[^\p{L}\p{N}]+/u, "").trim() || heading;
}

export function NotionCardItem({ theme, layout, item }: PluginTimelineItemProps<NotionCardData>) {
  const { pageId, action, status, command, output, exitCode, showCommand } = item.data;
  const [expanded, setExpanded] = useState(action === "create");
  const [showOutput, setShowOutput] = useState(false);
  const [openLists, setOpenLists] = useState<ReadonlySet<number>>(() => new Set());
  const loadPage = useRpc(notionPageRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [now, setNow] = useState(() => Date.now());

  const queryKey = useMemo(() => ["notion-card", pageId], [pageId]);
  const query = useQuery({
    queryKey,
    queryFn: () => loadPage({ pageId }),
    enabled: status !== "running" || action === "get",
    staleTime: 15_000,
    retry: 1,
    refetchInterval: expanded ? 60_000 : false,
  });
  const page = query.data?.page ?? null;

  // A write that just finished changed the page: refresh every card that shows it, older ones included.
  const previousStatus = useRef(status);
  useEffect(() => {
    if (previousStatus.current === "running" && status === "completed" && action !== "get") {
      void queryClient.invalidateQueries({ queryKey });
    }
    previousStatus.current = status;
  }, [status, action, queryClient, queryKey]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const styles = useMemo(() => {
    const small = layout.compact ? 11 : 12;
    return {
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden" as const,
        marginVertical: 2,
      },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, padding: 10 },
      emoji: { fontSize: 16, width: 20, textAlign: "center" as const },
      headText: { flex: 1, gap: 2 },
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      meta: { color: theme.colors.foregroundMuted, fontSize: small },
      pill: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 5,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
      },
      dot: { width: 7, height: 7, borderRadius: 4 },
      pillText: { fontSize: 11, fontWeight: "600" as const },
      progressMini: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 },
      progressMiniText: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" as const },
      props: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 6,
        paddingHorizontal: 10,
        paddingBottom: 10,
      },
      prop: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        maxWidth: "100%" as const,
      },
      propName: { color: theme.colors.foregroundMuted, fontSize: 11 },
      propValue: { color: theme.colors.foreground, fontSize: 11, fontWeight: "500" as const, flexShrink: 1 },
      section: { borderTopWidth: 1, borderTopColor: theme.colors.border },
      listHead: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
      },
      listTitle: { color: theme.colors.foreground, fontSize: 12, fontWeight: "500" as const, flexShrink: 1 },
      listCount: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: MONO },
      bar: { flex: 1, height: 5, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" as const },
      todo: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 8,
        paddingLeft: 28,
        paddingRight: 10,
        paddingVertical: 3,
      },
      todoText: { color: theme.colors.foreground, fontSize: 12, flex: 1, lineHeight: 17 },
      todoDone: { color: theme.colors.foregroundMuted, textDecorationLine: "line-through" as const },
      footer: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 8,
        padding: 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      button: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      buttonLabel: { color: theme.colors.foreground, fontSize: 12, fontWeight: "500" as const },
      updated: { color: theme.colors.foregroundMuted, fontSize: 11, marginLeft: "auto" as const },
      commandRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingVertical: 4 },
      command: { color: theme.colors.foregroundMuted, fontFamily: MONO, fontSize: 12, flexShrink: 1 },
      output: {
        maxHeight: 220,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        padding: 8,
        marginBottom: 6,
      },
      outputText: { color: theme.colors.foreground, fontFamily: MONO, fontSize: 11 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      statusRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, padding: 10 },
    };
  }, [theme, layout.compact]);

  const commandHeader = showCommand ? (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={showOutput ? "Hide command output" : "Show command output"}
        style={styles.commandRow}
        onPress={() => setShowOutput((value) => !value)}
      >
        <Icon name="SquareTerminal" size={13} color={theme.colors.foregroundMuted} />
        <Text style={styles.command} numberOfLines={showOutput ? undefined : 1}>
          {command}
        </Text>
        {status === "running" ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
        {exitCode !== null && exitCode !== 0 ? <Text style={styles.error}>exit {exitCode}</Text> : null}
        <Icon name={showOutput ? "ChevronUp" : "ChevronDown"} size={13} color={theme.colors.foregroundMuted} />
      </Pressable>
      {showOutput ? (
        <ScrollView style={styles.output} nestedScrollEnabled>
          <Text style={styles.outputText} selectable>
            {output.length > 0 ? output : "(no output)"}
          </Text>
        </ScrollView>
      ) : null}
    </>
  ) : null;

  if (!page) {
    const error = query.data?.error ?? (query.error instanceof Error ? query.error.message : null);
    return (
      <View>
        {commandHeader}
        <View style={[styles.card, styles.statusRow]}>
          {error ? (
            <Icon name="FileX" size={14} color={theme.colors.foregroundMuted} />
          ) : (
            <ActivityIndicator size="small" color={theme.colors.accent} />
          )}
          <Text style={[styles.meta, { flex: 1 }]} numberOfLines={2}>
            {error ? `Notion page unavailable: ${error}` : "Loading Notion page…"}
          </Text>
        </View>
      </View>
    );
  }

  const headline = headlineChecklist(page);
  const statusColor = notionColor(page.status?.color ?? null, theme);
  const subtitle = [ACTION_LABEL[action], page.parent, page.lastEditedAt ? `edited ${ago(page.lastEditedAt, now)} ago` : null]
    .filter(Boolean)
    .join(" · ");

  const toggleList = (index: number) =>
    setOpenLists((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <View>
      {commandHeader}
      <View style={styles.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Collapse Notion page" : "Expand Notion page"}
          style={styles.head}
          onPress={() => setExpanded((value) => !value)}
        >
          {page.icon ? (
            <Text style={styles.emoji}>{page.icon}</Text>
          ) : (
            <Icon name="FileText" size={16} color={theme.colors.foregroundMuted} />
          )}
          <View style={styles.headText}>
            <Text style={[styles.title, page.inTrash ? styles.todoDone : null]} numberOfLines={expanded ? 3 : 1}>
              {page.title}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {page.inTrash ? "In trash · " : ""}
              {subtitle}
            </Text>
          </View>
          {headline && !expanded ? (
            <View style={styles.progressMini}>
              <Icon
                name={headline.done === headline.total ? "SquareCheck" : "ListChecks"}
                size={13}
                color={headline.done === headline.total ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
              />
              <Text style={styles.progressMiniText}>
                {headline.done}/{headline.total}
              </Text>
            </View>
          ) : null}
          {page.status ? (
            <View style={[styles.pill, { backgroundColor: `${statusColor}26` }]}>
              <View style={[styles.dot, { backgroundColor: statusColor }]} />
              <Text style={[styles.pillText, { color: statusColor }]}>{page.status.value}</Text>
            </View>
          ) : null}
          {query.isFetching ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
        </Pressable>

        {expanded ? (
          <>
            {page.properties.length > 0 ? (
              <View style={styles.props}>
                {page.properties.map((property) => (
                  <View key={property.name} style={styles.prop}>
                    {property.value.toLowerCase().startsWith(property.name.toLowerCase()) ? null : (
                      <Text style={styles.propName}>{property.name}</Text>
                    )}
                    {property.color ? (
                      <View style={[styles.dot, { backgroundColor: notionColor(property.color, theme) }]} />
                    ) : null}
                    <Text style={styles.propValue} numberOfLines={1}>
                      {property.value}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}

            {page.checklists.map((list, index) => {
              const open = openLists.has(index);
              const complete = list.done === list.total;
              return (
                <View key={`${list.heading ?? ""}-${index}`} style={styles.section}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${shortHeading(list.heading)}: ${list.done} of ${list.total} done`}
                    style={styles.listHead}
                    onPress={() => toggleList(index)}
                  >
                    <Icon name={open ? "ChevronDown" : "ChevronRight"} size={13} color={theme.colors.foregroundMuted} />
                    <Text style={styles.listTitle} numberOfLines={1}>
                      {shortHeading(list.heading)}
                    </Text>
                    <View style={styles.bar}>
                      <View
                        style={{
                          width: `${list.total ? Math.round((list.done / list.total) * 100) : 0}%`,
                          height: "100%",
                          backgroundColor: complete ? theme.colors.statusSuccess : theme.colors.accent,
                        }}
                      />
                    </View>
                    <Text style={styles.listCount}>
                      {list.done}/{list.total}
                    </Text>
                  </Pressable>
                  {open
                    ? list.items.map((todo, todoIndex) => (
                        <View key={todoIndex} style={styles.todo}>
                          <Icon
                            name={todo.checked ? "SquareCheck" : "Square"}
                            size={14}
                            color={todo.checked ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
                          />
                          <Text style={[styles.todoText, todo.checked ? styles.todoDone : null]} selectable>
                            {todo.text || "(empty)"}
                          </Text>
                        </View>
                      ))
                    : null}
                  {open && list.items.length < list.total ? (
                    <Text style={[styles.meta, { paddingLeft: 28, paddingBottom: 6 }]}>
                      {list.total - list.items.length} more in Notion
                    </Text>
                  ) : null}
                </View>
              );
            })}

            <View style={styles.footer}>
              <Pressable accessibilityRole="link" style={styles.button} onPress={() => void openExternalUrl(page.url)}>
                <Icon name="ExternalLink" size={13} color={theme.colors.foreground} />
                <Text style={styles.buttonLabel}>Open in Notion</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() =>
                  copyText(page.url).then(
                    () => toast.show("Notion link copied", { variant: "success" }),
                    () => toast.error("Copy failed"),
                  )
                }
              >
                <Icon name="Copy" size={13} color={theme.colors.foreground} />
                <Text style={styles.buttonLabel}>Copy link</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh"
                style={styles.button}
                onPress={() => void query.refetch()}
              >
                <Icon name="RefreshCw" size={13} color={theme.colors.foreground} />
              </Pressable>
              <Text style={styles.updated}>Updated {ago(page.fetchedAt, now) ?? "0s"} ago</Text>
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}
