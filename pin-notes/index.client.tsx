import {
  openExternalUrl,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { notePopover } from "./client/note-popover";
import { PinDialogHost } from "./client/pin-dialog";
import { getPins, openPinDialog, setPins, subscribePins } from "./client/pin-store";
import { pinPillIcon } from "./client/pill-icon";
import { listPinsRpc, type Pin } from "./shared/pins";

type PillEntry = { signature: string; registration: PluginButtonRegistration };

export default function contribute(client: PluginClientContext) {
  const agentWorkspaces = new Map<string, string>();
  const pills = new Map<string, PillEntry>();

  client.addSidebarFooterItem({
    id: "pin-dialog",
    title: "Pin note dialog",
    Component: PinDialogHost,
  });

  client.addCommandCenterItem({
    id: "pin-note",
    title: "Pin note",
    icon: "Pin",
    keywords: ["note", "link", "bookmark", "pin"],
    context: "agent",
    onSelect({ agent }) {
      openPinDialog(agent.id);
    },
  });
  client.addCommandCenterItem({
    id: "manage-pins",
    title: "Manage pins",
    icon: "List",
    keywords: ["pin", "unpin", "pinned", "notes"],
    context: "agent",
    onSelect({ agent }) {
      openPinDialog(agent.id);
    },
  });

  function addPinPill(pin: Pin, workspaceId: string) {
    const url = pin.url;
    return client.addComposerPill({
      id: `pin-${pin.id}`,
      workspaceId,
      agentId: pin.agentId,
      button: {
        title: pin.title,
        label: pin.title,
        icon: pinPillIcon(pin.faviconUrl, Boolean(url)),
        behavior: url
          ? { kind: "action", onPress: () => openExternalUrl(url) }
          : { kind: "popover", Content: notePopover(pin) },
      },
    });
  }

  function renderPins() {
    const live = new Set<string>();
    for (const pin of getPins()) {
      const workspaceId = agentWorkspaces.get(pin.agentId);
      if (!workspaceId) continue;
      live.add(pin.id);
      const signature = [workspaceId, pin.title, pin.body, pin.url ?? "", pin.faviconUrl ?? ""].join(
        "\n",
      );
      const existing = pills.get(pin.id);
      if (existing?.signature === signature) continue;
      existing?.registration.remove();
      pills.set(pin.id, { signature, registration: addPinPill(pin, workspaceId) });
    }
    for (const [id, entry] of pills) {
      if (live.has(id)) continue;
      entry.registration.remove();
      pills.delete(id);
    }
  }

  const unsubscribePins = subscribePins(renderPins);
  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind !== "upsert" || !update.agent.workspaceId) return;
    agentWorkspaces.set(update.agent.id, update.agent.workspaceId);
    renderPins();
  });

  void client.paseo.agents.list().then(({ entries }) => {
    for (const { agent } of entries) {
      if (agent.workspaceId) agentWorkspaces.set(agent.id, agent.workspaceId);
    }
    renderPins();
  });
  void client.rpc(listPinsRpc, {}).then(({ pins }) => setPins(pins));

  return () => {
    unsubscribePins();
    unsubscribeAgents();
    for (const entry of pills.values()) entry.registration.remove();
    pills.clear();
  };
}
