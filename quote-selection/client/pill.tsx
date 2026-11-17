import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { BADGE_BLUE, excerpt, notesLabel, type Notebook } from "./notes";

/** One "N annotations" pill per agent that has notes, kept in step with the notebook. */
export function installPills(client: PluginClientContext, notebook: Notebook, workspaceOf: (agentId: string) => string | null) {
  const pills = new Map<string, PluginButtonRegistration>();

  const Panel = (props: PluginButtonContentProps) =>
    props.context === "agent" ? <NotesPanel {...props} agentId={props.agentId} notebook={notebook} /> : null;

  const sync = () => {
    for (const agentId of notebook.agents()) {
      const count = notebook.get(agentId).length;
      const pill = pills.get(agentId);
      const workspaceId = workspaceOf(agentId);
      if (count === 0 || !workspaceId) {
        pill?.remove();
        pills.delete(agentId);
        continue;
      }
      const label = notesLabel(count);
      if (pill) {
        pill.update({ label, title: label });
        continue;
      }
      pills.set(
        agentId,
        client.addComposerPill({
          id: "annotations",
          workspaceId,
          agentId,
          button: { title: label, label, icon: "MessageSquareQuote", behavior: { kind: "popover", Content: Panel } },
        }),
      );
    }
    for (const [agentId, pill] of pills) {
      if (notebook.has(agentId)) continue;
      pill.remove();
      pills.delete(agentId);
    }
  };

  const unsubscribe = notebook.subscribe(sync);
  sync();
  return {
    sync,
    dispose() {
      unsubscribe();
      for (const pill of pills.values()) pill.remove();
      pills.clear();
    },
  };
}

function NotesPanel({
  theme,
  agentId,
  notebook,
  close,
}: PluginButtonContentProps & { agentId: string; notebook: Notebook }) {
  const notes = useSyncExternalStore(
    (listener) => notebook.subscribe(listener),
    () => notebook.get(agentId),
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { colors } = theme;
  const styles = useMemo(
    () => ({
      panel: { minWidth: 320, maxWidth: 440 },
      list: { maxHeight: 280 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
      badge: {
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: BADGE_BLUE,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      badgeText: { color: "#ffffff", fontSize: 11, fontWeight: "600" as const },
      body: { flex: 1, flexDirection: "row" as const, alignItems: "baseline" as const, gap: 8, minWidth: 0 },
      comment: { color: colors.foreground, fontSize: 14, flexShrink: 0, maxWidth: "60%" as const },
      quote: { color: colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
      remove: { color: colors.foregroundMuted, fontSize: 14, paddingHorizontal: 4 },
      footer: {
        flexDirection: "row" as const,
        justifyContent: "flex-end" as const,
        alignItems: "center" as const,
        gap: 8,
        padding: 12,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        marginTop: 4,
      },
      ghost: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
      ghostText: { color: colors.foregroundMuted, fontSize: 14 },
      primary: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 8, backgroundColor: colors.accent },
      primaryText: { color: colors.accentForeground, fontSize: 14, fontWeight: "500" as const },
      error: { color: colors.statusDanger, fontSize: 12, paddingHorizontal: 14 },
      empty: { color: colors.foregroundMuted, fontSize: 13, padding: 14 },
    }),
    [colors],
  );

  if (notes.length === 0) return <Text style={styles.empty}>No annotations</Text>;

  const sendNow = async () => {
    setSending(true);
    setError(null);
    try {
      await notebook.sendNow(agentId);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send");
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.panel}>
      <ScrollView style={styles.list} contentContainerStyle={{ paddingTop: 6 }}>
        {notes.map((note, index) => (
          <View key={note.id} style={styles.row}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{index + 1}</Text>
            </View>
            <View style={styles.body}>
              {note.comment.trim() ? (
                <Text style={styles.comment} numberOfLines={1}>
                  {note.comment.trim()}
                </Text>
              ) : null}
              <Text style={styles.quote} numberOfLines={1}>
                {excerpt(note.quote, 80)}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete annotation ${index + 1}`}
              onPress={() => notebook.remove(agentId, [note.id])}
            >
              <Text style={styles.remove}>×</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          style={styles.ghost}
          onPress={() => {
            notebook.clear(agentId);
            close();
          }}
        >
          <Text style={styles.ghostText}>Clear all</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.primary} disabled={sending} onPress={sendNow}>
          <Text style={styles.primaryText}>{sending ? "Sending…" : "Send now"}</Text>
        </Pressable>
      </View>
    </View>
  );
}
