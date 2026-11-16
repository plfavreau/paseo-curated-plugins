import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { Icon, copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native";
import type { PrCardData, PrCheck, PrStatus } from "../shared/pr";
import { checkKind, prKey, prStatusRpc, rerunFailedRpc } from "../shared/pr";

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
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
  const [showOutput, setShowOutput] = useState(false);
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

  const styles = useMemo(() => {
    const small = layout.compact ? 11 : 12;
    return {
      card: {
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        backgroundColor: theme.colors.surface1,
        overflow: "hidden" as const,
        marginVertical: 2,
      },
      head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, padding: 10 },
      headText: { flex: 1, gap: 2 },
      titleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      number: { color: theme.colors.foregroundMuted, fontSize: 13, fontWeight: "500" as const },
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, flexShrink: 1 },
      meta: { color: theme.colors.foregroundMuted, fontSize: small },
      pill: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 999,
      },
      pillText: { fontSize: 11, fontWeight: "600" as const },
      badges: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, paddingHorizontal: 10, paddingBottom: 8 },
      badge: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
      },
      badgeText: { color: theme.colors.foreground, fontSize: 11 },
      counts: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      count: { flexDirection: "row" as const, alignItems: "center" as const, gap: 3 },
      countText: { fontSize: 12, fontWeight: "600" as const },
      checks: { borderTopWidth: 1, borderTopColor: theme.colors.border },
      checkRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
      },
      checkName: { color: theme.colors.foreground, fontSize: 12, flex: 1 },
      checkWorkflow: { color: theme.colors.foregroundMuted },
      checkTime: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: MONO },
      required: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 4,
        paddingHorizontal: 4,
      },
      toggleRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingHorizontal: 10, paddingVertical: 6 },
      footer: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        alignItems: "center" as const,
        gap: 8,
        padding: 10,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      button: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
      },
      buttonLabel: { color: theme.colors.foreground, fontSize: 12, fontWeight: "500" as const },
      updated: { color: theme.colors.foregroundMuted, fontSize: 11, marginLeft: "auto" as const },
      commandRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingVertical: 4 },
      command: { color: theme.colors.foregroundMuted, fontFamily: MONO, fontSize: 12, flexShrink: 1 },
      output: {
        maxHeight: 220,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        padding: 8,
        marginBottom: 6,
      },
      outputText: { color: theme.colors.foreground, fontFamily: MONO, fontSize: 11 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      statusRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, padding: 10 },
    };
  }, [theme, layout.compact]);

  const commandHeader = (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={showOutput ? "Hide command output" : "Show command output"}
        style={styles.commandRow}
        onPress={() => setShowOutput((value) => !value)}
      >
        <Icon name="SquareTerminal" size={13} color={theme.colors.foregroundMuted} />
        <Text style={styles.command} numberOfLines={showOutput ? undefined : 1}>
          {command}
        </Text>
        {status === "running" ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
        {exitCode !== null && exitCode !== 0 ? <Text style={styles.error}>exit {exitCode}</Text> : null}
        <Icon name={showOutput ? "ChevronUp" : "ChevronDown"} size={13} color={theme.colors.foregroundMuted} />
      </Pressable>
      {showOutput ? (
        <ScrollView style={styles.output} nestedScrollEnabled>
          <Text style={styles.outputText} selectable>
            {output.length > 0 ? output : "(no output)"}
          </Text>
        </ScrollView>
      ) : null}
    </>
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
        {commandHeader}
        {message ? <Text style={[styles.meta, { paddingBottom: 4 }]}>{message}</Text> : null}
      </View>
    );
  }

  if (!pr) {
    return (
      <View>
        {commandHeader}
        <View style={[styles.card, styles.statusRow]}>
          <ActivityIndicator size="small" color={theme.colors.accent} />
          <Text style={styles.meta}>Loading pull request…</Text>
        </View>
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

  const countBadges = (
    <View style={styles.counts}>
      {counts.failing > 0 ? (
        <View style={styles.count}>
          <Icon name="CircleX" size={13} color={theme.colors.statusDanger} />
          <Text style={[styles.countText, { color: theme.colors.statusDanger }]}>{counts.failing}</Text>
        </View>
      ) : null}
      {counts.running > 0 ? (
        <View style={styles.count}>
          <Icon name="LoaderCircle" size={13} color={theme.colors.statusWarning} />
          <Text style={[styles.countText, { color: theme.colors.statusWarning }]}>{counts.running}</Text>
        </View>
      ) : null}
      {counts.passed > 0 ? (
        <View style={styles.count}>
          <Icon name="CircleCheck" size={13} color={theme.colors.statusSuccess} />
          <Text style={[styles.countText, { color: theme.colors.statusSuccess }]}>{counts.passed}</Text>
        </View>
      ) : null}
    </View>
  );

  const renderCheck = (check: PrCheck) => {
    const checkStyle = checkLook(check.state, theme);
    const time = checkTime(check, now);
    const label =
      check.workflow && !check.name.toLowerCase().includes(check.workflow.toLowerCase()) ? `${check.workflow} / ` : "";
    return (
      <Pressable
        key={`${check.workflow ?? ""}-${check.name}`}
        accessibilityRole="link"
        accessibilityLabel={`${check.name}: ${check.state}`}
        style={styles.checkRow}
        disabled={!check.url}
        onPress={() => check.url && void openExternalUrl(check.url)}
      >
        <Icon name={checkStyle.icon} size={14} color={checkStyle.color} />
        <Text style={styles.checkName} numberOfLines={1}>
          <Text style={styles.checkWorkflow}>{label}</Text>
          {check.name}
        </Text>
        {check.required ? <Text style={styles.required}>Required</Text> : null}
        {time ? <Text style={styles.checkTime}>{time}</Text> : null}
      </Pressable>
    );
  };

  return (
    <View>
      {commandHeader}
      <View style={styles.card}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Collapse pull request" : "Expand pull request"}
          style={styles.head}
          onPress={() => setExpanded((value) => !value)}
        >
          <View style={[styles.pill, { backgroundColor: `${look.color}22` }]}>
            <Icon name={look.icon} size={12} color={look.color} />
            <Text style={[styles.pillText, { color: look.color }]}>{look.label}</Text>
          </View>
          <View style={styles.headText}>
            <View style={styles.titleRow}>
              <Text style={styles.number}>#{pr.number}</Text>
              <Text style={styles.title} numberOfLines={expanded ? 2 : 1}>
                {pr.title}
              </Text>
            </View>
            {expanded ? (
              <Text style={styles.meta} numberOfLines={1}>
                {pr.owner}/{pr.repo} · {pr.headRef} → {pr.baseRef}
                {pr.author ? ` · ${pr.author}` : ""}
              </Text>
            ) : null}
          </View>
          {countBadges}
          {query.isFetching ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
          <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={theme.colors.foregroundMuted} />
        </Pressable>

        {expanded ? (
          <>
            <View style={styles.badges}>
              <View style={styles.badge}>
                <Text style={[styles.badgeText, { color: theme.colors.statusSuccess }]}>+{pr.additions}</Text>
                <Text style={[styles.badgeText, { color: theme.colors.statusDanger }]}>−{pr.deletions}</Text>
                <Text style={styles.badgeText}>· {pr.changedFiles} files</Text>
              </View>
              {pr.reviewDecision ? (
                <View style={styles.badge}>
                  <Icon
                    name={pr.reviewDecision === "APPROVED" ? "UserCheck" : pr.reviewDecision === "CHANGES_REQUESTED" ? "UserX" : "User"}
                    size={12}
                    color={theme.colors.foregroundMuted}
                  />
                  <Text style={styles.badgeText}>{REVIEW_LABEL[pr.reviewDecision] ?? pr.reviewDecision}</Text>
                </View>
              ) : null}
              {pr.unresolvedThreads > 0 ? (
                <View style={styles.badge}>
                  <Icon name="MessageSquare" size={12} color={theme.colors.statusWarning} />
                  <Text style={styles.badgeText}>
                    {pr.unresolvedThreads} unresolved
                  </Text>
                </View>
              ) : null}
              {pr.state === "OPEN" && pr.mergeStateStatus && MERGE_LABEL[pr.mergeStateStatus] ? (
                <View style={styles.badge}>
                  <Icon
                    name={pr.mergeStateStatus === "CLEAN" ? "CircleCheck" : pr.mergeStateStatus === "DIRTY" ? "TriangleAlert" : "Lock"}
                    size={12}
                    color={pr.mergeStateStatus === "CLEAN" ? theme.colors.statusSuccess : theme.colors.foregroundMuted}
                  />
                  <Text style={styles.badgeText}>{MERGE_LABEL[pr.mergeStateStatus]}</Text>
                </View>
              ) : null}
            </View>

            {checks.length > 0 ? (
              <View style={styles.checks}>
                {activeChecks.map(renderCheck)}
                {passedChecks.length > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    style={styles.toggleRow}
                    onPress={() => setShowPassed((value) => !value)}
                  >
                    <Icon name={showPassed ? "ChevronDown" : "ChevronRight"} size={13} color={theme.colors.foregroundMuted} />
                    <Text style={styles.meta}>
                      {counts.passed} passed{counts.skipped > 0 ? `, ${counts.skipped} skipped` : ""}
                    </Text>
                  </Pressable>
                ) : null}
                {showPassed ? passedChecks.map(renderCheck) : null}
              </View>
            ) : (
              <View style={[styles.checks, styles.statusRow]}>
                <Text style={styles.meta}>No checks reported on {pr.headSha?.slice(0, 7) ?? "the head commit"}.</Text>
              </View>
            )}

            <View style={styles.footer}>
              <Pressable accessibilityRole="link" style={styles.button} onPress={() => void openExternalUrl(pr.url)}>
                <Icon name="ExternalLink" size={13} color={theme.colors.foreground} />
                <Text style={styles.buttonLabel}>Open</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={styles.button}
                onPress={() =>
                  copyText(pr.url).then(
                    () => toast.show("PR link copied", { variant: "success" }),
                    () => toast.error("Copy failed"),
                  )
                }
              >
                <Icon name="Copy" size={13} color={theme.colors.foreground} />
                <Text style={styles.buttonLabel}>Copy link</Text>
              </Pressable>
              {failedRunIds.length > 0 && pr.state === "OPEN" ? (
                <Pressable
                  accessibilityRole="button"
                  style={styles.button}
                  disabled={rerunMutation.isPending}
                  onPress={() => rerunMutation.mutate()}
                >
                  {rerunMutation.isPending ? (
                    <ActivityIndicator size="small" color={theme.colors.foreground} />
                  ) : (
                    <Icon name="RotateCcw" size={13} color={theme.colors.foreground} />
                  )}
                  <Text style={styles.buttonLabel}>Re-run failed</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh"
                style={styles.button}
                onPress={() => void query.refetch()}
              >
                <Icon name="RefreshCw" size={13} color={theme.colors.foreground} />
              </Pressable>
              <Text style={styles.updated}>
                {pollInterval(pr) ? `Live · updated ${fetchedAgo} ago` : `Updated ${fetchedAgo} ago`}
              </Text>
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
}
