import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, type SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { useRef } from "react";
import { Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { DEFAULT_PROMPT, preferences } from "../shared/contracts";
import { useSessions } from "./health";

export function CleanupSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const sessions = useSessions();
  const promptRef = useRef<SettingsInputHandle>(null);

  if (settings.status !== "ready") {
    return <Text style={{ color: theme.colors.foregroundMuted }}>{settings.status === "loading" ? "Loading…" : "Settings unavailable"}</Text>;
  }
  const { values, revision } = settings;
  const options = [{ label: "None", value: "" }, ...(sessions.data?.sessions ?? []).map((s) => ({ label: s.title, value: s.id }))];

  return (
    <SettingsSection title="Cleanup">
      <SettingsCard>
        <SettingsSelect
          label="Session"
          hint="The Paseo session that receives the message when you press Clean."
          value={values.targetWorkspaceId}
          options={options}
          onValueChange={(targetWorkspaceId) => void settings.save({ ...values, targetWorkspaceId }, revision)}
        />
        <SettingsInput
          ref={promptRef}
          label="Message"
          hint="{stats} is replaced with the current CPU, RAM and disk readings."
          initialValue={values.prompt}
          onChangeText={() => {}}
        />
        <SettingsAction
          label="Save message"
          actionLabel="Save"
          onPress={() => void settings.save({ ...values, prompt: promptRef.current?.getText() ?? values.prompt }, revision)}
        />
        <SettingsAction
          label="Default message"
          actionLabel="Reset"
          onPress={() => {
            promptRef.current?.replaceText(DEFAULT_PROMPT);
            void settings.save({ ...values, prompt: DEFAULT_PROMPT }, revision);
          }}
        />
      </SettingsCard>
      {settings.saveError ? <Text style={{ color: "#E5484D" }}>{String(settings.saveError)}</Text> : null}
    </SettingsSection>
  );
}
