import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { listPinsRpc, removePinRpc, type Pin } from "../shared/pins";
import { dialogStyles, type Theme } from "./dialog-styles";
import { PinGlyph } from "./pill-icon";
import { setPins, usePins } from "./pin-store";

function subtitle(pin: Pin) {
  if (pin.url) return new URL(pin.url).hostname.replace(/^www\./, "");
  return pin.body.replace(/\s+/g, " ");
}

export function PinsList({ agentId, theme }: { agentId: string; theme: Theme }) {
  const pins = usePins().filter((pin) => pin.agentId === agentId);
  const listPins = useRpc(listPinsRpc);
  const removePin = useRpc(removePinRpc);
  const styles = useMemo(() => dialogStyles(theme), [theme]);

  useEffect(() => {
    void listPins({}).then(({ pins: latest }) => setPins(latest));
  }, []);

  async function unpin(pin: Pin) {
    await removePin({ id: pin.id });
    setPins((await listPins({})).pins);
  }

  if (pins.length === 0) return <Text style={styles.empty}>Nothing pinned yet</Text>;

  return (
    <View style={styles.list}>
      <Text style={styles.sectionLabel}>Pinned</Text>
      {pins.map((pin) => {
        const url = pin.url;
        return (
          <Pressable
            key={pin.id}
            accessibilityRole={url ? "link" : "text"}
            disabled={!url}
            onPress={() => url && void openExternalUrl(url)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={styles.glyph}>
              <PinGlyph
                faviconUrl={pin.faviconUrl}
                isLink={Boolean(url)}
                size={18}
                color={theme.colors.foregroundMuted}
              />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {pin.title}
              </Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {subtitle(pin)}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Unpin ${pin.title}`}
              onPress={() => void unpin(pin)}
              style={styles.remove}
            >
              <Icon name="X" size={16} color={theme.colors.foregroundMuted} />
            </Pressable>
          </Pressable>
        );
      })}
    </View>
  );
}
