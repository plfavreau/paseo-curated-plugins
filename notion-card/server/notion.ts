import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { NotionChecklist, NotionProperty, notionPageRpc } from "../shared/notion";
import { normalizeId } from "../shared/notion";

type Input = RpcInput<typeof notionPageRpc>;
type Output = RpcOutput<typeof notionPageRpc>;

const TIMEOUT_MS = 20_000;
const MAX_BLOCK_PAGES = 3;
const MAX_PROPERTIES = 10;
const MAX_RELATION_LOOKUPS = 6;
const MAX_ITEMS_PER_CHECKLIST = 40;

/** Types that say nothing at a glance: computed values, buttons and audit fields. */
const HIDDEN_TYPES = new Set([
  "title",
  "status",
  "rollup",
  "formula",
  "button",
  "created_by",
  "created_time",
  "last_edited_by",
  "last_edited_time",
  "verification",
]);
/** Audit fields stored as ordinary properties on some boards ("Created by", "In this column since"). */
const HIDDEN_NAMES = /^(created|last edited|in this column since)\b/i;
const TYPE_ORDER = ["people", "select", "number", "relation", "multi_select", "date", "unique_id", "url", "checkbox"];

type Json = Record<string, any>;

let ntnBinary = "ntn";

function runNtn(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ntnBinary, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ntn timed out"));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk.toString("utf8");
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

async function api(path: string, ...params: string[]): Promise<Json> {
  let result;
  try {
    result = await runNtn(["api", path, ...params]);
  } catch (err) {
    // The daemon may not inherit the login shell PATH; the installer's default target is ~/.local/bin.
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && ntnBinary === "ntn") {
      ntnBinary = `${homedir()}/.local/bin/ntn`;
      result = await runNtn(["api", path, ...params]);
    } else {
      throw err;
    }
  }
  let parsed: Json | null = null;
  try {
    parsed = JSON.parse(result.stdout) as Json;
  } catch {
    parsed = null;
  }
  if (result.code !== 0 || !parsed || parsed.object === "error") {
    const message = parsed?.message ?? result.stderr.trim().split("\n").pop() ?? `ntn exited ${result.code}`;
    throw new Error(String(message).replace(/^error:\s*/i, "").replace(/^Public API request failed \(([^)]*)\):\s*/, ""));
  }
  return parsed;
}

function plain(richText: unknown): string {
  if (!Array.isArray(richText)) return "";
  return richText.map((part: Json) => part?.plain_text ?? "").join("");
}

function pageTitle(page: Json): string {
  for (const property of Object.values<Json>(page.properties ?? {})) {
    if (property?.type === "title") return plain(property.title).trim();
  }
  return "";
}

/** Titles of related pages and data sources barely change: one lookup per id for the plugin's life. */
const titleCache = new Map<string, string>();

async function titleOf(kind: "pages" | "data_sources" | "databases", id: string): Promise<string | null> {
  const key = `${kind}:${id}`;
  const cached = titleCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const object = await api(`/v1/${kind}/${id}`);
    const title = kind === "pages" ? pageTitle(object) : plain(object.title).trim();
    titleCache.set(key, title);
    return title;
  } catch {
    return null;
  }
}

function dateText(date: Json | null | undefined): string {
  if (!date?.start) return "";
  const short = (value: string) => value.replace(/T.*$/, "");
  return date.end ? `${short(date.start)} → ${short(date.end)}` : short(date.start);
}

async function describe(name: string, property: Json, budget: { lookups: number }): Promise<NotionProperty | null> {
  const type = String(property.type);
  const base = { name, type, color: null as string | null };
  switch (type) {
    case "select":
      return property.select ? { ...base, value: property.select.name, color: property.select.color ?? null } : null;
    case "multi_select": {
      const values = (property.multi_select ?? []) as Json[];
      return values.length ? { ...base, value: values.map((v) => v.name).join(", "), color: values[0]?.color ?? null } : null;
    }
    case "people": {
      const people = (property.people ?? []) as Json[];
      const names = people.map((person) => person.name).filter(Boolean);
      return names.length ? { ...base, value: names.join(", ") } : null;
    }
    case "number":
      return typeof property.number === "number" ? { ...base, value: String(property.number) } : null;
    case "date": {
      const value = dateText(property.date);
      return value ? { ...base, value } : null;
    }
    case "checkbox":
      return property.checkbox ? { ...base, value: "Yes" } : null;
    case "url":
    case "email":
    case "phone_number":
      return property[type] ? { ...base, value: String(property[type]) } : null;
    case "rich_text": {
      const value = plain(property.rich_text).trim();
      return value && value.length <= 80 ? { ...base, value } : null;
    }
    case "unique_id": {
      const unique = property.unique_id;
      if (typeof unique?.number !== "number") return null;
      return { ...base, value: unique.prefix ? `${unique.prefix}-${unique.number}` : String(unique.number) };
    }
    case "relation": {
      const related = (property.relation ?? []) as Json[];
      if (!related.length) return null;
      const titles: string[] = [];
      for (const entry of related.slice(0, 2)) {
        if (budget.lookups <= 0) break;
        budget.lookups--;
        const title = await titleOf("pages", entry.id);
        if (title) titles.push(title);
      }
      const rest = related.length - titles.length;
      const value = titles.length
        ? `${titles.join(", ")}${rest > 0 ? ` +${rest}` : ""}`
        : `${related.length} linked`;
      return { ...base, value };
    }
    default:
      return null;
  }
}

async function loadChecklists(pageId: string): Promise<NotionChecklist[]> {
  const groups: NotionChecklist[] = [];
  let heading: string | null = null;
  let current: NotionChecklist | null = null;
  let cursor: string | null = null;

  for (let round = 0; round < MAX_BLOCK_PAGES; round++) {
    const params = ["page_size==100"];
    if (cursor) params.push(`start_cursor==${cursor}`);
    const response = await api(`/v1/blocks/${pageId}/children`, ...params);
    for (const block of (response.results ?? []) as Json[]) {
      const type = String(block.type);
      if (type.startsWith("heading_")) {
        heading = plain(block[type]?.rich_text).trim() || null;
        current = null;
        continue;
      }
      if (type !== "to_do") continue;
      if (!current) {
        current = { heading, done: 0, total: 0, items: [] };
        groups.push(current);
      }
      const checked = Boolean(block.to_do?.checked);
      current.total++;
      if (checked) current.done++;
      if (current.items.length < MAX_ITEMS_PER_CHECKLIST) {
        current.items.push({ text: plain(block.to_do?.rich_text).trim().slice(0, 240), checked });
      }
    }
    if (!response.has_more || !response.next_cursor) break;
    cursor = String(response.next_cursor);
  }
  // Two to-do runs under the same heading (split by a paragraph) read as one list.
  const merged: NotionChecklist[] = [];
  for (const group of groups) {
    const previous = merged[merged.length - 1];
    if (previous && previous.heading === group.heading) {
      previous.done += group.done;
      previous.total += group.total;
      previous.items.push(...group.items.slice(0, MAX_ITEMS_PER_CHECKLIST - previous.items.length));
    } else {
      merged.push(group);
    }
  }
  return merged;
}

async function parentLabel(parent: Json | undefined): Promise<string | null> {
  if (!parent) return null;
  if (parent.type === "data_source_id") return titleOf("data_sources", parent.data_source_id);
  if (parent.type === "database_id") return titleOf("databases", parent.database_id);
  if (parent.type === "page_id") return titleOf("pages", parent.page_id);
  return null;
}

export async function loadPage({ pageId }: Input): Promise<Output> {
  const id = normalizeId(pageId);
  if (!id) return { page: null, error: "Not a Notion page id." };

  let page: Json;
  try {
    page = await api(`/v1/pages/${id}`);
  } catch (err) {
    return { page: null, error: err instanceof Error ? err.message : "Notion lookup failed." };
  }

  const budget = { lookups: MAX_RELATION_LOOKUPS };
  const entries = Object.entries<Json>(page.properties ?? {})
    .filter(([name, property]) => !HIDDEN_TYPES.has(String(property.type)) && !HIDDEN_NAMES.test(name))
    .sort(([, a], [, b]) => {
      const rank = (type: string) => (TYPE_ORDER.indexOf(type) + TYPE_ORDER.length + 1) % (TYPE_ORDER.length + 1);
      return rank(String(a.type)) - rank(String(b.type));
    });

  const [properties, checklists, parent] = await Promise.all([
    (async () => {
      const described: NotionProperty[] = [];
      for (const [name, property] of entries) {
        if (described.length >= MAX_PROPERTIES) break;
        const value = await describe(name, property, budget);
        if (value) described.push(value);
      }
      return described;
    })(),
    loadChecklists(id).catch(() => [] as NotionChecklist[]),
    parentLabel(page.parent),
  ]);

  const statusEntry = Object.entries<Json>(page.properties ?? {}).find(([, property]) => property.type === "status");
  const status = statusEntry?.[1].status
    ? { name: statusEntry[0], type: "status", value: String(statusEntry[1].status.name), color: statusEntry[1].status.color ?? null }
    : null;

  return {
    page: {
      id,
      url: String(page.url ?? `https://www.notion.so/${id.replace(/-/g, "")}`),
      title: pageTitle(page) || "Untitled",
      icon: page.icon?.type === "emoji" ? String(page.icon.emoji) : null,
      inTrash: Boolean(page.in_trash ?? page.archived),
      parent,
      lastEditedAt: typeof page.last_edited_time === "string" ? page.last_edited_time : null,
      status,
      properties,
      checklists,
      fetchedAt: new Date().toISOString(),
    },
    error: null,
  };
}
