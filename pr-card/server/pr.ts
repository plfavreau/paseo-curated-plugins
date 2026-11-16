import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PrCheck, PrStatus, prStatusRpc, rerunFailedRpc } from "../shared/pr";
import { prKey } from "../shared/pr";

type StatusInput = RpcInput<typeof prStatusRpc>;
type StatusOutput = RpcOutput<typeof prStatusRpc>;
type RerunInput = RpcInput<typeof rerunFailedRpc>;
type RerunOutput = RpcOutput<typeof rerunFailedRpc>;

const TIMEOUT_MS = 20_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function gh(args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`gh ${args[0]} timed out`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function lastLine(text: string): string {
  return text.trim().split("\n").pop() ?? "unknown error";
}

async function usableCwd(cwd: string | undefined): Promise<string | undefined> {
  if (!cwd) return undefined;
  try {
    return (await stat(cwd)).isDirectory() ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/** Branch selectors and bare numbers are resolved once; a PR never changes repository or number. */
const resolved = new Map<string, { owner: string; repo: string; number: number }>();

async function resolveRef(input: StatusInput): Promise<{ owner: string; repo: string; number: number } | string> {
  if (input.owner && input.repo && input.number !== undefined) {
    return { owner: input.owner, repo: input.repo, number: input.number };
  }
  const key = prKey(input);
  const cached = resolved.get(key);
  if (cached) return cached;

  const cwd = await usableCwd(input.cwd);
  if (!cwd && !(input.owner && input.repo)) return "No repository to look the pull request up in.";
  const args = ["pr", "view"];
  if (input.selector) args.push(input.selector);
  if (input.owner && input.repo) args.push("-R", `${input.owner}/${input.repo}`);
  args.push("--json", "url");
  const result = await gh(args, cwd);
  if (result.code !== 0) return lastLine(result.stderr);
  const match = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(result.stdout);
  if (!match) return "gh did not return a pull request URL.";
  const ref = { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
  resolved.set(key, ref);
  return ref;
}

const QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      number title url state isDraft headRefName baseRefName additions deletions changedFiles
      mergeable mergeStateStatus reviewDecision author{login}
      reviewThreads(first:100){nodes{isResolved}}
      commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){nodes{
        __typename
        ... on CheckRun{name status conclusion detailsUrl startedAt completedAt isRequired(pullRequestNumber:$number) checkSuite{workflowRun{databaseId workflow{name}}}}
        ... on StatusContext{context state targetUrl createdAt isRequired(pullRequestNumber:$number)}
      }}}}}}
    }
  }
}`;

interface CheckRunNode {
  __typename: "CheckRun";
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  isRequired: boolean;
  checkSuite: { workflowRun: { databaseId: number; workflow: { name: string } } | null } | null;
}
interface StatusContextNode {
  __typename: "StatusContext";
  context: string;
  state: string;
  targetUrl: string | null;
  createdAt: string | null;
  isRequired: boolean;
}

function toCheck(node: CheckRunNode | StatusContextNode): PrCheck {
  if (node.__typename === "StatusContext") {
    return {
      name: node.context,
      workflow: null,
      state: node.state.toLowerCase(),
      url: node.targetUrl,
      startedAt: node.createdAt,
      completedAt: null,
      required: node.isRequired,
      runId: null,
    };
  }
  const run = node.checkSuite?.workflowRun ?? null;
  return {
    name: node.name,
    workflow: run?.workflow.name ?? null,
    state: (node.status === "COMPLETED" ? (node.conclusion ?? "neutral") : node.status).toLowerCase(),
    url: node.detailsUrl,
    startedAt: node.startedAt,
    completedAt: node.completedAt,
    required: node.isRequired,
    runId: run?.databaseId ?? null,
  };
}

/** A re-run leaves the old attempt in the rollup; keep the latest one per workflow and job name. */
function latestPerCheck(checks: PrCheck[]): PrCheck[] {
  const byKey = new Map<string, PrCheck>();
  for (const check of checks) {
    const key = `${check.workflow ?? ""}\u0000${check.name}`;
    const previous = byKey.get(key);
    if (!previous || (check.startedAt ?? "") >= (previous.startedAt ?? "")) byKey.set(key, check);
  }
  return [...byKey.values()];
}

export async function loadStatus(input: StatusInput): Promise<StatusOutput> {
  let ref: Awaited<ReturnType<typeof resolveRef>>;
  try {
    ref = await resolveRef(input);
  } catch (err) {
    return { pr: null, error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof ref === "string") return { pr: null, error: ref };

  let result: RunResult;
  try {
    result = await gh([
      "api", "graphql",
      "-F", `owner=${ref.owner}`,
      "-F", `repo=${ref.repo}`,
      "-F", `number=${ref.number}`,
      "-f", `query=${QUERY}`,
    ]);
  } catch (err) {
    return { pr: null, error: err instanceof Error ? err.message : String(err) };
  }
  if (result.code !== 0) return { pr: null, error: lastLine(result.stderr || result.stdout) };

  const pr = JSON.parse(result.stdout)?.data?.repository?.pullRequest;
  if (!pr) return { pr: null, error: `Pull request ${ref.owner}/${ref.repo}#${ref.number} not found.` };

  const commit = pr.commits?.nodes?.[0]?.commit;
  const nodes: Array<CheckRunNode | StatusContextNode> = commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const status: PrStatus = {
    owner: ref.owner,
    repo: ref.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    author: pr.author?.login ?? null,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    mergeable: pr.mergeable ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    reviewDecision: pr.reviewDecision ?? null,
    unresolvedThreads: (pr.reviewThreads?.nodes ?? []).filter((t: { isResolved: boolean }) => !t.isResolved).length,
    headSha: commit?.oid ?? null,
    checks: latestPerCheck(nodes.map(toCheck)),
    fetchedAt: new Date().toISOString(),
  };
  return { pr: status, error: null };
}

export async function rerunFailed({ owner, repo, runIds }: RerunInput): Promise<RerunOutput> {
  let rerun = 0;
  const errors: string[] = [];
  for (const runId of new Set(runIds)) {
    try {
      const result = await gh(["run", "rerun", String(runId), "--failed", "-R", `${owner}/${repo}`]);
      if (result.code === 0) rerun++;
      else errors.push(lastLine(result.stderr));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { rerun, error: errors.length > 0 ? errors.join("; ") : null };
}
