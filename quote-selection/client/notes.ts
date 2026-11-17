import type { PluginPaseoApi } from "@getpaseo/plugin/client";

/** A comment on a passage of a chat, waiting to go out with the agent's next message. */
export interface Note {
  id: string;
  /** The selected text, as rendered. Also how the passage is found again to highlight it. */
  quote: string;
  comment: string;
  /** The transcript row the passage sits in, to highlight it; null when unknown. */
  messageId: string | null;
  role: "user" | "assistant" | null;
}

/** The badge blue, shared by the chat badges and the pill panel so a number reads the same in both. */
export const BADGE_BLUE = "#5b5fe6";

/** Notes live on the agent, so they survive a reload and leave with the agent when it is archived. */
const METADATA_KEY = "quoteSelection";

function readNotes(metadata: unknown): Note[] {
  if (!metadata || typeof metadata !== "object") return [];
  const value = (metadata as Record<string, unknown>)[METADATA_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter(
    (note): note is Note =>
      !!note && typeof note === "object" && typeof note.id === "string" && typeof note.quote === "string",
  );
}

export function formatNotes(notes: readonly Note[]): string {
  return notes
    .map((note) => {
      const from = note.role ? ` from="${note.role}"` : "";
      const lines = [`<chat-selection${from}>`, `  text: ${JSON.stringify(note.quote.trim())}`];
      const comment = note.comment.trim();
      if (comment) lines.push(`  feedback: ${comment.replace(/\n/g, "\n  ")}`);
      lines.push("</chat-selection>");
      return lines.join("\n");
    })
    .join("\n\n");
}

export function notesLabel(count: number): string {
  return count === 1 ? "1 annotation" : `${count} annotations`;
}

/** One line of the passage, for the pill panel. */
export function excerpt(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `n${Date.now().toString(36)}${counter.toString(36)}`;
}

/**
 * The notes of every agent on one host. Changes apply locally at once, then are written to the
 * agent's metadata; snapshots arriving while a write is in flight are ignored so they cannot
 * roll a newer local change back.
 */
export class Notebook {
  private byAgent = new Map<string, readonly Note[]>();
  private writing = new Map<string, number>();
  private listeners = new Set<() => void>();

  constructor(private readonly paseo: PluginPaseoApi) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  has(agentId: string): boolean {
    return this.byAgent.has(agentId);
  }

  get(agentId: string): readonly Note[] {
    return this.byAgent.get(agentId) ?? [];
  }

  agents(): string[] {
    return [...this.byAgent.keys()];
  }

  /** Called with every agent snapshot of the host. */
  observe(agentId: string, metadata: unknown): void {
    if (this.writing.get(agentId)) return;
    const next = readNotes(metadata);
    const current = this.byAgent.get(agentId);
    if (current && JSON.stringify(current) === JSON.stringify(next)) return;
    this.byAgent.set(agentId, next);
    this.notify();
  }

  forget(agentId: string): void {
    if (this.byAgent.delete(agentId)) this.notify();
  }

  add(agentId: string, note: Omit<Note, "id">): Note {
    const created = { ...note, id: newId() };
    this.write(agentId, [...this.get(agentId), created]);
    return created;
  }

  update(agentId: string, id: string, comment: string): void {
    this.write(
      agentId,
      this.get(agentId).map((note) => (note.id === id ? { ...note, comment } : note)),
    );
  }

  remove(agentId: string, ids: readonly string[]): void {
    const drop = new Set(ids);
    this.write(
      agentId,
      this.get(agentId).filter((note) => !drop.has(note.id)),
    );
  }

  clear(agentId: string): void {
    this.write(agentId, []);
  }

  /** Sends every note to the agent now, as its own message. */
  async sendNow(agentId: string): Promise<void> {
    const notes = this.get(agentId);
    if (notes.length === 0) return;
    await this.paseo.agents.ref(agentId).send(formatNotes(notes));
    this.remove(
      agentId,
      notes.map((note) => note.id),
    );
  }

  private write(agentId: string, notes: readonly Note[]): void {
    this.byAgent.set(agentId, notes);
    this.notify();
    this.writing.set(agentId, (this.writing.get(agentId) ?? 0) + 1);
    const value = notes.length ? notes.map((note) => ({ ...note })) : null;
    this.paseo.agents
      .ref(agentId)
      .setMetadata({ [METADATA_KEY]: value })
      .catch((error: unknown) => console.error("[quote-selection] could not save annotations", error))
      .finally(() => {
        const left = (this.writing.get(agentId) ?? 1) - 1;
        if (left > 0) this.writing.set(agentId, left);
        else this.writing.delete(agentId);
      });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
