import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tier } from "../shared/contracts";
import { ensureFreshAccount, forceRefreshAccount, type StoredAccount } from "./account-store";
import { availableProviderModels, pickDefaultModel } from "./accounts";
import { OPENCODE_DB, sqlitePath } from "./environment";
import { message } from "./force-account";

const execFileAsync = promisify(execFile);
const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const REQUEST_TIMEOUT_MS = 45_000;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const SIGNAL_CONCURRENCY = 4;
const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);

export interface Classification {
  tier: Tier;
  reason: string;
}

export interface ClassifyInput {
  agentId: string;
  sessionId: string | null;
  title: string;
  mode: string | null;
  workspace: string | null;
  running: boolean;
}

export interface ClassifyOutcome {
  results: Map<string, Classification>;
  called: number;
  reused: number;
  ms: number;
  error: string | null;
}

interface CacheEntry extends Classification {
  key: string;
  at: number;
}

const cache = new Map<string, CacheEntry>();

/** Whatever the last Balance concluded, so the overview can show it without spending a call. */
export function cachedClassification(agentId: string): Classification | undefined {
  const entry = cache.get(agentId);
  if (!entry || Date.now() - entry.at > CACHE_TTL_MS) return undefined;
  return { tier: entry.tier, reason: entry.reason };
}

interface Signals {
  tools: string;
  edits: number;
  first: string;
  latest: string;
}

const clean = (text: string | null | undefined, max: number) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

async function sqlite(sql: string): Promise<Record<string, unknown>[]> {
  const { stdout } = await execFileAsync(sqlitePath(), ["-readonly", "-json", OPENCODE_DB, sql], { timeout: 15_000, maxBuffer: 2_000_000 });
  return stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>[]) : [];
}

/** What a conversation has actually been doing: which tools it used, and what it was asked first and last. */
async function gatherSignals(sessionId: string | null): Promise<Signals> {
  const empty: Signals = { tools: "", edits: 0, first: "", latest: "" };
  if (!sessionId || !/^ses_[A-Za-z0-9]+$/.test(sessionId)) return empty;
  const userText = (order: "asc" | "desc", max: number) =>
    `SELECT substr(json_extract(p.data,'$.text'),1,${max}) AS t FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = '${sessionId}' AND json_extract(p.data,'$.type') = 'text' AND json_extract(m.data,'$.role') = 'user' AND json_extract(p.data,'$.text') NOT LIKE '▣%' ORDER BY p.time_created ${order} LIMIT 1;`;
  try {
    const [tools, first, latest] = await Promise.all([
      sqlite(`SELECT json_extract(data,'$.tool') AS tool, count(*) AS n FROM part WHERE session_id = '${sessionId}' AND json_extract(data,'$.type') = 'tool' GROUP BY 1 ORDER BY 2 DESC LIMIT 12;`),
      sqlite(userText("asc", 500)),
      sqlite(userText("desc", 400)),
    ]);
    const counted = tools.map((row) => ({ tool: String(row.tool ?? "?"), n: Number(row.n ?? 0) }));
    return {
      tools: counted.map((row) => `${row.tool} ${row.n}`).join(", "),
      edits: counted.filter((row) => EDIT_TOOLS.has(row.tool)).reduce((sum, row) => sum + row.n, 0),
      first: clean(first[0]?.t as string | undefined, 400),
      latest: clean(latest[0]?.t as string | undefined, 300),
    };
  } catch {
    return empty;
  }
}

const INSTRUCTIONS = `You triage AI coding conversations for a developer who has two kinds of model subscription.
- "careful": work where reasoning quality and correctness matter. Designing or implementing features, root-causing bugs, refactors, writing or fixing tests, reviewing or validating changes, infra or deployment changes, research that must be right, coordinating other agents on such work. Many file edits, or multi-step engineering, is strong evidence of careful.
- "housekeeping": admin and boring chores where a fast cheaper model is fine. Disk or environment cleanup, listing or summarizing status, one-line explanations, rebasing or merging branches with no design work, bumping dependencies, babysitting or watching CI, running something locally to look at it, updating boards or tickets, archiving, simple lookups. Read-only or shell-only activity with no code edits leans housekeeping.
Judge by what the conversation is doing now (latest request and tool usage), not only by its title; the title is the first message and may be stale. If it is genuinely unclear, answer "careful": a wrongly demoted conversation costs more than a wrongly kept one.
Reply with a single JSON object and nothing else: {"<id>": {"tier": "careful" | "housekeeping", "why": "<=10 words"}, ...} covering every id you were given.`;

export interface ClassifierModel {
  slug: string;
  label: string;
}

/** Fast and cheap on purpose: the smallest recent Codex model, since this runs every time Balance is pressed. */
export async function classifierModel(): Promise<ClassifierModel | undefined> {
  const models = await availableProviderModels("openai");
  const id = pickDefaultModel("openai", models, "small");
  const model = models.find((candidate) => candidate.id === id);
  return model ? { slug: model.id.replace(/^openai\//, ""), label: model.label } : undefined;
}

async function callModel(account: StoredAccount, model: string, text: string): Promise<string> {
  const body = {
    model,
    instructions: INSTRUCTIONS,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
    store: false,
    stream: true,
    reasoning: { effort: "low" },
    text: { verbosity: "low" },
  };
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${account.access}`,
      ...(account.externalAccountId ? { "chatgpt-account-id": account.externalAccountId } : {}),
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401) throw Object.assign(new Error("Codex rejected the token (401)"), { status: 401 });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Codex returned ${response.status}: ${clean(raw, 160)}`);
  let output = "";
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const event = JSON.parse(line.slice(6)) as { type?: string; delta?: string; response?: { error?: { message?: string } } };
      if (event.type === "response.output_text.delta" && event.delta) output += event.delta;
      if (event.type === "response.failed") throw new Error(event.response?.error?.message ?? "Codex reported a failure");
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return output;
}

function parseVerdicts(output: string): Record<string, { tier?: string; why?: string }> {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return JSON");
  return JSON.parse(output.slice(start, end + 1)) as Record<string, { tier?: string; why?: string }>;
}

async function runPool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) results[index] = await work(items[index]);
    }),
  );
  return results;
}

/**
 * Asks the user's Codex subscription which conversations are housekeeping.
 * One batched call for everything not already judged; a failure leaves callers on their keyword fallback.
 */
export async function classifyWithLlm(inputs: ClassifyInput[], model: ClassifierModel): Promise<ClassifyOutcome> {
  const started = Date.now();
  const results = new Map<string, Classification>();
  const outcome = (called: number, error: string | null): ClassifyOutcome => ({ results, called, reused: inputs.length - called, ms: Date.now() - started, error });
  if (inputs.length === 0) return outcome(0, null);

  const signals = await runPool(inputs, SIGNAL_CONCURRENCY, (input) => gatherSignals(input.sessionId));
  const pending: { id: string; input: ClassifyInput; signal: Signals; key: string }[] = [];
  inputs.forEach((input, index) => {
    const signal = signals[index];
    const key = `${input.title}|${signal.latest.slice(0, 100)}|${Math.min(3, Math.floor(signal.edits / 20))}`;
    const hit = cache.get(input.agentId);
    if (hit && hit.key === key && Date.now() - hit.at < CACHE_TTL_MS) {
      results.set(input.agentId, { tier: hit.tier, reason: hit.reason });
      return;
    }
    pending.push({ id: `s${pending.length + 1}`, input, signal, key });
  });
  if (pending.length === 0) return outcome(0, null);

  const prompt = pending
    .map(({ id, input, signal }) =>
      JSON.stringify({
        id,
        title: clean(input.title, 120),
        mode: input.mode,
        project: input.workspace,
        running: input.running,
        tools: signal.tools || "none recorded",
        fileEdits: signal.edits,
        firstRequest: signal.first,
        latestRequest: signal.latest === signal.first ? undefined : signal.latest,
      }),
    )
    .join("\n");

  try {
    let account = await ensureFreshAccount("openai");
    if (!account) throw new Error("No Codex account is signed in");
    let output: string;
    try {
      output = await callModel(account, model.slug, prompt);
    } catch (error) {
      if ((error as { status?: number }).status !== 401) throw error;
      account = await forceRefreshAccount("openai");
      if (!account) throw error;
      output = await callModel(account, model.slug, prompt);
    }
    const verdicts = parseVerdicts(output);
    for (const { id, input, key } of pending) {
      const verdict = verdicts[id];
      if (verdict?.tier !== "careful" && verdict?.tier !== "housekeeping") continue;
      const classification: Classification = { tier: verdict.tier, reason: clean(verdict.why, 80) || "no reason given" };
      results.set(input.agentId, classification);
      cache.set(input.agentId, { ...classification, key, at: Date.now() });
    }
    return outcome(pending.length, null);
  } catch (error) {
    return outcome(0, message(error));
  }
}
