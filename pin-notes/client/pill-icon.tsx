import type { PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { type ComponentType, useState } from "react";
import { Image } from "react-native";

export function PinGlyph({
  faviconUrl,
  isLink,
  size,
  color,
}: {
  faviconUrl: string | null;
  isLink: boolean;
  size: number;
  color: string;
}) {
  const [failed, setFailed] = useState(false);
  if (faviconUrl && !failed) {
    return (
      <Image
        source={{ uri: faviconUrl }}
        onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: size / 5 }}
      />
    );
  }
  return <Icon name={isLink ? "Link" : "StickyNote"} size={size} color={color} />;
}

export function pinPillIcon(
  faviconUrl: string | null,
  isLink: boolean,
): ComponentType<PluginButtonIconProps> {
  return function PinPillIcon({ size, color }) {
    return <PinGlyph faviconUrl={faviconUrl} isLink={isLink} size={size} color={color} />;
  };
}
