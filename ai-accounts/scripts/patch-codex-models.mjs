#!/usr/bin/env node
// opencode-openai-codex-auth@4.4.0 rewrites every request's model through a hardcoded
// table that stops at gpt-5.2, so any newer slug silently becomes "gpt-5.1" — which the
// ChatGPT-account Codex backend now rejects. Pass clean slugs through untouched instead.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(
  here,
  "../node_modules/opencode-openai-codex-auth/dist/lib/request/request-transformer.js",
);

const MARKER = "/* ai-accounts: pass through live Codex slugs */";

const ANCHOR = `    const mappedModel = getNormalizedModel(modelId);
    if (mappedModel) {
        return mappedModel;
    }`;

const PATCH = `${ANCHOR}
    ${MARKER}
    if (/^gpt-[0-9]+(\\.[0-9]+)?(-[a-z0-9]+)*$/i.test(modelId)) {
        return modelId;
    }`;

const source = await readFile(target, "utf8");

if (source.includes("pass through live Codex slugs */")) {
  process.exit(0);
}

if (!source.includes(ANCHOR)) {
  console.error(`patch-codex-models: anchor not found in ${target}; skipping.`);
  process.exit(1);
}

await writeFile(target, source.replace(ANCHOR, PATCH), "utf8");
console.log("patch-codex-models: applied.");
