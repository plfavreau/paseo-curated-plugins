import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import { notionLogo } from "./notion-logo";
import { Action, Card, CommandLine, Divider, Dot, MONO, SegmentBar } from "./ui";
import type { NotionAction, NotionCardData } from "../shared/notion";
import { notionPageRpc } from "../shared/notion";


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

function shortHeading(heading: string | null): string {
  if (!heading) return "To-dos";
  return heading.replace(/^[^\p{L}\p{N}]+/u, "").trim() || heading;
}

export function NotionCardItem({ theme, layout, item }: PluginTimelineItemProps<NotionCardData>) {
  const { pageId, action, status, command, output, exitCode, showCommand } = item.data;
  const [expanded, setExpanded] = useState(action === "create");
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

  const muted = theme.colors.foregroundMuted;
  const meta = { color: muted, fontSize: layout.compact ? 11 : 12 };
  const pad = layout.compact ? 10 : 12;

  const commandLine = showCommand ? (
    <CommandLine theme={theme} command={command} output={output} running={status === "running"} exitCode={exitCode} />
  ) : null;

  if (!page) {
    const error = query.data?.error ?? (query.error instanceof Error ? query.error.message : null);
    return (
      <View>
        {commandLine}
        <Card theme={theme}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: pad }}>
            {error ? <Icon icon={notionLogo(muted)} size={14} /> : <ActivityIndicator size="small" color={muted} />}
            <Text style={[meta, { flex: 1 }]} numberOfLines={2}>
              {error ? `Notion page unavailable. ${error}` : "Loading Notion page…"}
            </Text>
          </View>
        </Card>
      </View>
    );
  }

  const done = page.checklists.reduce((sum, list) => sum + list.done, 0);
  const total = page.checklists.reduce((sum, list) => sum + list.total, 0);
  const statusColor = notionColor(page.status?.color ?? null, theme);
  const context = [ACTION_LABEL[action], page.parent, page.lastEditedAt ? `edited ${ago(page.lastEditedAt, now)} ago` : null]
    .filter(Boolean)
    .join("  ·  ");

  const toggleList = (index: number) =>
    setOpenLists((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  return (
    <View>
      {commandLine}
      <Card theme={theme}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Collapse Notion page" : "Expand Notion page"}
          onPress={() => setExpanded((value) => !value)}
          style={{ paddingHorizontal: pad, paddingTop: pad - 2, paddingBottom: total ? 8 : pad - 2, gap: 4 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View style={{ width: 16, alignItems: "center" }}>
              {page.icon ? (
                <Text style={{ fontSize: 14 }}>{page.icon}</Text>
              ) : page.iconUrl ? (
                <Image source={{ uri: page.iconUrl }} style={{ width: 16, height: 16, borderRadius: 3 }} />
              ) : (
                <Icon icon={notionLogo(theme.colors.foreground)} size={15} />
              )}
            </View>
            <Text
              style={[
                { color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 },
                page.inTrash ? { textDecorationLine: "line-through", color: muted } : null,
              ]}
              numberOfLines={expanded ? 3 : 1}
            >
              {page.title}
            </Text>
            <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={muted} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 24 }}>
            {page.status ? (
              <>
                <Dot color={statusColor} />
                <Text style={[meta, { color: theme.colors.foreground }]}>{page.status.value}</Text>
                <Text style={meta}>·</Text>
              </>
            ) : null}
            {page.inTrash ? <Text style={[meta, { color: theme.colors.statusDanger }]}>In trash ·</Text> : null}
            <Text style={[meta, { flex: 1 }]} numberOfLines={1}>
              {context}
            </Text>
          </View>
          {total ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 24, paddingTop: 4 }}>
              <View style={{ flex: 1 }}>
                <SegmentBar
                  theme={theme}
                  segments={[
                    { value: done, color: done === total ? theme.colors.statusSuccess : theme.colors.accent },
                    { value: total - done, color: theme.colors.surface2 },
                  ]}
                />
              </View>
              <Text style={{ color: muted, fontSize: 11 }}>
                {done}/{total} to-dos
              </Text>
            </View>
          ) : null}
        </Pressable>

        {expanded ? (
          <>
            {page.properties.length > 0 ? (
              <>
                <Divider theme={theme} />
                <View style={{ paddingHorizontal: pad, paddingVertical: 8, gap: 2 }}>
                  {page.properties.map((property) => (
                    <View key={property.name} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 3 }}>
                      <Text style={[meta, { width: layout.compact ? 96 : 132 }]} numberOfLines={1}>
                        {property.name}
                      </Text>
                      <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}>
                        {property.color ? <Dot color={notionColor(property.color, theme)} /> : null}
                        <Text style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                          {property.value}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              </>
            ) : null}

            {page.checklists.length > 0 ? (
              <>
                <Divider theme={theme} />
                <View style={{ paddingVertical: 4 }}>
                  {page.checklists.map((list, index) => {
                    const open = openLists.has(index);
                    const complete = list.done === list.total;
                    return (
                      <View key={`${list.heading ?? ""}-${index}`}>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${shortHeading(list.heading)}: ${list.done} of ${list.total} done`}
                          onPress={() => toggleList(index)}
                          style={({ pressed }) => ({
                            flexDirection: "row",
                            alignItems: "center",
                            gap: 10,
                            paddingHorizontal: pad,
                            paddingVertical: 7,
                            backgroundColor: pressed ? theme.colors.surface1 : "transparent",
                          })}
                        >
                          <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={muted} />
                          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "500", flex: 1 }} numberOfLines={1}>
                            {shortHeading(list.heading)}
                          </Text>
                          <View style={{ width: layout.compact ? 56 : 96 }}>
                            <SegmentBar
                              theme={theme}
                              segments={[
                                { value: list.done, color: complete ? theme.colors.statusSuccess : theme.colors.accent },
                                { value: list.total - list.done, color: theme.colors.surface2 },
                              ]}
                            />
                          </View>
                          <Text style={{ color: muted, fontSize: 11, fontFamily: MONO, minWidth: 36, textAlign: "right" }}>
                            {list.done}/{list.total}
                          </Text>
                        </Pressable>
                        {open
                          ? list.items.map((todo, todoIndex) => (
                              <View
                                key={todoIndex}
                                style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingLeft: pad + 24, paddingRight: pad, paddingVertical: 3 }}
                              >
                                <View style={{ paddingTop: 1 }}>
                                  <Icon
                                    name={todo.checked ? "SquareCheck" : "Square"}
                                    size={13}
                                    color={todo.checked ? theme.colors.statusSuccess : muted}
                                  />
                                </View>
                                <Text
                                  style={[
                                    { color: theme.colors.foreground, fontSize: 12, flex: 1, lineHeight: 17 },
                                    todo.checked ? { color: muted } : null,
                                  ]}
                                  selectable
                                >
                                  {todo.text || "(empty)"}
                                </Text>
                              </View>
                            ))
                          : null}
                        {open && list.items.length < list.total ? (
                          <Text style={[meta, { paddingLeft: pad + 24, paddingVertical: 4 }]}>
                            {list.total - list.items.length} more in Notion
                          </Text>
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              </>
            ) : null}

            <Divider theme={theme} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2, paddingHorizontal: pad - 6, paddingVertical: 4 }}>
              <Action theme={theme} icon="ExternalLink" label="Open in Notion" onPress={() => void openExternalUrl(page.url)} />
              <Action
                theme={theme}
                icon="Link"
                label="Copy link"
                onPress={() =>
                  copyText(page.url).then(
                    () => toast.show("Link copied", { variant: "success" }),
                    () => toast.error("Copy failed"),
                  )
                }
              />
              <View style={{ flex: 1 }} />
              <Text style={{ color: muted, fontSize: 11 }}>Updated {ago(page.fetchedAt, now) ?? "0s"} ago</Text>
              <Action theme={theme} icon="RefreshCw" accessibilityLabel="Refresh" onPress={() => void query.refetch()} />
            </View>
          </>
        ) : null}
      </Card>
    </View>
  );
}
