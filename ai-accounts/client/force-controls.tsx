import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { forcePlanRpc, forceStartRpc, forceStatusRpc, type ForceJob } from "../shared/contracts";
import type { AccountProvider } from "./harness";
import { Button, Dot, Group, Meter, TABULAR, type Theme, useUi } from "./ui";

export const FORCE_STATUS_KEY = ["ai-accounts", "force-status"] as const;

/** Tracks the daemon-side force job. It outlives any popover or screen, so every surface can show it. */
export function useForceJob() {
  const forceStatus = useRpc(forceStatusRpc);
  const queryClient = useQueryClient();
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: FORCE_STATUS_KEY,
    queryFn: () => forceStatus({}),
    staleTime: 0,
    refetchInterval: (current) => {
      const job = current.state.data?.job;
      return job && job.finishedAt === null ? 1_500 : false;
    },
  });
  const job = query.data?.job ?? null;
  const running = job !== null && job.finishedAt === null;
  const finishedAt = job?.finishedAt ?? null;
  useEffect(() => {
    // Accounts, pins and the active badge all changed under every open view.
    if (finishedAt) void queryClient.invalidateQueries({ queryKey: ["ai-accounts"] });
  }, [finishedAt, queryClient]);
  return {
    job,
    running,
    visibleJob: job && job.id !== dismissedId ? job : null,
    dismiss: () => {
      if (job) setDismissedId(job.id);
    },
  };
}

export function ForceProgressCard({ theme, dense, job, running, onDismiss }: { theme: Theme; dense?: boolean; job: ForceJob; running: boolean; onDismiss(): void }) {
  const ui = useUi(theme, dense);
  const count = (outcome: ForceJob["results"][number]["outcome"]) => job.results.filter((result) => result.outcome === outcome).length;
  const failures = job.results.filter((result) => result.outcome === "failed");
  const notes = job.results.filter((result) => result.outcome !== "failed" && result.detail);
  const title =
    job.kind === "balance"
      ? running
        ? "Rebalancing conversations…"
        : job.phase === "failed"
          ? "Could not finish rebalancing"
          : "Conversations rebalanced"
      : running
        ? `Moving everything to ${job.email}…`
        : job.phase === "failed"
          ? `Could not move everything to ${job.email}`
          : `Everything now uses ${job.email}`;
  return (
    <Group theme={theme} dense={dense}>
      <View key="status" style={[ui.row, { flexDirection: "column", alignItems: "stretch", gap: 8 }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {running ? <ActivityIndicator color={theme.colors.foregroundMuted} size="small" /> : <Dot color={job.phase === "failed" ? theme.colors.statusDanger : theme.colors.statusSuccess} />}
          <Text style={[ui.primary, { flex: 1, fontWeight: "600" }]}>{title}</Text>
          {running ? null : <Button theme={theme} kind="plain" color={theme.colors.foregroundMuted} title="Dismiss" onPress={onDismiss} />}
        </View>
        {job.phase === "preparing" ? <Text style={ui.secondary}>Checking the account and listing conversations…</Text> : null}
        {job.total > 0 ? (
          <>
            <Meter theme={theme} value={job.completed / job.total} color={theme.colors.accent} />
            <Text style={[ui.secondary, TABULAR]}>
              {`${job.completed} of ${job.total} · ${count("resumed")} resumed · ${count("reassigned")} switched · ${failures.length} failed · ${job.assignments} pins moved`}
            </Text>
          </>
        ) : job.phase === "applying" || job.phase === "done" ? (
          <Text style={ui.secondary}>{`No open conversation needed moving. ${job.assignments} stored pins re-pointed.`}</Text>
        ) : null}
        {job.error ? <Text style={ui.danger}>{job.error}</Text> : null}
        {failures.map((result) => (
          <Text key={result.agentId} style={ui.danger}>{`${result.title}: ${result.detail ?? "failed"}`}</Text>
        ))}
        {notes.map((result) => (
          <Text key={result.agentId} style={ui.secondary}>{`${result.title}: ${result.detail}`}</Text>
        ))}
      </View>
    </Group>
  );
}

export function ForceConfirmCard({
  theme,
  dense,
  provider,
  providerLabel,
  accent,
  target,
  onCancel,
  onStarted,
}: {
  theme: Theme;
  dense?: boolean;
  provider: AccountProvider;
  providerLabel: string;
  accent: string;
  target: { accountId: string; email: string };
  onCancel(): void;
  onStarted(): void;
}) {
  const ui = useUi(theme, dense);
  const queryClient = useQueryClient();
  const forcePlan = useRpc(forcePlanRpc);
  const forceStart = useRpc(forceStartRpc);
  const plan = useQuery({
    queryKey: ["ai-accounts", "force-plan", provider, target.accountId],
    queryFn: () => forcePlan({ provider, accountId: target.accountId }),
    staleTime: 0,
    gcTime: 0,
  });
  const starter = useMutation({
    mutationFn: forceStart,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FORCE_STATUS_KEY });
      onStarted();
    },
  });
  const data = plan.data;
  const running = data?.agents.filter((agent) => agent.running).length ?? 0;
  const canStart = Boolean(data) && !data?.blocker && !data?.busy && !starter.isPending;
  const error = plan.error ?? starter.error;
  return (
    <Group theme={theme} dense={dense}>
      <View key="question" style={[ui.row, { flexDirection: "column", alignItems: "stretch", gap: 4 }]}>
        <Text style={[ui.primary, { fontWeight: "600" }]}>{`Use ${target.email} for every ${providerLabel} conversation?`}</Text>
        {plan.isLoading ? <ActivityIndicator color={accent} size="small" /> : null}
        {data ? (
          <Text style={ui.secondary}>
            {`${running} running will be paused, switched and resumed. ${data.agents.length - running} idle will be switched. ${data.assignments} stored pins move. New conversations follow this account until you release it.`}
          </Text>
        ) : null}
        {data?.blocker ? <Text style={ui.danger}>{data.blocker}</Text> : null}
        {data?.busy ? <Text style={ui.danger}>Another switch is already running.</Text> : null}
        {error ? <Text style={ui.danger}>{error instanceof Error ? error.message : String(error)}</Text> : null}
      </View>
      {data?.agents.slice(0, 6).map((agent) => (
        <View key={agent.agentId} style={ui.row}>
          <Dot color={agent.running ? accent : theme.colors.foregroundMuted} hollow={!agent.running} />
          <Text numberOfLines={1} style={[ui.primary, { flex: 1 }]}>
            {agent.title}
          </Text>
          <Text numberOfLines={1} style={ui.secondary}>
            {agent.fromEmail ? agent.fromEmail.split("@", 1)[0] : ""}
          </Text>
        </View>
      ))}
      {data && data.agents.length > 6 ? (
        <View key="more" style={ui.row}>
          <Text style={ui.secondary}>{`${data.agents.length - 6} more`}</Text>
        </View>
      ) : null}
      <View key="actions" style={[ui.row, { justifyContent: "flex-end", gap: 14 }]}>
        <Button theme={theme} kind="plain" color={theme.colors.foregroundMuted} title="Cancel" onPress={onCancel} />
        <Button
          theme={theme}
          kind="primary"
          title={running > 0 ? "Pause, switch & resume" : "Switch everything"}
          disabled={!canStart}
          loading={starter.isPending}
          onPress={() => starter.mutate({ provider, accountId: target.accountId })}
        />
      </View>
    </Group>
  );
}
