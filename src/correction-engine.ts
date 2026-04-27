import { readFile } from "node:fs/promises";
import { SymSpell, Verbosity, loadDefaultDictionaries } from "symspell-ts";

export type CorrectionResult = { corrected: false } | { corrected: true; suggestion: string };

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
   * omitted, defaults to 2.
   */
  getMinWordLength?: () => number;
}

const FALLBACK_MAX_EDIT_DISTANCE = 2;
const FALLBACK_MIN_WORD_LENGTH = 2;

export class CorrectionEngine {
  private readonly techDictPath: string;
  private readonly isLearned: (word: string) => boolean;
  private readonly maxEditDistance: number;
  private readonly getMinWordLength: () => number;
  private symspell?: SymSpell;
  private techDict: Set<string> = new Set();
  private ready = false;
  private cachedEligibleRegex?: { minLength: number; pattern: RegExp };

  constructor({ techDictPath, isLearned, maxEditDistance, getMinWordLength }: CorrectionEngineOptions) {
    this.techDictPath = techDictPath;
    this.isLearned = isLearned;
    this.maxEditDistance = maxEditDistance ?? FALLBACK_MAX_EDIT_DISTANCE;
    this.getMinWordLength = getMinWordLength ?? (() => FALLBACK_MIN_WORD_LENGTH);
  }

  async initialize(): Promise<void> {
    if (this.ready) {
      return;
    }

    try {
      // First arg is initialCapacity (left at SymSpell's default), second is
      // maxDictionaryEditDistance — the lookup-distance ceiling baked into
      // the index. The third arg (prefixLength, default 7) is intentionally
      // not exposed: it's an internal indexing tradeoff with no good user
      // reason to fiddle with it.
      const symspell = new SymSpell(undefined, this.maxEditDistance);
      loadDefaultDictionaries(symspell);

      const techDictionaryText = await readFile(this.techDictPath, "utf8");
      const techDict = new Set(
        techDictionaryText
          .split(/\r?\n/)
          .map((line) => line.trim().toLowerCase())
          .filter(Boolean),
      );

      this.symspell = symspell;
      this.techDict = techDict;
      this.ready = true;
    } catch (error) {
      this.symspell = undefined;
      this.techDict = new Set();
      this.ready = false;
      throw error;
    }
  }

  shouldCorrect(word: string): CorrectionResult {
    if (!this.eligibleRegex().test(word)) {
      return { corrected: false };
    }

    if (!this.ready || !this.symspell) {
      return { corrected: false };
    }

    const lower = word.toLowerCase();
    // Edit distance trades typo coverage for false positives — tech-dict
    // layer guards known terms. Driven by config (default 2).
    const suggestion = this.symspell.lookup(lower, Verbosity.Top, this.maxEditDistance)[0];

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
