import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SymSpell, Verbosity, loadDefaultDictionaries } from "symspell-ts";
import {
  CACHE_COMPACT_LEVEL,
  CACHE_COUNT_THRESHOLD,
  CACHE_PREFIX_LENGTH,
  computeCacheKey,
  loadCache,
  pruneStaleSiblings,
  writeCache,
  type CacheDescriptor,
} from "./index-cache.js";
import { resolveSymspellPackageRoot as defaultResolveSymspellPackageRoot } from "./symspell-paths.js";

export type CorrectionResult = { corrected: false } | { corrected: true; suggestion: string };

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
  /**
   * Maximum SymSpell edit distance for typo lookups. Baked into the
   * SymSpell index at initialize() time — callers must rebuild the engine
   * (drop and re-create) to change it. Defaults to 2.
   */
  maxEditDistance?: number;
  /**
   * Live accessor for the minimum word length eligible for correction.
   * Read on every shouldCorrect() call so that updates from `/typos config
   * minWordLength <n>` take effect without rebuilding the engine. When
   * omitted, defaults to FALLBACK_MIN_WORD_LENGTH (2).
   */
  getMinWordLength?: () => number;
  /**
   * Live accessor for the floor edit distance used by the adaptive ED curve:
   *   ED(L) = clamp(minED + floor((L - minWL) / step), minED, maxED)
   * Read on every shouldCorrect() call — no rebuild required when changed.
   * When omitted, defaults to FALLBACK_MIN_EDIT_DISTANCE (1).
   */
  getMinEditDistance?: () => number;
  /**
   * Live accessor for the number of additional characters of word length
   * required to ramp the effective edit distance up by one step.
   * Read on every shouldCorrect() call — no rebuild required when changed.
   * When omitted, defaults to FALLBACK_EDIT_DISTANCE_STEP_EVERY (4).
   */
  getEditDistanceStepEvery?: () => number;
  /**
   * @internal Test-only injection point for the symspell package-root resolver.
   * Pass `() => null` to force the upstream `loadDefaultDictionaries` fallback
   * path (which loads bigrams as a side effect). Defaults to the real
   * `resolveSymspellPackageRoot` implementation.
   */
  _resolveSymspellPackageRoot?: () => string | null;
}

const FALLBACK_MAX_EDIT_DISTANCE = 2;
const FALLBACK_MIN_WORD_LENGTH = 2;
export const FALLBACK_MIN_EDIT_DISTANCE = 1;
export const FALLBACK_EDIT_DISTANCE_STEP_EVERY = 4;

// SymSpell constructor positional-argument constants.
// Pinned here (rather than relying on upstream defaults) so that:
//  (a) prefixLength > maxEditDistance is enforced even when the ceiling is 4, and
//  (b) compactLevel and countThreshold — which affect the internal deletion-table
//      structure that the cache subsystem serializes — are fixed in source code
//      so an upstream default change doesn't silently corrupt future cache files.
const SYMSPELL_INITIAL_CAPACITY = 16;
// The three constants below are imported from src/index-cache.ts (the lower-level
// cache module that encodes them into the cache key). Importing rather than
// duplicating ensures both modules stay in sync automatically.
// Cross-referenced from src/index-cache.ts; if you change one, update both.
const SYMSPELL_PREFIX_LENGTH = CACHE_PREFIX_LENGTH; // 7; must be > maxEditDistance (max 4 < 7 ✓)
const SYMSPELL_COUNT_THRESHOLD = CACHE_COUNT_THRESHOLD; // 1
const SYMSPELL_COMPACT_LEVEL = CACHE_COMPACT_LEVEL; // 5

export class CorrectionEngine {
  private readonly techDictPath: string;
  private readonly isLearned: (word: string) => boolean;
  private readonly maxEditDistance: number;
  private readonly getMinWordLength: () => number;
  private readonly getMinEditDistance: () => number;
  private readonly getEditDistanceStepEvery: () => number;
  private readonly resolveSymspellPackageRoot: () => string | null;
  private symspell?: SymSpell;
  private techDict: Set<string> = new Set();
  private readinessState: ReadinessState = "building";
  private lastInitError?: unknown;
  private cachedEligibleRegex?: { minLength: number; pattern: RegExp };
  private inFlightInit: Promise<void> | undefined;

  constructor({
    techDictPath,
    isLearned,
    maxEditDistance,
    getMinWordLength,
    getMinEditDistance,
    getEditDistanceStepEvery,
    _resolveSymspellPackageRoot,
  }: CorrectionEngineOptions) {
    this.techDictPath = techDictPath;
    this.isLearned = isLearned;
    this.maxEditDistance = maxEditDistance ?? FALLBACK_MAX_EDIT_DISTANCE;
    this.getMinWordLength = getMinWordLength ?? (() => FALLBACK_MIN_WORD_LENGTH);
    this.getMinEditDistance = getMinEditDistance ?? (() => FALLBACK_MIN_EDIT_DISTANCE);
    this.getEditDistanceStepEvery = getEditDistanceStepEvery ?? (() => FALLBACK_EDIT_DISTANCE_STEP_EVERY);
    this.resolveSymspellPackageRoot = _resolveSymspellPackageRoot ?? defaultResolveSymspellPackageRoot;
    // readinessState is "building" from field initializer above.
  }

  /** Public accessor for the current readiness state. */
  getReadinessState(): ReadinessState {
    return this.readinessState;
  }

  /** Returns the error thrown during the most recent failed initialize(), if any. */
  getLastInitError(): unknown | undefined {
    return this.lastInitError;
  }

  async initialize(): Promise<void> {
    if (this.readinessState === "ready") {
      return;
    }
    // Idempotency under concurrent in-flight calls: if a build is already in
    // progress, return the existing promise rather than starting a second one.
    if (this.readinessState === "building" && this.inFlightInit !== undefined) {
      return this.inFlightInit;
    }

    this.inFlightInit = (async () => {
      try {
        // Build the cache descriptor from this engine's config + pinned constants.
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
            // Hydrate the SymSpell instance by writing directly into its
            // nominally-private fields. The cache key embeds the symspell-ts
            // version + cache schema version, so any upstream internal
            // restructuring auto-invalidates existing caches.
            (symspell as any).words = hydration.words;
            (symspell as any).deletes = hydration.deletes;
            (symspell as any).maxDictionaryWordLength = hydration.maxDictionaryWordLength;
            cacheLoaded = true;
            // Fire-and-forget: prune stale sibling cache files after a
            // successful load. Failures never propagate.
            void pruneStaleSiblings(key).catch(() => undefined);
          }
        }

        if (!cacheLoaded) {
          // Cache miss or caching disabled — run the unigram-only fresh build
          // (with resolver-failure fallback to upstream loadDefaultDictionaries).
          await this.loadDictionaries(symspell);
          // Fire-and-forget: persist the built index so the next session can
          // load it quickly. Failures NEVER propagate — readiness is not gated
          // on cache write success.
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

        this.symspell = symspell;
        this.techDict = techDict;
        this.readinessState = "ready";
      } catch (error) {
        this.symspell = undefined;
        this.techDict = new Set();
        this.readinessState = "degraded";
        this.lastInitError = error;
        throw error;
      } finally {
        // Clear after completion (success or failure) so that future calls
        // either no-op (ready) or restart (degraded).
        this.inFlightInit = undefined;
      }
    })();

    return this.inFlightInit;
  }

  shouldCorrect(word: string): CorrectionResult {
    if (!this.eligibleRegex().test(word)) {
      return { corrected: false };
    }

    if (this.readinessState !== "ready" || !this.symspell) {
      return { corrected: false };
    }

    const lower = word.toLowerCase();
    // Compute per-word effective edit distance from the adaptive curve.
    // Edit distance trades typo coverage for false positives — tech-dict
    // layer guards known terms. Driven by config (default 2 ceiling).
    const suggestion = this.symspell.lookup(lower, Verbosity.Top, this.effectiveEditDistance(word.length))[0];

    if (!suggestion) {
      return { corrected: false };
    }

    // SymSpell agrees the lowered word is already valid. Apply mixed-case
    // normalization if needed; the tech/learned dictionaries are not consulted
    // here because their job is to *suppress* spelling changes, not to block
    // case normalization of an otherwise-valid word.
    if (suggestion.term === lower) {
      if (!hasMixedCase(word)) {
        return { corrected: false };
      }

      return {
        corrected: true,
        suggestion: suggestion.term.toLowerCase(),
      };
    }

    // SymSpell would change the word. Suppress the change when the original
    // (case-insensitive) form is a known tech term or learned word.
    if (this.isLearned(lower) || this.techDict.has(lower)) {
      return { corrected: false };
    }

    return {
      corrected: true,
      suggestion: preserveCase(word, suggestion.term),
    };
  }

  /**
   * Compute the per-word effective edit distance using the adaptive curve:
   *   ED(L) = clamp(minED + floor((L - minWL) / step), minED, maxED)
   *
   * All four inputs are snapshotted once at the top so that a transient
   * inconsistency between live accessors (e.g. minED briefly > maxED during a
   * config rebuild) never causes lookup() to receive a per-call distance
   * greater than the index ceiling and never throws. The defensive clamp
   * `effectiveMin = Math.min(minED, maxED)` is the key guard.
   *
   * Math.max(step, 1) defends against a misbehaving accessor returning 0 or
   * a negative value; the config layer rejects those at write time, but the
   * engine adds a belt-and-suspenders guard at call time.
   */
  private effectiveEditDistance(wordLength: number): number {
    const minED = this.getMinEditDistance();
    const maxED = this.maxEditDistance;
    const step = this.getEditDistanceStepEvery();
    const minWL = this.getMinWordLength();

    // Defensive clamp: if the live accessor briefly returns minED > maxED
    // (transient inconsistency during config rebuild), cap the floor at maxED
    // so we never pass a per-call distance larger than the index ceiling.
    const effectiveMin = Math.min(minED, maxED);

    const intermediate = effectiveMin + Math.floor((wordLength - minWL) / Math.max(step, 1));
    return Math.max(effectiveMin, Math.min(intermediate, maxED));
  }

  /**
   * Load the English unigram dictionary into the given SymSpell instance.
   *
   * Default path: read <pkgRoot>/data/frequency_dictionary_en_82_765.txt and
   * call symspell.loadDictionary(text, 0, 1), loading only unigrams. This
   * skips the bigram file entirely, saving ~24 MB resident memory and ~30% of
   * cold-start build time vs. upstream loadDefaultDictionaries.
   *
   * Fallback (resolver failure): call upstream loadDefaultDictionaries, which
   * loads bigrams as a side effect. Correctness is preserved; the optimization
   * is not. See design.md §"Drop bigrams entirely" for full rationale.
   */
  private async loadDictionaries(symspell: SymSpell): Promise<void> {
    const pkgRoot = this.resolveSymspellPackageRoot();

    if (pkgRoot !== null) {
      const dictPath = join(pkgRoot, "data", "frequency_dictionary_en_82_765.txt");
      const text = await readFile(dictPath, "utf8");
      symspell.loadDictionary(text, 0, 1);
    } else {
      console.info(
        "[mobile-autocorrect] symspell-ts package root not resolvable; " +
          "falling back to upstream loadDefaultDictionaries (bigrams will be loaded as a side effect)",
      );
      loadDefaultDictionaries(symspell);
    }
  }

  private eligibleRegex(): RegExp {
    const minLength = this.getMinWordLength();
    if (this.cachedEligibleRegex?.minLength === minLength) {
      return this.cachedEligibleRegex.pattern;
    }
    // Sanitize: a non-integer or out-of-range value would have been
    // rejected at config write time, but defend against a buggy accessor.
    const safeMinLength = Number.isInteger(minLength) && minLength >= 1 ? minLength : FALLBACK_MIN_WORD_LENGTH;
    const pattern = new RegExp(`^[A-Za-z]{${safeMinLength},}$`);
    this.cachedEligibleRegex = { minLength, pattern };
    return pattern;
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

function hasMixedCase(word: string): boolean {
  return word !== word.toLowerCase() && word !== word.toUpperCase() && !isTitleCase(word);
}

function isTitleCase(word: string): boolean {
  return word[0] === word[0].toUpperCase() && word.slice(1) === word.slice(1).toLowerCase();
}
