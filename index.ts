import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { createTyposCommand, prewarmEngine } from "./src/commands.js";
import { Config } from "./src/config.js";
import { LearnedDictionary } from "./src/learned-dictionary.js";

// Native ESM runtime code must resolve packaged assets via import.meta.url.
// __dirname is not available in compiled ESM output.
// `index.ts` lives at the repo root, so `data/` is a sibling, not a parent.
export const TECH_DICTIONARY_PATH = fileURLToPath(
  new URL("./data/tech-dictionary.txt", import.meta.url),
);

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

  // Pre-warm the engine when the configured default mode is "on" so that
  // initialization is already in flight before session_start fires. The call
  // is non-blocking; errors are silently captured (the engine's readinessState
  // transitions to "degraded" and enable() handles that on first call).
  const prewarm =
    config.getDefaultMode() === "on"
      ? prewarmEngine({ techDictPath: TECH_DICTIONARY_PATH, learnedDictionary, config })
      : undefined;

  const typosCommand = createTyposCommand({
    learnedDictionary,
    techDictPath: TECH_DICTIONARY_PATH,
    config,
    prewarm,
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
