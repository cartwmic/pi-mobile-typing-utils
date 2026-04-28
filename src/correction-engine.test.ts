import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CorrectionEngine,
  FALLBACK_EDIT_DISTANCE_STEP_EVERY,
  FALLBACK_MIN_EDIT_DISTANCE,
} from "./correction-engine.js";

let tempDir = "";
let techDictPath = "";

describe("CorrectionEngine", () => {
  let learnedWords: Set<string>;
  let engine: CorrectionEngine;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "correction-engine-"));
    techDictPath = join(tempDir, "tech-dictionary.txt");
    writeFileSync(techDictPath, ["nginx", "kubectl", "webpack"].join("\n"), "utf8");

    learnedWords = new Set<string>();
    engine = new CorrectionEngine({
      techDictPath,
      isLearned: (word) => learnedWords.has(word),
    });
    await engine.initialize();
  });

  afterAll(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    learnedWords = new Set<string>();
  });

  test("corrects common typos", () => {
    expect(engine.shouldCorrect("teh")).toEqual({ corrected: true, suggestion: "the" });
    expect(engine.shouldCorrect("modle")).toEqual({ corrected: true, suggestion: "model" });
    expect(engine.shouldCorrect("atuhorization")).toEqual({ corrected: true, suggestion: "authorization" });
  });

  test("preserves known tech words", () => {
    expect(engine.shouldCorrect("nginx")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("kubectl")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("webpack")).toEqual({ corrected: false });
  });

  test("skips short words", () => {
    // Single-character words still fail the min-length-2 guard.
    // Two-character valid English words ("to", "is") pass the guard but are
    // identity-suppressed (SymSpell returns them at distance 0).
    expect(engine.shouldCorrect("a")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("to")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("is")).toEqual({ corrected: false });
  });

  test("2-letter typos are now eligible for correction (min length 2)", () => {
    // "og" is a 2-letter token: previously filtered by the {3,} guard, now
    // eligible with {2,}. SymSpell suggests "of" at edit distance 1.
    expect(engine.shouldCorrect("og")).toEqual({ corrected: true, suggestion: "of" });
  });

  test("leaves unknown novel words alone", () => {
    expect(engine.shouldCorrect("xyzzyplugh")).toEqual({ corrected: false });
  });

  test("returns no correction before initialize completes", () => {
    const notReadyEngine = new CorrectionEngine({
      techDictPath,
      isLearned: () => false,
    });

    expect(notReadyEngine.shouldCorrect("teh")).toEqual({ corrected: false });
  });

  test("preserves case on corrections", () => {
    expect(engine.shouldCorrect("Teh")).toEqual({ corrected: true, suggestion: "The" });
    expect(engine.shouldCorrect("TEH")).toEqual({ corrected: true, suggestion: "THE" });
    expect(engine.shouldCorrect("teh")).toEqual({ corrected: true, suggestion: "the" });
    expect(engine.shouldCorrect("tHe")).toEqual({ corrected: true, suggestion: "the" });
  });

  test("skips non-alphabetic tokens", () => {
    expect(engine.shouldCorrect("src/foo.ts")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("my_var")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("--force")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("v1beta1")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("don't")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("café")).toEqual({ corrected: false });
  });

  test("suppresses identity corrections", () => {
    expect(engine.shouldCorrect("the")).toEqual({ corrected: false });
  });

  test("corrects distance-2 typos (edit distance 2 required)", () => {
    // "reccomend" is 2 edits from "recommend" (double-c instead of single, shifted letters);
    // it would return { corrected: false } at distance 1 — requires distance-2 index + lookup.
    // Note: the task specified "kuberentes" → "kubernetes", but "kubernetes" is absent from
    // SymSpell's bundled English frequency dictionary so it cannot be suggested at any distance.
    expect(engine.shouldCorrect("reccomend")).toEqual({ corrected: true, suggestion: "recommend" });
  });

  test("uses live learned-dictionary lookups without re-initializing", () => {
    const beforeLearning = engine.shouldCorrect("termux");

    expect([true, false]).toContain(beforeLearning.corrected);

    learnedWords.add("termux");

    expect(engine.shouldCorrect("termux")).toEqual({ corrected: false });
  });

  test("performs case-insensitive tech and learned dictionary checks", () => {
    learnedWords.add("termux");

    expect(engine.shouldCorrect("Nginx")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("NGINX")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("nginx")).toEqual({ corrected: false });

    expect(engine.shouldCorrect("Termux")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("TERMUX")).toEqual({ corrected: false });
    expect(engine.shouldCorrect("termux")).toEqual({ corrected: false });
  });
});

// Regression coverage for T09 (mixed-case fallback): exercises the SAME bundled
// tech dictionary the live extension loads, not a synthetic fixture. Earlier
// unit tests with a 3-word fixture missed this because common English words
// like "the" leak into the cspell-derived bundled dictionary, and the engine
// previously short-circuited on tech-dict membership BEFORE the SymSpell
// lookup that performs the mixed-case → lowercase normalization.
describe("CorrectionEngine (bundled tech dictionary)", () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundledTechDictPath = resolve(projectRoot, "data/tech-dictionary.txt");
  let learned: Set<string>;
  let bundledEngine: CorrectionEngine;

  beforeAll(async () => {
    learned = new Set<string>();
    bundledEngine = new CorrectionEngine({
      techDictPath: bundledTechDictPath,
      isLearned: (word) => learned.has(word),
    });
    await bundledEngine.initialize();
  });

  beforeEach(() => {
    learned.clear();
  });

  test("T09: mixed-case input falls back to lowercase even when the lowered form is in the tech dictionary", () => {
    expect(bundledEngine.shouldCorrect("tHe")).toEqual({ corrected: true, suggestion: "the" });
    expect(bundledEngine.shouldCorrect("THe")).toEqual({ corrected: true, suggestion: "the" });
    expect(bundledEngine.shouldCorrect("tHE")).toEqual({ corrected: true, suggestion: "the" });
  });

  test("T09: supported case patterns still produce expected corrections", () => {
    expect(bundledEngine.shouldCorrect("teh")).toEqual({ corrected: true, suggestion: "the" });
    expect(bundledEngine.shouldCorrect("Teh")).toEqual({ corrected: true, suggestion: "The" });
    expect(bundledEngine.shouldCorrect("TEH")).toEqual({ corrected: true, suggestion: "THE" });
  });

  test("T09: identity correction still suppressed for clean lowercase / title / upper input", () => {
    expect(bundledEngine.shouldCorrect("the")).toEqual({ corrected: false });
    expect(bundledEngine.shouldCorrect("The")).toEqual({ corrected: false });
    expect(bundledEngine.shouldCorrect("THE")).toEqual({ corrected: false });
  });

  test("bundled tech terms are still preserved (no spurious correction)", () => {
    expect(bundledEngine.shouldCorrect("nginx")).toEqual({ corrected: false });
    expect(bundledEngine.shouldCorrect("kubectl")).toEqual({ corrected: false });
    expect(bundledEngine.shouldCorrect("webpack")).toEqual({ corrected: false });
    // 'accessor' is in the bundled tech dict and SymSpell suggests 'accessory';
    // the post-SymSpell tech-dict suppression must keep 'accessor' as-is.
    expect(bundledEngine.shouldCorrect("accessor")).toEqual({ corrected: false });
  });

  test("learned words still suppress SymSpell-suggested changes", () => {
    learned.add("termux");
    expect(bundledEngine.shouldCorrect("termux")).toEqual({ corrected: false });
    expect(bundledEngine.shouldCorrect("Termux")).toEqual({ corrected: false });
    expect(bundledEngine.shouldCorrect("TERMUX")).toEqual({ corrected: false });
  });
});

// ---------------------------------------------------------------------------
// Section 2 — Adaptive edit-distance curve
// ---------------------------------------------------------------------------
describe("Section 2 — Adaptive edit-distance curve", () => {
  let curveDir: string;
  let curveTechDict: string;

  beforeAll(() => {
    curveDir = mkdtempSync(join(tmpdir(), "curve-engine-"));
    curveTechDict = join(curveDir, "tech.txt");
    writeFileSync(curveTechDict, "", "utf8");
  });

  afterAll(() => {
    rmSync(curveDir, { recursive: true, force: true });
  });

  // 2.5.1 — Default curve table, maxED=2
  describe("2.5.1 default curve (minED=1, step=4, minWL=2, maxED=2)", () => {
    // Access private effectiveEditDistance via (engine as any) — intentional for
    // unit-testing the pure arithmetic of the adaptive-curve formula.
    let e: CorrectionEngine;

    beforeAll(async () => {
      e = new CorrectionEngine({
        techDictPath: curveTechDict,
        isLearned: () => false,
        maxEditDistance: 2,
        getMinEditDistance: () => 1,
        getEditDistanceStepEvery: () => 4,
        getMinWordLength: () => 2,
      });
      await e.initialize();
    });

    test.each([
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 2],
      [7, 2],
      [10, 2],
    ] as const)("length %d → ED %d", (len, expected) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((e as any).effectiveEditDistance(len)).toBe(expected);
    });
  });

  // 2.5.1 — Curve with maxED=3
  describe("2.5.1 curve (minED=1, step=4, minWL=2, maxED=3)", () => {
    let e: CorrectionEngine;

    beforeAll(async () => {
      e = new CorrectionEngine({
        techDictPath: curveTechDict,
        isLearned: () => false,
        maxEditDistance: 3,
        getMinEditDistance: () => 1,
        getEditDistanceStepEvery: () => 4,
        getMinWordLength: () => 2,
      });
      await e.initialize();
    });

    test.each([
      [6, 2],
      [10, 3],
    ] as const)("length %d → ED %d", (len, expected) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((e as any).effectiveEditDistance(len)).toBe(expected);
    });
  });

  // 2.5.1 — Curve with maxED=4
  describe("2.5.1 curve (minED=1, step=4, minWL=2, maxED=4)", () => {
    let e: CorrectionEngine;

    beforeAll(async () => {
      e = new CorrectionEngine({
        techDictPath: curveTechDict,
        isLearned: () => false,
        maxEditDistance: 4,
        getMinEditDistance: () => 1,
        getEditDistanceStepEvery: () => 4,
        getMinWordLength: () => 2,
      });
      await e.initialize();
    });

    test("length 14 → ED 4", () => {
      // 1 + floor((14-2)/4) = 1 + 3 = 4, clamped to maxED=4
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((e as any).effectiveEditDistance(14)).toBe(4);
    });
  });

  // 2.5.2 — Long-word ED capped at maxEditDistance
  test("2.5.2 long-word ED is capped at maxEditDistance", () => {
    const e = new CorrectionEngine({
      techDictPath: curveTechDict,
      isLearned: () => false,
      maxEditDistance: 2,
      getMinEditDistance: () => 1,
      getEditDistanceStepEvery: () => 1, // very aggressive ramp
      getMinWordLength: () => 2,
    });
    // With step=1, a 100-char word gives intermediate = 1 + (100-2)/1 = 99, but cap is 2.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((e as any).effectiveEditDistance(100)).toBe(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((e as any).effectiveEditDistance(1000)).toBe(2);
  });

  // 2.5.3 — Short-word ED floored at minEditDistance
  test("2.5.3 short-word ED is floored at minEditDistance", () => {
    const e = new CorrectionEngine({
      techDictPath: curveTechDict,
      isLearned: () => false,
      maxEditDistance: 3,
      getMinEditDistance: () => 2, // floor is 2
      getEditDistanceStepEvery: () => 4,
      getMinWordLength: () => 2,
    });
    // At length == minWL (2): 2 + floor(0/4) = 2 → floored at 2
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((e as any).effectiveEditDistance(2)).toBe(2);
    // At length 3: 2 + floor(1/4) = 2 → still floored at 2
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((e as any).effectiveEditDistance(3)).toBe(2);
  });

  // 2.5.4 — minED=0 sub-tests
  describe("2.5.4 minED=0 behavior", () => {
    let e0: CorrectionEngine;

    beforeAll(async () => {
      e0 = new CorrectionEngine({
        techDictPath: curveTechDict,
        isLearned: () => false,
        maxEditDistance: 2,
        getMinEditDistance: () => 0,
        getEditDistanceStepEvery: () => 4,
        getMinWordLength: () => 2,
      });
      await e0.initialize();
    });

    test("(a) lowercase exact match → no correction (identity-suppression applies at distance 0)", () => {
      // "the" is in the dictionary; SymSpell finds it at distance 0; identity-suppression → no correction
      expect(e0.shouldCorrect("the")).toEqual({ corrected: false });
    });

    test("(b) mixed-case exact match → case-normalized correction", () => {
      // "tHe" lowercases to "the", which is an exact dictionary match at distance 0.
      // hasMixedCase("tHe") is true → engine returns { corrected: true, suggestion: "the" }
      expect(e0.shouldCorrect("tHe")).toEqual({ corrected: true, suggestion: "the" });
    });

    test("(c) non-dictionary input → no correction (no exact match at distance 0)", () => {
      // "xyzzyplugh" is not in any dictionary; SymSpell finds nothing at distance 0 → no correction
      expect(e0.shouldCorrect("xyzzyplugh")).toEqual({ corrected: false });
    });
  });

  // 2.5.5 — Live curve change is observed without rebuild
  test("2.5.5 live curve change is observed without rebuild", async () => {
    let currentMinED = 1;

    // Build with maxED=2 and a mutable getMinEditDistance accessor.
    // At minED=1, length-2 words use ED=1, so "og" → "of" (corrected).
    // At minED=0, length-2 words use ED=0 (exact match only), so "og" → no correction
    // (it's not in the dictionary).
    const e = new CorrectionEngine({
      techDictPath: curveTechDict,
      isLearned: () => false,
      maxEditDistance: 2,
      getMinEditDistance: () => currentMinED,
      getEditDistanceStepEvery: () => 4,
      getMinWordLength: () => 2,
    });
    await e.initialize();

    // With minED=1, "og" (2 chars, ED=1 to "of") is corrected.
    expect(e.shouldCorrect("og")).toEqual({ corrected: true, suggestion: "of" });

    // Mutate the accessor — no rebuild.
    currentMinED = 0;

    // Now "og" (2 chars) uses ED=0 (exact match only) → not in dictionary → no correction.
    expect(e.shouldCorrect("og")).toEqual({ corrected: false });
  });

  // 2.5.6 — Defensive clamp: accessor returns getMinEditDistance() > maxEditDistance
  test("2.5.6 defensive clamp: transient minED > maxED does not throw or exceed index ceiling", () => {
    // Simulate a transient inconsistency: accessor returns 5 but maxED=2.
    const e = new CorrectionEngine({
      techDictPath: curveTechDict,
      isLearned: () => false,
      maxEditDistance: 2,
      getMinEditDistance: () => 5, // invalid: exceeds maxEditDistance
      getEditDistanceStepEvery: () => 4,
      getMinWordLength: () => 2,
    });

    // effectiveEditDistance must never return > maxEditDistance and must not throw.
    for (const len of [2, 3, 6, 10, 50]) {
      let result: number;
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = (e as any).effectiveEditDistance(len);
      }).not.toThrow();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((e as any).effectiveEditDistance(len)).toBeLessThanOrEqual(2);
    }
  });

  // 2.5.7 — Fallback constants
  test("2.5.7 FALLBACK constants match spec defaults", () => {
    expect(FALLBACK_MIN_EDIT_DISTANCE).toBe(1);
    expect(FALLBACK_EDIT_DISTANCE_STEP_EVERY).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Section 3 — Drop bigram loading
// ---------------------------------------------------------------------------
describe("Section 3 — Drop bigram loading", () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundledTechDictPath = resolve(projectRoot, "data/tech-dictionary.txt");

  // 3.4 — bigrams.size === 0 after unigram-only initialization
  test("3.4 unigram-only path: bigrams.size === 0 after initialize()", async () => {
    const e = new CorrectionEngine({
      techDictPath: bundledTechDictPath,
      isLearned: () => false,
    });
    await e.initialize();

    // Reach into nominally-private SymSpell state to assert no bigrams were
    // loaded. The field name was verified by inspecting
    // node_modules/symspell-ts/dist/symspell.js (line ~135: `this.bigrams = new Map()`).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((e as any).symspell.bigrams.size).toBe(0);
  });

  // 3.5 — Parity test: unigram-only path vs. upstream loadDefaultDictionaries
  test(
    "3.5 parity: unigram-only and fallback paths return identical shouldCorrect results",
    async () => {
      // Build engine via upstream loadDefaultDictionaries (force fallback by
      // injecting a null-returning resolver via _resolveSymspellPackageRoot).
      const fallbackEngine = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
        _resolveSymspellPackageRoot: () => null,
      });
      await fallbackEngine.initialize();

      // Build engine via unigram-only loader (real resolver).
      const unigramEngine = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
      });
      await unigramEngine.initialize();

      const corpus = [
        "teh",
        "the",
        "ot",
        "kbuernetes",
        "accomodate",
        "vitest",
        "termux",
        "kubrnetes",
        "supercalifragilisticexpialidocious",
      ];

      for (const word of corpus) {
        const fallbackResult = fallbackEngine.shouldCorrect(word);
        const unigramResult = unigramEngine.shouldCorrect(word);
        expect(unigramResult).toEqual(
          fallbackResult,
          `shouldCorrect("${word}") diverged: unigram=${JSON.stringify(unigramResult)}, fallback=${JSON.stringify(fallbackResult)}`,
        );
      }
    },
    // Two full engine builds; allow 30 s
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Section 4 — Engine readiness state
// ---------------------------------------------------------------------------
describe("Section 4 — Engine readiness state", () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundledTechDictPath = resolve(projectRoot, "data/tech-dictionary.txt");

  // 4.4.1 — Constructor → "building"
  test("4.4.1 constructor sets readinessState to 'building'", () => {
    const e = new CorrectionEngine({
      techDictPath: bundledTechDictPath,
      isLearned: () => false,
    });
    expect(e.getReadinessState()).toBe("building");
    expect(e.getLastInitError()).toBeUndefined();
  });

  // 4.4.2 — Successful initialize → "ready"
  test("4.4.2 successful initialize() transitions to 'ready'", async () => {
    const e = new CorrectionEngine({
      techDictPath: bundledTechDictPath,
      isLearned: () => false,
    });
    expect(e.getReadinessState()).toBe("building");
    await e.initialize();
    expect(e.getReadinessState()).toBe("ready");
    expect(e.getLastInitError()).toBeUndefined();
  });

  // 4.4.3 — Failed initialize → "degraded"
  test("4.4.3 failed initialize() transitions to 'degraded' and stores error", async () => {
    const e = new CorrectionEngine({
      // Non-existent tech dict path forces readFile to throw.
      techDictPath: "/non/existent/path/tech.txt",
      isLearned: () => false,
    });
    expect(e.getReadinessState()).toBe("building");

    await expect(e.initialize()).rejects.toThrow();

    expect(e.getReadinessState()).toBe("degraded");
    expect(e.getLastInitError()).toBeDefined();
  });

  // 4.4.4 — shouldCorrect returns { corrected: false } in building and degraded states
  test("4.4.4 shouldCorrect returns { corrected: false } when state is 'building'", () => {
    const e = new CorrectionEngine({
      techDictPath: bundledTechDictPath,
      isLearned: () => false,
    });
    expect(e.getReadinessState()).toBe("building");
    // Even a known-correctable typo must not correct while building.
    expect(e.shouldCorrect("teh")).toEqual({ corrected: false });
  });

  test("4.4.4 shouldCorrect returns { corrected: false } when state is 'degraded'", async () => {
    const e = new CorrectionEngine({
      techDictPath: "/non/existent/path/tech.txt",
      isLearned: () => false,
    });
    await expect(e.initialize()).rejects.toThrow();
    expect(e.getReadinessState()).toBe("degraded");
    expect(e.shouldCorrect("teh")).toEqual({ corrected: false });
  });
});

// ---------------------------------------------------------------------------
// Section 9.4 — initialize() idempotency under concurrent in-flight calls
// ---------------------------------------------------------------------------
describe("Section 9.4 — initialize() idempotency", () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundledTechDictPath = resolve(projectRoot, "data/tech-dictionary.txt");

  test(
    "9.4 double initialize() in parallel does not invoke loadDictionaries more than once",
    async () => {
      const e = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
      });
      // Spy on the private loadDictionaries method so we can count calls.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spy = vi.spyOn(e as any, "loadDictionaries");

      // Call twice without awaiting between — both must share the same in-flight promise.
      const p1 = e.initialize();
      const p2 = e.initialize();
      await Promise.all([p1, p2]);

      // Cache hit → 0 calls; cache miss → 1 call. Never 2.
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
      expect(e.getReadinessState()).toBe("ready");

      spy.mockRestore();
    },
    30_000,
  );
});
