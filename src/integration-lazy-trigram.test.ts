/**
 * integration-lazy-trigram.test.ts
 *
 * Integration tests for the lazy trigram attach mechanism (§8.5):
 *
 *   1. The engine reaches "ready" before the trigram table is attached.
 *   2. During the lazy window (table not yet attached), all trigram scores are
 *      exactly 0 (Case A: strict no-op — distinct from Case B where the table is
 *      attached but has no entry for the context, which produces a backoff score).
 *   3. After the table is attached, the trigram tier contributes to scoring:
 *      candidates with a direct hit receive a positive score, while candidates
 *      that fall through to backoff receive a negative score.
 *
 * ## Approach (Option ii from task §13.4)
 *
 * Rather than mocking TrigramTable.loadFromTsv to simulate a slow load, this test
 * uses the singleton accessor in isolation: the shared engine is initialized without
 * a MOBILE_AUTOCORRECT_CACHE_DIR that contains a valid TSV, so the process-wide
 * singleton is either skipped (getCacheDir() returns null) or fails silently
 * (TSV file not found). In either case, engine.rerank.trigramTable starts as null.
 *
 * The trigram table is then attached manually via engine.rerank.attachTrigramTable()
 * after a controlled delay (simulated by the test steps), allowing before/after
 * comparisons without any real file I/O.
 *
 * ## Score arithmetic (for reference)
 *
 * With the mock table supplying count("we","have","the")=100 000 and prefix=100:
 *   S("the"|"we","have") = 100 000 / 100 = 1 000
 *   trigram("the")  = α₂ · log10(1 000) = 0.3 · 3 = +0.9
 *   trigram("to")   ≈ α₂ · log10(0.4 · bigramRawProb("to"))
 *                   ≤ 0.3 · log10(0.4) ≈ −0.12
 *
 * The +1.02-unit swing for "the" outweighs any realistic bigram advantage
 * "have to" might have over "have the" in the SymSpell corpus (< 0.5 log units).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Verbosity } from "symspell-ts";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { CorrectionEngine } from "./correction-engine.js";
import { TrigramTable, __resetTrigramSingletonForTests } from "./trigram-table.js";

// ─── Shared engine (cold-start once per file) ─────────────────────────────────

let tempDir = "";
let engine: CorrectionEngine;

describe("lazy-trigram integration", () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "integration-lazy-trigram-"));
    const techDictPath = join(tempDir, "tech.txt");
    writeFileSync(techDictPath, "", "utf8");

    // Isolate the cache dir so the engine uses a fresh directory.
    // The trigram TSV does not exist at data/trigram-top500k.tsv in the test
    // environment (task 3.2 not yet complete), so the singleton either
    //   (a) is skipped entirely when cacheDir is null, or
    //   (b) resolves to null after a failed TSV read.
    // Either way, rerank.trigramTable starts as null after initialize().
    vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", join(tempDir, "cache"));
    const { __resetCacheDisabledForTests } = await import("./index-cache.js");
    __resetCacheDisabledForTests();

    engine = new CorrectionEngine({
      techDictPath,
      isLearned: () => false,
    });
    await engine.initialize();

    // Wait a short moment for the fire-and-forget lazy-attach promise to settle
    // (it will fail/resolve to null because the TSV doesn't exist). This prevents
    // the pending promise from interfering with subsequent test-controlled attaches.
    await new Promise((r) => setTimeout(r, 50));
  }, 60_000);

  afterAll(async () => {
    __resetTrigramSingletonForTests();
    vi.unstubAllEnvs();
    const { __resetCacheDisabledForTests } = await import("./index-cache.js");
    __resetCacheDisabledForTests();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    __resetTrigramSingletonForTests();
    // Detach any trigram table left by a previous test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).rerank?.attachTrigramTable(null);
  });

  afterEach(() => {
    __resetTrigramSingletonForTests();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).rerank?.attachTrigramTable(null);
    vi.restoreAllMocks();
  });

  // ── 1. Engine reaches "ready" before trigram is attached ──────────────────────
  //
  // initialize() sets readinessState to "ready" and then fires the lazy-attach
  // as a fire-and-forget promise. The engine must be "ready" immediately after
  // initialize() resolves, regardless of whether the trigram load has settled.

  test("engine reaches 'ready' immediately after initialize(); trigram table is null", () => {
    expect(engine.getReadinessState()).toBe("ready");

    // The trigram table is null because the TSV file does not exist in the test
    // environment and the fire-and-forget load fails (or was skipped).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).rerank?.trigramTable).toBeNull();
  });

  // ── 2. All trigram scores are exactly 0 during the lazy window (Case A) ───────
  //
  // When trigramTable is null, the scoring code takes the Case A path:
  //   "STRICT NO-OP: contribution is exactly 0"
  // This is distinct from Case B (table attached, no entry → backoff → negative).
  //
  // Verified by calling NgramRerankModule.rerank() directly so we can inspect the
  // scoresPerCandidate breakdown without going through shouldCorrect().

  test("all trigram scores are 0 during lazy window (Case A: table is null)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rerankModule = (engine as any).rerank;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const symspell = (engine as any).symspell;

    // trigramTable must be null for this assertion to be meaningful.
    expect(rerankModule.trigramTable).toBeNull();

    // Use the real SymSpell lookup so we have real candidates and bigram data.
    const candidates = symspell.lookup("te", Verbosity.All, 1) as Array<{
      term: string;
      distance: number;
      count: number;
    }>;
    expect(candidates.length).toBeGreaterThan(0);

    // Provide full context (prevPrev + prev) so the scoring path — not the bypass —
    // is exercised. With trigramTable null, Case A fires for all candidates.
    const { scoresPerCandidate } = rerankModule.rerank("te", candidates, {
      prev: "have",
      prevPrev: "we",
    }) as { winner: unknown; scoresPerCandidate: Array<{ term: string; scores: { trigram: number } }> };

    expect(scoresPerCandidate.length).toBeGreaterThan(0);
    for (const entry of scoresPerCandidate) {
      expect(entry.scores.trigram).toBe(0);
    }
  });

  // ── 3. After attach: trigram tier contributes; "the" gets a direct-hit score ───
  //
  // After attaching a mock TrigramTable biased toward ("we","have","the"):
  //   - "the"'s trigram score becomes +0.9 (direct hit at count=100 000, prefix=100)
  //   - "to"'s trigram score becomes negative (backoff through the chain)
  //
  // This proves Case B fires and differs from Case A (where both would be 0).

  test("after attach: 'the' gets positive trigram score; backoff candidates get negative score", () => {
    // Build a TrigramTable directly using the SEP constant (\x01).
    const SEP = "\x01";
    const mockTable = new TrigramTable(
      new Map([[`we${SEP}have${SEP}the`, 100_000]]),
      new Map([[`we${SEP}have`, 100]]),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rerankModule = (engine as any).rerank;
    rerankModule.attachTrigramTable(mockTable);
    expect(rerankModule.trigramTable).not.toBeNull();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const symspell = (engine as any).symspell;
    const candidates = symspell.lookup("te", Verbosity.All, 1) as Array<{
      term: string;
      distance: number;
      count: number;
    }>;

    const { scoresPerCandidate } = rerankModule.rerank("te", candidates, {
      prev: "have",
      prevPrev: "we",
    }) as {
      winner: { term: string } | null;
      scoresPerCandidate: Array<{ term: string; scores: { trigram: number; total: number } }>;
    };

    // "the" must have a direct trigram hit → positive trigram score.
    const theEntry = scoresPerCandidate.find((e) => e.term === "the");
    expect(theEntry).toBeDefined();
    expect(theEntry!.scores.trigram).toBeGreaterThan(0);

    // At least one other candidate takes the backoff path → negative trigram score.
    const backoffCandidates = scoresPerCandidate.filter(
      (e) => e.term !== "the" && e.scores.trigram < 0,
    );
    expect(backoffCandidates.length).toBeGreaterThan(0);
  });

  // ── 4. After attach: winner changes relative to Case A baseline ────────────────
  //
  // With the mock trigram strongly biasing "the" (+0.9 over backoff ≈ −0.12),
  // "the" should win the full head-to-head even if bigrams slightly favor "to".
  //
  // NOTE: The pre-attach winner is NOT asserted because it depends on the real
  // SymSpell bigram corpus (the race between "have to" and "have the" bigrams).
  // The post-attach assertion is the meaningful regression signal.

  test("after attach: shouldCorrect returns 'the' for 'te' when trigram biases (we,have,the)", () => {
    const SEP = "\x01";
    const mockTable = new TrigramTable(
      new Map([[`we${SEP}have${SEP}the`, 100_000]]),
      new Map([[`we${SEP}have`, 100]]),
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).rerank.attachTrigramTable(mockTable);

    const result = engine.shouldCorrect("te", { prev: "have", prevPrev: "we" });

    expect(result.corrected).toBe(true);
    if (result.corrected) {
      expect(result.suggestion).toBe("the");
      expect(result.kind).toBe("lookup");
    }
  });

  // ── 5. Before/after contrast: score changes prove trigram contribution ─────────
  //
  // Compare raw rerank scores for "the" before and after attaching the trigram table.
  // Before: trigram("the") === 0 (Case A)
  // After:  trigram("the") > 0 (direct hit)
  // This monotonicity property is documented in design.md: post-attach scores
  // for candidates WITH a direct hit increase, those without can only decrease.

  test("before/after: trigram score for 'the' increases from 0 (Case A) to positive (direct hit)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rerankModule = (engine as any).rerank;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const symspell = (engine as any).symspell;

    const candidates = symspell.lookup("te", Verbosity.All, 1) as Array<{
      term: string;
      distance: number;
      count: number;
    }>;
    const ctx = { prev: "have", prevPrev: "we" };

    // Before attach (Case A): trigram score for "the" is exactly 0.
    expect(rerankModule.trigramTable).toBeNull();
    const beforeResult = rerankModule.rerank("te", candidates, ctx) as {
      scoresPerCandidate: Array<{ term: string; scores: { trigram: number } }>;
    };
    const theScoreBefore = beforeResult.scoresPerCandidate.find((e) => e.term === "the");
    expect(theScoreBefore?.scores.trigram).toBe(0);

    // Attach the mock trigram table.
    const SEP = "\x01";
    const mockTable = new TrigramTable(
      new Map([[`we${SEP}have${SEP}the`, 100_000]]),
      new Map([[`we${SEP}have`, 100]]),
    );
    rerankModule.attachTrigramTable(mockTable);

    // After attach: trigram score for "the" is positive (direct hit).
    const afterResult = rerankModule.rerank("te", candidates, ctx) as {
      scoresPerCandidate: Array<{ term: string; scores: { trigram: number } }>;
    };
    const theScoreAfter = afterResult.scoresPerCandidate.find((e) => e.term === "the");
    expect(theScoreAfter?.scores.trigram).toBeGreaterThan(0);

    // Monotonicity: the score increased.
    expect(theScoreAfter!.scores.trigram).toBeGreaterThan(theScoreBefore!.scores.trigram);
  });
});
