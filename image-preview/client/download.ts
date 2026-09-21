/**
 * Saving a file to the device.
 *
 * The daemon cannot serve the file over HTTP: the relay only forwards
 * WebSocket frames, and the app refuses to use the built in download route
 * unless it has a direct TCP connection to the daemon. So the bytes arrive
 * over the plugin RPC channel and are assembled into a Blob here.
 *
 * Plugin client bundles are evaluated in the app's own realm, so on the web
 * app the DOM is reachable. It is not part of the plugin contract though, so
 * every capability is feature detected and the caller degrades gracefully.
 * The tsconfig deliberately has no DOM lib, hence the local declarations.
 */

interface BrowserBlob {
  readonly size: number;
}

type BlobConstructor = new (
  parts: ArrayBufferView[],
  options?: { type?: string },
) => BrowserBlob;

interface BrowserUrl {
  createObjectURL(blob: BrowserBlob): string;
  revokeObjectURL(url: string): void;
}

interface BrowserAnchor {
  href: string;
  download: string;
  rel: string;
  click(): void;
  remove(): void;
}

interface BrowserDocument {
  createElement(tagName: "a"): BrowserAnchor;
  body: { appendChild(node: BrowserAnchor): void };
}

const host = globalThis as unknown as {
  document?: BrowserDocument;
  Blob?: BlobConstructor;
  URL?: BrowserUrl;
  atob?: (input: string) => string;
  setTimeout?: (handler: () => void, timeout: number) => unknown;
};

export function canSaveFile(): boolean {
  return Boolean(host.document && host.Blob && host.URL && typeof host.atob === "function");
}

export function base64ToBytes(base64: string): Uint8Array {
  const decode = host.atob;
  if (!decode) throw new Error("This device cannot decode the file.");
  const binary = decode(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function saveFile(parts: Uint8Array[], fileName: string, mimeType: string): void {
  const doc = host.document;
  const BlobCtor = host.Blob;
  const url = host.URL;
  if (!doc || !BlobCtor || !url) {
    throw new Error("Saving files is only supported in the Paseo web app.");
  }
  const objectUrl = url.createObjectURL(new BlobCtor(parts, { type: mimeType }));
  const anchor = doc.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = "noopener";
  doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  const later = host.setTimeout;
  if (later) later(() => url.revokeObjectURL(objectUrl), 60_000);
  else url.revokeObjectURL(objectUrl);
}
