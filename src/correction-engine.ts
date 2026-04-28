import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SymSpell, Verbosity, loadDefaultDictionaries } from "symspell-ts";
import {
  CACHE_COMPACT_LEVEL,
  CACHE_COUNT_THRESHOLD,
  CACHE_PREFIX_LENGTH,
  computeCacheKey,
  getCacheDir,
  loadCache,
  pruneStaleSiblings,
  writeCache,
  type CacheDescriptor,
} from "./index-cache.js";
import { NgramRerankModule } from "./ngram-rerank.js";
import type { TelemetryWriter } from "./telemetry.js";
import { getTrigramTableSingleton } from "./trigram-table.js";
import type { TrigramTable } from "./trigram-table.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Surrounding-word context passed to shouldCorrect(). The shape is a structural
 * superset of the rerank module's RerankCorrectionContext, making it directly
 * assignable without a cast or circular import.
 */
export type CorrectionContext = {
  /** Previous eligible token, lowercased; undefined at line start. */
  prev?: string;
  /** Token before prev, lowercased; undefined when not available. */
  prevPrev?: string;
  /** Full current line at trigger time (debug telemetry only). */
  lineText?: string;
  /** Cursor position at trigger time (debug telemetry only). */
  cursor?: { line: number; col: number };
};

export type CorrectionKind = "lookup" | "segmentation";

export type CorrectionResult =
  | { corrected: false }
  | { corrected: true; kind: "lookup"; suggestion: string }
  | { corrected: true; kind: "segmentation"; suggestion: string; segments: string[] };

/**
 * Readiness state of the correction engine.
 *  - "building" : initialize() has not yet resolved (constructor state or in-flight)
 *  - "ready"    : initialize() resolved successfully; lookups are available
 *  - "degraded" : initialize() rejected; lookups silently return no-correction
 */
export type ReadinessState = "building" | "ready" | "degraded";

export interface CorrectionEngineOptions {
  techDictPath: string;
  isLearned: (word: string) => boolean;
  maxEditDistance?: number;
  getMinWordLength?: () => number;
  getMinEditDistance?: () => number;
  getEditDistanceStepEvery?: () => number;
  getRerankBigramWeight?: () => number;
  getRerankTrigramWeight?: () => number;
  getRerankEditDistancePenalty?: () => number;
  getEnableContextRerank?: () => boolean;
  getEnableSegmentation?: () => boolean;
  getSegmentationMinLength?: () => number;
  getSegmentationMaxEditDistance?: () => number;
  getSegmentationLogProbFloor?: () => number;
  getSegmentationVsLookupBias?: () => number;
  /**
   * Injected accessor returning the current owner-generation token from
   * `commands.ts` state. Used by the orphan-generation guard in
   * `attachIfStillOwning` to detect superseded engine instances.
   * When omitted, defaults to `() => 0` (always current, suitable for tests).
   */
  getOwnerGeneration?: () => number;
  /**
   * Override the trigram TSV path. Test-only knob — production code resolves
   * the TSV relative to the package data directory via `resolveProjectDataDir()`.
   */
  getTrigramTsvPath?: () => string;
  telemetry?: TelemetryWriter;
}

// ─── Fallback constants ───────────────────────────────────────────────────────

const FALLBACK_MAX_EDIT_DISTANCE = 2;
const FALLBACK_MIN_WORD_LENGTH = 2;
export const FALLBACK_MIN_EDIT_DISTANCE = 1;
export const FALLBACK_EDIT_DISTANCE_STEP_EVERY = 4;

const FALLBACK_RERANK_BIGRAM_WEIGHT = 0.5;
const FALLBACK_RERANK_TRIGRAM_WEIGHT = 0.3;
const FALLBACK_RERANK_EDIT_DISTANCE_PENALTY = 1.0;
const FALLBACK_ENABLE_CONTEXT_RERANK = true;

const FALLBACK_ENABLE_SEGMENTATION = true;
const FALLBACK_SEGMENTATION_MIN_LENGTH = 6;
const FALLBACK_SEGMENTATION_MAX_EDIT_DISTANCE = 1;
const FALLBACK_SEGMENTATION_LOG_PROB_FLOOR = -12.0;
const FALLBACK_SEGMENTATION_VS_LOOKUP_BIAS = 0.0;

const SYMSPELL_INITIAL_CAPACITY = 16;
const SYMSPELL_PREFIX_LENGTH = CACHE_PREFIX_LENGTH;
const SYMSPELL_COUNT_THRESHOLD = CACHE_COUNT_THRESHOLD;
const SYMSPELL_COMPACT_LEVEL = CACHE_COMPACT_LEVEL;

export class CorrectionEngine {
  private readonly techDictPath: string;
  private readonly isLearned: (word: string) => boolean;
  private readonly maxEditDistance: number;
  private readonly getMinWordLength: () => number;
  private readonly getMinEditDistance: () => number;
  private readonly getEditDistanceStepEvery: () => number;
  private readonly getRerankBigramWeight: () => number;
  private readonly getRerankTrigramWeight: () => number;
  private readonly getRerankEditDistancePenalty: () => number;
  private readonly getEnableContextRerank: () => boolean;
  private readonly getEnableSegmentation: () => boolean;
  private readonly getSegmentationMinLength: () => number;
  private readonly getSegmentationMaxEditDistance: () => number;
  private readonly getSegmentationLogProbFloor: () => number;
  private readonly getSegmentationVsLookupBias: () => number;

  private symspell?: SymSpell;
  private techDict: Set<string> = new Set();
  /** N-gram rerank module; constructed inside initialize() after SymSpell is ready. */
  rerank?: NgramRerankModule;
  private readonly telemetry?: TelemetryWriter;
  private readinessState: ReadinessState = "building";
  private lastInitError?: unknown;
  private cachedEligibleRegex?: { minLength: number; pattern: RegExp };
  private inFlightInit: Promise<void> | undefined;
  private readonly getOwnerGeneration: () => number;
  private readonly getTrigramTsvPath: (() => string) | undefined;

  constructor({
    techDictPath,
    isLearned,
    maxEditDistance,
    getMinWordLength,
    getMinEditDistance,
    getEditDistanceStepEvery,
    getRerankBigramWeight,
    getRerankTrigramWeight,
    getRerankEditDistancePenalty,
    getEnableContextRerank,
    getEnableSegmentation,
    getSegmentationMinLength,
    getSegmentationMaxEditDistance,
    getSegmentationLogProbFloor,
    getSegmentationVsLookupBias,
    getOwnerGeneration,
    getTrigramTsvPath,
    telemetry,
  }: CorrectionEngineOptions) {
    this.techDictPath = techDictPath;
    this.isLearned = isLearned;
    this.maxEditDistance = maxEditDistance ?? FALLBACK_MAX_EDIT_DISTANCE;
    this.getMinWordLength = getMinWordLength ?? (() => FALLBACK_MIN_WORD_LENGTH);
    this.getMinEditDistance = getMinEditDistance ?? (() => FALLBACK_MIN_EDIT_DISTANCE);
    this.getEditDistanceStepEvery = getEditDistanceStepEvery ?? (() => FALLBACK_EDIT_DISTANCE_STEP_EVERY);
    this.getRerankBigramWeight = getRerankBigramWeight ?? (() => FALLBACK_RERANK_BIGRAM_WEIGHT);
    this.getRerankTrigramWeight = getRerankTrigramWeight ?? (() => FALLBACK_RERANK_TRIGRAM_WEIGHT);
    this.getRerankEditDistancePenalty = getRerankEditDistancePenalty ?? (() => FALLBACK_RERANK_EDIT_DISTANCE_PENALTY);
    this.getEnableContextRerank = getEnableContextRerank ?? (() => FALLBACK_ENABLE_CONTEXT_RERANK);
    this.getEnableSegmentation = getEnableSegmentation ?? (() => FALLBACK_ENABLE_SEGMENTATION);
    this.getSegmentationMinLength = getSegmentationMinLength ?? (() => FALLBACK_SEGMENTATION_MIN_LENGTH);
    this.getSegmentationMaxEditDistance = getSegmentationMaxEditDistance ?? (() => FALLBACK_SEGMENTATION_MAX_EDIT_DISTANCE);
    this.getSegmentationLogProbFloor = getSegmentationLogProbFloor ?? (() => FALLBACK_SEGMENTATION_LOG_PROB_FLOOR);
    this.getSegmentationVsLookupBias = getSegmentationVsLookupBias ?? (() => FALLBACK_SEGMENTATION_VS_LOOKUP_BIAS);
    this.getOwnerGeneration = getOwnerGeneration ?? (() => 0);
    this.getTrigramTsvPath = getTrigramTsvPath;
    this.telemetry = telemetry;
  }

  getReadinessState(): ReadinessState {
    return this.readinessState;
  }

  getLastInitError(): unknown | undefined {
    return this.lastInitError;
  }

  async initialize(): Promise<void> {
    if (this.readinessState === "ready") {
      return;
    }
    if (this.readinessState === "building" && this.inFlightInit !== undefined) {
      return this.inFlightInit;
    }

    this.inFlightInit = (async () => {
      const initStart = Date.now();
      try {
        const descriptor: CacheDescriptor = {
          maxEditDistance: this.maxEditDistance,
          prefixLength: SYMSPELL_PREFIX_LENGTH,
          compactLevel: SYMSPELL_COMPACT_LEVEL,
          countThreshold: SYMSPELL_COUNT_THRESHOLD,
        };

        const symspell = new SymSpell(
          SYMSPELL_INITIAL_CAPACITY,
          this.maxEditDistance,
          SYMSPELL_PREFIX_LENGTH,
          SYMSPELL_COUNT_THRESHOLD,
          SYMSPELL_COMPACT_LEVEL,
        );

        const key = computeCacheKey(descriptor);
        let cacheLoaded = false;

        if (key !== null) {
          const hydration = await loadCache(descriptor);
          if (hydration !== null) {
            (symspell as any).words = hydration.words;
            (symspell as any).deletes = hydration.deletes;
            (symspell as any).maxDictionaryWordLength = hydration.maxDictionaryWordLength;
            (symspell as any).bigrams = hydration.bigrams;
            (symspell as any).bigramCountMin = hydration.bigramCountMin;
            cacheLoaded = true;
            void pruneStaleSiblings(key).catch(() => undefined);
          }
        }

        if (!cacheLoaded) {
          await this.loadDictionaries(symspell);
          if (key !== null) {
            void writeCache(descriptor, symspell).catch(() => undefined);
          }
        }

        const techDictionaryText = await readFile(this.techDictPath, "utf8");
        const techDict = new Set(
          techDictionaryText
            .split(/\r?\n/)
            .map((line) => line.trim().toLowerCase())
            .filter(Boolean),
        );

        // Construct NgramRerankModule AFTER symspell is assigned so
        // the getSymspell live accessor always returns a valid instance.
        const rerank = new NgramRerankModule({
          getBigramWeight: () => this.getRerankBigramWeight(),
          getTrigramWeight: () => this.getRerankTrigramWeight(),
          getEdPenalty: () => this.getRerankEditDistancePenalty(),
          getEnableContextRerank: () => this.getEnableContextRerank(),
          getSymspell: () => this.symspell!,
        });

        this.symspell = symspell;
        this.techDict = techDict;
        this.rerank = rerank;
        this.readinessState = "ready";

        // §12.2 — engine.init telemetry (success path)
        this.telemetry?.emit({
          event: "engine.init",
          timestamp: new Date().toISOString(),
          fromCache: cacheLoaded,
          buildMs: Date.now() - initStart,
          unigramCount: (symspell as any).words.size as number,
          bigramCount: (symspell as any).bigrams.size as number,
          outcome: "ready",
          cause: null,
        });

        // § 8.2 — Kick off lazy trigram attach (fire-and-forget, § 8.3).
        // ownerGen is captured NOW (before the async load) so the orphan-
        // generation guard in attachIfStillOwning can compare against the
        // generation that was current when this engine reached "ready".
        {
          const ownerGen = this.getOwnerGeneration();
          const cacheDir = getCacheDir();
          const tsvPath = this.getTrigramTsvPath
            ? this.getTrigramTsvPath()
            : resolve(this.resolveProjectDataDir(), "trigram-top500k.tsv");
          if (cacheDir !== null) {
            void getTrigramTableSingleton({
              cacheDir,
              tsvPath,
              telemetry: this.telemetry,
            })
              .then((table) => this.attachIfStillOwning(table, ownerGen))
              .catch(() => undefined); // defensive top-level swallow (§ 8.3)
          }
        }
      } catch (error) {
        this.symspell = undefined;
        this.techDict = new Set();
        this.rerank = undefined;
        this.readinessState = "degraded";
        this.lastInitError = error;

        // §12.2 — engine.init telemetry (degraded path, BEFORE re-throw)
        this.telemetry?.emit({
          event: "engine.init",
          timestamp: new Date().toISOString(),
          fromCache: false,
          buildMs: Date.now() - initStart,
          unigramCount: 0,
          bigramCount: 0,
          outcome: "degraded",
          cause: error instanceof Error ? error.message : String(error),
        });

        throw error;
      } finally {
        this.inFlightInit = undefined;
      }
    })();

    return this.inFlightInit;
  }

  /**
   * Determine whether and how to correct a token.
   *
   * Runs lookup-then-rerank and (when eligible) word-segmentation head-to-head.
   * Returns the higher-scoring result. When ctx is omitted the rerank module
   * falls back to unigram-only ranking.
   */
  shouldCorrect(token: string, ctx: CorrectionContext = {}): CorrectionResult {
    const callStart = Date.now();

    // 1. Eligibility gate: regex / length
    if (!this.eligibleRegex().test(token)) {
      this.telemetry?.emit({
        event: "correction.skipped",
        timestamp: new Date().toISOString(),
        tokenLength: token.length,
        reason: "not_eligible",
        token: null,
        lineText: null,
        cursor: null,
      });
      return { corrected: false };
    }

    if (this.readinessState !== "ready" || !this.symspell || !this.rerank) {
      return { corrected: false };
    }

    const lower = token.toLowerCase();
    const effectiveED = this.effectiveEditDistance(token.length);

    // 2. Lookup path: Verbosity.All + rerank
    const lookupStart = Date.now();
    const candidates = this.symspell.lookup(lower, Verbosity.All, effectiveED);
    const lookupMs = Date.now() - lookupStart;

    const { winner, scoresPerCandidate } = this.rerank.rerank(token, candidates, ctx);

    let sLookup: number;
    if (winner === null) {
      sLookup = -Infinity;
    } else {
      if (scoresPerCandidate.length > 0) {
        // Full scoring path: find winner in breakdown array.
        const entry = scoresPerCandidate.find((e) => e.term === winner.term);
        sLookup = entry !== undefined ? entry.scores.total : -Infinity;
      } else {
        // Bypass path (no context or context-rerank disabled):
        // derive a proxy score from the winner's unigram frequency.
        sLookup = Math.log10(winner.count > 0 ? winner.count / SymSpell.N : 1 / SymSpell.N);
      }

      // Suppress SPELLING CHANGES for learned / tech words.
      // NOT applied for identity (winner.term === lower) so that mixed-case
      // tokens like "tHe" are still case-normalised even when "the" is in
      // the tech dict (T09 regression contract).
      if (winner.term !== lower && (this.isLearned(lower) || this.techDict.has(lower))) {
        sLookup = -Infinity;
      }
    }

    // 3. Segmentation path
    let sSegmentation = -Infinity;
    let segResult: CorrectionResult = { corrected: false };

    // Learned / tech words are NEVER segmented (design.md Decision / §7 spec).
    const inAnyDict = this.isLearned(lower) || this.techDict.has(lower);
    if (!inAnyDict && this.getEnableSegmentation() && token.length >= this.getSegmentationMinLength()) {
      const seg = this.tryWordSegmentation(token, ctx, sLookup);
      sSegmentation = seg.score;
      segResult = seg.result;
    }

    // 4. Head-to-head comparison
    const totalMs = Date.now() - callStart;
    const scoresVsAlt =
      sLookup > -Infinity && sSegmentation > -Infinity
        ? { lookupScore: sLookup, segmentationScore: sSegmentation }
        : null;

    if (sSegmentation > sLookup) {
      const sr = segResult as { corrected: true; kind: "segmentation"; suggestion: string; segments: string[] };
      this.telemetry?.emit({
        event: "correction.applied",
        timestamp: new Date().toISOString(),
        kind: "segmentation",
        tokenLength: token.length,
        suggestionLength: sr.suggestion.length,
        candidateCount: candidates.length,
        winningEditDistance: null,
        latencyMs: totalMs,
        scores: null,
        scoresVsAlt,
        token: null,
        suggestion: null,
        original: null,
        candidates: null,
        lineText: null,
        cursor: null,
      });
      this.telemetry?.emit({
        event: "lookup.latency",
        timestamp: new Date().toISOString(),
        tokenLength: token.length,
        candidateCount: candidates.length,
        latencyMs: lookupMs,
        result: "skipped",
        token: null,
        suggestion: null,
        lineText: null,
        cursor: null,
      });
      return segResult;
    }

    // tie-breaker: lookup wins on equal finite scores
    if (sLookup > -Infinity) {
      let suggestion: string;
      if (winner!.term === lower) {
        // Rerank returned the identity candidate because the input is mixed-case
        // (all-lowercase identity is suppressed by rerank; this case means
        // token !== token.toLowerCase()). Return the lowercased form.
        suggestion = winner!.term;
      } else {
        suggestion = preserveCase(token, winner!.term);
      }

      const winnerEntry = scoresPerCandidate.find((e) => e.term === winner!.term);
      this.telemetry?.emit({
        event: "correction.applied",
        timestamp: new Date().toISOString(),
        kind: "lookup",
        tokenLength: token.length,
        suggestionLength: suggestion.length,
        candidateCount: candidates.length,
        winningEditDistance: winner!.distance,
        latencyMs: totalMs,
        scores: winnerEntry ? winnerEntry.scores : null,
        scoresVsAlt,
        token: null,
        suggestion: null,
        original: null,
        candidates: null,
        lineText: null,
        cursor: null,
      });
      this.telemetry?.emit({
        event: "lookup.latency",
        timestamp: new Date().toISOString(),
        tokenLength: token.length,
        candidateCount: candidates.length,
        latencyMs: lookupMs,
        result: "corrected",
        token: null,
        suggestion: null,
        lineText: null,
        cursor: null,
      });
      return { corrected: true, kind: "lookup", suggestion };
    }

    // Both paths -Infinity: no correction.
    const skipReason = candidates.length === 0 ? "no_candidates" : "in_dict";
    this.telemetry?.emit({
      event: "correction.skipped",
      timestamp: new Date().toISOString(),
      tokenLength: token.length,
      reason: skipReason,
      token: null,
      lineText: null,
      cursor: null,
    });
    this.telemetry?.emit({
      event: "lookup.latency",
      timestamp: new Date().toISOString(),
      tokenLength: token.length,
      candidateCount: candidates.length,
      latencyMs: lookupMs,
      result: "skipped",
      token: null,
      suggestion: null,
      lineText: null,
      cursor: null,
    });
    return { corrected: false };
  }

  /**
   * Attempt word-segmentation correction via SymSpell.wordSegmentation().
   *
   * Returns the result and its log-space score so the caller can compare
   * against the lookup path. Returns score: -Infinity when any gate fails.
   *
   * @param token   Raw input token (original case).
   * @param ctx     Context (reserved for future diagnostics).
   * @param sLookup Lookup score (informational only; §7.1 — not used for short-circuit).
   */
  private tryWordSegmentation(
    token: string,
    _ctx: CorrectionContext,
    _sLookup: number,
  ): { result: CorrectionResult; score: number } {
    const rejected: { result: CorrectionResult; score: number } = {
      result: { corrected: false },
      score: -Infinity,
    };

    // Defensive re-check (caller already gates; guards direct callers).
    if (!this.getEnableSegmentation() || token.length < this.getSegmentationMinLength()) {
      return rejected;
    }

    const segStart = Date.now();
    const segResult = this.symspell!.wordSegmentation(
      token.toLowerCase(),
      this.getSegmentationMaxEditDistance(),
    );
    const latencyMs = Date.now() - segStart;

    const { correctedString, probabilityLogSum } = segResult;

    // Acceptance gates (§7.4)
    const hasSpace = correctedString.includes(" ");
    const segments = correctedString.split(/\s+/);
    const minWL = this.getMinWordLength();
    const allSegmentsLongEnough = segments.every((s) => s.length >= minWL);
    const allSegmentsAlphabetic = segments.every((s) => /^[A-Za-z]+$/.test(s));
    const aboveFloor = probabilityLogSum >= this.getSegmentationLogProbFloor();
    const notIdentity = correctedString.toLowerCase() !== token.toLowerCase();

    const accepted =
      hasSpace && allSegmentsLongEnough && allSegmentsAlphabetic && aboveFloor && notIdentity;

    this.telemetry?.emit({
      event: "segmentation.attempt",
      timestamp: new Date().toISOString(),
      tokenLength: token.length,
      accepted,
      segmentCount: accepted ? segments.length : null,
      probabilityLogSum,
      latencyMs,
      token: null,
      suggestion: null,
    });

    if (!accepted) return rejected;

    // First-segment-only case preservation (§7.5)
    const firstSegCased = preserveCase(token, segments[0]);
    const caseAdjustedSegments = [firstSegCased, ...segments.slice(1).map((s) => s.toLowerCase())];
    const caseAdjustedString = caseAdjustedSegments.join(" ");

    const score = probabilityLogSum + this.getSegmentationVsLookupBias();

    return {
      result: {
        corrected: true,
        kind: "segmentation",
        suggestion: caseAdjustedString,
        segments: caseAdjustedSegments,
      },
      score,
    };
  }

  /**
   * Compute the per-word effective edit distance using the adaptive curve:
   *   ED(L) = clamp(minED + floor((L - minWL) / step), minED, maxED)
   */
  private effectiveEditDistance(wordLength: number): number {
    const minED = this.getMinEditDistance();
    const maxED = this.maxEditDistance;
    const step = this.getEditDistanceStepEvery();
    const minWL = this.getMinWordLength();

    const effectiveMin = Math.min(minED, maxED);
    const intermediate = effectiveMin + Math.floor((wordLength - minWL) / Math.max(step, 1));
    return Math.max(effectiveMin, Math.min(intermediate, maxED));
  }

  /**
   * Load the English unigram and bigram dictionaries into the given SymSpell
   * instance via the upstream `loadDefaultDictionaries` API from `symspell-ts`.
   */
  private async loadDictionaries(symspell: SymSpell): Promise<void> {
    loadDefaultDictionaries(symspell);
  }

  private eligibleRegex(): RegExp {
    const minLength = this.getMinWordLength();
    if (this.cachedEligibleRegex?.minLength === minLength) {
      return this.cachedEligibleRegex.pattern;
    }
    const safeMinLength = Number.isInteger(minLength) && minLength >= 1 ? minLength : FALLBACK_MIN_WORD_LENGTH;
    const pattern = new RegExp(`^[A-Za-z]{${safeMinLength},}$`);
    this.cachedEligibleRegex = { minLength, pattern };
    return pattern;
  }

  /**
   * Attach the trigram table to the rerank module if this engine instance
   * still owns the current generation and is in the "ready" state.
   *
   * Orphan-generation guard: `ownerGen` is the generation captured at the
   * time the lazy-attach started (inside initialize(), after "ready" is set).
   * If the live generation has changed since then, this engine has been
   * superseded by a rebuild — silently return without attaching.
   */
  private attachIfStillOwning(table: TrigramTable | null, ownerGen: number): void {
    if (table === null) return;
    if (ownerGen !== this.getOwnerGeneration()) return;
    if (this.readinessState !== "ready") return;
    this.rerank!.attachTrigramTable(table);
  }

  /**
   * Resolve the project’s `data/` directory relative to this module’s location.
   *
   * In development (vitest runs TypeScript directly):
   *   src/correction-engine.ts → dirname = src/ → ../data = data/ (repo root)
   * In a `dist/src/correction-engine.js` layout (compiled output, scenario
   * harness via `-e ./dist/index.js`):
   *   dist/src/ → ../data = dist/data/ which does not exist; fall back to
   *   ../../data = repo-root data/.
   */
  private resolveProjectDataDir(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    const sibling = resolve(here, "../data");
    if (existsSync(sibling)) return sibling;
    return resolve(here, "../../data");
  }
}

function preserveCase(original: string, suggestion: string): string {
  if (original === original.toLowerCase()) {
    return suggestion.toLowerCase();
  }

  if (original.length >= 2 && original === original.toUpperCase()) {
    return suggestion.toUpperCase();
  }

  if (isTitleCase(original)) {
    return `${suggestion[0]?.toUpperCase() ?? ""}${suggestion.slice(1).toLowerCase()}`;
  }

  return suggestion.toLowerCase();
}

function isTitleCase(word: string): boolean {
  return word[0] === word[0].toUpperCase() && word.slice(1) === word.slice(1).toLowerCase();
}
