import { BADGE_BLUE } from "../notes";
import { isDarkPage, web, type Dom } from "./dom";

const COMMENT_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const COPY_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

const STYLE = `
.qs * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.qs .toolbar {
  position: fixed; display: none; align-items: center; gap: 2px; padding: 3px;
  border-radius: 9px; background: rgba(24,24,27,0.97); border: 1px solid rgba(255,255,255,0.12);
  box-shadow: 0 6px 20px rgba(0,0,0,0.25); pointer-events: auto;
}
.qs .toolbar[data-open] { display: flex; }
.qs .toolbar button {
  display: flex; align-items: center; gap: 6px; padding: 5px 9px; border: 0; border-radius: 6px;
  background: transparent; color: #fafafa; font-size: 12px; font-weight: 500; cursor: pointer;
}
.qs .toolbar button:hover { background: rgba(255,255,255,0.1); }
.qs .toolbar kbd { font: 500 10px/14px inherit; padding: 0 4px; border-radius: 4px; background: rgba(255,255,255,0.14); color: #d4d4d8; }
.qs .toolbar .sep { width: 1px; height: 16px; background: rgba(255,255,255,0.14); }
.qs .card {
  position: fixed; display: none; flex-direction: column; gap: 8px; width: 340px; padding: 10px;
  border-radius: 12px; background: var(--bg); color: var(--fg); border: 1px solid var(--border);
  box-shadow: 0 10px 32px rgba(0,0,0,0.18); pointer-events: auto;
}
.qs .card[data-open] { display: flex; }
.qs .card .quote {
  font-size: 12px; line-height: 16px; color: var(--muted); padding-left: 8px; border-left: 2px solid ${BADGE_BLUE};
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.qs .card textarea {
  width: 100%; min-height: 56px; max-height: 180px; resize: none; border: 0; outline: none; padding: 0;
  background: transparent; color: var(--fg); font-size: 14px; line-height: 20px;
}
.qs .card textarea::placeholder { color: var(--muted); }
.qs .card .actions { display: flex; align-items: center; gap: 6px; }
.qs .card .hint { flex: 1; font-size: 11px; color: var(--muted); }
.qs .card button { border: 0; border-radius: 7px; padding: 5px 11px; font-size: 12px; font-weight: 500; cursor: pointer; }
.qs .card .delete { background: transparent; color: var(--muted); }
.qs .card .delete:hover { color: #e5484d; }
.qs .card .save { background: ${BADGE_BLUE}; color: #fff; }
.qs .card .delete[hidden] { display: none; }
.qs .badge {
  position: fixed; width: 18px; height: 18px; border-radius: 9px; background: ${BADGE_BLUE}; color: #fff;
  font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; cursor: pointer;
  pointer-events: auto; box-shadow: 0 1px 3px rgba(0,0,0,0.25); user-select: none;
}
.qs .badge:hover { filter: brightness(1.12); }
`;

export interface CardRequest {
  quote: string;
  comment: string;
  /** Where to anchor the card: below this rectangle, or above it when there is no room. */
  rect: Dom;
  editing: boolean;
  submit(comment: string): void;
  remove?(): void;
  /** The card closed, by any path. */
  closed(): void;
}

export interface BadgeSpot {
  key: string;
  label: string;
  left: number;
  top: number;
  open(rect: Dom): void;
}

export function createUi(handlers: { comment(): void; copy(): void }) {
  const host = web.document.createElement("div");
  host.setAttribute("data-quote-selection", "");
  Object.assign(host.style, { position: "fixed", top: "0", left: "0", width: "0", height: "0", zIndex: "2147483646" });
  // A plain subtree rather than a shadow root: the app only leaves keys alone in its own text
  // fields when the event target is a real textarea, which a shadow root would hide.
  host.className = "qs";
  const root = host;
  root.innerHTML = `<style>${STYLE}</style>
    <div class="badges"></div>
    <div class="toolbar">
      <button data-action="comment">${COMMENT_ICON}<span>Comment</span><kbd>Q</kbd></button>
      <span class="sep"></span>
      <button data-action="copy">${COPY_ICON}<span>Copy</span></button>
    </div>
    <div class="card">
      <div class="quote"></div>
      <textarea rows="3" placeholder="Comment on this passage…"></textarea>
      <div class="actions">
        <span class="hint">Enter to save · Esc to cancel</span>
        <button class="delete" type="button">Delete</button>
        <button class="save" type="button">Add</button>
      </div>
    </div>`;
  web.document.body.appendChild(host);

  const toolbar = root.querySelector(".toolbar");
  const card = root.querySelector(".card");
  const quote = card.querySelector(".quote");
  const field = card.querySelector("textarea");
  const deleteButton = card.querySelector(".delete");
  const saveButton = card.querySelector(".save");
  const badgeLayer = root.querySelector(".badges");
  let request: CardRequest | null = null;

  // Clicks in the plugin's UI must not clear the chat selection under it.
  toolbar.addEventListener("mousedown", (event: Dom) => event.preventDefault());
  toolbar.addEventListener("click", (event: Dom) => {
    const action = event.target.closest("button")?.getAttribute("data-action");
    if (action === "comment") handlers.comment();
    if (action === "copy") handlers.copy();
  });

  const closeCard = () => {
    if (!request) return;
    const current = request;
    request = null;
    card.removeAttribute("data-open");
    current.closed();
  };
  const submit = () => {
    if (!request) return;
    const current = request;
    const comment = field.value.trim();
    closeCard();
    current.submit(comment);
  };
  field.addEventListener("keydown", (event: Dom) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      closeCard();
    } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  saveButton.addEventListener("click", submit);
  deleteButton.addEventListener("click", () => {
    const current = request;
    closeCard();
    current?.remove?.();
  });

  // A click outside keeps what was typed, like leaving a comment box in a doc; an empty new
  // comment is dropped.
  const onOutside = (event: Dom) => {
    if (!request || host.contains(event.target)) return;
    if (field.value.trim() || request.editing) submit();
    else closeCard();
  };
  web.document.addEventListener("mousedown", onOutside, true);

  const place = (element: Dom, rect: Dom, width: number, height: number, gap: number) => {
    const left = Math.min(Math.max(8, rect.left), web.innerWidth - width - 8);
    const below = rect.bottom + gap;
    const top = below + height < web.innerHeight - 8 ? below : Math.max(8, rect.top - height - gap);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  };

  return {
    showToolbar(rect: Dom) {
      toolbar.setAttribute("data-open", "");
      const width = toolbar.offsetWidth;
      const left = Math.min(Math.max(8, rect.right - width), web.innerWidth - width - 8);
      const above = rect.top - toolbar.offsetHeight - 6;
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${above > 8 ? above : rect.bottom + 6}px`;
    },
    hideToolbar() {
      toolbar.removeAttribute("data-open");
    },
    toolbarOpen: () => toolbar.hasAttribute("data-open"),
    cardOpen: () => request !== null,
    openCard(next: CardRequest) {
      closeCard();
      request = next;
      const dark = isDarkPage();
      card.style.setProperty("--bg", dark ? "#1f1f23" : "#ffffff");
      card.style.setProperty("--fg", dark ? "#f4f4f5" : "#18181b");
      card.style.setProperty("--muted", dark ? "#a1a1aa" : "#71717a");
      card.style.setProperty("--border", dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.1)");
      quote.textContent = next.quote.replace(/\s+/g, " ");
      field.value = next.comment;
      deleteButton.hidden = !next.editing;
      saveButton.textContent = next.editing ? "Save" : "Add";
      card.setAttribute("data-open", "");
      place(card, next.rect, card.offsetWidth, card.offsetHeight, 8);
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    },
    closeCard,
    renderBadges(spots: readonly BadgeSpot[]) {
      const existing = new Map<string, Dom>();
      for (const badge of Array.from(badgeLayer.children as ArrayLike<Dom>)) existing.set(badge.dataset.key, badge);
      for (const spot of spots) {
        let badge = existing.get(spot.key);
        existing.delete(spot.key);
        if (!badge) {
          badge = web.document.createElement("div");
          badge.className = "badge";
          badge.dataset.key = spot.key;
          badge.addEventListener("mousedown", (event: Dom) => event.preventDefault());
          badgeLayer.appendChild(badge);
        }
        badge.onclick = () => spot.open(badge.getBoundingClientRect());
        if (badge.textContent !== spot.label) badge.textContent = spot.label;
        badge.style.left = `${spot.left}px`;
        badge.style.top = `${spot.top}px`;
      }
      for (const stale of existing.values()) stale.remove();
    },
    owns: (node: Dom) => host.contains(node),
    dispose() {
      web.document.removeEventListener("mousedown", onOutside, true);
      host.remove();
    },
  };
}
