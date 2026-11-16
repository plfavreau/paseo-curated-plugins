import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// NOTE: the app validates contribution ids/kinds with /^[a-z][a-z0-9-]*$/.
export const NOTION_CARD_KIND = "notion-card-page";
export const NOTION_CARD_VERSION = 1;

/** At most this many cards come out of one command. */
const MAX_PAGES_PER_COMMAND = 3;

const UUID = /\b([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})\b/i;
const UUID_GLOBAL = new RegExp(UUID.source, "gi");
/** A Notion page URL ends with the page id, optionally after a slug: `.../Some-title-<32 hex>`. */
const NOTION_URL = /https?:\/\/(?:www\.)?(?:app\.)?notion\.(?:so|site|com)\/[^\s"'<>)]*/gi;

export function normalizeId(raw: string): string | null {
  const match = UUID.exec(raw);
  if (!match) return null;
  return match.slice(1, 6).join("-").toLowerCase();
}

function idFromUrl(url: string): string | null {
  const path = url.split(/[?#]/)[0] ?? url;
  const match = /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(path);
  return match ? normalizeId(match[1]!) : null;
}

/** Splits one line into shell-ish tokens, honouring simple quotes. */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  return tokens;
}

export type NotionAction = "get" | "edit" | "create" | "trash" | "update" | "append";

export type NotionMention = { pageId: string; action: NotionAction };

/** Picks the id of the page a create returned: JSON `id`, a page URL, or the first id that is not the parent. */
function createdPageId(output: string, exclude: Set<string>): string | null {
  const trimmed = output.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { object?: unknown; id?: unknown };
      if (parsed.object === "page" && typeof parsed.id === "string") return normalizeId(parsed.id);
    } catch {
      // Not pure JSON: fall through to text scanning.
    }
  }
  for (const url of output.match(NOTION_URL) ?? []) {
    const id = idFromUrl(url);
    if (id && !exclude.has(id)) return id;
  }
  for (const match of output.matchAll(UUID_GLOBAL)) {
    const id = normalizeId(match[0]);
    if (id && !exclude.has(id)) return id;
  }
  return null;
}

/**
 * Finds the Notion pages an `ntn` command reads or writes.
 *
 * `ntn pages get|edit|trash <id>`, `ntn pages create` (id taken from the output), and
 * `ntn api /v1/pages/<id>` or `/v1/blocks/<id>/children`. Parent ids of a create are skipped:
 * they are databases or data sources, not the page the agent is working on.
 */
export function findNotionMentions(command: string, output: string): NotionMention[] {
  const mentions: NotionMention[] = [];
  const seen = new Set<string>();
  const add = (pageId: string | null, action: NotionAction) => {
    if (!pageId || seen.has(pageId) || mentions.length >= MAX_PAGES_PER_COMMAND) return;
    seen.add(pageId);
    mentions.push({ pageId, action });
  };

  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const tokens = tokenize(segment);
    const start = tokens.findIndex((token) => token === "ntn" || token.endsWith("/ntn"));
    if (start < 0) continue;
    const args = tokens.slice(start + 1);
    const [group, sub] = args;

    if (group === "pages" && (sub === "get" || sub === "edit" || sub === "trash")) {
      const target = args.slice(2).find((token) => !token.startsWith("-"));
      if (target) add(target.startsWith("http") ? idFromUrl(target) : normalizeId(target), sub);
      continue;
    }
    if (group === "pages" && sub === "create") {
      const parents = new Set(
        args.flatMap((token) => [...token.matchAll(UUID_GLOBAL)].map((m) => normalizeId(m[0])!)),
      );
      add(createdPageId(output, parents), "create");
      continue;
    }
    if (group === "api") {
      const path = args.find((token) => token.startsWith("/v1/") || token.startsWith("v1/"));
      if (!path) continue;
      const methodIndex = args.findIndex((token) => token === "-X" || token === "--method");
      const method = methodIndex >= 0 ? args[methodIndex + 1]?.toUpperCase() : undefined;
      const hasBody = args.some((token) => token === "-d" || token === "--data" || /^[\w[\]]+:?=(?!=)/.test(token));
      const page = /v1\/pages\/([0-9a-f-]{32,36})/i.exec(path);
      if (page) {
        add(normalizeId(page[1]!), method === "PATCH" || hasBody ? "update" : "get");
        continue;
      }
      const blocks = /v1\/blocks\/([0-9a-f-]{32,36})\/children/i.exec(path);
      if (blocks) {
        add(normalizeId(blocks[1]!), method === "PATCH" || hasBody ? "append" : "get");
        continue;
      }
      if (/v1\/pages\/?$/.test(path) && (method === "POST" || hasBody || !method)) {
        add(createdPageId(output, new Set()), "create");
      }
    }
  }
  return mentions;
}

export const notionCardSchema = z.object({
  pageId: z.string(),
  action: z.enum(["get", "edit", "create", "trash", "update", "append"]),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  command: z.string(),
  output: z.string(),
  exitCode: z.number().nullable(),
  /** Only the first card of a command shows the command header, so it is not repeated. */
  showCommand: z.boolean(),
});
export type NotionCardData = z.output<typeof notionCardSchema>;

const propertySchema = z.object({
  name: z.string(),
  type: z.string(),
  value: z.string(),
  /** A Notion color name (`green`, `red`...) for select and status values. */
  color: z.string().nullable(),
});
export type NotionProperty = z.output<typeof propertySchema>;

const checklistSchema = z.object({
  heading: z.string().nullable(),
  done: z.number(),
  total: z.number(),
  items: z.array(z.object({ text: z.string(), checked: z.boolean() })),
});
export type NotionChecklist = z.output<typeof checklistSchema>;

const pageSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  icon: z.string().nullable(),
  /** A custom page icon (uploaded or linked image). */
  iconUrl: z.string().nullable(),
  inTrash: z.boolean(),
  parent: z.string().nullable(),
  lastEditedAt: z.string().nullable(),
  status: propertySchema.nullable(),
  properties: z.array(propertySchema),
  checklists: z.array(checklistSchema),
  fetchedAt: z.string(),
});
export type NotionPage = z.output<typeof pageSchema>;

export const notionPageRpc = defineRpc({
  name: "notion-card.page",
  input: z.object({ pageId: z.string().min(32) }),
  output: z.object({ page: pageSchema.nullable(), error: z.string().nullable() }),
});
