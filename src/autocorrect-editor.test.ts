import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function fakeMatchesKey(data: string, keyId: string): boolean {
  switch (keyId) {
    case "backspace":
      return data === "\x7f" || data === "\x08";
    case "left":
      return data === "\x1b[D";
    case "right":
      return data === "\x1b[C";
    case "up":
      return data === "\x1b[A";
    case "down":
      return data === "\x1b[B";
    case "home":
      return data === "\x1b[H";
    case "end":
      return data === "\x1b[F";
    case "pageUp":
      return data === "\x1b[5~";
    case "pageDown":
      return data === "\x1b[6~";
    case "delete":
      return data === "\x1b[3~";
    case "insert":
      return data === "\x1b[2~";
    case "enter":
    case "return":
      return data === "\n" || data === "\r";
    case "tab":
      return data === "\t";
    case "escape":
      return data === "\x1b";
    default:
      return false;
  }
}

class FakeCustomEditor {
  text = "";
  cursorIndex = 0;
  autocompleteVisible = false;
  handledInputs: string[] = [];

  constructor(_tui: unknown, _theme: unknown, _keybindings: unknown, _options?: unknown) {}

  handleInput(data: string): void {
    this.handledInputs.push(data);

    if (fakeMatchesKey(data, "backspace")) {
      this.deleteBackward();
      return;
    }

    if (fakeMatchesKey(data, "left")) {
      this.cursorIndex = Math.max(0, this.cursorIndex - 1);
      return;
    }

    if (fakeMatchesKey(data, "right")) {
      this.cursorIndex = Math.min(this.text.length, this.cursorIndex + 1);
      return;
    }

    if (fakeMatchesKey(data, "up")) {
      this.moveVertical(-1);
      return;
    }

    if (fakeMatchesKey(data, "down")) {
      this.moveVertical(1);
      return;
    }

    if (fakeMatchesKey(data, "home")) {
      const { line } = this.getCursor();
      this.setCursorPosition(line, 0);
      return;
    }

    if (fakeMatchesKey(data, "end")) {
      const { line } = this.getCursor();
      const lineText = this.getLines()[line] ?? "";
      this.setCursorPosition(line, lineText.length);
      return;
    }

    if (fakeMatchesKey(data, "enter") || fakeMatchesKey(data, "return")) {
      this.insertTextAtCursor("\n");
      return;
    }

    if (fakeMatchesKey(data, "tab")) {
      this.insertTextAtCursor("\t");
      return;
    }

    if (data.startsWith("\x1b")) {
      return;
    }

    this.insertTextAtCursor(data);
  }

  getText(): string {
    return this.text;
  }

  getCursor(): { line: number; col: number } {
    const beforeCursor = this.text.slice(0, this.cursorIndex).split("\n");
    return {
      line: beforeCursor.length - 1,
      col: beforeCursor[beforeCursor.length - 1]?.length ?? 0,
    };
  }

  insertTextAtCursor(text: string): void {
    this.text = `${this.text.slice(0, this.cursorIndex)}${text}${this.text.slice(this.cursorIndex)}`;
    this.cursorIndex += text.length;
  }

  setText(text: string): void {
    this.text = text;
    this.cursorIndex = text.length;
  }

  setCursorPosition(line: number, col: number): void {
    const lines = this.getLines();
    const safeLine = Math.max(0, Math.min(line, Math.max(lines.length - 1, 0)));
    const safeCol = Math.max(0, Math.min(col, (lines[safeLine] ?? "").length));

    let index = 0;
    for (let currentLine = 0; currentLine < safeLine; currentLine += 1) {
      index += (lines[currentLine] ?? "").length + 1;
    }

    this.cursorIndex = index + safeCol;
  }

  isShowingAutocomplete(): boolean {
    return this.autocompleteVisible;
  }

  private getLines(): string[] {
    return this.text.split("\n");
  }

  private deleteBackward(): void {
    if (this.cursorIndex === 0) {
      return;
    }

    this.text = `${this.text.slice(0, this.cursorIndex - 1)}${this.text.slice(this.cursorIndex)}`;
    this.cursorIndex -= 1;
  }

  private moveVertical(direction: -1 | 1): void {
    const { line, col } = this.getCursor();
    const lines = this.getLines();
    const targetLine = Math.max(0, Math.min(line + direction, lines.length - 1));
    const targetCol = Math.min(col, (lines[targetLine] ?? "").length);
    this.setCursorPosition(targetLine, targetCol);
  }
}

vi.mock("@mariozechner/pi-coding-agent", () => ({
  CustomEditor: FakeCustomEditor,
}));

vi.mock("@mariozechner/pi-tui", () => ({
  matchesKey: fakeMatchesKey,
}));

const { AutocorrectEditor } = await import("./autocorrect-editor.js");

describe("AutocorrectEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("corrects on space trigger and clears status after 500ms", () => {
    const { editor, engine, learnedDictionary, uiAdapter } = createEditor({ teh: "the" });

    typeText(editor, "teh ");

    expect(editor.getText()).toBe("the ");
    expect(engine.shouldCorrect).toHaveBeenCalledWith("teh");
    expect(learnedDictionary.recordRejection).not.toHaveBeenCalled();
    expect(uiAdapter.setStatus).toHaveBeenCalledWith("typos-correction", "✓ teh → the");

    vi.advanceTimersByTime(500);

    expect(uiAdapter.setStatus).toHaveBeenLastCalledWith("typos-correction", undefined);
  });

  test("corrects on punctuation triggers", () => {
    for (const trigger of [".", ",", ";", ":", "!", "?"]) {
      const { editor } = createEditor({ modle: "model" });

      typeText(editor, `modle${trigger}`);

      expect(editor.getText()).toBe(`model${trigger}`);
    }
  });

  test("immediate backspace undoes the correction and second backspace deletes normally", () => {
    const { editor, learnedDictionary } = createEditor({ teh: "the" });

    typeText(editor, "teh ");
    editor.handleInput("\x7f");

    expect(editor.getText()).toBe("teh");
    expect(learnedDictionary.recordRejection).toHaveBeenCalledWith("teh");
    expect((editor as any).lastCorrection).toBeUndefined();

    editor.handleInput("\x7f");

    expect(editor.getText()).toBe("te");
  });

  test("cursor movement commits a correction so later backspace deletes normally", () => {
    const { editor, learnedDictionary } = createEditor({ teh: "the" });

    typeText(editor, "teh ");
    editor.handleInput("\x1b[A");
    editor.handleInput("\x7f");

    expect(learnedDictionary.recordRejection).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("the");
    expect((editor as any).lastCorrection?.committed).toBe(true);
  });

  test("typing any other key commits the correction", () => {
    const { editor, learnedDictionary } = createEditor({ teh: "the" });

    typeText(editor, "teh ");
    editor.handleInput("x");
    editor.handleInput("\x7f");

    expect(editor.getText()).toBe("the ");
    expect(learnedDictionary.recordRejection).not.toHaveBeenCalled();
    expect((editor as any).lastCorrection?.committed).toBe(true);
  });

  test("skips correction while autocomplete is visible", () => {
    const { editor, engine } = createEditor({ teh: "the" });
    (editor as FakeCustomEditor).autocompleteVisible = true;

    typeText(editor, "teh ");

    expect(editor.getText()).toBe("teh ");
    expect(engine.shouldCorrect).not.toHaveBeenCalled();
  });

  test("skips single-character words (below min-length-2 threshold)", () => {
    // Min-length guard is now 2; 1-char tokens are still filtered out.
    // ("is" and "to" are 2-letter words and are now eligible — see correction-engine tests.)
    const { editor, engine } = createEditor({ a: "the", i: "in" });

    typeText(editor, "a i ");

    expect(editor.getText()).toBe("a i ");
    expect(engine.shouldCorrect).not.toHaveBeenCalled();
  });

  test("skips non alphabetic tokens", () => {
    const { editor, engine } = createEditor({ foo: "bar", beta: "alphabet", force: "enforce" });

    typeText(editor, "don't café src/foo --force v1beta ");

    expect(editor.getText()).toBe("don't café src/foo --force v1beta ");
    expect(engine.shouldCorrect).not.toHaveBeenCalledWith("foo");
    expect(engine.shouldCorrect).not.toHaveBeenCalledWith("force");
    expect(engine.shouldCorrect).not.toHaveBeenCalledWith("beta");
  });

  test("skips correction when the cursor is not at a word boundary", () => {
    const { editor, engine } = createEditor({ xfoo: "bar" });

    typeText(editor, "teh");
    (editor as FakeCustomEditor).setCursorPosition(0, 1);
    typeText(editor, "xfoo ");

    expect(editor.getText()).toBe("txfoo eh");
    expect(engine.shouldCorrect).not.toHaveBeenCalledWith("xfoo");
  });

  test("double space does not attempt to correct an empty token", () => {
    const { editor, engine } = createEditor({ teh: "the" });

    typeText(editor, "teh  ");

    expect(editor.getText()).toBe("the  ");
    expect(engine.shouldCorrect).toHaveBeenCalledTimes(1);
  });

  test("suppresses re-correction at the same position after undo", () => {
    const { editor, engine, learnedDictionary } = createEditor({ nginx: "engine" });

    typeText(editor, "nginx ");
    editor.handleInput("\x7f");
    editor.handleInput(" ");

    expect(editor.getText()).toBe("nginx ");
    expect(learnedDictionary.recordRejection).toHaveBeenCalledWith("nginx");
    expect(engine.shouldCorrect).toHaveBeenCalledTimes(1);
  });

  test("suppression is cleared when the rejected word shifts position", () => {
    const { editor, engine } = createEditor({ nginx: "engine" });

    typeText(editor, "nginx ");
    editor.handleInput("\x7f");
    (editor as FakeCustomEditor).setCursorPosition(0, 0);
    typeText(editor, "x");
    (editor as FakeCustomEditor).setCursorPosition(0, editor.getText().length);
    editor.handleInput(" ");

    expect(engine.shouldCorrect).toHaveBeenCalledTimes(2);
  });

  test("suppression is cleared when the cursor leaves the line", () => {
    const { editor, engine } = createEditor({ nginx: "engine" });

    typeText(editor, "nginx ");
    editor.handleInput("\x7f");
    typeText(editor, "\n");
    typeText(editor, "nginx ");

    expect(engine.shouldCorrect).toHaveBeenCalledTimes(2);
  });

  test("processes multi-character printable payloads byte-by-byte and shows the last status", () => {
    const { editor, uiAdapter } = createEditor({ teh: "the", wsa: "was" });

    editor.handleInput("teh wsa ");

    expect(editor.getText()).toBe("the was ");
    expect(uiAdapter.setStatus).toHaveBeenCalledWith("typos-correction", "✓ teh → the");
    expect(uiAdapter.setStatus).toHaveBeenCalledWith("typos-correction", "✓ wsa → was");

    vi.advanceTimersByTime(499);
    expect(uiAdapter.setStatus).not.toHaveBeenLastCalledWith("typos-correction", undefined);

    vi.advanceTimersByTime(1);
    expect(uiAdapter.setStatus).toHaveBeenLastCalledWith("typos-correction", undefined);
  });

  test("escape sequences pass through untouched", () => {
    const { editor, engine } = createEditor({ teh: "the" });

    editor.handleInput("\x1b[A");

    expect((editor as FakeCustomEditor).handledInputs).toContain("\x1b[A");
    expect(editor.getText()).toBe("");
    expect(engine.shouldCorrect).not.toHaveBeenCalled();
  });

  test("interleaved buffered backspace can undo within the same chunk", () => {
    const { editor, learnedDictionary } = createEditor({ teh: "the" });

    editor.handleInput(`teh \x7f`);

    expect(editor.getText()).toBe("teh");
    expect(learnedDictionary.recordRejection).toHaveBeenCalledWith("teh");
  });

  test("next input clears the previous status immediately", () => {
    const { editor, uiAdapter } = createEditor({ teh: "the" });

    typeText(editor, "teh ");
    editor.handleInput("x");

    expect(uiAdapter.setStatus).toHaveBeenNthCalledWith(1, "typos-correction", "✓ teh → the");
    expect(uiAdapter.setStatus).toHaveBeenNthCalledWith(2, "typos-correction", undefined);
  });

  test("notifies when a rejected word becomes learned", () => {
    const { editor, learnedDictionary, uiAdapter } = createEditor(
      { teh: "the" },
      { learnedOnReject: true },
    );

    typeText(editor, "teh ");
    editor.handleInput("\x7f");

    expect(learnedDictionary.recordRejection).toHaveBeenCalledWith("teh");
    expect(uiAdapter.notify).toHaveBeenCalledWith("Learned: teh", "info");
  });
});

function createEditor(
  corrections: Record<string, string>,
  options: { learnedOnReject?: boolean } = {},
): {
  editor: InstanceType<typeof AutocorrectEditor> & FakeCustomEditor;
  engine: { shouldCorrect: ReturnType<typeof vi.fn> };
  learnedDictionary: { recordRejection: ReturnType<typeof vi.fn> };
  uiAdapter: { setStatus: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
} {
  const engine = {
    shouldCorrect: vi.fn((word: string) => {
      const suggestion = corrections[word];
      return suggestion ? { corrected: true as const, suggestion } : { corrected: false as const };
    }),
  };

  const learnedDictionary = {
    recordRejection: vi.fn((word: string) => ({
      learned: options.learnedOnReject ?? false,
      word: word.toLowerCase(),
    })),
  };

  const uiAdapter = {
    setStatus: vi.fn(),
    notify: vi.fn(),
  };

  const editor = new AutocorrectEditor({} as never, {} as never, {} as never, {
    correctionEngine: engine as never,
    learnedDictionary: learnedDictionary as never,
    uiAdapter,
  }) as InstanceType<typeof AutocorrectEditor> & FakeCustomEditor;

  return { editor, engine, learnedDictionary, uiAdapter };
}

function typeText(editor: { handleInput(data: string): void }, text: string): void {
  for (const char of text) {
    editor.handleInput(char);
  }
}
