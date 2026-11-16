import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// NOTE: the app validates contribution ids/kinds with /^[a-z][a-z0-9-]*$/.
export const PR_CARD_KIND = "pr-card-gh";
export const PR_CARD_VERSION = 1;

const SUBCOMMANDS = [
  "create",
  "view",
  "checks",
  "merge",
  "ready",
  "edit",
  "comment",
  "review",
  "reopen",
  "close",
] as const;
export type PrSubcommand = (typeof SUBCOMMANDS)[number];

/** `gh pr` flags that consume the next token, so it is not taken for the PR selector. */
const VALUE_FLAGS = new Set([
  "-R", "--repo", "-t", "--title", "-b", "--body", "-B", "--base", "-H", "--head", "-F", "--body-file",
  "-l", "--label", "-a", "--assignee", "-r", "--reviewer", "-m", "--milestone", "-p", "--project",
  "--json", "-q", "--jq", "-T", "--template", "--add-label", "--remove-label", "--add-reviewer",
  "--remove-reviewer", "--add-assignee", "--remove-assignee", "--add-project", "--remove-project",
  "--match-head-commit", "-S", "--subject", "-A", "--author-email", "-i", "--interval", "-e", "--editor",
]);

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

export type PrRef = {
  owner?: string;
  repo?: string;
  number?: number;
  /** A branch name or number, resolved by `gh pr view` in `cwd` when owner/repo/number are not all known. */
  selector?: string;
  cwd?: string;
};

export interface PrMention {
  subcommand: PrSubcommand;
  ref: PrRef;
}

/** Splits one line into shell-ish tokens, honouring simple quotes. Good enough for gh invocations. */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  return tokens;
}

function joinPath(base: string | undefined, path: string): string | undefined {
  if (path.startsWith("/")) return path;
  if (path.startsWith("~")) return undefined;
  if (!base) return undefined;
  const parts = `${base}/${path}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * Finds the first `gh pr <subcommand>` in a shell command and what PR it targets.
 * The PR is read from, in order: a URL in the output (what `gh pr create` prints),
 * a URL or number given as the selector, then `-R owner/repo`. Anything left open
 * is resolved on the daemon with `gh pr view` in the command's working directory.
 */
export function findPrMention(command: string, cwd: string | undefined, output: string | undefined): PrMention | null {
  // Only the first line that runs gh matters; heredoc bodies on later lines often quote other PR URLs.
  const lines = command.split("\n");
  let effectiveCwd = cwd;
  for (const line of lines) {
    const ghIndex = line.search(/(^|[\s;&|(])gh\s+pr\s+/);
    const cdMatch = /(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)/.exec(line);
    if (cdMatch && (ghIndex === -1 || cdMatch.index < ghIndex)) {
      effectiveCwd = joinPath(effectiveCwd, cdMatch[1]!.replace(/^["']|["']$/g, "")) ?? effectiveCwd;
    }
    if (ghIndex === -1) continue;

    const tokens = tokenize(line.slice(ghIndex));
    const prAt = tokens.indexOf("pr");
    const sub = tokens[prAt + 1] as PrSubcommand | undefined;
    if (!sub || !SUBCOMMANDS.includes(sub)) continue;

    const ref: PrRef = effectiveCwd ? { cwd: effectiveCwd } : {};
    for (let i = prAt + 2; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === "&&" || token === "||" || token === "|" || token === ";" || token.startsWith(">")) break;
      if (token.startsWith("-")) {
        const [flag, inline] = token.split("=", 2) as [string, string | undefined];
        const value = inline ?? (VALUE_FLAGS.has(flag) ? tokens[++i] : undefined);
        if ((flag === "-R" || flag === "--repo") && value) {
          const [owner, repo] = value.replace(/^github\.com\//, "").split("/");
          if (owner && repo) Object.assign(ref, { owner, repo });
        }
        continue;
      }
      if (ref.selector !== undefined || ref.number !== undefined) continue;
      const url = PR_URL.exec(token);
      if (url) {
        Object.assign(ref, { owner: url[1], repo: url[2], number: Number(url[3]) });
      } else if (/^#?\d+$/.test(token)) {
        ref.number = Number(token.replace("#", ""));
      } else if (/^[\w./-]+$/.test(token) && !token.includes("$")) {
        ref.selector = token;
      }
    }

    if (ref.number === undefined && ref.selector === undefined && output) {
      const url = PR_URL.exec(output);
      if (url) Object.assign(ref, { owner: url[1], repo: url[2], number: Number(url[3]) });
    }
    if (ref.number !== undefined && ref.selector === undefined && !ref.owner) ref.selector = String(ref.number);
    return { subcommand: sub, ref };
  }
  return null;
}

export const prRefSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  number: z.number().int().optional(),
  selector: z.string().optional(),
  cwd: z.string().optional(),
});

export const prCardSchema = z.object({
  subcommand: z.enum(SUBCOMMANDS),
  ref: prRefSchema,
  status: z.enum(["running", "completed", "failed", "canceled"]),
  command: z.string(),
  output: z.string(),
  exitCode: z.number().nullable(),
});
export type PrCardData = z.output<typeof prCardSchema>;

const checkSchema = z.object({
  name: z.string(),
  workflow: z.string().nullable(),
  /** queued | in_progress | success | failure | cancelled | skipped | neutral | timed_out | action_required | pending | error */
  state: z.string(),
  url: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  required: z.boolean(),
  runId: z.number().nullable(),
});
export type PrCheck = z.output<typeof checkSchema>;

export const prStatusSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  author: z.string().nullable(),
  headRef: z.string(),
  baseRef: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  mergeable: z.string().nullable(),
  mergeStateStatus: z.string().nullable(),
  reviewDecision: z.string().nullable(),
  unresolvedThreads: z.number(),
  headSha: z.string().nullable(),
  checks: z.array(checkSchema),
  fetchedAt: z.string(),
});
export type PrStatus = z.output<typeof prStatusSchema>;

export const prStatusRpc = defineRpc({
  name: "pr-card.status",
  input: prRefSchema,
  output: z.object({ pr: prStatusSchema.nullable(), error: z.string().nullable() }),
});

export const rerunFailedRpc = defineRpc({
  name: "pr-card.rerun-failed",
  input: z.object({ owner: z.string(), repo: z.string(), runIds: z.array(z.number().int()).max(20) }),
  output: z.object({ rerun: z.number(), error: z.string().nullable() }),
});

export function prKey(ref: PrRef): string {
  if (ref.owner && ref.repo && ref.number !== undefined) return `${ref.owner}/${ref.repo}#${ref.number}`;
  return `${ref.cwd ?? ""}|${ref.owner ?? ""}/${ref.repo ?? ""}|${ref.selector ?? ""}`;
}

const FAILING = new Set(["failure", "cancelled", "timed_out", "action_required", "error", "startup_failure"]);
const RUNNING = new Set(["in_progress", "queued", "pending", "waiting", "requested"]);

export function checkKind(state: string): "failing" | "running" | "passed" | "skipped" {
  if (FAILING.has(state)) return "failing";
  if (RUNNING.has(state)) return "running";
  if (state === "skipped" || state === "neutral" || state === "stale") return "skipped";
  return "passed";
}
