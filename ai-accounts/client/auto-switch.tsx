import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Switch, Text, View } from "react-native";
import { autoSwitchGetRpc, autoSwitchSetRpc, type SwitchNote } from "../shared/contracts";
import { Group, SectionHead, type Theme, useUi } from "./ui";

const KEY = ["ai-accounts", "auto-switch"];

function liftsLabel(liftsAt: string | null): string {
  if (!liftsAt) return "";
  const date = new Date(liftsAt);
  return Number.isNaN(date.getTime()) ? "" : `, free again ${date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

export function SwitchNoteView({ item, theme }: PluginTimelineItemProps<SwitchNote>) {
  const { from, to, liftsAt } = item.data;
  return (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, paddingVertical: 4 }}>
      {`↪ Switched to ${to}: ${from ?? "the previous account"} hit its usage limit${liftsLabel(liftsAt)}.`}
    </Text>
  );
}

function Row({ theme, title, detail, value, disabled, onChange }: { theme: Theme; title: string; detail: string; value: boolean; disabled?: boolean; onChange(value: boolean): void }) {
  const ui = useUi(theme);
  return (
    <View style={[ui.row, { gap: 12 }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={ui.primary}>{title}</Text>
        <Text style={ui.secondary}>{detail}</Text>
      </View>
      <Switch accessibilityLabel={title} value={value} disabled={disabled} onValueChange={onChange} />
    </View>
  );
}

export function AutoSwitchSettings({ theme, dense }: { theme: Theme; dense?: boolean }) {
  const get = useRpc(autoSwitchGetRpc);
  const set = useRpc(autoSwitchSetRpc);
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: KEY, queryFn: () => get({}) });
  const update = useMutation({ mutationFn: set, onSuccess: (next) => queryClient.setQueryData(KEY, next) });
  const value = update.isPending && settings.data ? { ...settings.data, ...update.variables } : settings.data;
  if (!value) return null;
  return (
    <View style={{ gap: 8 }}>
      <SectionHead theme={theme} dense={dense} title="Automatic switching" />
      <Group theme={theme} dense={dense}>
        <Row
          theme={theme}
          title="Switch when an account hits its limit"
          detail="Moves the conversation to the Claude account with the most room. OpenCode retries the refused request there without a restart."
          value={value.onLimit}
          onChange={(onLimit) => update.mutate({ onLimit })}
        />
        <Row
          theme={theme}
          title="Continue after a Claude Code switch"
          detail="Claude Code restarts on the new account, so it is told to carry on with the interrupted task."
          value={value.continueAfter}
          disabled={!value.onLimit}
          onChange={(continueAfter) => update.mutate({ continueAfter })}
        />
      </Group>
    </View>
  );
}
