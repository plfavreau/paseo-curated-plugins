import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { CleanupScreen, HealthPopover, SidebarPills } from "./client/health";
import { CleanupSettings } from "./client/settings";

function HealthItem({ openPopover }: PluginSidebarItemProps) {
  return <SidebarRow icon="Activity" label="" onPress={() => openPopover(HealthPopover)} trailing={<SidebarPills />} />;
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "cleanup", title: "Cleanup", Component: CleanupScreen });
  client.addSidebarHeaderItem({ id: "system-health", title: "System health", Component: HealthItem });
  client.addSettingsScreen({ id: "cleanup", title: "System health", icon: "Activity", Component: CleanupSettings });
  return () => {};
}
