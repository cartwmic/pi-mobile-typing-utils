import { readFile } from "node:fs/promises";
import { SymSpell, Verbosity, loadDefaultDictionaries } from "symspell-ts";

export type CorrectionResult = { corrected: false } | { corrected: true; suggestion: string };

export interface CorrectionEngineOptions {
  techDictPath: string;
  isLearned: (word: string) => boolean;
}

const ELIGIBLE_WORD = /^[A-Za-z]{3,}$/;

export class CorrectionEngine {
  private readonly techDictPath: string;
  private readonly isLearned: (word: string) => boolean;
  private symspell?: SymSpell;
  private techDict: Set<string> = new Set();
  private ready = false;

  constructor({ techDictPath, isLearned }: CorrectionEngineOptions) {
    this.techDictPath = techDictPath;
    this.isLearned = isLearned;
  }

  async initialize(): Promise<void> {
    if (this.ready) {
      return;
    }

    try {
      const symspell = new SymSpell();
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
    if (!ELIGIBLE_WORD.test(word)) {
      return { corrected: false };
    }

    if (!this.ready || !this.symspell) {
      return { corrected: false };
    }

    const lower = word.toLowerCase();
    const suggestion = this.symspell.lookup(lower, Verbosity.Top, 1)[0];

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
