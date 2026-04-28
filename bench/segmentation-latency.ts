/**
 * bench/segmentation-latency.ts — Measure wordSegmentation() latency.
 *
 * Builds a CorrectionEngine (for access to the underlying SymSpell instance)
 * and drives wordSegmentation() on a corpus of 1,000 concatenated tokens.
 * Reports p50 / p95 / p99 wall time (µs).
 *
 * Soft target (informational, NOT a CI gate): p95 ≤ 10 ms on macOS.
 * Termux numbers are typically 3–10× higher and are recorded in NOTES.md.
 *
 * Run:
 *   npx tsx bench/segmentation-latency.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const TECH_DICT_PATH = fileURLToPath(
  new URL("../data/tech-dictionary.txt", import.meta.url),
);

// Fixture concatenated tokens — adjacent common English words joined together.
// Designed to exercise real segmentation paths (some accept, some reject).
const FIXTURES: string[] = [
  "thequick", "helloworld", "wantto", "outof", "asmuch", "goback",
  "cometrue", "lookout", "takeover", "makeshift", "breakdown", "turnover",
  "setback", "workout", "breakthrough", "standout", "pushback", "cutback",
  "feedback", "outlook", "outcome", "output", "overcome", "overlook",
  "overrun", "overture", "underway", "undertake", "underline", "understand",
  "background", "backward", "backtrack", "backstop", "backup", "backyard",
  "framework", "foreground", "foreword", "forward", "forthcoming", "forefront",
  "mainstream", "meanwhile", "moreover", "meanwhile", "nevertheless", "nonetheless",
  "otherwise", "somewhat", "somehow", "somewhere", "something", "sometimes",
  "somebody", "sometime", "somehow", "anyone", "anything", "anywhere",
  "everyone", "everything", "everywhere", "nothing", "nobody", "nowhere",
  "himself", "herself", "itself", "myself", "yourself", "themselves",
  "cannot", "cannot", "perhaps", "because", "before", "behind",
  "beside", "beyond", "between", "within", "without", "throughout",
  "although", "however", "therefore", "whether", "wherever", "whenever",
  "theyare", "weknow", "youcan", "hehas", "shewas", "itwas",
  "andthe", "ofthe", "inthe", "tothe", "forthe", "onthe",
  "withinthe", "fromthe", "bythe", "atthe", "asthe", "afterthe",
  "giveback", "giveup", "takedown", "lineup", "backup", "carryout",
];

// Repeat fixtures to reach ~1000 total calls.
function buildCorpus(): string[] {
  const corpus: string[] = [];
  while (corpus.length < 1000) {
    for (const f of FIXTURES) {
      corpus.push(f);
      if (corpus.length >= 1000) break;
    }
  }
  return corpus;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
}

async function main() {
  console.log("## Segmentation latency benchmark\n");
  console.log("Building CorrectionEngine…");

  const tempDir = await mkdtemp(join(tmpdir(), "pi-bench-seg-"));
  process.env.MOBILE_AUTOCORRECT_CACHE_DIR = tempDir;

  try {
    const { CorrectionEngine } = await import("../src/correction-engine.js");

    const engine = new CorrectionEngine({
      techDictPath: TECH_DICT_PATH,
      isLearned: () => false,
      maxEditDistance: 2,
      getEnableSegmentation: () => true,
      getSegmentationMinLength: () => 4, // lower min so all fixtures qualify
      getSegmentationMaxEditDistance: () => 1,
    });
    await engine.initialize();

    const corpus = buildCorpus();
    console.log(`Engine ready. Measuring wordSegmentation() over ${corpus.length} calls…\n`);
    console.log("Soft target: p95 ≤ 10 ms on macOS (informational, not a CI gate).\n");

    // Drive via shouldCorrect() with segmentation enabled (natural call path).
    // Each fixture is long enough to bypass the minWordLength gate.
    const latencies: number[] = [];

    for (const token of corpus) {
      const t0 = process.hrtime.bigint();
      engine.shouldCorrect(token, {});
      const t1 = process.hrtime.bigint();
      latencies.push(Number(t1 - t0) / 1_000); // ns → µs
    }

    latencies.sort((a, b) => a - b);

    console.table([
      {
        "Samples": latencies.length,
        "p50 (µs)": percentile(latencies, 50).toFixed(1),
        "p95 (µs)": percentile(latencies, 95).toFixed(1),
        "p99 (µs)": percentile(latencies, 99).toFixed(1),
        "p95 target": "≤ 10 000 µs",
      },
    ]);

    const p95 = percentile(latencies, 95);
    if (p95 > 10_000) {
      console.warn(
        `\n⚠ p95 (${(p95 / 1000).toFixed(1)} ms) exceeds soft target of 10 ms.`,
        "Investigate segmentation call count or ED setting.",
      );
    } else {
      console.log(`\n✓ p95 (${(p95 / 1000).toFixed(1)} ms) within soft target.`);
    }

    console.log("\nNote: 1 ms = 1000 µs.  Termux/phone times are typically 3–10× higher.");
    console.log("Record results in NOTES.md under §19.6.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
