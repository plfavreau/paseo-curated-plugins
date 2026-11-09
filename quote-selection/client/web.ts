import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}
interface Node {
  parentElement: Element | null;
  contains(other: Node | null): boolean;
}
interface Element extends Node {
  closest(selector: string): Element | null;
  querySelector(selector: string): Element | null;
  getAttribute(name: string): string | null;
}
interface HTMLElement extends Element {
  style: Record<string, string>;
  innerHTML: string;
  title: string;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: DomEvent) => void): void;
  remove(): void;
  focus(): void;
  appendChild(child: HTMLElement): void;
  dispatchEvent(event: object): boolean;
}
interface TextArea extends HTMLElement {
  value: string;
  setSelectionRange(start: number, end: number): void;
  scrollTop: number;
  scrollHeight: number;
}
interface DomEvent {
  target: Node | null;
  key?: string;
  preventDefault(): void;
  stopPropagation(): void;
}
interface Range {
  commonAncestorContainer: Node;
  getBoundingClientRect(): Rect;
}
interface Selection {
  isCollapsed: boolean;
  rangeCount: number;
  anchorNode: Node | null;
  focusNode: Node | null;
  toString(): string;
  getRangeAt(index: number): Range;
  removeAllRanges(): void;
}
declare const window: {
  getSelection(): Selection | null;
  innerWidth: number;
  addEventListener(type: string, listener: (event: DomEvent) => void, options?: boolean): void;
  removeEventListener(type: string, listener: (event: DomEvent) => void, options?: boolean): void;
  setTimeout(callback: () => void, ms: number): number;
};
declare const document: {
  body: HTMLElement;
  createElement(tag: string): HTMLElement;
  addEventListener(type: string, listener: (event: DomEvent) => void, options?: boolean): void;
  removeEventListener(type: string, listener: (event: DomEvent) => void, options?: boolean): void;
};
declare const HTMLTextAreaElement: { prototype: object };
declare const InputEvent: new (type: string, init: { bubbles: boolean }) => object;

const COMPOSER_TEXTAREA = '[data-testid="message-input-root"] textarea';
const EDITABLE = 'textarea, input, [contenteditable="true"], [data-testid="message-input-root"]';
const QUOTE_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/></svg>';

interface Pending {
  text: string;
  composer: TextArea;
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return (node as Element).closest ? (node as Element) : node.parentElement;
}

// The composer sharing the nearest ancestor with the selection is the one of its pane.
function composerFor(node: Node): TextArea | null {
  for (let el = elementOf(node); el; el = el.parentElement) {
    const textarea = el.querySelector(COMPOSER_TEXTAREA);
    if (textarea) return textarea as TextArea;
  }
  return null;
}

function readSelection(): (Pending & { rect: Rect }) | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  for (const node of [selection.anchorNode, selection.focusNode]) {
    if (elementOf(node)?.closest(EDITABLE)) return null;
  }
  const range = selection.getRangeAt(0);
  const composer = composerFor(range.commonAncestorContainer);
  if (!composer) return null;
  return { text, composer, rect: range.getBoundingClientRect() };
}

export function formatQuote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

function insertQuote({ text, composer }: Pending): void {
  const current = composer.value.replace(/\s+$/, "");
  const next = `${current ? `${current}\n\n` : ""}${formatQuote(text)}\n\n`;
  // React owns the textarea value, so write through the native setter and announce an input.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) return;
  setter.call(composer, next);
  composer.dispatchEvent(new InputEvent("input", { bubbles: true }));
  const focusEnd = () => {
    composer.focus();
    composer.setSelectionRange(next.length, next.length);
    composer.scrollTop = composer.scrollHeight;
  };
  focusEnd();
  // React re-renders after the input event and can drop the caret, so place it again once settled.
  window.setTimeout(focusEnd, 50);
}

function createButton(): HTMLElement {
  const button = document.createElement("button");
  button.setAttribute("type", "button");
  button.setAttribute("aria-label", "Quote selection in the prompt");
  button.title = "Quote in prompt (Q)";
  button.innerHTML = `${QUOTE_ICON}<span>Quote</span>`;
  Object.assign(button.style, {
    position: "fixed",
    zIndex: "2147483647",
    display: "none",
    alignItems: "center",
    gap: "6px",
    padding: "5px 10px",
    borderRadius: "8px",
    border: "1px solid rgba(127,127,127,0.35)",
    background: "rgba(24,24,27,0.96)",
    color: "#fafafa",
    font: "500 12px/16px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
    cursor: "pointer",
    userSelect: "none",
  });
  return button;
}

// Paseo runs one instance per connected host in the same window; only the first may own the page,
// otherwise each one quotes the selection on Q. When it stops, the next one takes over.
interface Claim {
  start: () => () => void;
  stop: (() => void) | null;
}
const holder = globalThis as { __quoteSelectionRuntime?: { queue: Claim[]; owner: Claim | null } };

function claimPage(start: () => () => void): () => void {
  const runtime = (holder.__quoteSelectionRuntime ??= { queue: [], owner: null });
  const promote = () => {
    const next = runtime.queue[0];
    if (runtime.owner || !next) return;
    runtime.owner = next;
    next.stop = next.start();
  };
  const claim: Claim = { start, stop: null };
  runtime.queue.push(claim);
  promote();
  return () => {
    runtime.queue = runtime.queue.filter((other) => other !== claim);
    if (runtime.owner !== claim) return;
    claim.stop?.();
    runtime.owner = null;
    promote();
  };
}

export function installSelectionQuote(): () => void {
  if (Platform.OS !== "web") return () => {};
  return claimPage(mountSelectionQuote);
}

function mountSelectionQuote(): () => void {
  const button = createButton();
  document.body.appendChild(button);
  let pending: Pending | null = null;

  const hide = () => {
    pending = null;
    button.style.display = "none";
  };

  const show = () => {
    const current = readSelection();
    if (!current) return hide();
    pending = { text: current.text, composer: current.composer };
    const width = 84;
    const left = Math.min(Math.max(8, current.rect.right - width), window.innerWidth - width - 8);
    const above = current.rect.top - 34;
    button.style.left = `${left}px`;
    button.style.top = `${above > 8 ? above : current.rect.bottom + 6}px`;
    button.style.display = "flex";
  };

  const quote = () => {
    const current = pending ?? readSelection();
    if (!current) return;
    window.getSelection()?.removeAllRanges();
    hide();
    insertQuote(current);
  };

  const onMouseUp = (event: DomEvent) => {
    if (button.contains(event.target)) return;
    window.setTimeout(show, 0);
  };
  const onSelectionChange = () => {
    if (window.getSelection()?.isCollapsed) hide();
  };
  const onKeyDown = (
    event: DomEvent & { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean },
  ) => {
    if (!pending) return;
    if (event.key === "Escape") return hide();
    const hasModifier = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
    if (hasModifier || event.key?.toLowerCase() !== "q") return;
    if (elementOf(event.target)?.closest(EDITABLE)) return;
    event.preventDefault();
    event.stopPropagation();
    quote();
  };

  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    quote();
  });
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("keydown", onKeyDown as (event: DomEvent) => void, true);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);

  return () => {
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("keydown", onKeyDown as (event: DomEvent) => void, true);
    window.removeEventListener("scroll", hide, true);
    window.removeEventListener("resize", hide);
    button.remove();
  };
}
