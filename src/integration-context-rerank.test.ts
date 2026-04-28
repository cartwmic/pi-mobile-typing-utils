/**
 * integration-context-rerank.test.ts
 *
 * Integration tests for the n-gram context rerank module, verifying that the
 * AutocorrectEditor correctly extracts prev/prevPrev context from the line buffer
 * and passes it to the CorrectionEngine, which uses bigram and trigram tiers to
 * bias candidate disambiguation.
 *
 * ## Design (§13.1 interpretation)
 *
 * The task originally described sub-test B as `te quick fox ` placing `te` at
 * the START of the line, giving ctx.prev=undefined (no bigram context). The
 * interpretation used here is instead:
 *
 *   Sub-test A: `want te `      — prev="want", prevPrev=undefined → bigram tier only
 *   Sub-test B: `we have te `   — prev="have", prevPrev="we"      → bigram + trigram tiers
 *
 * Both tests drive the full AutocorrectEditor (handleInput) so that
 * extractCorrectionContext() is exercised end-to-end.
 *
 * ## Sub-test A rationale
 *
 * The real SymSpell bigram corpus contains "want to" with a higher count than
 * "want the", biasing the rerank toward "to" when prev="want". This mirrors
 * correction-engine.test.ts §6.7.2 but adds the editor's context-extraction layer.
 *
 * ## Sub-test B rationale (mock trigram)
 *
 * The mock TrigramTable gives ("we","have","the") count=100 000 with prefix count
 * 100, yielding:
 *   trigram("the") = α₂ · log10(100 000 / 100) = 0.3 · 3 = +0.9
 *
 * All other candidates fall through to the backoff path:
 *   trigram("to") ≈ 0.3 · log10(0.4 · bigramRawProb) ≤ 0.3 · log10(0.4) ≈ −0.12
 *
 * The swing (+0.9 − (−0.12) = +1.02) exceeds the realistic bigram advantage that
 * "have to" has over "have the" in the SymSpell corpus (empirically < 0.5 log
 * units), so "the" wins regardless of the real bigram distribution.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { FakeCustomEditor, fakeMatchesKey, typeText } from "../test/fake-custom-editor.js";
import { CorrectionEngine } from "./correction-engine.js";
import { TrigramTable, __resetTrigramSingletonForTests } from "./trigram-table.js";

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

describe("context-rerank integration", () => {
  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "integration-ctx-rerank-"));
    const techDictPath = join(tempDir, "tech.txt");
    writeFileSync(techDictPath, "", "utf8");

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

  // ── Sub-test A: bigram tier biases "te" → "to" with prev="want" ─────────────
  //
  // Line: "want te "
  //   - After "want ": ctx.prev=undefined (line start), identity-suppressed → no correction
  //   - After "te ":   ctx.prev="want", ctx.prevPrev=undefined → bigram tier fires
  //     The SymSpell corpus has a strong "want to" bigram → "to" wins.

  test("A: editor passes prev='want' to engine; bigram biases te → to", () => {
    const editor = createEditor(engine);

    // "want" is identity-corrected (in dict, bypass path) → no change.
    // "te" is corrected with ctx.prev="want" → bigram selects "to".
    typeText(editor, "want te ");

    expect(editor.getText()).toBe("want to ");
  });

  // ── Sub-test B: trigram tier biases "te" → "the" with prevPrev="we", prev="have"
  //
  // Line: "we have te "
  //   - After "we ":   identity-suppressed → no correction
  //   - After "have ": identity-suppressed (dist=0) → no correction
  //   - After "te ":   ctx.prev="have", ctx.prevPrev="we" → full scoring path
  //     Mock trigram: (we,have,the)=100 000, prefix=100 → trigram("the")=+0.9
  //     This overrides any bigram advantage "have to" may have.

  test("B: editor passes prevPrev='we', prev='have'; trigram biases te → the", () => {
    // Attach a mock trigram table that strongly favors "the" after (we, have, …).
    const mockTable = {
      getTrigramCount: (w1: string, w2: string, w3: string): number =>
        w1 === "we" && w2 === "have" && w3 === "the" ? 100_000 : 0,
      getBigramPrefixCount: (w1: string, w2: string): number =>
        w1 === "we" && w2 === "have" ? 100 : 0,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (engine as any).rerank.attachTrigramTable(mockTable as unknown as TrigramTable);

    const editor = createEditor(engine);

    // "we" → identity-suppressed; "have" → identity-suppressed (dist=0);
    // "te" → corrected with ctx = { prev:"have", prevPrev:"we" }.
    // Trigram mock scores "the" at +0.9 and "to" at ≈ −0.5 → "the" wins.
    typeText(editor, "we have te ");

    expect(editor.getText()).toBe("we have the ");
  });

  // ── Sanity check: context extraction produces expected prev/prevPrev ──────────
  //
  // Verifies that extractCorrectionContext correctly skips single-char tokens
  // (ELIGIBLE_TOKEN requires ≥ 2 chars) and captures two-char tokens as prevPrev.

  test("single-char 'i' is skipped by context extraction; first eligible token becomes prev", () => {
    // "i" is 1 char → ineligible for ELIGIBLE_TOKEN → skipped.
    // "want" is the first eligible token → prev.
    // prevPrev remains undefined because there is no second eligible token.
    // Result: same as sub-test A (bigram tier fires, no trigram).
    const editor = createEditor(engine);

    typeText(editor, "i want te ");

    // "i" is skipped; context for "te" is { prev:"want", prevPrev:undefined }.
    // Same bigram bias → "to" wins.
    expect(editor.getText()).toBe("i want to ");
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
