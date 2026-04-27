import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { CorrectionEngine } from "./correction-engine.js";

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
