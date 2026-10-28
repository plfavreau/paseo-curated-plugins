import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { ComponentType } from "react";
import type { Pin } from "../shared/pins";

export function notePopover(pin: Pin): ComponentType<PluginButtonContentProps> {
  return function NotePopover({ theme }) {
    return (
      <View style={{ gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>
          {pin.title}
        </Text>
        <Text selectable style={{ color: theme.colors.foreground, lineHeight: 20 }}>
          {pin.body}
        </Text>
      </View>
    );
  };
}
