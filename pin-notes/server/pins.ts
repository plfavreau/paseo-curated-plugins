import { randomUUID } from "node:crypto";
import type { Pin } from "../shared/pins.ts";
import { fetchLinkMetadata, findFirstUrl } from "./link-metadata.ts";
import { addPin, defaultPinsPath, readPins, removePin, updatePin } from "./pins-store.ts";

export interface PinDraft {
  agentId: string;
  title: string;
  body: string;
  createdBy: Pin["createdBy"];
}

async function linkFields(body: string, title: string) {
  const url = findFirstUrl(body);
  const metadata = url ? await fetchLinkMetadata(url) : { title: null, faviconUrl: null };
  return {
    url,
    faviconUrl: metadata.faviconUrl,
    title:
      title.trim() ||
      metadata.title ||
      (url ? new URL(url).hostname : body.split("\n")[0].slice(0, 60)),
  };
}

export type PinService = ReturnType<typeof createPinService>;

export function createPinService(path = defaultPinsPath) {
  return {
    list: () => readPins(path),

    async create({ agentId, title, body, createdBy }: PinDraft): Promise<Pin> {
      const pin: Pin = {
        id: randomUUID(),
        agentId,
        body,
        createdBy,
        createdAt: new Date().toISOString(),
        ...(await linkFields(body, title)),
      };
      await addPin(path, pin);
      return pin;
    },

    async update(id: string, { title, body }: { title?: string; body?: string }) {
      const current = (await readPins(path)).find((pin) => pin.id === id);
      if (!current) return null;
      const nextBody = body ?? current.body;
      const fields =
        nextBody === current.body
          ? { url: current.url, faviconUrl: current.faviconUrl, title: current.title }
          : await linkFields(nextBody, "");
      return updatePin(path, id, (pin) => ({
        ...pin,
        ...fields,
        body: nextBody,
        title: title?.trim() || fields.title,
      }));
    },

    remove: (id: string) => removePin(path, id),
  };
}
