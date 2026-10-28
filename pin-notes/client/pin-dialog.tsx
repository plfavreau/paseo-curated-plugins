import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { dialogStyles } from "./dialog-styles";
import { PinComposer } from "./pin-composer";
import { closePinDialog, usePinDialog } from "./pin-store";
import { PinsList } from "./pins-list";

export function PinDialogHost({ theme }: PluginSidebarItemProps) {
  const agentId = usePinDialog();
  const styles = useMemo(() => dialogStyles(theme), [theme]);

  return (
    <Modal
      title="Pins"
      icon={<Icon name="Pin" size={18} color={theme.colors.foreground} />}
      open={agentId !== null}
      onOpenChange={(open) => {
        if (!open) closePinDialog();
      }}
    >
      <Modal.Content contentContainerStyle={styles.body}>
        {agentId ? (
          <>
            <PinComposer agentId={agentId} theme={theme} />
            <PinsList agentId={agentId} theme={theme} />
          </>
        ) : null}
      </Modal.Content>
    </Modal>
  );
}
