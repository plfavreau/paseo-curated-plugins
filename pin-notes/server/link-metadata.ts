export interface LinkMetadata {
  title: string | null;
  faviconUrl: string | null;
}

const USER_AGENT = "Mozilla/5.0 (compatible; paseo-workspace-links)";
const MAX_HTML_CHARS = 512_000;
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
};

export function findFirstUrl(text: string) {
  const match = text.match(/https?:\/\/[^\s<>"']+/)?.[0];
  return match ? match.replace(/[),.;:!?]+$/, "") : null;
}

function decode(text: string) {
  return text.replace(/&(amp|quot|#39|lt|gt);/g, (entity) => ENTITIES[entity] ?? entity).trim();
}

function attribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? decode(match[1] ?? "") : null;
}

export function parseLinkMetadata(html: string, pageUrl: string): LinkMetadata {
  const ogTitle = (html.match(/<meta\b[^>]*>/gi) ?? []).find(
    (tag) => attribute(tag, "property") === "og:title",
  );
  const documentTitle = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const title =
    (ogTitle ? attribute(ogTitle, "content") : null) ||
    (documentTitle ? decode(documentTitle) : null) ||
    null;

  const iconTag = (html.match(/<link\b[^>]*>/gi) ?? []).find((tag) =>
    (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/).includes("icon"),
  );
  const iconHref = iconTag ? attribute(iconTag, "href") : null;

  return {
    title,
    faviconUrl: new URL(iconHref ?? "/favicon.ico", pageUrl).toString(),
  };
}

export async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  const fallback = { title: null, faviconUrl: new URL("/favicon.ico", url).toString() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT },
    });
    const html = (await response.text()).slice(0, MAX_HTML_CHARS);
    return parseLinkMetadata(html, response.url || url);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
