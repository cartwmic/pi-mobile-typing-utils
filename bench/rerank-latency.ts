/**
 * bench/rerank-latency.ts — Measure shouldCorrect() latency with context rerank enabled.
 *
 * Builds a real CorrectionEngine with the bundled SymSpell dictionaries (bigrams
 * included) and drives 10,000 token+ctx pairs across token-length buckets.
 * Reports p50 / p95 / p99 wall time (µs) per bucket.
 *
 * Soft target (informational, NOT a CI gate): p95 ≤ 2.0 ms on macOS.
 * Termux numbers are typically 3–10× higher and are recorded manually in NOTES.md.
 *
 * Run:
 *   npx tsx bench/rerank-latency.ts
 *
 * For tighter heap numbers add --expose-gc:
 *   node --expose-gc $(which tsx) bench/rerank-latency.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const TECH_DICT_PATH = fileURLToPath(
  new URL("../data/tech-dictionary.txt", import.meta.url),
);

// Token fixtures by length bucket.  Each entry is [token, prevWord].
// Using common English words / plausible typos so SymSpell returns real candidates.
const BUCKETS: Record<number, [string, string][]> = {
  3: [
    ["teh", "fix"], ["hte", "and"], ["adn", "is"], ["tje", "the"],
    ["fot", "out"], ["ot", "go"], ["fo", "is"], ["seh", "and"],
    ["hwo", "is"], ["woh", "who"],
  ],
  5: [
    ["thier", "check"], ["recieve", "please"], ["accout", "bank"],
    ["ocurr", "might"], ["befor", "the"], ["simpl", "a"], ["writng", "start"],
    ["abotu", "think"], ["hwich", "know"], ["fromt", "away"],
  ],
  7: [
    ["recieved", "just"], ["beleived", "never"], ["definately", "this"],
    ["occured", "what"], ["begining", "at"], ["existance", "no"],
    ["acheived", "we"], ["arguement", "strong"], ["seperate", "keep"],
    ["relevent", "very"],
  ],
  10: [
    ["accesories", "buying"], ["accomodation", "book"], ["addreses", "check"],
    ["permananet", "make"], ["convienient", "very"], ["interupt", "do"],
    ["necesary", "is"], ["embarased", "feeling"], ["noticable", "quite"],
    ["occassion", "special"],
  ],
  15: [
    ["demonstartion", "live"], ["comprehensible", "easily"], ["misunderstaning", "clear"],
    ["accomodating", "quite"], ["internationla", "the"], ["entrepreneural", "an"],
    ["unconventionel", "very"], ["representtaion", "visual"], ["transformaion", "complete"],
    ["correspondance", "email"],
  ],
};

const RUNS_PER_FIXTURE = 1000; // each fixture repeated to reach ~10k total per bucket

function percentile(sorted: number[], p: number): number {
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

async function main() {
  console.log("## Rerank latency benchmark\n");
  console.log("Building CorrectionEngine with bundled dicts (bigrams included)…");

  const tempDir = await mkdtemp(join(tmpdir(), "pi-bench-rerank-"));
  process.env.MOBILE_AUTOCORRECT_CACHE_DIR = tempDir;

  try {
    const { CorrectionEngine } = await import("../src/correction-engine.js");

    const engine = new CorrectionEngine({
      techDictPath: TECH_DICT_PATH,
      isLearned: () => false,
      maxEditDistance: 2,
      getEnableContextRerank: () => true,
    });
    await engine.initialize();

    console.log("Engine ready. Running latency measurements…\n");
    // Soft target note
    console.log("Soft target: p95 ≤ 2.0 ms on macOS (informational, not a CI gate).\n");

    const rows: Array<{
      "Length bucket": number;
      "Samples": number;
      "p50 (µs)": string;
      "p95 (µs)": string;
      "p99 (µs)": string;
    }> = [];

    for (const [bucketKey, fixtures] of Object.entries(BUCKETS)) {
      const length = Number(bucketKey);
      const latencies: number[] = [];

      for (const [token, prev] of fixtures) {
        for (let i = 0; i < RUNS_PER_FIXTURE; i++) {
          const t0 = process.hrtime.bigint();
          engine.shouldCorrect(token, { prev });
          const t1 = process.hrtime.bigint();
          latencies.push(Number(t1 - t0) / 1_000); // ns → µs
        }
      }

      latencies.sort((a, b) => a - b);

      rows.push({
        "Length bucket": length,
        "Samples": latencies.length,
        "p50 (µs)": percentile(latencies, 50).toFixed(1),
        "p95 (µs)": percentile(latencies, 95).toFixed(1),
        "p99 (µs)": percentile(latencies, 99).toFixed(1),
      });
    }

    console.table(rows);
    console.log("\nNote: 1 ms = 1000 µs.  Soft target: p95 ≤ 2000 µs on macOS.");
    console.log("Termux/phone times are typically 3–10× higher.");
    console.log("Record results in NOTES.md under §19.6.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
