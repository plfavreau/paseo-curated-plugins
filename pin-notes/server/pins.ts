import { randomUUID } from "node:crypto";
import type { RpcInput } from "@getpaseo/plugin";
import type { Pin, savePinRpc } from "../shared/pins";
import { fetchLinkMetadata, findFirstUrl } from "./link-metadata";
import { addPin, defaultPinsPath, readPins, removePin as removeStoredPin } from "./pins-store";

export async function listPins() {
  return { pins: await readPins(defaultPinsPath) };
}

export async function savePin({ agentId, title, body }: RpcInput<typeof savePinRpc>): Promise<Pin> {
  const url = findFirstUrl(body);
  const metadata = url ? await fetchLinkMetadata(url) : { title: null, faviconUrl: null };
  const pin: Pin = {
    id: randomUUID(),
    agentId,
    title:
      title.trim() ||
      metadata.title ||
      (url ? new URL(url).hostname : body.split("\n")[0].slice(0, 60)),
    body,
    url,
    faviconUrl: metadata.faviconUrl,
    createdAt: new Date().toISOString(),
  };
  await addPin(defaultPinsPath, pin);
  return pin;
}

export async function removePin(id: string) {
  return { removed: await removeStoredPin(defaultPinsPath, id) };
}
