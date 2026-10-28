import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { listPinsRpc, savePinRpc } from "../shared/pins";
import { dialogStyles, type Theme } from "./dialog-styles";
import { setPins } from "./pin-store";

export function PinComposer({ agentId, theme }: { agentId: string; theme: Theme }) {
  const savePin = useRpc(savePinRpc);
  const listPins = useRpc(listPinsRpc);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const styles = useMemo(() => dialogStyles(theme), [theme]);
  const canSave = body.trim().length > 0 && !saving;

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await savePin({ agentId, title: title.trim(), body: body.trim() });
      setPins((await listPins({})).pins);
      setTitle("");
      setBody("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.composer}>
      <TextInput
        accessibilityLabel="Pin description"
        value={body}
        onChangeText={setBody}
        placeholder="Paste a link or write a note"
        placeholderTextColor={theme.colors.foregroundMuted}
        multiline
        autoFocus
        style={styles.bodyInput}
      />
      {body.trim().length > 0 ? (
        <TextInput
          accessibilityLabel="Pin title"
          value={title}
          onChangeText={setTitle}
          placeholder="Title (automatic for links)"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.titleInput}
        />
      ) : null}
      <View style={styles.composerFooter}>
        {error ? (
          <Text style={styles.error}>{error}</Text>
        ) : (
          <Text style={styles.hint}>Pinned to this conversation</Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save pin"
          disabled={!canSave}
          onPress={() => void submit()}
          style={[styles.pinButton, !canSave && { opacity: 0.35 }]}
        >
          <Text style={styles.pinButtonText}>{saving ? "Pinning…" : "Pin"}</Text>
        </Pressable>
      </View>
    </View>
  );
}
