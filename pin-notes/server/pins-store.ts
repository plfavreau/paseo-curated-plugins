import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Pin } from "../shared/pins";

export const defaultPinsPath = join(homedir(), ".paseo", "plugin-data", "pin-notes", "pins.json");

let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

export async function readPins(path: string): Promise<Pin[]> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Pin[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writePins(path: string, pins: Pin[]) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(pins, null, 2));
  await rename(temporaryPath, path);
}

export function addPin(path: string, pin: Pin) {
  return serialized(async () => {
    await writePins(path, [...(await readPins(path)), pin]);
  });
}

export function removePin(path: string, id: string) {
  return serialized(async () => {
    const pins = await readPins(path);
    const remaining = pins.filter((pin) => pin.id !== id);
    if (remaining.length === pins.length) return false;
    await writePins(path, remaining);
    return true;
  });
}
