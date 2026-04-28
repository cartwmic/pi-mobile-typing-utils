/**
 * Tests for src/ngram-rerank.ts (Phase 4 — tasks 4.1–4.8)
 *
 * Mocking strategy:
 *   SymSpell is mocked as a plain object exposing only the fields the rerank
 *   module reads: `bigrams` (public) and `words` (private, accessed via cast).
 *   SymSpell.N is the real static class property (≈ 1.025e12) — its actual
 *   value matters for computing expected log-probabilities in math tests.
 *
 *   TrigramTable is mocked as a plain object implementing only
 *   `getTrigramCount` and `getBigramPrefixCount`.
 */

import { SymSpell, SuggestItem } from "symspell-ts";
import { describe, expect, test } from "vitest";
import {
  NgramRerankModule,
  MAX_RERANK_CANDIDATES,
  type RerankCorrectionContext,
  type NgramRerankModuleOptions,
} from "./ngram-rerank.js";
import type { TrigramTable } from "./trigram-table.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a SuggestItem.  Uses the real constructor so the object is a proper instance. */
function item(term: string, distance: number, count: number): SuggestItem {
  return new SuggestItem(term, distance, count);
}

/**
 * Build a minimal SymSpell mock.
 * The rerank module accesses:
 *   - symspell.bigrams  (public Map)
 *   - (symspell as any).words  (private Map, cast-accessed)
 *   - SymSpell.N  (static on the class, not the instance)
 */
function mockSymspell(
  words: Map<string, number>,
  bigrams: Map<string, number>,
): SymSpell {
  return { words, bigrams } as unknown as SymSpell;
}

/**
 * Build a minimal TrigramTable mock that returns specified counts.
 * Keys in the argument maps must use the '\x01' separator, e.g.
 * "i\x01want\x01to" for a trigram and "i\x01want" for a bigram prefix.
 */
function mockTrigramTable(
  trigramCounts: Record<string, number> = {},
  prefixCounts: Record<string, number> = {},
): TrigramTable {
  return {
    trigrams: new Map<string, number>(),
    bigramPrefixCounts: new Map<string, number>(),
    getTrigramCount(w1: string, w2: string, w3: string): number {
      return trigramCounts[`${w1}\x01${w2}\x01${w3}`] ?? 0;
    },
    getBigramPrefixCount(w1: string, w2: string): number {
      return prefixCounts[`${w1}\x01${w2}`] ?? 0;
    },
  } as unknown as TrigramTable;
}

/**
 * Build an NgramRerankModule with sensible defaults.
 * The caller can override any option via the `overrides` parameter.
 */
function makeModule(opts: {
  bigramWeight?: number;
  trigramWeight?: number;
  edPenalty?: number;
  enableContextRerank?: boolean;
  words?: Map<string, number>;
  bigrams?: Map<string, number>;
}): NgramRerankModule {
  const {
    bigramWeight = 0.5,
    trigramWeight = 0.3,
    edPenalty = 1.0,
    enableContextRerank = true,
    words = new Map<string, number>(),
    bigrams = new Map<string, number>(),
  } = opts;

  return new NgramRerankModule({
    getBigramWeight: () => bigramWeight,
    getTrigramWeight: () => trigramWeight,
    getEdPenalty: () => edPenalty,
    getEnableContextRerank: () => enableContextRerank,
    getSymspell: () => mockSymspell(words, bigrams),
  });
}

/** Real SymSpell.N (static class property). */
const N = SymSpell.N;

// ---------------------------------------------------------------------------
// §4.8 Test 1: Empty candidate list
// ---------------------------------------------------------------------------
describe("NgramRerankModule — empty candidate list", () => {
  test("winner is null and scoresPerCandidate is empty", () => {
    const module = makeModule({});
    const result = module.rerank("test", [], {});
    expect(result.winner).toBeNull();
    expect(result.scoresPerCandidate).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §4.8 Test 2: Single-candidate pass-through
// ---------------------------------------------------------------------------
describe("NgramRerankModule — single-candidate pass-through", () => {
  test("ctx empty → bypass: no scoring, returns candidates[0]", () => {
    const words = new Map([["the", 1_000_000]]);
    const module = makeModule({ words });
    const candidate = item("the", 1, 1_000_000);
    const result = module.rerank("teh", [candidate], {});
    // "teh".toLowerCase() = "teh" ≠ "the" → no identity suppression
    expect(result.winner).toEqual(candidate);
    expect(result.scoresPerCandidate).toHaveLength(0);
  });

  test("ctx with prev → scoring runs, scores are finite", () => {
    const words = new Map([["the", 1_000_000], ["want", 500_000]]);
    const bigrams = new Map([["want the", 20_000]]);
    const module = makeModule({ words, bigrams });
    const candidate = item("the", 1, 1_000_000);
    const result = module.rerank("teh", [candidate], { prev: "want" });
    // "teh".toLowerCase() = "teh" ≠ "the" → no suppression
    expect(result.winner).toEqual(candidate);
    expect(result.scoresPerCandidate).toHaveLength(1);
    const scores = result.scoresPerCandidate[0].scores;
    expect(Number.isFinite(scores.unigram)).toBe(true);
    expect(Number.isFinite(scores.bigram)).toBe(true);
    expect(Number.isFinite(scores.total)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §4.8 Test 3: Multi-candidate ranking
// ---------------------------------------------------------------------------
describe("NgramRerankModule — multi-candidate ranking", () => {
  test("picks candidate with highest combined score", () => {
    // "to" has far higher unigram count and a strong bigram with "want"
    const words = new Map([
      ["to", 1_000_000],
      ["ten", 100_000],
      ["want", 500_000],
    ]);
    const bigrams = new Map([
      ["want to", 50_000],
      ["want ten", 500],
    ]);
    const module = makeModule({ words, bigrams });
    const candidates = [
      item("to", 1, 1_000_000),
      item("ten", 1, 100_000),
    ];
    const result = module.rerank("te", candidates, { prev: "want" });
    expect(result.winner).not.toBeNull();
    expect(result.winner!.term).toBe("to");
    expect(result.scoresPerCandidate).toHaveLength(2);
  });

  test("ties broken by original ordering (first candidate wins)", () => {
    // Identical unigram counts, no bigrams → scores differ only by word identity.
    // Both have the same count so unigram scores are equal; first wins.
    const words = new Map([
      ["abc", 1_000],
      ["xyz", 1_000],
    ]);
    const module = makeModule({ words });
    const candidates = [item("abc", 1, 1_000), item("xyz", 1, 1_000)];
    const result = module.rerank("aXc", candidates, { prev: "some" });
    expect(result.winner!.term).toBe("abc");
  });

  test("multi-candidate with trigram table; highest trigram score wins", () => {
    const words = new Map([
      ["to", 500_000],
      ["the", 500_000],
      ["want", 400_000],
    ]);
    const bigrams = new Map([
      ["want to", 10_000],
      ["want the", 10_000], // equal bigram counts → trigram breaks the tie
    ]);
    const module = makeModule({ words, bigrams });
    // Attach a trigram table where "i want to" is far more common than "i want the"
    module.attachTrigramTable(
      mockTrigramTable(
        { "i\x01want\x01to": 8_000, "i\x01want\x01the": 100 },
        { "i\x01want": 10_000 },
      ),
    );
    const candidates = [item("to", 1, 500_000), item("the", 1, 500_000)];
    const result = module.rerank("te", candidates, { prev: "want", prevPrev: "i" });
    expect(result.winner!.term).toBe("to");
  });
});

// ---------------------------------------------------------------------------
// §4.8 Test 4: prev undefined, prevPrev undefined → bypass
// ---------------------------------------------------------------------------
describe("NgramRerankModule — line-start bypass (both context words absent)", () => {
  test("no scoring, returns candidates[0]", () => {
    const words = new Map([["the", 1_000_000]]);
    const module = makeModule({ words });
    const candidates = [item("the", 1, 1_000_000), item("tee", 1, 50_000)];
    const result = module.rerank("teh", candidates, { prev: undefined, prevPrev: undefined });
    expect(result.winner).toEqual(candidates[0]);
    expect(result.scoresPerCandidate).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §4.8 Test 5: prev defined, prevPrev undefined → bigram active, trigram = 0
// ---------------------------------------------------------------------------
describe("NgramRerankModule — second token (prevPrev absent)", () => {
  test("bigram tier active; trigram contribution is exactly 0", () => {
    const words = new Map([["to", 1_000_000], ["want", 500_000]]);
    const bigrams = new Map([["want to", 50_000]]);
    const module = makeModule({ words, bigrams });
    // Attach a non-null table to confirm the null-table guard is not what fires.
    module.attachTrigramTable(mockTrigramTable());

    const candidates = [item("to", 1, 1_000_000)];
    const result = module.rerank("te", candidates, { prev: "want", prevPrev: undefined });

    expect(result.scoresPerCandidate).toHaveLength(1);
    const scores = result.scoresPerCandidate[0].scores;
    expect(scores.trigram).toBe(0);
    // Bigram tier IS active (not zero).
    expect(scores.bigram).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §4.8 Test 6: trigramTable null → strict no-op (trigram contribution = 0)
// ---------------------------------------------------------------------------
describe("NgramRerankModule — trigramTable null (strict no-op)", () => {
  test("trigram contribution is exactly 0 when table has not been attached", () => {
    const words = new Map([["to", 1_000_000], ["want", 500_000]]);
    const bigrams = new Map([["want to", 50_000]]);
    const module = makeModule({ words, bigrams });
    // trigramTable is null by default (not attached)

    const candidates = [item("to", 1, 1_000_000)];
    const result = module.rerank("te", candidates, { prev: "want", prevPrev: "i" });

    expect(result.scoresPerCandidate).toHaveLength(1);
    expect(result.scoresPerCandidate[0].scores.trigram).toBe(0);
  });

  test("null table vs attached-but-empty table produce different trigram scores", () => {
    // The attached-but-empty case applies stupid backoff → negative contribution.
    const words = new Map([["to", 1_000_000], ["want", 500_000]]);
    const bigrams = new Map([["want to", 50_000]]);

    const moduleNull = makeModule({ words, bigrams });
    // moduleNull.trigramTable stays null

    const moduleEmpty = makeModule({ words, bigrams });
    moduleEmpty.attachTrigramTable(mockTrigramTable()); // attached but no entries

    const candidates = [item("to", 1, 1_000_000)];
    const ctx: RerankCorrectionContext = { prev: "want", prevPrev: "i" };

    const r1 = moduleNull.rerank("te", candidates, ctx);
    const r2 = moduleEmpty.rerank("te", candidates, ctx);

    // Null table: trigram = 0 (strict no-op)
    expect(r1.scoresPerCandidate[0].scores.trigram).toBe(0);
    // Attached-but-empty: backoff fires → trigram < 0
    expect(r2.scoresPerCandidate[0].scores.trigram).toBeLessThan(0);
    // Post-attach total ≤ pre-attach total (score-monotonicity)
    expect(r2.scoresPerCandidate[0].scores.total).toBeLessThan(
      r1.scoresPerCandidate[0].scores.total,
    );
  });
});

// ---------------------------------------------------------------------------
// §4.8 Test 7: Score-monotonicity after lazy trigram attach
// ---------------------------------------------------------------------------
describe("NgramRerankModule — score-monotonicity after trigram attach", () => {
  test("winner is same before and after attaching an empty trigram table", () => {
    // Fixture: two candidates A ("to") and B ("tea").
    // Both get a different bigram score with "want", so after attaching an empty
    // table the backoff penalty differs: A's bigramRawProb is higher (0.1) than
    // B's (0.0004), so A's trigram backoff penalty is smaller in absolute value.
    // A wins both before and after attach, confirming score-monotonicity.
    const words = new Map([
      ["to", 1_000_000],
      ["tea", 50_000],
      ["want", 500_000],
    ]);
    const bigrams = new Map([
      ["want to", 50_000],  // bigramRawProb(to)  = 50000/500000 = 0.1
      ["want tea", 200],    // bigramRawProb(tea) = 200/500000  = 0.0004
    ]);

    // Module 1: null trigram table (pre-attach state)
    const mod1 = makeModule({ words, bigrams });
    const candidates = [item("to", 1, 1_000_000), item("tea", 1, 50_000)];
    const ctx: RerankCorrectionContext = { prev: "want", prevPrev: "i" };
    const res1 = mod1.rerank("te", candidates, ctx);
    expect(res1.winner!.term).toBe("to");

    // Module 2: empty table attached (post-attach state)
    const mod2 = makeModule({ words, bigrams });
    mod2.attachTrigramTable(mockTrigramTable());
    const res2 = mod2.rerank("te", candidates, ctx);
    expect(res2.winner!.term).toBe("to"); // same winner after attach

    // Score-monotonicity: every candidate's post-attach score ≤ pre-attach score
    for (let i = 0; i < candidates.length; i++) {
      expect(res2.scoresPerCandidate[i].scores.total).toBeLessThanOrEqual(
        res1.scoresPerCandidate[i].scores.total,
      );
    }

    // The backoff penalty DIFFERS between candidates (meaningful fixture check):
    const trigramA_post = res2.scoresPerCandidate[0].scores.trigram;
    const trigramB_post = res2.scoresPerCandidate[1].scores.trigram;
    // Both are negative (backoff fires for both)
    expect(trigramA_post).toBeLessThan(0);
    expect(trigramB_post).toBeLessThan(0);
    // A has smaller penalty (bigramRawProb_A > bigramRawProb_B → log10(0.4·A) > log10(0.4·B))
    expect(trigramA_post).toBeGreaterThan(trigramB_post);
  });
});

// ---------------------------------------------------------------------------
// §4.8 Test 8: enableContextRerank: false → bypass
// ---------------------------------------------------------------------------
describe("NgramRerankModule — enableContextRerank: false", () => {
  test("skips scoring and returns candidates[0] even when context is available", () => {
    const words = new Map([["the", 1_000_000]]);
    const module = makeModule({ words, enableContextRerank: false });
    const candidates = [item("the", 1, 1_000_000), item("tee", 1, 50_000)];
    const result = module.rerank("teh", candidates, { prev: "want", prevPrev: "i" });
    expect(result.winner).toEqual(candidates[0]);
    expect(result.scoresPerCandidate).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §4.8 Test 9: Identity suppression — all-lowercase token
// ---------------------------------------------------------------------------
describe("NgramRerankModule — identity suppression", () => {
  test("all-lowercase token with matching top candidate → winner is null", () => {
    const words = new Map([["the", 1_000_000]]);
    const module = makeModule({ words });
    // Bypass path (ctx empty): suppression still fires
    const result = module.rerank("the", [item("the", 0, 1_000_000)], {});
    expect(result.winner).toBeNull();
  });

  test("identity suppression also fires on the scoring path", () => {
    const words = new Map([["the", 1_000_000], ["want", 500_000]]);
    const bigrams = new Map([["want the", 20_000]]);
    const module = makeModule({ words, bigrams });
    // Scoring path (prev defined)
    const result = module.rerank("the", [item("the", 0, 1_000_000)], { prev: "want" });
    expect(result.winner).toBeNull();
  });

  test("suppression returns null but scoresPerCandidate is still populated (scoring path)", () => {
    const words = new Map([["the", 1_000_000], ["want", 500_000]]);
    const bigrams = new Map([["want the", 20_000]]);
    const module = makeModule({ words, bigrams });
    const result = module.rerank("the", [item("the", 0, 1_000_000)], { prev: "want" });
    expect(result.winner).toBeNull();
    // Scores were computed even though winner is suppressed
    expect(result.scoresPerCandidate).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §4.8 Test 10: Identity NON-suppression — mixed-case token
// ---------------------------------------------------------------------------
describe("NgramRerankModule — identity non-suppression (mixed-case input)", () => {
  test("mixed-case token matching lowercase candidate is NOT suppressed", () => {
    const words = new Map([["the", 1_000_000]]);
    const module = makeModule({ words });
    const candidate = item("the", 0, 1_000_000);
    // "The".toLowerCase() === "the" === candidate.term, but "The" !== "the" (mixed)
    const result = module.rerank("The", [candidate], {});
    expect(result.winner).toEqual(candidate);
  });

  test("ALL-CAPS token matching lowercase candidate is NOT suppressed", () => {
    const words = new Map([["the", 1_000_000]]);
    const module = makeModule({ words });
    const candidate = item("the", 0, 1_000_000);
    const result = module.rerank("THE", [candidate], {});
    expect(result.winner).toEqual(candidate);
  });
});

// ---------------------------------------------------------------------------
// §4.8 Test 11: Candidate-list truncation at N=16
// ---------------------------------------------------------------------------
describe("NgramRerankModule — candidate-list truncation", () => {
  test("truncates to exactly 16 candidates; dropped 4 are lowest-frequency", () => {
    const words = new Map<string, number>();
    // Build 20 candidates with counts 20000, 19000, ..., 1000 (index 0 is highest)
    const candidates = Array.from({ length: 20 }, (_, i) => {
      const count = (20 - i) * 1_000;
      const term = `word${20 - i}`;
      words.set(term, count);
      return item(term, 1, count);
    });

    const module = makeModule({ words });
    const result = module.rerank("wrod", candidates, { prev: "some" });

    expect(result.scoresPerCandidate).toHaveLength(MAX_RERANK_CANDIDATES);

    // Top 16 candidates should appear in the scored list (in order)
    const scoredTerms = result.scoresPerCandidate.map((s) => s.term);
    const expectedTop16 = candidates.slice(0, 16).map((c) => c.term);
    expect(scoredTerms).toEqual(expectedTop16);

    // Bottom 4 (indices 16–19) must not appear in scored output
    for (let i = 16; i < 20; i++) {
      expect(scoredTerms).not.toContain(candidates[i].term);
    }
  });
});

// ---------------------------------------------------------------------------
// §4.8 Test 12: Stupid-backoff math correctness
// ---------------------------------------------------------------------------
describe("NgramRerankModule — stupid-backoff math", () => {
  test("count_b === 0 → bigram = α₁ · log10(0.4 · count_u(c) / N)", () => {
    const countToWord = 1_000_000;
    const words = new Map([["to", countToWord], ["want", 500_000]]);
    // No bigram entry for "want to" → backoff must fire
    const bigrams = new Map<string, number>();
    const bigramWeight = 0.5;
    const module = makeModule({ words, bigrams, bigramWeight });

    const result = module.rerank("te", [item("to", 1, countToWord)], { prev: "want" });
    const scores = result.scoresPerCandidate[0].scores;

    const probU = countToWord / N;
    const expectedBigram = bigramWeight * Math.log10(BACKOFF_ALPHA_EXPORT * probU);
    expect(scores.bigram).toBeCloseTo(expectedBigram, 10);
  });

  test("count_b > 0, count_u(prev) > 0 → bigram = α₁ · log10(count_b / count_u(prev))", () => {
    const countB = 50_000;
    const countUPrev = 500_000;
    const countUTerm = 1_000_000;
    const words = new Map([["to", countUTerm], ["want", countUPrev]]);
    const bigrams = new Map([["want to", countB]]);
    const bigramWeight = 0.5;
    const module = makeModule({ words, bigrams, bigramWeight });

    const result = module.rerank("te", [item("to", 1, countUTerm)], { prev: "want" });
    const scores = result.scoresPerCandidate[0].scores;

    const expectedBigram = bigramWeight * Math.log10(countB / countUPrev);
    expect(scores.bigram).toBeCloseTo(expectedBigram, 10);
  });
});

// ---------------------------------------------------------------------------
// §4.8 Test 13: Bigram-tier denominator missing (prev not in unigram dict)
// ---------------------------------------------------------------------------
describe("NgramRerankModule — bigram denominator missing", () => {
  test("count_u(prev) === 0 → full backoff, no NaN/Infinity in scores", () => {
    const countUTerm = 1_000_000;
    const words = new Map([["to", countUTerm]]);
    // "kubernetes" is NOT in the unigram dict → count_u(prev) = 0
    const bigrams = new Map<string, number>();
    const module = makeModule({ words, bigrams });

    const result = module.rerank("te", [item("to", 1, countUTerm)], { prev: "kubernetes" });
    const scores = result.scoresPerCandidate[0].scores;

    expect(Number.isNaN(scores.bigram)).toBe(false);
    expect(Number.isFinite(scores.bigram)).toBe(true);
    expect(Number.isNaN(scores.total)).toBe(false);
    expect(Number.isFinite(scores.total)).toBe(true);

    // Verify: falls back to α₁ · log10(0.4 · P(c))
    const probU = countUTerm / N;
    const expectedBigram = 0.5 * Math.log10(0.4 * probU);
    expect(scores.bigram).toBeCloseTo(expectedBigram, 10);
  });

  test("count_u(prev) === 0 AND prev not in bigrams → graceful backoff, all scores finite", () => {
    const words = new Map([["word", 500_000]]);
    // Both prev word and bigram completely absent
    const bigrams = new Map<string, number>();
    const module = makeModule({ words, bigrams });

    const result = module.rerank("wrod", [item("word", 1, 500_000)], {
      prev: "unknownword",
      prevPrev: "also_unknown",
    });

    const scores = result.scoresPerCandidate[0].scores;
    expect(Number.isFinite(scores.unigram)).toBe(true);
    expect(Number.isFinite(scores.bigram)).toBe(true);
    expect(Number.isFinite(scores.trigram)).toBe(true);
    expect(Number.isFinite(scores.total)).toBe(true);
    expect(Number.isNaN(scores.total)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Additional: trigram tier direct-hit and backoff math
// ---------------------------------------------------------------------------
describe("NgramRerankModule — trigram tier scoring", () => {
  test("direct trigram hit → α₂ · log10(count_t / prefix_count)", () => {
    const words = new Map([["to", 1_000_000], ["want", 500_000]]);
    const bigrams = new Map([["want to", 50_000]]);
    const trigramWeight = 0.3;
    const module = makeModule({ words, bigrams, trigramWeight });

    const countT = 10_000;
    const prefixCount = 50_000;
    module.attachTrigramTable(
      mockTrigramTable(
        { "i\x01want\x01to": countT },
        { "i\x01want": prefixCount },
      ),
    );

    const result = module.rerank("te", [item("to", 1, 1_000_000)], {
      prev: "want",
      prevPrev: "i",
    });
    const scores = result.scoresPerCandidate[0].scores;
    const expectedTrigram = trigramWeight * Math.log10(countT / prefixCount);
    expect(scores.trigram).toBeCloseTo(expectedTrigram, 10);
  });

  test("trigram miss → backoff to α₂ · log10(0.4 · bigramRawProb)", () => {
    const countB = 50_000;
    const countUPrev = 500_000;
    const countUTerm = 1_000_000;
    const words = new Map([["to", countUTerm], ["want", countUPrev]]);
    const bigrams = new Map([["want to", countB]]);
    const trigramWeight = 0.3;
    const module = makeModule({ words, bigrams, trigramWeight });
    // Attach empty table → all trigrams miss → backoff fires
    module.attachTrigramTable(mockTrigramTable());

    const result = module.rerank("te", [item("to", 1, countUTerm)], {
      prev: "want",
      prevPrev: "i",
    });
    const scores = result.scoresPerCandidate[0].scores;
    const bigramRawProb = countB / countUPrev;
    const expectedTrigram = trigramWeight * Math.log10(0.4 * bigramRawProb);
    expect(scores.trigram).toBeCloseTo(expectedTrigram, 10);
  });

  test("double-backoff: trigram miss + bigram miss → α₂ · log10(0.4 · 0.4 · P(c))", () => {
    const countUTerm = 1_000_000;
    const words = new Map([["to", countUTerm], ["want", 500_000]]);
    // No bigram entries, no trigram entries → full double backoff
    const bigrams = new Map<string, number>();
    const trigramWeight = 0.3;
    const module = makeModule({ words, bigrams, trigramWeight });
    module.attachTrigramTable(mockTrigramTable());

    const result = module.rerank("te", [item("to", 1, countUTerm)], {
      prev: "want",
      prevPrev: "i",
    });
    const scores = result.scoresPerCandidate[0].scores;
    const probU = countUTerm / N;
    // bigramRawProb = 0.4 * probU (bigram backoff)
    // trigram backoff = 0.4 * bigramRawProb = 0.4 * 0.4 * probU
    const expectedTrigram = trigramWeight * Math.log10(0.4 * 0.4 * probU);
    expect(scores.trigram).toBeCloseTo(expectedTrigram, 10);
  });
});

// ---------------------------------------------------------------------------
// Additional: unigram floor (count_u === 0)
// ---------------------------------------------------------------------------
describe("NgramRerankModule — unigram floor", () => {
  test("term not in unigram dict → floor probability 1/N, log10 is finite", () => {
    const words = new Map<string, number>();
    // "xyz" has count 0 in the words map
    const module = makeModule({ words });
    const result = module.rerank("xyz", [item("xyz", 0, 0)], { prev: "some" });
    const scores = result.scoresPerCandidate[0].scores;
    expect(Number.isFinite(scores.unigram)).toBe(true);
    expect(Number.isNaN(scores.unigram)).toBe(false);
    expect(scores.unigram).toBeCloseTo(Math.log10(1 / N), 10);
  });
});

// Expose the BACKOFF_ALPHA constant via a small re-export for math assertions above.
// (The constant is module-private; we reconstruct it here rather than exporting it
// from the production module to avoid cluttering the public API surface.)
const BACKOFF_ALPHA_EXPORT = 0.4;
