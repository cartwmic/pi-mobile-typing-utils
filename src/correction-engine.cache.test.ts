/**
 * Section 9.5 — Engine ↔ cache integration tests.
 *
 * Each test runs with an isolated temp directory set via
 * MOBILE_AUTOCORRECT_CACHE_DIR, and __resetCacheDisabledForTests() is called
 * in beforeEach to flush the module-level cacheDisabled/dirEnsured state so
 * that each test starts with a clean cache layer (mirrors the pattern used in
 * index-cache.test.ts).
 *
 * Tests that do a full fresh dictionary build are marked { timeout: 30_000 }
 * because the SymSpell deletion-table build is CPU-bound (~1 s on a laptop).
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CorrectionEngine } from "./correction-engine.js";
import * as indexCacheModule from "./index-cache.js";
import {
  __resetCacheDisabledForTests,
  CACHE_COMPACT_LEVEL,
  CACHE_COUNT_THRESHOLD,
  CACHE_PREFIX_LENGTH,
  computeCacheKey,
  getCacheFilePath,
  type CacheDescriptor,
} from "./index-cache.js";
import * as symspellPathsModule from "./symspell-paths.js";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundledTechDictPath = resolve(projectRoot, "data/tech-dictionary.txt");

/** CacheDescriptor matching the default engine config (maxEditDistance=2). */
function defaultDescriptor(): CacheDescriptor {
  return {
    maxEditDistance: 2,
    prefixLength: CACHE_PREFIX_LENGTH,
    compactLevel: CACHE_COMPACT_LEVEL,
    countThreshold: CACHE_COUNT_THRESHOLD,
  };
}

/** Poll for up to maxMs until predicate() returns true; resolves true/false. */
async function pollUntil(
  predicate: () => Promise<boolean>,
  maxMs = 5000,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// ─── Per-test isolation ───────────────────────────────────────────────────────

let tempDir = "";

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "engine-cache-test-"));
  vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", tempDir);
  __resetCacheDisabledForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    tempDir = "";
  }
  __resetCacheDisabledForTests();
});

// ─── Helper: wait for a symspell-*.bin file to appear in the temp dir ────────

async function waitForCacheFile(): Promise<string | undefined> {
  const found = await pollUntil(async () => {
    const files = await readdir(tempDir);
    return files.some((f) => f.startsWith("symspell-") && f.endsWith(".bin"));
  });
  if (!found) return undefined;
  const files = await readdir(tempDir);
  return files.find((f) => f.startsWith("symspell-") && f.endsWith(".bin"));
}

// ─── 9.5.1 — First init: cache miss → fresh build → cache file appears ───────

describe("9.5.1 — first init writes cache file", () => {
  test(
    "cache miss on first init → fresh build → symspell-*.bin appears in cache dir",
    async () => {
      const engine = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
        maxEditDistance: 2,
      });

      await engine.initialize();
      expect(engine.getReadinessState()).toBe("ready");

      // The cache write is fire-and-forget; poll up to 5 s for the file.
      const cacheFile = await waitForCacheFile();
      expect(cacheFile).toBeDefined();
      expect(cacheFile).toMatch(/^symspell-[0-9a-f]{16}\.bin$/);

      // Verify the file is at the exact path we expect.
      const key = computeCacheKey(defaultDescriptor());
      expect(key).not.toBeNull();
      const expectedPath = getCacheFilePath(key!);
      expect(expectedPath).not.toBeNull();
      expect(expectedPath).toBe(join(tempDir, `symspell-${key!}.bin`));
    },
    30_000,
  );
});

// ─── 9.5.2 — Second init: cache hit → unigram loader skipped → lookups ok ────

describe("9.5.2 — second init uses cache; unigram loader not called", () => {
  test(
    "cache hit on second init → loadDictionaries not called → lookups correct",
    async () => {
      // First init: build and write cache.
      const engine1 = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
        maxEditDistance: 2,
      });
      await engine1.initialize();

      const cacheFile = await waitForCacheFile();
      expect(cacheFile).toBeDefined();

      // Reset module state so the second engine can hit the cache cleanly.
      __resetCacheDisabledForTests();

      // Second init: should hit the cache.
      const engine2 = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
        maxEditDistance: 2,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spy = vi.spyOn(engine2 as any, "loadDictionaries");
      await engine2.initialize();

      expect(spy).not.toHaveBeenCalled();
      expect(engine2.getReadinessState()).toBe("ready");
      expect(engine2.shouldCorrect("teh")).toEqual({ corrected: true, suggestion: "the" });
    },
    30_000,
  );
});

// ─── 9.5.3 — Corrupted cache: falls back to fresh build ──────────────────────

describe("9.5.3 — corrupted cache falls back to fresh build", () => {
  test(
    "garbage cache file → silent fallback → fresh build → engine ready",
    async () => {
      // Pre-populate the expected cache path with garbage bytes.
      const key = computeCacheKey(defaultDescriptor());
      expect(key).not.toBeNull();
      await writeFile(join(tempDir, `symspell-${key!}.bin`), Buffer.from("not a valid cache"));

      const engine = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
        maxEditDistance: 2,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spy = vi.spyOn(engine as any, "loadDictionaries");

      await engine.initialize();

      expect(engine.getReadinessState()).toBe("ready");
      // Fresh build must have run exactly once.
      expect(spy).toHaveBeenCalledOnce();
      expect(engine.shouldCorrect("teh")).toEqual({ corrected: true, suggestion: "the" });
    },
    30_000,
  );
});

// ─── 9.5.4 — Stale siblings pruned after successful cache LOAD ───────────────

describe("9.5.4 — stale sibling files pruned after cache load", () => {
  test(
    "stale sibling present before cache load → absent after successful load",
    async () => {
      // Step 1: First init builds and writes the real cache file.
      const engine1 = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
        maxEditDistance: 2,
      });
      await engine1.initialize();
      const realFile = await waitForCacheFile();
      expect(realFile).toBeDefined();

      // Step 2: Plant a stale sibling in the same directory.
      const staleFile = "symspell-deadbeefdeadbeef.bin";
      await writeFile(join(tempDir, staleFile), Buffer.from("stale"));

      const beforeFiles = await readdir(tempDir);
      expect(beforeFiles).toContain(staleFile);
      expect(beforeFiles).toContain(realFile!);

      // Reset module state for the second engine.
      __resetCacheDisabledForTests();

      // Step 3: Second init should load from cache and trigger prune.
      const engine2 = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
        maxEditDistance: 2,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const loadSpy = vi.spyOn(engine2 as any, "loadDictionaries");
      await engine2.initialize();

      // Verify it was a cache hit (loadDictionaries not called).
      expect(loadSpy).not.toHaveBeenCalled();
      expect(engine2.getReadinessState()).toBe("ready");

      // pruneStaleSiblings is fire-and-forget; poll until the stale file disappears.
      const staleGone = await pollUntil(async () => {
        const files = await readdir(tempDir);
        return !files.includes(staleFile);
      });
      expect(staleGone).toBe(true);
      // The real cache file must still be present.
      const afterFiles = await readdir(tempDir);
      expect(afterFiles).toContain(realFile!);
    },
    30_000,
  );
});

// ─── 9.5.5 — MOBILE_AUTOCORRECT_CACHE_DIR env override is honored ────────────

describe("9.5.5 — MOBILE_AUTOCORRECT_CACHE_DIR env override", () => {
  test(
    "cache files are written to the overridden directory",
    async () => {
      // Explicit assertion that getCacheDir() returns our injected value.
      const { getCacheDir } = await import("./index-cache.js");
      expect(getCacheDir()).toBe(tempDir);

      const engine = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
        maxEditDistance: 2,
      });
      await engine.initialize();

      // Cache file must appear in tempDir (the overridden location).
      const cacheFile = await waitForCacheFile();
      expect(cacheFile).toBeDefined();

      // Verify path is under tempDir.
      const key = computeCacheKey(defaultDescriptor());
      expect(join(tempDir, `symspell-${key!}.bin`)).toBe(getCacheFilePath(key!));
    },
    30_000,
  );
});

// ─── 9.5.6 — Cache write failure does not block readiness ────────────────────

describe("9.5.6 — cache write failure does not block readiness", () => {
  test(
    "writeCache rejection is swallowed; engine still reaches ready",
    async () => {
      // Spy on writeCache so it rejects; the fire-and-forget .catch() swallows it.
      const spy = vi
        .spyOn(indexCacheModule, "writeCache")
        .mockRejectedValue(new Error("simulated disk full"));

      const engine = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
        maxEditDistance: 2,
      });

      await engine.initialize();

      expect(engine.getReadinessState()).toBe("ready");
      expect(engine.shouldCorrect("teh")).toEqual({ corrected: true, suggestion: "the" });
      expect(spy).toHaveBeenCalled();
    },
    30_000,
  );
});

// ─── 9.5.7 — Unresolvable package root: fresh build, no cache written ────────

describe("9.5.7 — unresolvable package root disables cache", () => {
  test(
    "computeCacheKey returns null → fresh build via fallback → no cache file written",
    async () => {
      // Make computeCacheKey return null (simulates resolver failure).
      const keySpy = vi
        .spyOn(indexCacheModule, "computeCacheKey")
        .mockReturnValue(null);

      const engine = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
        // Also use the resolver-failure fallback in loadDictionaries.
        _resolveSymspellPackageRoot: () => null,
      });

      await engine.initialize();

      expect(engine.getReadinessState()).toBe("ready");

      // Allow extra time for any fire-and-forget write that might slip through.
      await new Promise((r) => setTimeout(r, 500));
      const files = await readdir(tempDir);
      const cacheFiles = files.filter(
        (f) => f.startsWith("symspell-") && f.endsWith(".bin"),
      );
      expect(cacheFiles).toHaveLength(0);

      expect(keySpy).toHaveBeenCalled();
    },
    30_000,
  );
});

// ─── 9.5.8 — Double initialize() while building does not call loader twice ───

describe("9.5.8 — double initialize() while building; loader called at most once", () => {
  test(
    "two concurrent initialize() calls share the in-flight promise",
    async () => {
      const engine = new CorrectionEngine({
        techDictPath: bundledTechDictPath,
        isLearned: () => false,
        maxEditDistance: 2,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spy = vi.spyOn(engine as any, "loadDictionaries");

      // Fire both calls before either awaits.
      const p1 = engine.initialize();
      const p2 = engine.initialize();
      const [r1, r2] = await Promise.allSettled([p1, p2]);

      expect(r1.status).toBe("fulfilled");
      expect(r2.status).toBe("fulfilled");
      expect(engine.getReadinessState()).toBe("ready");

      // Temp dir starts empty → guaranteed cache miss → exactly 1 call.
      // (If cache were warm it would be 0, still ≤ 1.)
      expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
    },
    30_000,
  );
});
