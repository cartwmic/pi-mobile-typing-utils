/**
 * bench/unigram-vs-full-dict-parity.ts — Verify that unigram-only and full
 * (with bigrams) dictionary paths return identical shouldCorrect() results
 * across the cache-fidelity corpus.
 *
 * Builds two engines:
 *  - Default path: unigram-only loader (resolveSymspellPackageRoot succeeds).
 *  - Fallback path: upstream loadDefaultDictionaries (bigrams loaded as side
 *    effect), forced by injecting `_resolveSymspellPackageRoot: () => null`.
 *
 * Any divergent results are printed. There should be zero.
 *
 * Run: npx tsx bench/unigram-vs-full-dict-parity.ts
 */

import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TECH_DICT_PATH = fileURLToPath(
  new URL("../data/tech-dictionary.txt", import.meta.url),
);
const CORPUS_PATH = fileURLToPath(
  new URL("../tests/fixtures/cache-fidelity-corpus.txt", import.meta.url),
);

async function main() {
  console.log("## Unigram-only vs full-dict (bigrams) parity check\n");
  console.log(`Corpus: ${CORPUS_PATH}\n`);

  const corpusText = await readFile(CORPUS_PATH, "utf8");
  const words = corpusText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  console.log(`Corpus size: ${words.length} words\n`);

  // Build unigram-only engine (default path).
  const unigramCacheDir = await mkdtemp(join(tmpdir(), "pi-bench-unigram-"));
  // Build full-dict engine (fallback path: resolver returns null → loadDefaultDictionaries).
  const fullCacheDir = await mkdtemp(join(tmpdir(), "pi-bench-full-"));

  try {
    process.env.MOBILE_AUTOCORRECT_CACHE_DIR = unigramCacheDir;
    const { __resetCacheDisabledForTests } = await import("../src/index-cache.js");
    __resetCacheDisabledForTests();
    const { CorrectionEngine } = await import("../src/correction-engine.js");

    const unigramEngine = new CorrectionEngine({
      techDictPath: TECH_DICT_PATH,
      isLearned: () => false,
      maxEditDistance: 2,
    });
    await unigramEngine.initialize();
    console.log("Unigram-only engine: initialized");

    process.env.MOBILE_AUTOCORRECT_CACHE_DIR = fullCacheDir;
    __resetCacheDisabledForTests();

    const fullEngine = new CorrectionEngine({
      techDictPath: TECH_DICT_PATH,
      isLearned: () => false,
      maxEditDistance: 2,
      _resolveSymspellPackageRoot: () => null, // force fallback path
    });
    await fullEngine.initialize();
    console.log("Full-dict engine (bigrams loaded): initialized\n");

    let divergences = 0;
    for (const word of words) {
      const unigramResult = unigramEngine.shouldCorrect(word);
      const fullResult = fullEngine.shouldCorrect(word);

      const unigramStr = unigramResult.corrected ? unigramResult.suggestion : "(no correction)";
      const fullStr = fullResult.corrected ? fullResult.suggestion : "(no correction)";

      if (unigramStr !== fullStr) {
        console.log(`DIVERGENCE: "${word}" → unigram="${unigramStr}" vs full="${fullStr}"`);
        divergences++;
      }
    }

    if (divergences === 0) {
      console.log(`✓ All ${words.length} corpus words: identical results between unigram-only and full-dict engines.`);
    } else {
      console.log(`\n✗ ${divergences} divergence(s) found.`);
      process.exit(1);
    }
  } finally {
    await rm(unigramCacheDir, { recursive: true, force: true });
    await rm(fullCacheDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
