// Paseo has no plugin API for chat selections, chat decorations or the moment a message is sent,
// so the web client works on the app's own markup. Every selector it relies on is here; when a
// Paseo release breaks the plugin, start with this file. Checked against Paseo 0.16.1.
//
// The plugin typechecks without the DOM library; the web code works on loosely typed nodes.
export type Dom = any;

export const web = globalThis as Dom;

export const TRANSCRIPT = '[data-testid="agent-chat-scroll"]';
export const MESSAGE_ROW = "[data-message-id]";
const USER_MESSAGE = '[data-testid="user-message"]';
const ASSISTANT_MESSAGE = '[data-testid="assistant-message"]';
export const COMPOSER_ROOT = '[data-testid="message-input-root"]';
export const COMPOSER = "textarea[data-composer-input]";
export const EDITABLE = 'textarea, input, [contenteditable="true"], [data-testid="message-input-root"]';

const SHOW_TEXT = 4;

export function elementOf(node: Dom): Dom {
  if (!node) return null;
  return node.nodeType === 1 ? node : node.parentElement;
}

export function isVisible(element: Dom): boolean {
  return !!element && element.getClientRects().length > 0;
}

// The chat and composer components take the agent as an `agentId` prop, which React keeps on the
// fiber of their DOM nodes. The nearest one above an element is the agent it belongs to.
const agentCache = new WeakMap<object, string | null>();
export function agentIdOf(element: Dom): string | null {
  if (!element) return null;
  if (agentCache.has(element)) return agentCache.get(element) ?? null;
  const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"));
  let fiber = key ? element[key] : null;
  let found: string | null = null;
  for (let depth = 0; fiber && depth < 200; depth += 1) {
    const agentId = fiber.memoizedProps?.agentId;
    if (typeof agentId === "string" && agentId) {
      found = agentId;
      break;
    }
    fiber = fiber.return;
  }
  if (found) agentCache.set(element, found);
  return found;
}

export interface Passage {
  quote: string;
  messageId: string | null;
  role: "user" | "assistant" | null;
  agentId: string;
  transcript: Dom;
  range: Dom;
}

/** The chat selection, when it lies in one transcript and outside any text field. */
export function readPassage(): Passage | null {
  const selection = web.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const quote = selection.toString().trim();
  if (!quote) return null;
  const start = elementOf(selection.anchorNode);
  const end = elementOf(selection.focusNode);
  if (!start || !end || start.closest(EDITABLE) || end.closest(EDITABLE)) return null;
  const transcript = start.closest(TRANSCRIPT);
  if (!transcript || end.closest(TRANSCRIPT) !== transcript) return null;
  const agentId = agentIdOf(transcript);
  if (!agentId) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const first = elementOf(range.startContainer);
  const role = first?.closest(USER_MESSAGE) ? "user" : first?.closest(ASSISTANT_MESSAGE) ? "assistant" : null;
  const messageId = first?.closest(MESSAGE_ROW)?.getAttribute("data-message-id") ?? null;
  return { quote, messageId, role, agentId, transcript, range };
}

/**
 * Finds `quote` in the transcript again, ignoring whitespace (the selection's text puts line
 * breaks between blocks that the DOM does not have). Looks in the passage's own message first.
 */
export function findPassage(transcript: Dom, quote: string, messageId: string | null): Dom {
  const needle = quote.replace(/\s+/g, "");
  if (!needle) return null;
  const scopes: Dom[] = [];
  if (messageId) {
    const rows = Array.from(transcript.querySelectorAll(MESSAGE_ROW) as ArrayLike<Dom>).filter(
      (row) => row.getAttribute("data-message-id") === messageId,
    );
    scopes.push(...rows);
  }
  scopes.push(transcript);
  for (const scope of scopes) {
    const range = findIn(scope, needle);
    if (range) return range;
  }
  return null;
}

function findIn(root: Dom, needle: string): Dom {
  const walker = web.document.createTreeWalker(root, SHOW_TEXT);
  const nodes: Dom[] = [];
  const offsets: number[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value: string = node.nodeValue ?? "";
    for (let i = 0; i < value.length; i += 1) {
      if (/\s/.test(value[i])) continue;
      text += value[i];
      nodes.push(node);
      offsets.push(i);
    }
  }
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const last = at + needle.length - 1;
  const range = web.document.createRange();
  range.setStart(nodes[at], offsets[at]);
  range.setEnd(nodes[last], offsets[last] + 1);
  return range;
}

/** Writes into a React-owned textarea through the browser's editing path, so React sees it. */
export function insertAt(input: Dom, at: number, text: string): void {
  input.focus({ preventScroll: true });
  input.setSelectionRange(at, at);
  web.document.execCommand("insertText", false, text);
}

export function deleteRange(input: Dom, start: number, end: number): void {
  input.focus({ preventScroll: true });
  input.setSelectionRange(start, end);
  web.document.execCommand("delete");
}

export function isDarkPage(): boolean {
  const probe = web.document.querySelector(COMPOSER_ROOT) ?? web.document.body;
  let element = probe;
  while (element) {
    const color: string = web.getComputedStyle(element).backgroundColor;
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (match && (match[4] === undefined || Number(match[4]) > 0.5)) {
      const [r, g, b] = match.slice(1, 4).map(Number);
      return 0.299 * r + 0.587 * g + 0.114 * b < 128;
    }
    element = element.parentElement;
  }
  return false;
}
