/**
 * integration-segmentation.test.ts
 *
 * Integration tests for the word-segmentation correction path, driven through
 * a full AutocorrectEditor with a real CorrectionEngine (bundled SymSpell dicts).
 *
 * ## Tech-dict fixture
 *
 * A custom tech dict is used (NOT the bundled data/tech-dictionary.txt) because:
 *   - The bundled dict contains "helloworld", which would suppress the
 *     "helloworld → hello world" segmentation test via the inAnyDict gate.
 *   - The custom dict includes "kubernetes" to demonstrate the v1 limitation:
 *     even when "kubernetes" is a known tech word, the concatenation "kubernetespod"
 *     is NOT segmented because wordSegmentation() consults only SymSpell unigrams
 *     (not the tech dict).
 *
 * ## Fixture notes
 *
 * - "andro" (5 chars): the task description attributes rejection to the probability
 *   floor, but the actual gate that fires is the length gate (5 < segmentationMinLength=6).
 *   Documented here so future readers are not confused.
 * - "imho" (4 chars): filtered by length gate (4 < 6). Both "andro" and "imho"
 *   demonstrate the same length-gate behavior.
 * - "kubernetespod" (13 chars): passes the length gate, but wordSegmentation() cannot
 *   produce "kubernetes pod" because "kubernetes" is absent from the SymSpell unigram
 *   index (it is only in the tech dict layer). This is the documented v1 limitation.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { FakeCustomEditor, fakeMatchesKey, typeText } from "../test/fake-custom-editor.js";
import { CorrectionEngine } from "./correction-engine.js";
import { __resetTrigramSingletonForTests } from "./trigram-table.js";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  CustomEditor: FakeCustomEditor,
}));

vi.mock("@mariozechner/pi-tui", () => ({
  matchesKey: fakeMatchesKey,
}));

// Dynamic import after mocks are established.
const { AutocorrectEditor } = await import("./autocorrect-editor.js");

// ─── Shared engine (cold-start once per file) ─────────────────────────────────

let tempDir = "";
let engine: CorrectionEngine;

describe("segmentation integration", () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "integration-segmentation-"));
    const techDictPath = join(tempDir, "tech.txt");

    // Custom tech dict: includes "kubernetes" to show the v1 limitation, but does
    // NOT include "helloworld" (so it can segment freely).
    writeFileSync(
      techDictPath,
      ["kubernetes", "kubectl", "docker", "terraform"].join("\n"),
      "utf8",
    );

    // Isolate the index cache so the test always has a reproducible state.
    vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", join(tempDir, "cache"));
    const { __resetCacheDisabledForTests } = await import("./index-cache.js");
    __resetCacheDisabledForTests();

    engine = new CorrectionEngine({
      techDictPath,
      isLearned: () => false,
    });
    await engine.initialize();
  }, 60_000);

  afterAll(async () => {
    __resetTrigramSingletonForTests();
    vi.unstubAllEnvs();
    const { __resetCacheDisabledForTests } = await import("./index-cache.js");
    __resetCacheDisabledForTests();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    __resetTrigramSingletonForTests();
    // Detach any trigram table left by a previous test.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).rerank?.attachTrigramTable(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetTrigramSingletonForTests();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).rerank?.attachTrigramTable(null);
    vi.restoreAllMocks();
  });

  // ── Classic concatenation: "thequick" → "the quick" ──────────────────────────
  //
  // Both "the" and "quick" are in the SymSpell unigram dictionary. The segmentation
  // probability is well above the default floor (−12.0). No context is needed.

  test("thequick + space → the quick + space (classic concatenation)", () => {
    const editor = createEditor(engine);

    typeText(editor, "thequick ");

    expect(editor.getText()).toBe("the quick ");
  });

  // ── Concatenation of common words: "helloworld" → "hello world" ──────────────
  //
  // "helloworld" is absent from the custom tech dict, so the inAnyDict gate does
  // not fire. Both "hello" and "world" are in SymSpell unigrams.

  test("helloworld + space → hello world + space (both segments in SymSpell unigram dict)", () => {
    const editor = createEditor(engine);

    typeText(editor, "helloworld ");

    expect(editor.getText()).toBe("hello world ");
  });

  // ── Length gate: "andro" (5 chars < segmentationMinLength=6) ─────────────────
  //
  // NOTE: The task description attributes this to the probability floor. The actual
  // gate that fires is the LENGTH gate: 5 < default segmentationMinLength=6.
  // "andro" is therefore identical to "imho" in terms of the filtering mechanism.
  // If SymSpell lookup also finds no ED=1 English candidates, the text is unchanged.

  test("andro → NOT split by segmentation (5 chars < segmentationMinLength=6; length gate fires)", () => {
    // NOTE: Contrary to the task description, the gate that fires for "andro" is the
    // LENGTH gate (5 chars < default segmentationMinLength=6), NOT the probability floor.
    // SymSpell DOES correct "andro" via the lookup path (to "andre" at ED=1).
    // The key assertion: segmentation is NEVER applied (no space introduced).

    const result = engine.shouldCorrect("andro");
    if (result.corrected) {
      // If corrected, must be via lookup (not segmentation).
      expect(result.kind).toBe("lookup");
    }

    // Also verify via editor: no space is inserted into the word.
    const editor = createEditor(engine);
    typeText(editor, "andro ");
    const text = editor.getText();
    // Segmentation would introduce a space inside "andro" (e.g., "an dro").
    // Lookup may change the spelling (e.g., "andro" → "andre"), but that is a
    // single word with no internal space.
    const wordPart = text.replace(/ $/, "");
    expect(wordPart).not.toContain(" ");
  });

  // ── Length gate: "imho" (4 chars < segmentationMinLength=6) ──────────────────
  //
  // 4 < 6 → length gate fires before segmentation is even attempted.
  // The existing unit test (7.7.3) documents that lookup may or may not find
  // a suggestion; the key assertion is no SEGMENTATION result.

  test("imho + space → NOT split by segmentation (4 chars < segmentationMinLength=6)", () => {
    const editor = createEditor(engine);

    typeText(editor, "imho ");

    const text = editor.getText();
    // Must not be split by segmentation (no "im ho" or any other split form).
    // Lookup might or might not correct it (the exact candidate is corpus-dependent).
    expect(text).not.toMatch(/im\s+ho/);
    // Key assertion from spec: segmentation never fires for tokens below minLength.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sym = (engine as any).symspell;
    const wsSpy = vi.spyOn(sym, "wordSegmentation");
    // Re-trigger shouldCorrect via a fresh editor call for the spy assertion.
    engine.shouldCorrect("imho");
    expect(wsSpy).not.toHaveBeenCalled();
  });

  // ── V1 limitation: "kubernetespod" is NOT split ───────────────────────────────
  //
  // "kubernetes" is in the custom tech dict, so users would expect the concatenation
  // "kubernetespod" to split into "kubernetes pod". However, wordSegmentation() only
  // consults the SymSpell unigram index, which does NOT include "kubernetes" (it is
  // layered in the tech dict above SymSpell). Therefore, no valid high-probability
  // segmentation is found and the token is not split.
  //
  // This is the documented v1 limitation: tech-prose concatenations remain unsegmented.

  test("kubernetespod + space → NOT split (kubernetes absent from SymSpell unigrams; v1 limitation)", () => {
    const editor = createEditor(engine);

    typeText(editor, "kubernetespod ");

    const text = editor.getText();
    // Must not produce "kubernetes pod" (or any other segmentation containing
    // "kubernetes" + a space), because "kubernetes" is not in SymSpell unigrams.
    expect(text).not.toContain("kubernetes pod");
    expect(text).not.toContain("kubernetes ");
    // The token should remain unsegmented.  It might be spelled-corrected by
    // the lookup path, but only if SymSpell has an ED-1/ED-2 candidate.
    // In practice (13-char token, effectiveED=2), lookup is unlikely to match.
    // We do NOT assert `text === "kubernetespod "` to remain robust against
    // future corpus changes; the segmentation assertion above is the binding check.
  });

  // ── Segmentation result is correct type in CorrectionEngine ──────────────────
  //
  // Direct shouldCorrect() call (not via editor) to verify the returned kind.

  test("thequick shouldCorrect returns kind='segmentation' with correct segments", () => {
    const result = engine.shouldCorrect("thequick");
    expect(result).toEqual({
      corrected: true,
      kind: "segmentation",
      suggestion: "the quick",
      segments: ["the", "quick"],
    });
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createEditor(
  correctionEngine: CorrectionEngine,
): InstanceType<typeof AutocorrectEditor> & FakeCustomEditor {
  return new AutocorrectEditor({} as never, {} as never, {} as never, {
    correctionEngine,
    learnedDictionary: {
      recordRejection: vi.fn(() => ({ learned: false, word: "" })),
    } as never,
    uiAdapter: { setStatus: vi.fn(), notify: vi.fn() },
  }) as InstanceType<typeof AutocorrectEditor> & FakeCustomEditor;
}
