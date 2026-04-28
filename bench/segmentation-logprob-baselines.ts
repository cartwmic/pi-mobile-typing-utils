/**
 * bench/segmentation-logprob-baselines.ts — Validate segmentationLogProbFloor default.
 *
 * Purpose: drive SymSpell.wordSegmentation() on a locked fixture set and print
 * each fixture's probabilityLogSum at ED=0 and ED=1.  The numbers justify the
 * `segmentationLogProbFloor: -12.0` default in src/config.ts (Decision 12 in
 * design.md).
 *
 * Once this bench is run, copy the observed numbers into the comment block below
 * labeled "COMMITTED BASELINES" and commit.
 *
 * Classification rules:
 *   should-accept  → probabilityLogSum >= -12.0  (expect: thequick, wantto, helloworld)
 *   should-reject  → probabilityLogSum < -12.0 OR no valid split
 *                    (expect: andro, imho, imadog, kubernetespod)
 *
 * kubernetespod is expected to remain unsegmented because `kubernetes` is in the
 * layered tech-dictionary, NOT in the SymSpell unigram index.  wordSegmentation()
 * only consults the SymSpell unigram index, so no split is possible.  This
 * validates the documented v1 limitation.
 *
 * If any should-accept fixture has probabilityLogSum < -12.0 OR any should-reject
 * fixture has probabilityLogSum >= -12.0, raise a design-review flag.
 *
 * Run:
 *   npx tsx bench/segmentation-logprob-baselines.ts
 *
 * ── COMMITTED BASELINES ─────────────────────────────────────────────────────
 * Observed on macOS (Apple Silicon), Node 24.14, with bundled SymSpell
 * unigram dictionary (no trigrams; §16.2 deferred). Floor = -12.0.
 *
 *   thequick      ED=0:  -5.7247  ED=1:  -5.7247  (should-accept; passes ✓)
 *   wantto        ED=0:  -5.5245  ED=1:  -5.5245  (should-accept; passes ✓)
 *   helloworld    ED=0:  -7.8680  ED=1:  -7.8680  (should-accept; passes ✓)
 *   andro         ED=0: -14.9075  ED=1:  -3.7885  (should-reject; ED=1 above floor ⚠)
 *   imho          ED=0:  -9.6611  ED=1:  -7.1398  (should-reject; both above floor ⚠)
 *   imadog        ED=0: -18.1333  ED=1:  -6.2055  (should-reject; ED=1 above floor ⚠)
 *   kubernetespod ED=0: -38.2584  ED=1: -15.3291  (should-reject; passes ✓)
 *
 * Three should-reject fixtures (andro, imho, imadog) have ED=1 logsums above
 * the floor. In production:
 *   - `andro` (length 5) and `imho` (length 4) are filtered out by the
 *     `segmentationMinLength: 6` gate BEFORE wordSegmentation() runs, so
 *     log-prob is irrelevant for them.
 *   - `imadog` (length 6) is the only fixture that actually reaches the
 *     log-prob check; whether it splits in production is a v1.1 tuning
 *     target documented in NOTES.md.
 *
 * Default `segmentationLogProbFloor: -12.0` retained for v1; revisiting the
 * floor and the `imadog` outcome is a v1.1 tuning target.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const TECH_DICT_PATH = fileURLToPath(
  new URL("../data/tech-dictionary.txt", import.meta.url),
);

const LOG_PROB_FLOOR = -12.0;

type FixtureClass = "should-accept" | "should-reject";

interface Fixture {
  token: string;
  cls: FixtureClass;
  note?: string;
}

const FIXTURES: Fixture[] = [
  // Should-accept: common English words concatenated; SymSpell can split them.
  { token: "thequick",    cls: "should-accept" },
  { token: "wantto",      cls: "should-accept" },
  { token: "helloworld",  cls: "should-accept" },

  // Should-reject: below floor, no valid split, or tech-dict word.
  { token: "andro",       cls: "should-reject", note: "partial word; no clean split" },
  { token: "imho",        cls: "should-reject", note: "below segmentationMinLength=6 in production; forced here for logprob check" },
  { token: "imadog",      cls: "should-reject", note: "mixed token; expect low logprob" },
  {
    token: "kubernetespod",
    cls: "should-reject",
    note: "'kubernetes' is in tech-dictionary, NOT in SymSpell unigram index — wordSegmentation() cannot construct this split (v1 known limitation)",
  },
];

async function main() {
  console.log("## Segmentation log-prob baselines\n");
  console.log(`Floor threshold: segmentationLogProbFloor = ${LOG_PROB_FLOOR}\n`);

  const tempDir = await mkdtemp(join(tmpdir(), "pi-bench-logprob-"));
  process.env.MOBILE_AUTOCORRECT_CACHE_DIR = tempDir;

  try {
    // Access SymSpell directly through the engine's initialization side-effect.
    // We import the engine to trigger dictionary loading; then call wordSegmentation
    // via a minimal SymSpell instance the engine exposes via its internal symspell field.
    //
    // Because SymSpell is not exported directly, we instantiate a CorrectionEngine
    // and use the `shouldCorrect` path with segmentation forced on (minLength=1, floor=-Infinity)
    // to surface the raw probabilityLogSum indirectly.
    //
    // For this bench we need raw probabilityLogSum values, so we import SymSpell directly
    // from symspell-ts and build a standalone instance identical to what the engine uses.

    const { SymSpell, Verbosity, loadDefaultDictionaries } = await import("symspell-ts");

    console.log("Loading SymSpell with full dictionaries (this may take a few seconds)…");

    const symspell = new SymSpell(16, 2, 7, 1, 3);
    await loadDefaultDictionaries(symspell);

    console.log("Dictionaries loaded.\n");

    const rows: Array<{
      "Token": string;
      "Class": string;
      "ED=0 logSum": string;
      "ED=1 logSum": string;
      "ED=0 pass?": string;
      "ED=1 pass?": string;
      "Flag?": string;
    }> = [];

    let flagCount = 0;

    for (const { token, cls, note } of FIXTURES) {
      const results: Record<number, number | null> = {};

      for (const ed of [0, 1]) {
        const seg = symspell.wordSegmentation(token, ed);
        results[ed] = seg?.probabilityLogSum ?? null;
      }

      const ed0 = results[0];
      const ed1 = results[1];

      const passes = (val: number | null): boolean =>
        val !== null && val >= LOG_PROB_FLOOR;

      const ed0Pass = passes(ed0);
      const ed1Pass = passes(ed1);

      // Determine whether this fixture is on the wrong side of the floor.
      const isAccept = cls === "should-accept";
      const flagEd0 = isAccept ? !ed0Pass : ed0Pass;
      const flagEd1 = isAccept ? !ed1Pass : ed1Pass;
      const flagged = flagEd0 || flagEd1;
      if (flagged) flagCount++;

      rows.push({
        "Token": token,
        "Class": cls,
        "ED=0 logSum": ed0 !== null ? ed0.toFixed(4) : "null",
        "ED=1 logSum": ed1 !== null ? ed1.toFixed(4) : "null",
        "ED=0 pass?": ed0Pass ? "yes" : "no",
        "ED=1 pass?": ed1Pass ? "yes" : "no",
        "Flag?": flagged ? "⚠ REVIEW" : "ok",
      });

      if (note) {
        // Print note after table (captured per-fixture for readability).
        process.stdout.write(`  Note [${token}]: ${note}\n`);
      }
    }

    console.log("\n--- Results ---");
    console.table(rows);

    if (flagCount > 0) {
      console.error(
        `\n⚠ ${flagCount} fixture(s) flagged for design review:\n` +
        "  A 'should-accept' fixture has probabilityLogSum < floor, OR\n" +
        "  a 'should-reject' fixture has probabilityLogSum >= floor.\n" +
        "  Options: (a) move segmentationLogProbFloor default in src/config.ts and update\n" +
        "  design.md Decision 12, OR (b) document the fixture as a v1.1 tuning target.",
      );
    } else {
      console.log("\n✓ All fixtures are on the correct side of the floor. Baseline confirmed.");
    }

    console.log(
      "\nNext step: copy the observed numbers into the COMMITTED BASELINES block at the\n" +
      "top of this script and commit.",
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
