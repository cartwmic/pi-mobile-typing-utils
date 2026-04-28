/**
 * bench/build-time.ts — Measure CorrectionEngine build time and heap delta
 * at each maxEditDistance from 1 to 4.
 *
 * Each build uses a fresh temp directory so the cache cannot interfere.
 * Run: npx tsx bench/build-time.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Force cache to a fresh temp dir for each run so every build is a genuine
// cache-miss build (no stale cache from a prior bench run).
const TECH_DICT_PATH = fileURLToPath(
  new URL("../data/tech-dictionary.txt", import.meta.url),
);

async function buildOnce(maxEditDistance: number, cacheDir: string): Promise<{ wallMs: number; heapDeltaMB: number }> {
  // Set the cache dir env var so index-cache writes to our temp dir.
  process.env.MOBILE_AUTOCORRECT_CACHE_DIR = cacheDir;

  // Dynamically import the engine fresh (no module cache reuse between runs
  // because we're in the same process; use separate temp dirs to isolate
  // the on-disk cache).
  const { CorrectionEngine } = await import("../src/correction-engine.js");

  const isLearned = (_word: string) => false;

  // Force GC before measuring if available (Node --expose-gc flag).
  if (typeof global.gc === "function") global.gc();

  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();

  const engine = new CorrectionEngine({
    techDictPath: TECH_DICT_PATH,
    isLearned,
    maxEditDistance,
  });
  await engine.initialize();

  const wallMs = performance.now() - start;

  if (typeof global.gc === "function") global.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMB = (heapAfter - heapBefore) / (1024 * 1024);

  return { wallMs, heapDeltaMB };
}

async function main() {
  console.log("## Build-time benchmark\n");
  console.log("Each run uses a fresh temp cache dir (guaranteed cache miss).\n");
  console.log("| maxEditDistance | Wall time (ms) | Heap delta (MB) |");
  console.log("|-----------------|---------------|-----------------|");

  for (let ed = 1; ed <= 4; ed++) {
    const tempDir = await mkdtemp(join(tmpdir(), `pi-bench-ed${ed}-`));
    try {
      const { wallMs, heapDeltaMB } = await buildOnce(ed, tempDir);
      const sign = heapDeltaMB >= 0 ? "+" : "";
      console.log(
        `| ${String(ed).padEnd(15)} | ${Math.round(wallMs).toString().padStart(13)} | ${sign}${heapDeltaMB.toFixed(1).padStart(14)} |`,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  console.log("\nNote: numbers vary by hardware. Termux/phone times are typically 3–10× higher.");
  console.log("ED=4 lookups are ~7× slower than ED=1 (index build is the bottleneck shown here).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
