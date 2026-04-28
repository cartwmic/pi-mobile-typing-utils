/**
 * ngram-rerank.ts — N-gram rerank module for the mobile-autocorrect engine.
 *
 * Receives a SymSpell candidate list (Verbosity.All ordering) plus a
 * surrounding-word context and returns the single best correction via a
 * weighted sum of unigram, bigram, and trigram log-probabilities with
 * stupid-backoff smoothing and an edit-distance penalty.
 *
 * All log-probabilities use base 10 (Math.log10) to match SymSpell's own
 * `wordSegmentation().probabilityLogSum` convention.
 *
 * ## SymSpell internal-field access
 *
 * SymSpell exposes `bigrams` (public) but keeps `words` private.  The
 * module reads `words` via a type-unsafe cast — the same pattern already
 * used by `correction-engine.ts` when it hydrates from the index cache.
 * SymSpell.N is a static class property (≈ 1.025 trillion) accessed
 * directly on the class, not on any instance.
 *
 * ## Ownership
 *
 * - **Candidate truncation** — owned here.  The engine passes the full
 *   Verbosity.All list; this module slices to MAX_RERANK_CANDIDATES.
 * - **Identity-correction suppression** — owned here (sole owner).
 *   The engine must NOT duplicate the rule.
 */

import { SymSpell } from "symspell-ts";
import type { SuggestItem } from "symspell-ts";
import type { TrigramTable } from "./trigram-table.js";

/** Hard limit on candidates scored (top-N by SymSpell frequency). */
export const MAX_RERANK_CANDIDATES = 16;

/**
 * Stupid-backoff interpolation constant (Brants et al., 2007).
 * Not user-tunable in v1; hardcoded per the spec.
 */
const BACKOFF_ALPHA = 0.4;

/**
 * Minimal context object required by the rerank module.
 *
 * The full `CorrectionContext` added in §6 is a structural superset of this
 * type, making it directly assignable here and avoiding a circular dependency
 * with the correction engine.
 */
export type RerankCorrectionContext = {
  prev?: string;
  prevPrev?: string;
};

/** Weighted score breakdown for a single candidate. */
export type CandidateScoreBreakdown = {
  /** α₀ · log10(P(c))  — unigram tier, α₀ = 1.0 fixed */
  unigram: number;
  /** α₁ · log10(S(c|prev)) — bigram tier, or 0 when no prev context */
  bigram: number;
  /**
   * α₂ · log10(S(c|prevPrev,prev)) — trigram tier, or 0 when:
   *   (a) trigramTable is null (lazy load not yet complete — strict no-op)
   *   (b) ctx.prevPrev is undefined (second token on line)
   * Case (a) and case (b) both produce 0; they are distinguished by whether
   * the table is attached at all (see score-monotonicity notes in design.md).
   */
  trigram: number;
  /** δ · editDistance(token, c)  — positive value, subtracted from total */
  edPenalty: number;
  /** unigram + bigram + trigram − edPenalty */
  total: number;
};

/** Entry in scoresPerCandidate. */
export type CandidateScore = {
  term: string;
  ed: number;
  scores: CandidateScoreBreakdown;
};

/** Return value of rerank(). */
export type RerankResult = {
  /**
   * The chosen candidate, or null when:
   *  - the candidate list was empty, OR
   *  - identity-correction suppression fired (sole owner: this module).
   */
  winner: SuggestItem | null;
  /**
   * Per-candidate score breakdowns for all scored candidates (up to 16).
   * Empty array when a bypass path was taken (no scoring performed).
   */
  scoresPerCandidate: CandidateScore[];
};

/** Constructor options for NgramRerankModule. */
export interface NgramRerankModuleOptions {
  /** Live accessor for α₁ (bigram tier weight). Default config: 0.5. */
  getBigramWeight: () => number;
  /** Live accessor for α₂ (trigram tier weight). Default config: 0.3. */
  getTrigramWeight: () => number;
  /** Live accessor for δ (edit-distance penalty). Default config: 1.0. */
  getEdPenalty: () => number;
  /** Live accessor for the context-rerank enable flag. */
  getEnableContextRerank: () => boolean;
  /**
   * Returns the active SymSpell instance.  The module reads:
   *   - `symspell.bigrams`  (Map<string, number>, public)
   *   - `(symspell as any).words`  (Map<string, number>, private — cast required)
   *   - `SymSpell.N`  (static class property, not instance)
   */
  getSymspell: () => SymSpell;
}

/**
 * N-gram rerank module.
 *
 * Instantiated once per engine instance.  The trigram table is attached
 * lazily via `attachTrigramTable()` once the singleton load completes.
 */
export class NgramRerankModule {
  private readonly getBigramWeight: () => number;
  private readonly getTrigramWeight: () => number;
  private readonly getEdPenalty: () => number;
  private readonly getEnableContextRerank: () => boolean;
  private readonly getSymspell: () => SymSpell;
  private trigramTable: TrigramTable | null = null;

  constructor({
    getBigramWeight,
    getTrigramWeight,
    getEdPenalty,
    getEnableContextRerank,
    getSymspell,
  }: NgramRerankModuleOptions) {
    this.getBigramWeight = getBigramWeight;
    this.getTrigramWeight = getTrigramWeight;
    this.getEdPenalty = getEdPenalty;
    this.getEnableContextRerank = getEnableContextRerank;
    this.getSymspell = getSymspell;
  }

  /**
   * Attach the trigram side-table.  Called by the engine once the
   * process-wide singleton lazy-load resolves.  Pass `null` on failure to
   * keep the module in its "no trigram" state.
   */
  attachTrigramTable(table: TrigramTable | null): void {
    this.trigramTable = table;
  }

  /**
   * Pick the best correction from a SymSpell candidate list given context.
   *
   * @param token      Raw input token (original case, as typed).
   * @param candidates Candidates from `symspell.lookup(…, Verbosity.All, …)`.
   *                   Pre-sorted by distance ascending, frequency descending.
   * @param ctx        Surrounding context words.
   */
  rerank(
    token: string,
    candidates: SuggestItem[],
    ctx: RerankCorrectionContext,
  ): RerankResult {
    // Empty candidate list: no correction possible.
    if (candidates.length === 0) {
      return { winner: null, scoresPerCandidate: [] };
    }

    // Hard-truncate to MAX_RERANK_CANDIDATES.
    // Input from Verbosity.All is already frequency-sorted; slice preserves order.
    const truncated = candidates.slice(0, MAX_RERANK_CANDIDATES);

    // -----------------------------------------------------------------------
    // Bypass paths (§4.4): skip scoring, return frequency-top candidate.
    //   1. Context rerank disabled via config flag.
    //   2. No surrounding-word context available (both prev and prevPrev absent).
    // Identity suppression is still applied on bypass to keep this module as
    // the sole owner of that rule (design.md Decision 5 / §4.7).
    // -----------------------------------------------------------------------
    if (
      !this.getEnableContextRerank() ||
      (ctx.prev === undefined && ctx.prevPrev === undefined)
    ) {
      return {
        winner: this.applyIdentitySuppression(token, truncated[0]),
        scoresPerCandidate: [],
      };
    }

    // -----------------------------------------------------------------------
    // Full scoring path
    // -----------------------------------------------------------------------
    const symspell = this.getSymspell();

    // `words` is private in SymSpell; access via cast (same pattern as the
    // correction engine's cache-hydration path in correction-engine.ts).
    const wordsMap = (symspell as unknown as { words: Map<string, number> }).words;

    // SymSpell.N is a static class property (total token count ≈ 1.025e12).
    // Accessed on the class, not the instance.
    const N = SymSpell.N;

    const α1 = this.getBigramWeight();
    const α2 = this.getTrigramWeight();
    const δ = this.getEdPenalty();

    const scoresPerCandidate: CandidateScore[] = truncated.map((c) =>
      this.scoreCandidate(c, ctx, symspell, wordsMap, N, α1, α2, δ),
    );

    // Winner = highest total score.  Ties broken by original ordering (first wins).
    let bestIdx = 0;
    for (let i = 1; i < scoresPerCandidate.length; i++) {
      if (scoresPerCandidate[i].scores.total > scoresPerCandidate[bestIdx].scores.total) {
        bestIdx = i;
      }
    }

    return {
      winner: this.applyIdentitySuppression(token, truncated[bestIdx]),
      scoresPerCandidate,
    };
  }

  /**
   * Compute the weighted score breakdown for a single candidate.
   *
   * Formula:
   *   total = α₀·log10(P(c))
   *         + α₁·log10(S(c|prev))
   *         + α₂·log10(S(c|prevPrev,prev))
   *         − δ·ed
   *
   * where α₀ = 1.0 (fixed) and S(·) follows stupid backoff (α = 0.4).
   */
  private scoreCandidate(
    c: SuggestItem,
    ctx: RerankCorrectionContext,
    symspell: SymSpell,
    wordsMap: Map<string, number>,
    N: number,
    α1: number,
    α2: number,
    δ: number,
  ): CandidateScore {
    const term = c.term;
    // SuggestItem uses `distance` internally; we expose it as `ed` in the breakdown.
    const ed = c.distance;

    // ----- Unigram tier (α₀ = 1.0, always computed) -------------------------
    //
    // P(c) = count_u(c) / N
    //
    // Floor when count_u(c) === 0: use 1/N as the minimal unit-count
    // probability.  This keeps log10(P(c)) finite and is consistent with
    // SymSpell's own scoring convention (count/N in wordSegmentation).
    // Alternatives: Number.EPSILON yields a probability orders of magnitude
    // smaller than the unigram scale and would distort relative rankings
    // more than the "one phantom occurrence" floor of 1/N does.
    const countU = wordsMap.get(term) ?? 0;
    const probU = countU > 0 ? countU / N : 1 / N;
    const unigram = Math.log10(probU); // α₀ = 1.0

    // ----- Bigram tier -------------------------------------------------------
    //
    // Active when ctx.prev is defined (§4.5: undefined → contribution is 0).
    // `bigramRawProb` is initialised to the full-backoff value so it is always
    // valid when re-used as the trigram backoff base below.
    let bigramRawProb: number = BACKOFF_ALPHA * probU;
    let bigram: number = 0;

    if (ctx.prev !== undefined) {
      const countB = symspell.bigrams.get(`${ctx.prev} ${term}`) ?? 0;
      const countUPrev = wordsMap.get(ctx.prev) ?? 0;

      if (countB > 0 && countUPrev > 0) {
        // Direct bigram hit: S(c|prev) = count_b / count_u(prev)
        bigramRawProb = countB / countUPrev;
      } else {
        // Backoff covers both:
        //   • count_b === 0  (bigram unseen)
        //   • count_u(prev) === 0  (prev not in unigram dict, e.g. a tech-dict-only
        //     word like "kubernetes") — avoids division-by-zero.
        bigramRawProb = BACKOFF_ALPHA * probU;
      }

      bigram = α1 * Math.log10(bigramRawProb);
    }
    // else: ctx.prev undefined → bigram stays 0  (§4.5)
    //   bigramRawProb retains its BACKOFF_ALPHA*probU initialisation for the
    //   trigram backoff path (which will itself be gated out by the ctx.prev check).

    // ----- Trigram tier ------------------------------------------------------
    //
    // Two distinct zero cases (§4.6):
    //
    //   Case A — trigramTable is null (lazy load not yet complete):
    //     STRICT NO-OP: contribution is exactly 0.  The α₂·log10(…) term is
    //     skipped entirely.  This is the pre-attach state.
    //
    //   Case B — trigramTable attached but no entry for this context:
    //     Backoff fires: S(c|prevPrev,prev) = 0.4·S(c|prev).
    //     Contribution = α₂·log10(0.4·bigramRawProb) < 0.
    //
    // Cases A and B produce DIFFERENT scores (B is always more negative),
    // which is the key invariant for score-monotonicity: post-attach scores
    // are ≤ pre-attach scores for any candidate, so the lazy-attach window
    // can only flip winners toward candidates that gain real trigram evidence.
    let trigram: number = 0;

    if (ctx.prev !== undefined && ctx.prevPrev !== undefined && this.trigramTable !== null) {
      // Case B: table is attached; check for a direct hit.
      const countT = this.trigramTable.getTrigramCount(ctx.prevPrev, ctx.prev, term);
      const prefixCount = this.trigramTable.getBigramPrefixCount(ctx.prevPrev, ctx.prev);

      if (countT > 0 && prefixCount > 0) {
        // Direct trigram hit.
        const trigramRawProb = countT / prefixCount;
        trigram = α2 * Math.log10(trigramRawProb);
      } else {
        // Trigram miss → backoff to bigram tier.
        // S(c|prevPrev,prev) = 0.4 · S(c|prev)
        const backedOffProb = BACKOFF_ALPHA * bigramRawProb;
        trigram = α2 * Math.log10(backedOffProb);
      }
    }
    // else: Case A (trigramTable null) OR prevPrev undefined → trigram stays 0.

    const edPenalty = δ * ed;
    const total = unigram + bigram + trigram - edPenalty;

    return {
      term,
      ed,
      scores: { unigram, bigram, trigram, edPenalty, total },
    };
  }

  /**
   * Apply identity-correction suppression.
   *
   * Rule: if `candidate.term === token.toLowerCase()` AND the input is already
   * all-lowercase (`token === token.toLowerCase()`), no change is needed —
   * return null.
   *
   * Exception: mixed-case input (token !== token.toLowerCase()) matching a
   * lowercase dict entry is NOT suppressed.  The engine's case-normalizing
   * path produces the appropriate re-cased form from the returned candidate.
   *
   * This module is the SOLE OWNER of this rule.  The correction engine must
   * not duplicate it (design.md Decision 5 / §4.7).
   */
  private applyIdentitySuppression(token: string, candidate: SuggestItem): SuggestItem | null {
    if (candidate.term === token.toLowerCase() && token === token.toLowerCase()) {
      return null;
    }
    return candidate;
  }
}
