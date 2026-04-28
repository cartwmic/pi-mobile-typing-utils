/**
 * bench/format-size.ts — Report on-disk size of symspell-{key}.bin at each
 * maxEditDistance from 1 to 4.
 *
 * Each build uses a fresh temp directory. After building, we measure the .bin
 * file size.
 *
 * Run: npx tsx bench/format-size.ts
 */

import { readdir, stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TECH_DICT_PATH = fileURLToPath(
  new URL("../data/tech-dictionary.txt", import.meta.url),
);

async function buildAndMeasureSize(maxEditDistance: number): Promise<number> {
  const tempDir = await mkdtemp(join(tmpdir(), `pi-bench-fmt-ed${maxEditDistance}-`));
  try {
    process.env.MOBILE_AUTOCORRECT_CACHE_DIR = tempDir;

    const { __resetCacheDisabledForTests } = await import("../src/index-cache.js");
    __resetCacheDisabledForTests();

    const { CorrectionEngine } = await import("../src/correction-engine.js");
    const engine = new CorrectionEngine({
      techDictPath: TECH_DICT_PATH,
      isLearned: () => false,
      maxEditDistance,
    });
    await engine.initialize();

    // Allow the fire-and-forget cache write to complete.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const files = await readdir(tempDir);
    const binFiles = files.filter((f) => f.endsWith(".bin"));
    if (binFiles.length === 0) {
      return -1; // cache disabled or write failed
    }

    const { size } = await stat(join(tempDir, binFiles[0]!));
    return size;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  console.log("## Cache file size benchmark\n");
  console.log("| maxEditDistance | File size (MB) |");
  console.log("|-----------------|----------------|");

  for (let ed = 1; ed <= 4; ed++) {
    const bytes = await buildAndMeasureSize(ed);
    if (bytes < 0) {
      console.log(`| ${String(ed).padEnd(15)} | (cache disabled)   |`);
    } else {
      const mb = bytes / (1024 * 1024);
      console.log(`| ${String(ed).padEnd(15)} | ${mb.toFixed(1).padStart(14)} |`);
    }
  }

  console.log("\nDesign measurement: ~29.8 MB at ED=4 (binary with deduplicated string table).");
  console.log("Alternatives: JSON ~86 MB, JSON+gzip ~27 MB, binary-naive ~50 MB.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
