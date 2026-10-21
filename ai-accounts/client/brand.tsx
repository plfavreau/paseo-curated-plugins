import { Image, View } from "react-native";
import type { AccountProvider } from "./harness";
import { CLAUDE_LOGO, OPENAI_LOGO } from "./logos";

export const BRAND = {
  anthropic: {
    name: "Claude",
    accent: "#D97757",
    tint: "#D9775718",
    logo: CLAUDE_LOGO,
  },
  openai: {
    name: "OpenAI Codex",
    accent: "#10A37F",
    tint: "#10A37F18",
    logo: OPENAI_LOGO,
  },
};
export function ProviderLogo({ provider, size }: { provider: AccountProvider; size: number }) {
  const brand = BRAND[provider];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 3, alignItems: "center", justifyContent: "center", backgroundColor: brand.tint }}>
      <Image accessibilityLabel={`${brand.name} logo`} resizeMode="contain" source={{ uri: brand.logo }} style={{ width: size * 0.62, height: size * 0.62 }} />
    </View>
  );
}

