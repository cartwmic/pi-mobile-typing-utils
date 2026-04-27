import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { FakeCustomEditor, fakeMatchesKey, typeText } from "../test/fake-custom-editor.js";
import { CorrectionEngine } from "./correction-engine.js";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  CustomEditor: FakeCustomEditor,
}));

vi.mock("@mariozechner/pi-tui", () => ({
  matchesKey: fakeMatchesKey,
}));

const { AutocorrectEditor } = await import("./autocorrect-editor.js");

let tempDir = "";
let engine: CorrectionEngine;

describe("case preservation integration", () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "integration-case-preservation-"));
    const techDictPath = join(tempDir, "tech-dictionary.txt");
    writeFileSync(techDictPath, "", "utf8");

    engine = new CorrectionEngine({
      techDictPath,
      isLearned: () => false,
    });
    await engine.initialize();
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.each([
    ["Teh ", "The "],
    ["TEH ", "THE "],
    ["teh ", "the "],
  ])("corrects %s to %s", (input, expected) => {
    const editor = createEditor(engine);

    typeText(editor, input);

    expect(editor.getText()).toBe(expected);
  });
});

function createEditor(engine: CorrectionEngine) {
  const editor = new AutocorrectEditor({} as never, {} as never, {} as never, {
    correctionEngine: engine,
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
