/**
 * bench/memory-residency.ts — Measure engine + trigram-table resident memory.
 *
 * Builds a CorrectionEngine, awaits ready, awaits the trigram lazy-attach
 * (if data/trigram-top500k.tsv exists), settles 10 seconds for GC to stabilize,
 * then reports process.memoryUsage().
 *
 * Soft targets (informational, NOT CI gates):
 *   rss delta over empty Node process ≤ 150 MB on macOS
 *   rss delta over empty Node process ≤ 100 MB on Termux
 *
 * For tighter measurements, run with --expose-gc so global.gc() is available:
 *   node --expose-gc $(which tsx) bench/memory-residency.ts
 *
 * Record results in NOTES.md under §19.5.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const TECH_DICT_PATH = fileURLToPath(
  new URL("../data/tech-dictionary.txt", import.meta.url),
);
const TRIGRAM_TSV_PATH = fileURLToPath(
  new URL("../data/trigram-top500k.tsv", import.meta.url),
);

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function settle(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("## Memory residency benchmark\n");

  const trigramPresent = existsSync(TRIGRAM_TSV_PATH);
  if (!trigramPresent) {
    console.warn(
      "⚠ data/trigram-top500k.tsv is not present (§16.2 deferred).\n" +
      "  Trigram lazy-attach will not fire. Results reflect bigram-only residency.\n",
    );
  }

  // Baseline: memory before any engine construction.
  if (typeof global.gc === "function") global.gc();
  const baselineRss = process.memoryUsage().rss;
  const baselineHeap = process.memoryUsage().heapUsed;

  console.log(`Baseline RSS:  ${formatMB(baselineRss)}`);
  console.log(`Baseline heap: ${formatMB(baselineHeap)}`);
  console.log("\nBuilding CorrectionEngine (bigrams included)…");

  const tempDir = await mkdtemp(join(tmpdir(), "pi-bench-mem-"));
  process.env.MOBILE_AUTOCORRECT_CACHE_DIR = tempDir;

  try {
    const { CorrectionEngine } = await import("../src/correction-engine.js");
    const { getTrigramTableSingleton } = await import("../src/trigram-table.js");

    const engine = new CorrectionEngine({
      techDictPath: TECH_DICT_PATH,
      isLearned: () => false,
      maxEditDistance: 2,
      getEnableContextRerank: () => true,
      getEnableSegmentation: () => true,
    });
    await engine.initialize();
    console.log("Engine ready.");

    if (trigramPresent) {
      console.log("Awaiting trigram lazy-attach…");
      await getTrigramTableSingleton({
        cacheDir: tempDir,
        tsvPath: TRIGRAM_TSV_PATH,
      });
      console.log("Trigram attach complete.");
    }

    // Settle 10 s so GC can stabilize allocations.
    console.log("\nSettling 10 seconds for GC…");
    await settle(10_000);

    if (typeof global.gc === "function") {
      global.gc();
      console.log("global.gc() called.");
    } else {
      console.log(
        "(--expose-gc not set; heap numbers may include GC-collectable allocations.)",
      );
    }

    const afterRss = process.memoryUsage().rss;
    const afterHeap = process.memoryUsage().heapUsed;
    const deltaRss = afterRss - baselineRss;
    const deltaHeap = afterHeap - baselineHeap;

    console.log("\n--- Results ---");
    console.table([
      {
        Metric: "RSS (after)",
        Value: formatMB(afterRss),
        Delta: formatMB(deltaRss),
        "macOS soft target": "≤ 150 MB delta",
        "Termux soft target": "≤ 100 MB delta",
      },
      {
        Metric: "Heap used (after)",
        Value: formatMB(afterHeap),
        Delta: formatMB(deltaHeap),
        "macOS soft target": "—",
        "Termux soft target": "—",
      },
    ]);

    if (deltaRss > 150 * 1024 * 1024) {
      console.warn(
        `\n⚠ RSS delta (${formatMB(deltaRss)}) exceeds macOS soft target of 150 MB.`,
      );
    } else {
      console.log(`\n✓ RSS delta (${formatMB(deltaRss)}) within macOS soft target.`);
    }

    console.log("\nRecord these results in NOTES.md under §19.5.");
    console.log("Trigram TSV present:", trigramPresent);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
