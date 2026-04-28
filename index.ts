import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { createTyposCommand, prewarmEngine } from "./src/commands.js";
import { Config } from "./src/config.js";
import { getCacheDir } from "./src/index-cache.js";
import { LearnedDictionary } from "./src/learned-dictionary.js";
import { TelemetryWriter } from "./src/telemetry.js";

// Native ESM runtime code must resolve packaged assets via import.meta.url.
// __dirname is not available in compiled ESM output.
//
// Path resolution is layout-aware:
//  - When running from the repo's `index.ts` directly (the canonical
//    Pi-extension load path per package.json `pi.extensions`), `./data/...`
//    is a sibling of import.meta.url.
//  - When running from a compiled `dist/index.js` (e.g., a scenario harness
//    using `-e ./dist/index.js`, or a published-package layout), `./data/...`
//    resolves under `dist/`, which does not exist; we fall back to
//    `../data/...` to reach the repo-root `data/` directory.
function resolveDataAsset(relname: string): string {
  const sibling = fileURLToPath(new URL(`./data/${relname}`, import.meta.url));
  if (existsSync(sibling)) return sibling;
  return fileURLToPath(new URL(`../data/${relname}`, import.meta.url));
}

export const TECH_DICTIONARY_PATH = resolveDataAsset("tech-dictionary.txt");

export default async function (pi: ExtensionAPI): Promise<void> {
  const learnedDictionary = new LearnedDictionary({
    filePath:
      process.env.MOBILE_AUTOCORRECT_DICT_PATH ??
      join(homedir(), ".pi", "agent", "mobile-autocorrect-dictionary.json"),
  });

  await learnedDictionary.load();

  const config = new Config({
    filePath:
      process.env.MOBILE_AUTOCORRECT_CONFIG_PATH ??
      join(homedir(), ".pi", "agent", "mobile-autocorrect-config.json"),
  });

  await config.load();

  // §12.1: Instantiate TelemetryWriter once per process after config.load().
  // If getCacheDir() === null (cache disabled), telemetry is silently skipped.
  const cacheDir = getCacheDir();
  const telemetry = cacheDir
    ? new TelemetryWriter({ cacheDir, getLevel: () => config.getTelemetry() })
    : undefined;

  // Pre-warm the engine when the configured default mode is "on" so that
  // initialization is already in flight before session_start fires. The call
  // is non-blocking; errors are silently captured (the engine's readinessState
  // transitions to "degraded" and enable() handles that on first call).
  const prewarm =
    config.getDefaultMode() === "on"
      ? prewarmEngine({ techDictPath: TECH_DICTIONARY_PATH, learnedDictionary, config, telemetry })
      : undefined;

  const typosCommand = createTyposCommand({
    learnedDictionary,
    techDictPath: TECH_DICTIONARY_PATH,
    config,
    prewarm,
    telemetry,
    cacheDir: cacheDir ?? undefined,
  });

  pi.registerCommand("typos", {
    description: "Toggle mobile autocorrect (gboard-style word-by-word correction)",
    getArgumentCompletions: typosCommand.getArgumentCompletions,
    handler: typosCommand.handler,
  });

  // Reconcile session state with the configured default mode on every
  // session_start. Idempotent and silent when already in the desired state.
  pi.on("session_start", async (_event, ctx) => {
    await typosCommand.applyDefaultMode(ctx);
  });
}
