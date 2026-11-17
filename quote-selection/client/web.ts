import { Platform } from "react-native";
import { formatNotes, type Note, type Notebook } from "./notes";
import {
  COMPOSER,
  COMPOSER_ROOT,
  EDITABLE,
  TRANSCRIPT,
  agentIdOf,
  deleteRange,
  elementOf,
  findPassage,
  insertAt,
  isVisible,
  readPassage,
  web,
  type Dom,
  type Passage,
} from "./web/dom";
import { createUi, type BadgeSpot } from "./web/ui";

const HIGHLIGHT = "quote-selection";
const DRAFT_HIGHLIGHT = "quote-selection-draft";
const PAGE_STYLE = `
::highlight(${HIGHLIGHT}) { background-color: rgba(91, 95, 230, 0.16); }
::highlight(${DRAFT_HIGHLIGHT}) { background-color: rgba(91, 95, 230, 0.3); }
`;

// Paseo runs one instance per connected host in the same window. Each host registers its notebook;
// only the first instance drives the page, and finds the notebook of whichever agent a chat shows.
// When it stops, the next one takes over.
interface Claim {
  start: () => () => void;
  stop: (() => void) | null;
}
interface Runtime {
  queue: Claim[];
  owner: Claim | null;
  notebooks: Set<Notebook>;
  redraw: (() => void) | null;
}
const holder = globalThis as { __quoteSelectionRuntime?: Runtime };
const runtime = (holder.__quoteSelectionRuntime ??= { queue: [], owner: null, notebooks: new Set(), redraw: null });

function notebookFor(agentId: string | null): Notebook | null {
  if (!agentId) return null;
  for (const notebook of runtime.notebooks) if (notebook.has(agentId)) return notebook;
  return null;
}

export function installWeb(notebook: Notebook): () => void {
  if (Platform.OS !== "web") return () => {};
  runtime.notebooks.add(notebook);
  const unsubscribe = notebook.subscribe(() => runtime.redraw?.());
  const release = claimPage(mount);
  return () => {
    unsubscribe();
    runtime.notebooks.delete(notebook);
    release();
    runtime.redraw?.();
  };
}

function claimPage(start: () => () => void): () => void {
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

/** The composer of the pane a chat element sits in: the nearest one sharing an ancestor with it. */
function composerNear(element: Dom): Dom {
  for (let node = element; node; node = node.parentElement) {
    const input = node.querySelector?.(COMPOSER);
    if (input) return input;
  }
  return null;
}

function mount(): () => void {
  const highlights = web.CSS?.highlights;
  const Highlight = web.Highlight;
  const style = web.document.createElement("style");
  style.textContent = PAGE_STYLE;
  web.document.head.appendChild(style);

  let pending: Passage | null = null;
  const ui = createUi({ comment: () => openNewComment(), copy: () => copySelection() });

  const setDraft = (range: Dom) => {
    if (!highlights || !Highlight) return;
    if (range) highlights.set(DRAFT_HIGHLIGHT, new Highlight(range));
    else highlights.delete(DRAFT_HIGHLIGHT);
  };

  // Where each note sits in the page. A cached range stays valid while its text nodes are mounted.
  const ranges = new Map<string, Dom>();
  const rangeOf = (transcript: Dom, note: Note) => {
    const cached = ranges.get(note.id);
    if (cached && cached.startContainer.isConnected && cached.endContainer.isConnected && !cached.collapsed) {
      if (transcript.contains(cached.startContainer)) return cached;
    }
    const found = findPassage(transcript, note.quote, note.messageId);
    if (found) ranges.set(note.id, found);
    else ranges.delete(note.id);
    return found;
  };

  // The badges sit above the whole page, so one is hidden when the app draws something over its
  // spot in the chat, such as a popover or a menu.
  const coveredOutside = (transcript: Dom, x: number, y: number) => {
    const top = (web.document.elementsFromPoint(x, y) as Dom[]).find((element) => !ui.owns(element));
    return !top || !transcript.contains(top);
  };

  const redraw = () => {
    const all: Dom[] = [];
    const spots: BadgeSpot[] = [];
    const taken = new Map<string, number>();
    for (const transcript of Array.from(web.document.querySelectorAll(TRANSCRIPT) as ArrayLike<Dom>)) {
      if (!isVisible(transcript)) continue;
      const agentId = agentIdOf(transcript);
      const notebook = notebookFor(agentId);
      if (!agentId || !notebook) continue;
      const box = transcript.getBoundingClientRect();
      notebook.get(agentId).forEach((note, index) => {
        const range = rangeOf(transcript, note);
        if (!range) return;
        all.push(range);
        const first = range.getClientRects()[0];
        if (!first || first.top < box.top || first.top > box.bottom - 8) return;
        // Notes on the same passage line their badges up instead of covering each other.
        const spot = `${Math.round(first.left)},${Math.round(first.top)}`;
        const stacked = taken.get(spot) ?? 0;
        taken.set(spot, stacked + 1);
        const left = first.left - 9 + stacked * 16;
        const top = first.top - 12;
        if (coveredOutside(transcript, left + 9, top + 9)) return;
        spots.push({
          key: note.id,
          label: String(index + 1),
          left,
          top,
          open: (rect) => openEdit(notebook, agentId, note, range, rect),
        });
      });
    }
    if (highlights && Highlight) {
      if (all.length) highlights.set(HIGHLIGHT, new Highlight(...all));
      else highlights.delete(HIGHLIGHT);
    }
    ui.renderBadges(spots);
  };

  let frame = 0;
  const scheduleRedraw = () => {
    if (frame) return;
    frame = web.requestAnimationFrame(() => {
      frame = 0;
      redraw();
    });
  };
  runtime.redraw = scheduleRedraw;

  function openNewComment() {
    const passage = pending ?? readPassage();
    if (!passage) return;
    const notebook = notebookFor(passage.agentId);
    if (!notebook) return;
    pending = null;
    ui.hideToolbar();
    setDraft(passage.range);
    const rect = passage.range.getBoundingClientRect();
    web.getSelection()?.removeAllRanges();
    ui.openCard({
      quote: passage.quote,
      comment: "",
      rect,
      editing: false,
      submit(comment) {
        notebook.add(passage.agentId, {
          quote: passage.quote,
          comment,
          messageId: passage.messageId,
          role: passage.role,
        });
        composerNear(passage.transcript)?.focus({ preventScroll: true });
      },
      closed: () => setDraft(null),
    });
  }

  function openEdit(notebook: Notebook, agentId: string, note: Note, range: Dom, rect: Dom) {
    setDraft(range);
    ui.openCard({
      quote: note.quote,
      comment: note.comment,
      rect,
      editing: true,
      submit: (comment) => notebook.update(agentId, note.id, comment),
      remove: () => notebook.remove(agentId, [note.id]),
      closed: () => setDraft(null),
    });
  }

  function copySelection() {
    const passage = pending ?? readPassage();
    ui.hideToolbar();
    pending = null;
    if (passage) void web.navigator.clipboard?.writeText(passage.quote);
  }

  const onMouseUp = (event: Dom) => {
    if (elementOf(event.target)?.closest("[data-quote-selection]")) return;
    web.setTimeout(() => {
      if (ui.cardOpen()) return;
      pending = readPassage();
      if (pending && notebookFor(pending.agentId)) ui.showToolbar(pending.range.getBoundingClientRect());
      else ui.hideToolbar();
    }, 0);
  };
  const onSelectionChange = () => {
    if (web.getSelection()?.isCollapsed) {
      pending = null;
      ui.hideToolbar();
    }
  };
  const onKeyDown = (event: Dom) => {
    if (ui.toolbarOpen() && !ui.cardOpen()) {
      if (event.key === "Escape") return ui.hideToolbar();
      const modified = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
      if (!modified && event.key?.toLowerCase() === "q" && !elementOf(event.target)?.closest(EDITABLE)) {
        event.preventDefault();
        event.stopPropagation();
        return openNewComment();
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.isComposing) {
      const target = elementOf(event.target);
      if (target?.matches(COMPOSER)) attachToMessage(target);
    }
  };
  /** The send button is the composer's last button. */
  const onClick = (event: Dom) => {
    const button = elementOf(event.target)?.closest("button");
    const root = button?.closest(COMPOSER_ROOT);
    if (!button || !root || button.disabled) return;
    const buttons = root.querySelectorAll("button");
    if (buttons[buttons.length - 1] !== button) return;
    const input = root.querySelector(COMPOSER);
    if (input?.value.trim()) attachToMessage(input);
  };

  // There is no hook before a message is sent, so this runs ahead of the composer's own handler:
  // the notes are appended to the text the composer is about to send. A moment later an emptied
  // composer means the message went out with them; otherwise Enter did something else (a newline,
  // an autocomplete pick) and the notes are taken back out.
  function attachToMessage(input: Dom) {
    if (input.readOnly || input.disabled || input.value.trimStart().startsWith("/")) return;
    const agentId = agentIdOf(input);
    const notebook = notebookFor(agentId);
    if (!agentId || !notebook) return;
    const notes = notebook.get(agentId);
    if (notes.length === 0) return;
    const current: string = input.value;
    const gap = !current.trim() ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    const block = gap + formatNotes(notes);
    insertAt(input, current.length, block);
    web.setTimeout(() => {
      const at = input.value.lastIndexOf(block);
      if (at >= 0) deleteRange(input, at, at + block.length);
      else
        notebook.remove(
          agentId,
          notes.map((note) => note.id),
        );
    }, 0);
  }

  const onScroll = () => {
    ui.hideToolbar();
    scheduleRedraw();
  };
  const observer = new web.MutationObserver((records: Dom[]) => {
    if (records.some((record) => !ui.owns(record.target))) scheduleRedraw();
  });
  observer.observe(web.document.body, { childList: true, subtree: true, characterData: true });
  web.document.addEventListener("mouseup", onMouseUp);
  web.document.addEventListener("selectionchange", onSelectionChange);
  // On the window, ahead of the app's type-to-focus, which would move a typed Q into the composer.
  web.addEventListener("keydown", onKeyDown, true);
  web.document.addEventListener("click", onClick, true);
  web.addEventListener("scroll", onScroll, true);
  web.addEventListener("resize", scheduleRedraw);
  scheduleRedraw();

  return () => {
    observer.disconnect();
    web.document.removeEventListener("mouseup", onMouseUp);
    web.document.removeEventListener("selectionchange", onSelectionChange);
    web.removeEventListener("keydown", onKeyDown, true);
    web.document.removeEventListener("click", onClick, true);
    web.removeEventListener("scroll", onScroll, true);
    web.removeEventListener("resize", scheduleRedraw);
    if (frame) web.cancelAnimationFrame(frame);
    if (runtime.redraw === scheduleRedraw) runtime.redraw = null;
    highlights?.delete(HIGHLIGHT);
    highlights?.delete(DRAFT_HIGHLIGHT);
    ui.dispose();
    style.remove();
  };
}
