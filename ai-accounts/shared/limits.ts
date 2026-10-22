// No imports here: OpenCode loads this file through opencode-plugin.ts from a checkout built with
// `npm ci --omit=dev`, where the Paseo plugin SDK and zod (dev dependencies) are not installed.

/** A window at or above this utilization is treated as blocked; the vendor refuses shortly before 100%. */
export const USABILITY_CEILING = 95;
