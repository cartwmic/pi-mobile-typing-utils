import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FakeCustomEditor, fakeMatchesKey, typeText } from "../test/fake-custom-editor.js";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  CustomEditor: FakeCustomEditor,
}));

vi.mock("@mariozechner/pi-tui", () => ({
  matchesKey: fakeMatchesKey,
}));

const { AutocorrectEditor } = await import("./autocorrect-editor.js");

describe("autocomplete integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("does not correct trigger characters while autocomplete is visible", () => {
    const engine = {
      shouldCorrect: vi.fn(() => ({ corrected: true as const, suggestion: "the" })),
    };
    const editor = createEditor(engine);

    editor.autocompleteVisible = true;
    typeText(editor, "teh ");

    expect(editor.getText()).toBe("teh ");
    expect(engine.shouldCorrect).not.toHaveBeenCalled();
  });

  test.each(["/", "@"])("passes %s through without invoking correction logic", (char) => {
    const engine = {
      shouldCorrect: vi.fn(() => ({ corrected: true as const, suggestion: "ignored" })),
    };
    const editor = createEditor(engine);

    editor.handleInput(char);

    expect(editor.getText()).toBe(char);
    expect(editor.handledInputs).toEqual([char]);
    expect(engine.shouldCorrect).not.toHaveBeenCalled();
  });
});

function createEditor(engine: { shouldCorrect: (word: string) => unknown }) {
  const editor = new AutocorrectEditor({} as never, {} as never, {} as never, {
    correctionEngine: engine as never,
    learnedDictionary: {
      recordRejection: vi.fn(() => ({ learned: false, word: "" })),
    } as never,
    uiAdapter: {
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
  }) as InstanceType<typeof AutocorrectEditor> & FakeCustomEditor;

  return editor;
}
