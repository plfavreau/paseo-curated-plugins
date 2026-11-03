import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";

export function HostHint({ theme, hostLabel, onPress }: { theme: PluginSidebarItemProps["theme"]; hostLabel: string; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hostLabel}
      onPress={onPress}
      style={{ maxWidth: 180, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: theme.colors.surface2 }}
    >
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {hostLabel}
      </Text>
    </Pressable>
  );
}

/** Renders `children(hovered)` so a row can swap its trailing slot for the host name while the pointer is over it. */
export function HostHover({ children }: { children: (hovered: boolean) => ReactNode }) {
  const [hovered, setHovered] = useState(false);
  return (
    <View onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      {children(hovered)}
    </View>
  );
}
