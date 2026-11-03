// Read-only: no migration, refresh, credential restoration or config writes.
import { liveNativeOwnership, nativeHandoffReadiness } from "../server/native-handoff.ts";

try {
  if (process.argv.includes("--attest-only")) {
    const ownership = await liveNativeOwnership();
    console.log(JSON.stringify({ handoffReady: false, ownership, message: "Live RPC attestation only, not process-drain or native-inference authorization." }, null, 2));
    process.exitCode = ownership.status === "native-auth-present" ? 0 : 2;
  } else {
    const result = await nativeHandoffReadiness(process.argv.includes("--confirm-legacy-retired"));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ready ? 0 : 2;
  }
} catch {
  console.log(JSON.stringify({ ready: false, reason: "live-ownership-unattested" }, null, 2));
  process.exitCode = 2;
}
