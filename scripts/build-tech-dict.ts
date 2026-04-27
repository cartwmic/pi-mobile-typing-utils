import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

type DictionaryDefinition = {
  path: string;
};

type CSpellExtension = {
  dictionaryDefinitions?: DictionaryDefinition[];
};

const require = createRequire(import.meta.url);

const PACKAGES = [
  "@cspell/dict-software-terms",
  "@cspell/dict-typescript",
  "@cspell/dict-node",
  "@cspell/dict-python",
  "@cspell/dict-k8s",
] as const;

const MIN_WORD_COUNT = 15_000;
const MAX_WORD_COUNT = 30_000;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_PATH = resolve(PROJECT_ROOT, "data/tech-dictionary.txt");

// These pinned cspell package versions were inspected to ensure they ship text
// dictionaries (.txt / .txt.gz). If a future upgrade switches a package to only
// .trie.gz assets, this script should fail fast because trie files need a
// different parser and Batch 2 intentionally relies on plain text word lists.
function parseJsonc<T>(source: string): T {
  return new Function(`return (${source});`)() as T;
}

function readDictionaryFile(path: string): string {
  const buffer = readFileSync(path);

  if (path.endsWith(".txt.gz")) {
    return gunzipSync(buffer).toString("utf8");
  }

  if (path.endsWith(".txt")) {
    return buffer.toString("utf8");
  }

  if (path.endsWith(".trie.gz")) {
    throw new Error(
      `Unsupported trie dictionary at ${path}. Pick a package/version that ships .txt or .txt.gz instead.`,
    );
  }

  throw new Error(`Unsupported dictionary format at ${path}. Only .txt and .txt.gz are supported.`);
}

function resolveDictionaryPaths(packageName: string): string[] {
  const extensionPath = require.resolve(packageName);
  const packageDir = dirname(extensionPath);
  const extension = parseJsonc<CSpellExtension>(readFileSync(extensionPath, "utf8"));
  const definitions = extension.dictionaryDefinitions ?? [];

  if (definitions.length === 0) {
    throw new Error(`No dictionaryDefinitions found in ${extensionPath}.`);
  }

  return definitions.map((definition) => resolve(packageDir, definition.path));
}

function main(): void {
  const allWords = new Set<string>();
  const packageSummaries: string[] = [];

  for (const packageName of PACKAGES) {
    const dictionaryPaths = resolveDictionaryPaths(packageName);
    let addedByPackage = 0;

    for (const dictionaryPath of dictionaryPaths) {
      const content = readDictionaryFile(dictionaryPath);

      for (const rawLine of content.split(/\r?\n/)) {
        const word = rawLine.trim();
        if (!word || word.startsWith("#")) {
          continue;
        }

        const normalizedWord = word.toLowerCase();
        const previousSize = allWords.size;
        allWords.add(normalizedWord);
        if (allWords.size > previousSize) {
          addedByPackage += 1;
        }
      }
    }

    packageSummaries.push(`${packageName}: ${addedByPackage} unique words added`);
  }

  const sortedWords = Array.from(allWords).sort();
  const wordCount = sortedWords.length;

  if (wordCount < MIN_WORD_COUNT || wordCount > MAX_WORD_COUNT) {
    throw new Error(
      `Tech dictionary word count ${wordCount} is outside the expected ${MIN_WORD_COUNT}-${MAX_WORD_COUNT} range.`,
    );
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${sortedWords.join("\n")}\n`, "utf8");

  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`Tech dictionary word count: ${wordCount}`);
  for (const summary of packageSummaries) {
    console.log(`- ${summary}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
}
