import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Pressable, View } from "react-native";
import { CleanupScreen, HealthPopover, SidebarPills } from "./client/health";
import { CleanupSettings } from "./client/settings";

function HealthItem({ host, openPopover }: PluginSidebarItemProps) {
  const open = () => openPopover(HealthPopover);
  return (
    <View>
      <SidebarRow icon="Activity" label={`Health · ${host.label}`} onPress={open} />
      <Pressable accessibilityRole="button" accessibilityLabel={`System health · ${host.label}`} onPress={open} style={{ paddingLeft: 30, paddingRight: 8, paddingBottom: 6 }}>
        <SidebarPills />
      </Pressable>
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "cleanup", title: (params) => params.hostLabel ? `Cleanup · ${params.hostLabel}` : "Cleanup", Component: CleanupScreen });
  client.addSidebarFooterItem({ id: "system-health", title: "System health", Component: HealthItem });
  client.addSettingsScreen({ id: "cleanup", title: "System health", icon: "Activity", Component: CleanupSettings });
  return () => {};
}
