/**
 * bench/cache-load-time.ts — Compare fresh-build time vs cache-hit time.
 *
 * 1. Runs a fresh build (cache miss) and times it.
 * 2. Runs a second build against the same cache dir (cache hit) and times it.
 * 3. Reports both numbers.
 *
 * Run: npx tsx bench/cache-load-time.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TECH_DICT_PATH = fileURLToPath(
  new URL("../data/tech-dictionary.txt", import.meta.url),
);
const MAX_EDIT_DISTANCE = 2; // Default; change to test other values.

async function buildEngine(cacheDir: string): Promise<number> {
  process.env.MOBILE_AUTOCORRECT_CACHE_DIR = cacheDir;

  // Reset module-level cache state so each run re-probes the directory.
  const { __resetCacheDisabledForTests } = await import("../src/index-cache.js");
  __resetCacheDisabledForTests();

  const { CorrectionEngine } = await import("../src/correction-engine.js");

  const isLearned = (_word: string) => false;
  const start = performance.now();
  const engine = new CorrectionEngine({
    techDictPath: TECH_DICT_PATH,
    isLearned,
    maxEditDistance: MAX_EDIT_DISTANCE,
  });
  await engine.initialize();
  return performance.now() - start;
}

async function main() {
  console.log(`## Cache load-time benchmark (maxEditDistance=${MAX_EDIT_DISTANCE})\n`);

  const tempDir = await mkdtemp(join(tmpdir(), "pi-bench-cache-"));
  try {
    // Pass 1: cache miss (fresh build + cache write).
    const freshMs = await buildEngine(tempDir);
    console.log(`Fresh build (cache miss):  ${Math.round(freshMs)} ms`);

    // Pass 2: cache hit (load from disk).
    const hitMs = await buildEngine(tempDir);
    console.log(`Cache load  (cache hit):   ${Math.round(hitMs)} ms`);

    const speedup = freshMs / hitMs;
    console.log(`\nSpeedup: ~${speedup.toFixed(1)}× (cache hit vs fresh build)`);
    console.log("\nNote: fresh build time varies by hardware; cache load varies by disk speed.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
