import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Action, Card, CommandLine, Divider, Dot, MONO, SegmentBar } from "./ui";
import type { PrCardData, PrCheck, PrStatus } from "../shared/pr";
import { checkKind, prKey, prStatusRpc, rerunFailedRpc } from "../shared/pr";

const KIND_ORDER = { failing: 0, running: 1, passed: 2, skipped: 3 } as const;

function pollInterval(pr: PrStatus | null | undefined): number | false {
  if (!pr || pr.state !== "OPEN") return false;
  return pr.checks.some((check) => checkKind(check.state) === "running") ? 10_000 : 60_000;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function checkTime(check: PrCheck, now: number): string | null {
  if (!check.startedAt) return null;
  const start = Date.parse(check.startedAt);
  const end = check.completedAt ? Date.parse(check.completedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return duration(end - start);
}

function stateLook(pr: PrStatus, theme: PluginTheme) {
  if (pr.state === "MERGED") return { label: "Merged", icon: "GitMerge", color: "#8957e5" };
  if (pr.state === "CLOSED") return { label: "Closed", icon: "GitPullRequestClosed", color: theme.colors.statusDanger };
  if (pr.isDraft) return { label: "Draft", icon: "GitPullRequestDraft", color: theme.colors.foregroundMuted };
  return { label: "Open", icon: "GitPullRequest", color: theme.colors.statusSuccess };
}

function checkLook(state: string, theme: PluginTheme) {
  switch (checkKind(state)) {
    case "failing":
      return { icon: state === "cancelled" ? "CircleSlash" : "CircleX", color: theme.colors.statusDanger };
    case "running":
      return { icon: state === "in_progress" ? "LoaderCircle" : "Clock", color: theme.colors.statusWarning };
    case "skipped":
      return { icon: "CircleMinus", color: theme.colors.foregroundMuted };
    default:
      return { icon: "CircleCheck", color: theme.colors.statusSuccess };
  }
}

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
};
const MERGE_LABEL: Record<string, string> = {
  CLEAN: "Ready to merge",
  BLOCKED: "Blocked",
  BEHIND: "Behind base",
  DIRTY: "Conflicts",
  UNSTABLE: "Checks failing",
  HAS_HOOKS: "Ready to merge",
  DRAFT: "Draft",
};

export function PrCardItem({ theme, layout, item }: PluginTimelineItemProps<PrCardData>) {
  const { subcommand, ref, status, command, output, exitCode } = item.data;
  const [expanded, setExpanded] = useState(subcommand === "create");
  const [showPassed, setShowPassed] = useState(false);
  const loadStatus = useRpc(prStatusRpc);
  const rerun = useRpc(rerunFailedRpc);
  const queryClient = useQueryClient();
  const toast = useToast();

  // `gh pr create` has no PR to show until it prints the URL.
  const waitingForCreate = subcommand === "create" && ref.number === undefined;
  const queryKey = ["pr-card", prKey(ref)];
  const query = useQuery({
    queryKey,
    queryFn: () => loadStatus(ref),
    enabled: !waitingForCreate,
    staleTime: 5_000,
    retry: 1,
    refetchInterval: (q) => pollInterval(q.state.data?.pr),
  });
  const pr = query.data?.pr ?? null;

  const checks = useMemo(
    () =>
      [...(pr?.checks ?? [])].sort(
        (a, b) => KIND_ORDER[checkKind(a.state)] - KIND_ORDER[checkKind(b.state)] || a.name.localeCompare(b.name),
      ),
    [pr],
  );
  const counts = useMemo(() => {
    const result = { failing: 0, running: 0, passed: 0, skipped: 0 };
    for (const check of checks) result[checkKind(check.state)]++;
    return result;
  }, [checks]);
  const now = useNow(expanded);

  const failedRunIds = useMemo(
    () => [
      ...new Set(
        checks
          .filter((check) => checkKind(check.state) === "failing" && check.runId !== null)
          .map((check) => check.runId as number),
      ),
    ],
    [checks],
  );
  const rerunMutation = useMutation({
    mutationFn: () => rerun({ owner: pr!.owner, repo: pr!.repo, runIds: failedRunIds }),
    onSuccess: (result) => {
      if (result.error) toast.error(result.error);
      else toast.show(`Re-running ${result.rerun} workflow${result.rerun === 1 ? "" : "s"}`, { variant: "success" });
      setTimeout(() => void queryClient.invalidateQueries({ queryKey }), 3000);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Re-run failed"),
  });

  const muted = theme.colors.foregroundMuted;
  const text = { color: theme.colors.foreground, fontSize: 13 };
  const meta = { color: muted, fontSize: layout.compact ? 11 : 12 };
  const pad = layout.compact ? 10 : 12;

  const commandLine = (
    <CommandLine theme={theme} command={command} output={output} running={status === "running"} exitCode={exitCode} />
  );

  if (waitingForCreate || (!pr && (query.isError || query.data?.error))) {
    // Nothing to show beyond the command: creating, or a failed lookup (the output says why).
    const message = waitingForCreate
      ? status === "running"
        ? "Creating pull request…"
        : null
      : (query.data?.error ?? (query.error instanceof Error ? query.error.message : null));
    return (
      <View>
        {commandLine}
        {message ? <Text style={[meta, { paddingBottom: 4 }]}>{message}</Text> : null}
      </View>
    );
  }

  if (!pr) {
    return (
      <View>
        {commandLine}
        <Card theme={theme}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: pad }}>
            <ActivityIndicator size="small" color={muted} />
            <Text style={meta}>Loading pull request…</Text>
          </View>
        </Card>
      </View>
    );
  }

  const look = stateLook(pr, theme);
  const passedChecks = checks.filter((check) => {
    const kind = checkKind(check.state);
    return kind === "passed" || kind === "skipped";
  });
  const activeChecks = checks.filter((check) => !passedChecks.includes(check));
  const fetchedAgo = duration(now - Date.parse(pr.fetchedAt));
  const live = pollInterval(pr) !== false;

  const summary = [
    counts.failing ? { label: `${counts.failing} failing`, color: theme.colors.statusDanger } : null,
    counts.running ? { label: `${counts.running} running`, color: theme.colors.statusWarning } : null,
    counts.passed ? { label: `${counts.passed} passed`, color: muted } : null,
  ].filter((part): part is { label: string; color: string } => part !== null);

  const facts: Array<{ label: string; color?: string }> = [{ label: look.label, color: look.color }];
  facts.push({ label: `${pr.repo} #${pr.number}` });
  if (pr.reviewDecision && REVIEW_LABEL[pr.reviewDecision]) {
    facts.push({
      label: REVIEW_LABEL[pr.reviewDecision]!,
      color: pr.reviewDecision === "APPROVED" ? theme.colors.statusSuccess : pr.reviewDecision === "CHANGES_REQUESTED" ? theme.colors.statusDanger : undefined,
    });
  }
  if (pr.unresolvedThreads > 0) facts.push({ label: `${pr.unresolvedThreads} unresolved`, color: theme.colors.statusWarning });
  if (pr.state === "OPEN" && pr.mergeStateStatus && MERGE_LABEL[pr.mergeStateStatus] && pr.mergeStateStatus !== "DRAFT") {
    const merge = pr.mergeStateStatus;
    facts.push({
      label: MERGE_LABEL[merge]!,
      color: merge === "CLEAN" || merge === "HAS_HOOKS" ? theme.colors.statusSuccess : merge === "DIRTY" ? theme.colors.statusDanger : undefined,
    });
  }

  const renderCheck = (check: PrCheck) => {
    const checkStyle = checkLook(check.state, theme);
    const time = checkTime(check, now);
    const prefix =
      check.workflow && !check.name.toLowerCase().includes(check.workflow.toLowerCase()) ? `${check.workflow} / ` : "";
    return (
      <Pressable
        key={`${check.workflow ?? ""}-${check.name}`}
        accessibilityRole="link"
        accessibilityLabel={`${check.name}: ${check.state}`}
        disabled={!check.url}
        onPress={() => check.url && void openExternalUrl(check.url)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: pad,
          paddingVertical: 6,
          backgroundColor: pressed ? theme.colors.surface1 : "transparent",
        })}
      >
        <Icon name={checkStyle.icon} size={14} color={checkStyle.color} />
        <Text style={{ color: theme.colors.foreground, fontSize: 12, flex: 1 }} numberOfLines={1}>
          <Text style={{ color: muted }}>{prefix}</Text>
          {check.name}
        </Text>
        {check.required ? <Text style={{ color: muted, fontSize: 11 }}>Required</Text> : null}
        {time ? <Text style={{ color: muted, fontSize: 11, fontFamily: MONO, minWidth: 44, textAlign: "right" }}>{time}</Text> : null}
      </Pressable>
    );
  };

  return (
    <View>
      {commandLine}
      <Card theme={theme}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Collapse pull request" : "Expand pull request"}
          onPress={() => setExpanded((value) => !value)}
          style={{ paddingHorizontal: pad, paddingTop: pad - 2, paddingBottom: checks.length ? 8 : pad - 2, gap: 4 }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name={look.icon} size={15} color={look.color} />
            <Text style={[text, { fontWeight: "600", flex: 1 }]} numberOfLines={expanded ? 3 : 1}>
              {pr.title}
            </Text>
            <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={muted} />
          </View>
          <Text style={[meta, { paddingLeft: 23 }]} numberOfLines={expanded ? 2 : 1}>
            {facts.map((fact, index) => (
              <Text key={index}>
                {index > 0 ? "  ·  " : ""}
                <Text style={fact.color ? { color: fact.color } : null}>{fact.label}</Text>
              </Text>
            ))}
          </Text>
          {expanded ? (
            <Text style={[meta, { paddingLeft: 23, fontFamily: MONO, fontSize: 11 }]} numberOfLines={1}>
              {pr.headRef} → {pr.baseRef}
              <Text style={{ fontFamily: undefined }}>
                {"  ·  "}
                <Text style={{ color: theme.colors.statusSuccess }}>+{pr.additions}</Text>{" "}
                <Text style={{ color: theme.colors.statusDanger }}>−{pr.deletions}</Text>
                {pr.author ? `  ·  ${pr.author}` : ""}
              </Text>
            </Text>
          ) : null}
          {checks.length ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 23, paddingTop: 4 }}>
              <View style={{ flex: 1 }}>
                <SegmentBar
                  theme={theme}
                  segments={[
                    { value: counts.failing, color: theme.colors.statusDanger },
                    { value: counts.running, color: theme.colors.statusWarning },
                    { value: counts.passed, color: theme.colors.statusSuccess },
                    { value: counts.skipped, color: theme.colors.border },
                  ]}
                />
              </View>
              <Text style={{ fontSize: 11, color: muted }}>
                {summary.map((part, index) => (
                  <Text key={part.label}>
                    {index > 0 ? ", " : ""}
                    <Text style={{ color: part.color }}>{part.label}</Text>
                  </Text>
                ))}
              </Text>
            </View>
          ) : null}
        </Pressable>

        {expanded ? (
          <>
            <Divider theme={theme} />
            {checks.length > 0 ? (
              <View style={{ paddingVertical: 4 }}>
                {activeChecks.map(renderCheck)}
                {passedChecks.length > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setShowPassed((value) => !value)}
                    style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: pad, paddingVertical: 6 }}
                  >
                    <Icon name={showPassed ? "ChevronDown" : "ChevronRight"} size={14} color={muted} />
                    <Text style={{ color: muted, fontSize: 12 }}>
                      {showPassed ? "Hide" : "Show"} {counts.passed} passed
                      {counts.skipped > 0 ? `, ${counts.skipped} skipped` : ""}
                    </Text>
                  </Pressable>
                ) : null}
                {showPassed ? passedChecks.map(renderCheck) : null}
              </View>
            ) : (
              <Text style={[meta, { padding: pad }]}>No checks on {pr.headSha?.slice(0, 7) ?? "the head commit"}.</Text>
            )}
            <Divider theme={theme} />
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2, paddingHorizontal: pad - 6, paddingVertical: 4 }}>
              <Action theme={theme} icon="ExternalLink" label="Open" onPress={() => void openExternalUrl(pr.url)} />
              <Action
                theme={theme}
                icon="Link"
                label="Copy link"
                onPress={() =>
                  copyText(pr.url).then(
                    () => toast.show("Link copied", { variant: "success" }),
                    () => toast.error("Copy failed"),
                  )
                }
              />
              {failedRunIds.length > 0 && pr.state === "OPEN" ? (
                <Action
                  theme={theme}
                  icon="RotateCcw"
                  label="Re-run failed"
                  busy={rerunMutation.isPending}
                  onPress={() => rerunMutation.mutate()}
                />
              ) : null}
              <View style={{ flex: 1 }} />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                {live ? <Dot color={theme.colors.statusSuccess} /> : null}
                <Text style={{ color: muted, fontSize: 11 }}>
                  {live ? "Live" : "Updated"} · {fetchedAgo} ago
                </Text>
              </View>
              <Action theme={theme} icon="RefreshCw" accessibilityLabel="Refresh" onPress={() => void query.refetch()} />
            </View>
          </>
        ) : null}
      </Card>
    </View>
  );
}
