import { useSyncExternalStore } from "react";
import type { Pin } from "../shared/pins";

let pins: Pin[] = [];
let dialogAgentId: string | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getPins() {
  return pins;
}

export function setPins(next: Pin[]) {
  pins = next;
  emit();
}

export function openPinDialog(agentId: string) {
  dialogAgentId = agentId;
  emit();
}

export function closePinDialog() {
  dialogAgentId = null;
  emit();
}

export function subscribePins(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePins() {
  return useSyncExternalStore(subscribePins, getPins);
}

export function usePinDialog() {
  return useSyncExternalStore(subscribePins, () => dialogAgentId);
}
