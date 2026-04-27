import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { createTyposCommand } from "./src/commands.js";
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

  const typosCommand = createTyposCommand({
    learnedDictionary,
    techDictPath: TECH_DICTIONARY_PATH,
  });

  pi.registerCommand("typos", {
    description: "Toggle mobile autocorrect (gboard-style word-by-word correction)",
    getArgumentCompletions: typosCommand.getArgumentCompletions,
    handler: typosCommand.handler,
  });
}
