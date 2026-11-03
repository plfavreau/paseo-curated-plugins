import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Pressable } from "react-native";
import { CleanupScreen, HealthPopover, SidebarPills } from "./client/health";
import { CleanupSettings } from "./client/settings";

function HealthItem({ openPopover }: PluginSidebarItemProps) {
  const open = () => openPopover(HealthPopover);
  return (
    <SidebarRow
      icon="Activity"
      label=""
      onPress={open}
      trailing={
        <Pressable accessibilityRole="button" accessibilityLabel="System health" onPress={open}>
          <SidebarPills />
        </Pressable>
      }
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "cleanup", title: (params) => params.hostLabel ? `Cleanup · ${params.hostLabel}` : "Cleanup", Component: CleanupScreen });
  client.addSidebarFooterItem({ id: "system-health", title: "System health", Component: HealthItem });
  client.addSettingsScreen({ id: "cleanup", title: "System health", icon: "Activity", Component: CleanupSettings });
  return () => {};
}
