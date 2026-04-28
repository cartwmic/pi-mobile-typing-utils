import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { matchesKey, type EditorOptions, type EditorTheme, type TUI } from "@mariozechner/pi-tui";

import type { CorrectionContext, CorrectionEngine } from "./correction-engine.js";
import type { LearnedDictionary } from "./learned-dictionary.js";
import type { TelemetryWriter } from "./telemetry.js";

export type UIAdapter = {
  setStatus(key: string, value?: string): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
};

export type AutocorrectEditorOptions = EditorOptions & {
  correctionEngine: CorrectionEngine;
  learnedDictionary: LearnedDictionary;
  uiAdapter: UIAdapter;
  telemetry?: TelemetryWriter;
};

type CorrectionState = {
  original: string;
  corrected: string;
  line: number;
  wordStartCol: number;
  trailingChar: string;
  committed: boolean;
  kind: "lookup" | "segmentation";
  appliedAt: number;
};

const TRIGGER_CHARS = new Set([" ", ".", ",", ";", ":", "!", "?"]);
const ELIGIBLE_TOKEN = /^[A-Za-z]{2,}$/;
const SAFE_BOUNDARY_CHARS = new Set([" ", "\t", "\n", "\r", "(", ")", "[", "]", "{", "}", '"', ",", ";", ":", "!", "?"]);
const REJECTION_CAP = 32;
const STATUS_KEY = "typos-correction";
const STATUS_DURATION_MS = 500;
const WHOLE_EVENT_KEYS = [
  "enter",
  "return",
  "tab",
  "escape",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageUp",
  "pageDown",
  "delete",
  "insert",
] as const;

export class AutocorrectEditor extends CustomEditor {
  private readonly correctionEngine: CorrectionEngine;
  private readonly learnedDictionary: LearnedDictionary;
  private readonly uiAdapter: UIAdapter;
  private readonly telemetry: TelemetryWriter | undefined;
  private lastCorrection: CorrectionState | undefined;
  private recentlyRejected: Map<string, string> = new Map();
  private statusClearTimer?: NodeJS.Timeout;

  constructor(tui: TUI, theme: EditorTheme, keybindings: object, options: AutocorrectEditorOptions) {
    const { correctionEngine, learnedDictionary, uiAdapter, telemetry, ...editorOptions } = options;
    super(tui, theme, keybindings as never, editorOptions);
    this.correctionEngine = correctionEngine;
    this.learnedDictionary = learnedDictionary;
    this.uiAdapter = uiAdapter;
    this.telemetry = telemetry;
  }

  override handleInput(data: string): void {
    this.clearCorrectionStatusIfVisible();

    if (this.isBackspaceEvent(data)) {
      this.handleBackspaceEvent();
      return;
    }

    if (this.isWholeControlEvent(data)) {
      this.commitLastCorrection();
      super.handleInput(data);
      return;
    }

    if (data.length === 1) {
      this.handleSingleUnitInput(data);
      return;
    }

    if (data.startsWith("\x1b")) {
      this.commitLastCorrection();
      super.handleInput(data);
      return;
    }

    for (const char of data) {
      this.handleBufferedInputUnit(char);
    }
  }

  private handleSingleUnitInput(data: string): void {
    if (this.isBackspaceEvent(data)) {
      this.handleBackspaceEvent();
      return;
    }

    if (!isPrintableChar(data)) {
      this.commitLastCorrection();
      super.handleInput(data);
      return;
    }

    this.commitLastCorrection();

    if (!TRIGGER_CHARS.has(data)) {
      super.handleInput(data);
      return;
    }

    if (this.isShowingAutocomplete()) {
      super.handleInput(data);
      return;
    }

    super.handleInput(data);
    this.maybeApplyCorrection(data);
  }

  private handleBufferedInputUnit(data: string): void {
    if (this.isBackspaceByte(data)) {
      this.handleBackspaceEvent();
      return;
    }

    if (!isPrintableChar(data)) {
      this.commitLastCorrection();
      super.handleInput(data);
      return;
    }

    this.handleSingleUnitInput(data);
  }

  private handleBackspaceEvent(): void {
    if (!this.lastCorrection || this.lastCorrection.committed) {
      super.handleInput("\x7f");
      return;
    }

    const correction = this.lastCorrection;

    for (let index = 0; index < correction.corrected.length + correction.trailingChar.length; index += 1) {
      super.handleInput("\x7f");
    }

    this.insertTextAtCursor(correction.original);

    this.telemetry?.emit({
      event: "correction.rejected",
      timestamp: new Date().toISOString(),
      msUntilUndo: Date.now() - correction.appliedAt,
      kind: correction.kind,
      tokenLength: correction.original.length,
      token: null,
      suggestion: null,
    });

    const rejection = this.learnedDictionary.recordRejection(correction.original);
    if (rejection.learned) {
      this.uiAdapter.notify(`Learned: ${rejection.word}`, "info");
    }

    this.rememberRejected(correction.line, correction.wordStartCol, correction.original);
    this.lastCorrection = undefined;
  }

  private maybeApplyCorrection(trigger: string): void {
    const cursor = this.getCursor();
    const lineText = this.getLineText(cursor.line);

    if (cursor.col === 0) {
      return;
    }

    const triggerStartCol = cursor.col - trigger.length;
    if (triggerStartCol < 0 || lineText.slice(triggerStartCol, cursor.col) !== trigger) {
      return;
    }

    const rightBoundaryChar = lineText[cursor.col];
    if (!isSafeBoundaryChar(rightBoundaryChar)) {
      return;
    }

    let scanCol = triggerStartCol - 1;
    let token = "";

    while (scanCol >= 0 && isAsciiLetter(lineText[scanCol])) {
      token = lineText[scanCol] + token;
      scanCol -= 1;
    }

    if (!ELIGIBLE_TOKEN.test(token)) {
      return;
    }

    const wordStartCol = triggerStartCol - token.length;
    const leftBoundaryChar = lineText[wordStartCol - 1];
    if (!isSafeBoundaryChar(leftBoundaryChar)) {
      return;
    }

    if (this.shouldSuppressRejectedWord(cursor.line, wordStartCol, token)) {
      return;
    }

    const ctx = extractCorrectionContext(lineText, wordStartCol, cursor);
    const result = this.correctionEngine.shouldCorrect(token, ctx);
    if (!result.corrected) {
      return;
    }

    for (let index = 0; index < token.length + trigger.length; index += 1) {
      super.handleInput("\x7f");
    }

    this.insertTextAtCursor(result.suggestion + trigger);
    this.lastCorrection = {
      original: token,
      corrected: result.suggestion,
      line: cursor.line,
      wordStartCol,
      trailingChar: trigger,
      committed: false,
      kind: result.kind,
      appliedAt: Date.now(),
    };

    this.showCorrectionStatus(token, result.suggestion, result.kind);
  }

  private shouldSuppressRejectedWord(line: number, wordStartCol: number, token: string): boolean {
    this.pruneRejectedEntries(line);

    const key = makeRejectedKey(line, wordStartCol);
    const rejectedWord = this.recentlyRejected.get(key);
    if (!rejectedWord) {
      return false;
    }

    const currentWord = this.getWordAt(line, wordStartCol);
    if (currentWord.toLowerCase() !== rejectedWord) {
      this.recentlyRejected.delete(key);
      return false;
    }

    return rejectedWord === token.toLowerCase();
  }

  private getWordAt(line: number, wordStartCol: number): string {
    const lineText = this.getLineText(line);
    let word = "";
    let col = wordStartCol;

    while (col < lineText.length && isAsciiLetter(lineText[col])) {
      word += lineText[col];
      col += 1;
    }

    return word;
  }

  private getLineText(line: number): string {
    return this.getText().split("\n")[line] ?? "";
  }

  private commitLastCorrection(): void {
    if (this.lastCorrection) {
      this.lastCorrection.committed = true;
    }
  }

  private showCorrectionStatus(original: string, suggestion: string, kind: "lookup" | "segmentation"): void {
    if (this.statusClearTimer) {
      clearTimeout(this.statusClearTimer);
    }

    const kindSuffix = kind === "segmentation" ? " (split)" : "";
    this.uiAdapter.setStatus(STATUS_KEY, `✓ ${original} → ${suggestion}${kindSuffix}`);
    this.statusClearTimer = setTimeout(() => {
      this.statusClearTimer = undefined;
      this.uiAdapter.setStatus(STATUS_KEY, undefined);
    }, STATUS_DURATION_MS);
  }

  private clearCorrectionStatusIfVisible(): void {
    if (!this.statusClearTimer) {
      return;
    }

    clearTimeout(this.statusClearTimer);
    this.statusClearTimer = undefined;
    this.uiAdapter.setStatus(STATUS_KEY, undefined);
  }

  private rememberRejected(line: number, wordStartCol: number, original: string): void {
    const key = makeRejectedKey(line, wordStartCol);
    this.recentlyRejected.set(key, original.toLowerCase());

    if (this.recentlyRejected.size <= REJECTION_CAP) {
      return;
    }

    const oldestKey = this.recentlyRejected.keys().next().value;
    if (oldestKey) {
      this.recentlyRejected.delete(oldestKey);
    }
  }

  private pruneRejectedEntries(currentLine: number): void {
    for (const [key] of this.recentlyRejected) {
      const [lineText, colText] = key.split(":");
      const line = Number(lineText);
      const wordStartCol = Number(colText);

      if (line !== currentLine) {
        this.recentlyRejected.delete(key);
        continue;
      }

      const expectedWord = this.recentlyRejected.get(key);
      if (!expectedWord) {
        continue;
      }

      const currentWord = this.getWordAt(line, wordStartCol).toLowerCase();
      if (currentWord !== expectedWord) {
        this.recentlyRejected.delete(key);
      }
    }
  }

  private isBackspaceEvent(data: string): boolean {
    return matchesKey(data, "backspace") || this.isBackspaceByte(data);
  }

  private isBackspaceByte(data: string): boolean {
    return data === "\x7f" || data === "\x08";
  }

  private isWholeControlEvent(data: string): boolean {
    return WHOLE_EVENT_KEYS.some((key) => matchesKey(data, key));
  }
}

function makeRejectedKey(line: number, wordStartCol: number): string {
  return `${line}:${wordStartCol}`;
}

/**
 * Walk left from tokenStartCol, skipping SAFE_BOUNDARY_CHARS, to extract up
 * to two preceding eligible tokens for correction context.
 */
export function extractCorrectionContext(
  lineText: string,
  tokenStartCol: number,
  cursor: { line: number; col: number },
): CorrectionContext {
  let prev: string | undefined;
  let prevPrev: string | undefined;

  let col = tokenStartCol - 1;

  // Find up to two eligible tokens walking left
  while (col >= 0) {
    // Skip boundary characters
    while (col >= 0 && SAFE_BOUNDARY_CHARS.has(lineText[col]!)) {
      col -= 1;
    }

    if (col < 0) break;

    // We have a non-boundary character — check if it's alphabetic
    if (!isAsciiLetter(lineText[col])) {
      // Non-alphabetic, non-boundary (e.g. digit): stop walking
      break;
    }

    // Capture the contiguous alphabetic run
    const runEnd = col;
    while (col >= 0 && isAsciiLetter(lineText[col])) {
      col -= 1;
    }
    const runStart = col + 1;
    const run = lineText.slice(runStart, runEnd + 1);

    // Check eligibility (must match ELIGIBLE_TOKEN: /^[A-Za-z]{2,}$/)
    if (!ELIGIBLE_TOKEN.test(run)) {
      // Single-letter or otherwise ineligible — skip past it, keep walking
      continue;
    }

    if (prev === undefined) {
      prev = run.toLowerCase();
    } else {
      prevPrev = run.toLowerCase();
      break;
    }
  }

  return { prev, prevPrev, lineText, cursor };
}

function isAsciiLetter(char: string | undefined): boolean {
  return !!char && /[A-Za-z]/.test(char);
}

function isPrintableChar(char: string): boolean {
  return char.length === 1 && char.charCodeAt(0) >= 32;
}

function isSafeBoundaryChar(char: string | undefined): boolean {
  return char === undefined || SAFE_BOUNDARY_CHARS.has(char);
}
