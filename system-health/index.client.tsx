import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Pressable } from "react-native";
import { CleanupScreen, HealthPopover, SidebarPills } from "./client/health";
import { HostHint, HostHover } from "./client/host-hover";
import { CleanupSettings } from "./client/settings";

function HealthItem({ host, theme, openPopover }: PluginSidebarItemProps) {
  const open = () => openPopover(HealthPopover);
  return (
    <HostHover>
      {(hovered) => (
        <SidebarRow
          icon="Activity"
          label=""
          onPress={open}
          trailing={
            hovered ? (
              <HostHint theme={theme} hostLabel={host.label} onPress={open} />
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel="System health" onPress={open}>
                <SidebarPills />
              </Pressable>
            )
          }
        />
      )}
    </HostHover>
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "cleanup", title: (params) => params.hostLabel ? `Cleanup · ${params.hostLabel}` : "Cleanup", Component: CleanupScreen });
  client.addSidebarFooterItem({ id: "system-health", title: "System health", Component: HealthItem });
  client.addSettingsScreen({ id: "cleanup", title: "System health", icon: "Activity", Component: CleanupSettings });
  return () => {};
}
