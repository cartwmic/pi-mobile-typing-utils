/**
 * bench/cache-hydrate-latency.ts — Measure warm-cache engine initialization latency.
 *
 * Phase 1 (cold): builds CorrectionEngine against an empty cache dir, letting
 * it write the binary index cache (unigrams + bigrams; schema v2).
 *
 * Phase 2 (warm × 10): constructs a new CorrectionEngine against the populated
 * cache dir and times initialize() end-to-end for 10 runs, reporting median.
 *
 * Breakdown note: this script measures the full initialize() wall time, which
 * includes file-stat + readFile I/O + binary deserialize. Separating I/O from
 * deserialization would require instrumenting index-cache.ts internals; the
 * whole-call measurement is the most actionable number.
 *
 * Prior baseline (unigram-only, schema v1):  ~189 ms on macOS at ED=4.
 * New baseline adds bigram serialization;  expect ~200–350 ms at ED=2 on macOS.
 *
 * Soft targets (informational, NOT CI gates):
 *   Cache hydration ≤ 500 ms on macOS
 *   Cache hydration ≤ 2 s on Termux
 *
 * Run:
 *   npx tsx bench/cache-hydrate-latency.ts
 *
 * Record results in NOTES.md under §19.6.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

/**
 * Poll the cache directory for the final symspell-*.bin file (i.e., the rename
 * step has completed). The cache write is fire-and-forget; without this poll
 * Phase 2's first runs see the *.tmp file (or nothing) and miss the cache,
 * producing misleading wall-time numbers.
 */
async function waitForCacheWrite(cacheDir: string, timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const files = await readdir(cacheDir);
      if (files.some((f) => /^symspell-[0-9a-f]{16}\.bin$/.test(f))) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const TECH_DICT_PATH = fileURLToPath(
  new URL("../data/tech-dictionary.txt", import.meta.url),
);

function formatMs(ns: bigint): string {
  return `${(Number(ns) / 1_000_000).toFixed(1)} ms`;
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

async function timeInitialize(
  techDictPath: string,
  cacheDir: string,
): Promise<bigint> {
  // Each call imports fresh via a cache-busted URL trick is not possible in
  // Node module cache — but we want a NEW engine instance each time. The module
  // cache keeps the same CorrectionEngine class, which is fine: each `new` call
  // allocates a fresh instance. The SymSpell instance is constructed inside
  // initialize(), so each run is a genuine cold-construct + cache-load.
  const { CorrectionEngine } = await import("../src/correction-engine.js");
  const engine = new CorrectionEngine({
    techDictPath,
    isLearned: () => false,
    maxEditDistance: 2,
  });
  const t0 = process.hrtime.bigint();
  await engine.initialize();
  return process.hrtime.bigint() - t0;
}

async function main() {
  console.log("## Cache hydration latency benchmark\n");
  console.log(
    "Prior unigram-only baseline (schema v1): ~189 ms on macOS at ED=4.\n" +
    "Schema v2 adds bigrams; expect slightly higher (200–350 ms at ED=2).\n",
  );

  const tempDir = await mkdtemp(join(tmpdir(), "pi-bench-cache-"));
  process.env.MOBILE_AUTOCORRECT_CACHE_DIR = tempDir;

  try {
    // ── Phase 1: cold build + cache write ────────────────────────────────────
    console.log("Phase 1: cold build (cache miss + write)…");
    const coldNs = await timeInitialize(TECH_DICT_PATH, tempDir);
    console.log(`  Cold build time: ${formatMs(coldNs)}`);

    // Cache write is fire-and-forget; wait for the .tmp → .bin rename to flush.
    console.log("  Waiting for cache write to flush…");
    const flushed = await waitForCacheWrite(tempDir);
    if (!flushed) {
      console.warn("  ⚠ Cache file did not appear within 30s; warm runs will miss cache.");
    } else {
      console.log("  Cache file flushed to disk.\n");
    }

    // ── Phase 2: warm cache × 10 ─────────────────────────────────────────────
    console.log("Phase 2: warm-cache hydration × 10 runs…");
    const warmMs: number[] = [];

    for (let i = 0; i < 10; i++) {
      const ns = await timeInitialize(TECH_DICT_PATH, tempDir);
      const ms = Number(ns) / 1_000_000;
      warmMs.push(ms);
      process.stdout.write(`  Run ${i + 1}: ${ms.toFixed(1)} ms\n`);
    }

    const med = median(warmMs);
    const min = Math.min(...warmMs);
    const max = Math.max(...warmMs);

    console.log("\n--- Results ---");
    console.table([
      {
        Metric: "Cold build (cache miss)",
        "Time (ms)": (Number(coldNs) / 1_000_000).toFixed(1),
        "Target": "—",
      },
      {
        Metric: "Warm cache median",
        "Time (ms)": med.toFixed(1),
        "Target": "≤ 500 ms macOS / ≤ 2000 ms Termux",
      },
      {
        Metric: "Warm cache min",
        "Time (ms)": min.toFixed(1),
        "Target": "—",
      },
      {
        Metric: "Warm cache max",
        "Time (ms)": max.toFixed(1),
        "Target": "—",
      },
    ]);

    if (med > 500) {
      console.warn(`\n⚠ Warm-cache median (${med.toFixed(1)} ms) exceeds macOS soft target of 500 ms.`);
    } else {
      console.log(`\n✓ Warm-cache median (${med.toFixed(1)} ms) within macOS soft target.`);
    }

    console.log("\nRecord results in NOTES.md under §19.6.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
