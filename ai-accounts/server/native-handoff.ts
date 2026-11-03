import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { nativeOwnershipRpc } from "../shared/contracts";
import { daemonUrl, PLUGIN_ID } from "./environment";

const execFileAsync = promisify(execFile);

/** Conservative scan, not an attribution of which server loaded which plugin. No argv is returned. */
export async function openCodeProcessIds(readProcesses = async () => {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=", "-o", "comm=", "-o", "args="], { timeout: 10_000, maxBuffer: 8_000_000 });
  return stdout;
}): Promise<number[]> {
  const stdout = await readProcesses();
  if (!stdout.trim()) throw new Error("Empty process inventory");
  return stdout.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) throw new Error("Unreadable process inventory");
    if (Number(match[1]) === process.pid) return [];
    return /(?:^|[/\s])opencode(?:$|[-.\s/])/i.test(match[2]) ? [Number(match[1])] : [];
  });
}

/** This probes the loaded plugin, never source text or the old state RPC. */
export async function liveNativeOwnership() {
  const url = daemonUrl();
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) throw new Error("Run handoff on the daemon host using its loopback endpoint");
  const daemon = new DaemonClient({ url, clientId: `${PLUGIN_ID}-handoff-${randomUUID()}`, clientType: "cli", connectTimeoutMs: 10_000, reconnect: { enabled: false } });
  try {
    await daemon.connect();
    return nativeOwnershipRpc.output.parse(await daemon.invokePluginRpc(PLUGIN_ID, nativeOwnershipRpc.name, {}));
  } finally {
    if (daemon.isConnected) await daemon.close();
  }
}

export async function nativeHandoffReadiness(
  confirmedLegacyRetired: boolean,
  inspectProcesses = openCodeProcessIds,
  attest = liveNativeOwnership,
) {
  if (!confirmedLegacyRetired) return { ready: false, reason: "legacy-retirement-unconfirmed", message: "An operator must drain and fully retire every affected old OpenCode process, including idle servers, before native login/inference. No process is stopped automatically. Then pass --confirm-legacy-retired. This flag confirms operator review, not permission to kill anything." };
  let pids: number[];
  try {
    pids = await inspectProcesses();
  } catch {
    return { ready: false, reason: "process-inspection-unavailable", message: "Cannot verify the process inventory. Handoff is pending operator review." };
  }
  if (pids.length) return { ready: false, reason: "opencode-processes-present", pids, message: "Conservative gate: detected OpenCode processes may retain broker refresh ownership. Ask permission to drain/retire affected servers; do not restart Paseo. The scanner does not distinguish native from legacy servers." };
  try {
    // Validate injected results as well: missing/unknown versions are never readiness.
    const ownership = nativeOwnershipRpc.output.parse(await attest());
    return { ready: ownership.status === "native-auth-present", reason: ownership.status, ownership, message: "Live plugin ownership attested. Process scan is point-in-time only; keep launches paused until handoff completes. Operator confirmation must cover renamed/wrapped/remote processes sharing these credentials, which local ps cannot prove absent." };
  } catch {
    return { ready: false, reason: "live-ownership-unattested", message: "The running ai-accounts plugin did not return ownershipVersion 1 from ai-accounts.native-ownership. Disk contents are not attestation. Handoff remains pending." };
  }
}
