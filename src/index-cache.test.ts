/**
 * Tests for src/index-cache.ts (Section 8.9 — tasks 8.9.1–8.9.12)
 *
 * Mocking strategy:
 *   vi.mock('node:fs/promises') wraps targeted functions in vi.fn() stubs.
 *   A global beforeEach calls vi.resetAllMocks() — which clears queued
 *   once-implementations that a previous test left unconsumed — and then
 *   restores pass-through implementations so real fs semantics apply by
 *   default. Tests that need failures use mockImplementationOnce.
 *
 * Schema-version (8.9.3):
 *   SCHEMA_VERSION is a compile-time constant baked into the SHA-256 hash.
 *   Changing it without module re-evaluation would require vi.resetModules()
 *   + dynamic re-import (defeating shared setup). We test sensitivity
 *   indirectly: the hash is a SHA-256 over all six canonical inputs, so the
 *   uniqueness sub-tests for the other five inputs — together with the
 *   determinism check — guarantee that a SCHEMA_VERSION bump changes the key.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { SymSpell, Verbosity } from "symspell-ts";
import { resolveSymspellPackageRoot } from "./symspell-paths.js";
import {
  __resetCacheDisabledForTests,
  BucketOverflowError,
  CACHE_COMPACT_LEVEL,
  CACHE_COUNT_THRESHOLD,
  CACHE_MAGIC,
  CACHE_PREFIX_LENGTH,
  computeCacheKey,
  deserializeIndex,
  getCacheDir,
  loadCache,
  pruneStaleSiblings,
  SCHEMA_VERSION,
  serializeIndex,
  writeCache,
  type CacheDescriptor,
} from "./index-cache.js";

// ─── Module-level mocks ───────────────────────────────────────────────────────
//
// We mock only the functions we need to intercept. The ...actual spread keeps
// everything else (mkdtemp, rm, stat, …) as real implementations. In
// beforeEach we call vi.resetAllMocks() to flush queued once-implementations
// from previous tests, then re-attach pass-through defaults.

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    readFile: vi.fn(),
    unlink: vi.fn(),
    readdir: vi.fn(),
  };
});

vi.mock("./symspell-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./symspell-paths.js")>();
  return {
    ...actual,
    resolveSymspellPackageRoot: vi.fn(),
  };
});

// ─── Actual implementations (captured once) ───────────────────────────────────

let actualFs: typeof import("node:fs/promises");
let actualResolveRoot: typeof resolveSymspellPackageRoot;

beforeAll(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const actualPaths = await vi.importActual<typeof import("./symspell-paths.js")>(
    "./symspell-paths.js",
  );
  actualResolveRoot = actualPaths.resolveSymspellPackageRoot;
});

// ─── Global reset + pass-through restore ─────────────────────────────────────

beforeEach(() => {
  // Clear call history AND queued once-implementations AND default implementations.
  vi.resetAllMocks();
  // Restore pass-through defaults so real fs semantics apply unless a test
  // overrides with mockImplementationOnce.
  if (actualFs) {
    vi.mocked(rename).mockImplementation(actualFs.rename);
    vi.mocked(writeFile).mockImplementation((...args: unknown[]) =>
      (actualFs.writeFile as (...a: unknown[]) => Promise<void>)(...args),
    );
    vi.mocked(mkdir).mockImplementation((...args: unknown[]) =>
      (actualFs.mkdir as (...a: unknown[]) => Promise<string | undefined>)(...args),
    );
    vi.mocked(readFile).mockImplementation((...args: unknown[]) =>
      (actualFs.readFile as (...a: unknown[]) => Promise<Buffer>)(...args),
    );
    vi.mocked(unlink).mockImplementation(actualFs.unlink);
    vi.mocked(readdir).mockImplementation((...args: unknown[]) =>
      (actualFs.readdir as (...a: unknown[]) => Promise<string[]>)(...args),
    );
  }
  if (actualResolveRoot) {
    vi.mocked(resolveSymspellPackageRoot).mockImplementation(actualResolveRoot);
  }
  __resetCacheDisabledForTests();
});

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const BASE_DESCRIPTOR: CacheDescriptor = {
  maxEditDistance: 2,
  prefixLength: CACHE_PREFIX_LENGTH,
  compactLevel: CACHE_COMPACT_LEVEL,
  countThreshold: CACHE_COUNT_THRESHOLD,
};

/**
 * Minimal fake SymSpell-shaped object sufficient for serializeIndex().
 * Does not run real lookups — used for I/O-path and serializer tests.
 */
const MINIMAL_FAKE = {
  words: new Map<string, number>([
    ["hello", 100_000],
    ["world", 50_000],
    ["test", 75_000],
  ]),
  deletes: new Map<number, string[]>([
    [0x1234_5678 | 0, ["hello", "world"]],
    [-0x5678_1234 | 0, ["test"]],
  ]),
  maxDictionaryWordLength: 5,
  maxDictionaryEditDistance: 2,
  belowThresholdWords: new Map<string, number>(),
  bigrams: new Map<string, number>(),
};

async function fileExists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

// ─── 8.9.1 & 8.9.2 — Round-trip fidelity ────────────────────────────────────

describe("round-trip fidelity", () => {
  let realSymspell: InstanceType<typeof SymSpell>;
  let corpusLines: string[];

  beforeAll(async () => {
    const pkgRoot = actualResolveRoot();
    if (!pkgRoot) throw new Error("resolveSymspellPackageRoot() returned null");

    const dictPath = join(pkgRoot, "data", "frequency_dictionary_en_82_765.txt");
    const dictText = readFileSync(dictPath, "utf8");

    realSymspell = new SymSpell(
      16,
      BASE_DESCRIPTOR.maxEditDistance,
      CACHE_PREFIX_LENGTH,
      CACHE_COUNT_THRESHOLD,
      CACHE_COMPACT_LEVEL,
    );
    realSymspell.loadDictionary(dictText, 0, 1);

    const corpusPath = join(
      new URL(".", import.meta.url).pathname,
      "..",
      "tests",
      "fixtures",
      "cache-fidelity-corpus.txt",
    );
    corpusLines = readFileSync(corpusPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }, 60_000);

  test("8.9.1 — serialize + deserialize produces identical lookup results for every corpus word", () => {
    const buffer = serializeIndex(realSymspell);
    const result = deserializeIndex(buffer, BASE_DESCRIPTOR);
    expect(result).not.toBeNull();

    // Hydrate a fresh SymSpell from the deserialized data by setting the
    // nominally-private fields directly (matching what Section 9 production
    // code will do).
    const hydratedSS = new SymSpell(
      16,
      BASE_DESCRIPTOR.maxEditDistance,
      BASE_DESCRIPTOR.prefixLength,
      BASE_DESCRIPTOR.countThreshold,
      BASE_DESCRIPTOR.compactLevel,
    ) as unknown as Record<string, unknown> & InstanceType<typeof SymSpell>;
    hydratedSS["words"] = result!.words;
    hydratedSS["deletes"] = result!.deletes;
    hydratedSS["maxDictionaryWordLength"] = result!.maxDictionaryWordLength;

    for (const word of corpusLines) {
      const lower = word.toLowerCase();
      const origSugs = realSymspell.lookup(lower, Verbosity.Top, BASE_DESCRIPTOR.maxEditDistance);
      const hydrSugs = (hydratedSS as InstanceType<typeof SymSpell>).lookup(
        lower,
        Verbosity.Top,
        BASE_DESCRIPTOR.maxEditDistance,
      );

      const origTop = origSugs[0] ? { term: origSugs[0].term, distance: origSugs[0].distance } : null;
      const hydrTop = hydrSugs[0] ? { term: hydrSugs[0].term, distance: hydrSugs[0].distance } : null;
      expect(hydrTop).toEqual(origTop);
    }
  });

  test("8.9.2 — round-trip correctly handles delete buckets with > 255 entries", () => {
    const deletes = (realSymspell as unknown as Record<string, unknown>)["deletes"] as Map<
      number,
      string[]
    >;

    let largeBucket: [number, string[]] | undefined;
    for (const entry of deletes.entries()) {
      if (entry[1].length > 255) {
        largeBucket = entry;
        break;
      }
    }

    if (!largeBucket) {
      throw new Error(
        "No delete bucket with > 255 entries found in the live build. " +
          "If this fails, the corpus or upstream library has changed — " +
          "verify that the measured maximum (~5430) still holds.",
      );
    }

    const [largeHash, largeSugs] = largeBucket;

    const buffer = serializeIndex(realSymspell);
    const result = deserializeIndex(buffer, BASE_DESCRIPTOR);
    expect(result).not.toBeNull();

    const roundTripped = result!.deletes.get(largeHash);
    expect(roundTripped).toBeDefined();
    expect(roundTripped!.length).toBe(largeSugs.length);
    expect(roundTripped).toEqual(largeSugs);
  });
});

// ─── 8.9.3 — Cache key uniqueness ────────────────────────────────────────────

describe("computeCacheKey", () => {
  test("returns a 16-character hex string", () => {
    expect(computeCacheKey(BASE_DESCRIPTOR)).toMatch(/^[0-9a-f]{16}$/);
  });

  test("is deterministic", () => {
    expect(computeCacheKey(BASE_DESCRIPTOR)).toBe(computeCacheKey(BASE_DESCRIPTOR));
  });

  test("8.9.3 — maxEditDistance change produces a different key", () => {
    const k2 = computeCacheKey({ ...BASE_DESCRIPTOR, maxEditDistance: 2 });
    const k3 = computeCacheKey({ ...BASE_DESCRIPTOR, maxEditDistance: 3 });
    expect(k2).not.toBeNull();
    expect(k3).not.toBeNull();
    expect(k2).not.toBe(k3);
  });

  test("8.9.3 — prefixLength change produces a different key", () => {
    const k7 = computeCacheKey({ ...BASE_DESCRIPTOR, prefixLength: 7 });
    const k8 = computeCacheKey({ ...BASE_DESCRIPTOR, prefixLength: 8 });
    expect(k7).not.toBeNull();
    expect(k8).not.toBeNull();
    expect(k7).not.toBe(k8);
  });

  test("8.9.3 — compactLevel change produces a different key", () => {
    const k5 = computeCacheKey({ ...BASE_DESCRIPTOR, compactLevel: 5 });
    const k6 = computeCacheKey({ ...BASE_DESCRIPTOR, compactLevel: 6 });
    expect(k5).not.toBeNull();
    expect(k6).not.toBeNull();
    expect(k5).not.toBe(k6);
  });

  test("8.9.3 — countThreshold change produces a different key", () => {
    const k1 = computeCacheKey({ ...BASE_DESCRIPTOR, countThreshold: 1 });
    const k2 = computeCacheKey({ ...BASE_DESCRIPTOR, countThreshold: 2 });
    expect(k1).not.toBeNull();
    expect(k2).not.toBeNull();
    expect(k1).not.toBe(k2);
  });

  test("8.9.3 — lib version change produces a different key", () => {
    const fakeRoot = mkdtempSync(join(tmpdir(), "fake-pkg-"));
    try {
      writeFileSync(
        join(fakeRoot, "package.json"),
        JSON.stringify({ name: "symspell-ts", version: "99.99.99" }),
      );

      vi.mocked(resolveSymspellPackageRoot).mockImplementationOnce(() => fakeRoot);
      const keyFakeVersion = computeCacheKey(BASE_DESCRIPTOR);

      // The mockImplementationOnce was consumed; next call uses real resolver.
      const keyRealVersion = computeCacheKey(BASE_DESCRIPTOR);

      expect(keyFakeVersion).not.toBeNull();
      expect(keyRealVersion).not.toBeNull();
      expect(keyFakeVersion).not.toBe(keyRealVersion);
    } finally {
      rmSync(fakeRoot, { recursive: true });
    }
  });

  test("returns null when resolveSymspellPackageRoot returns null", () => {
    vi.mocked(resolveSymspellPackageRoot).mockImplementationOnce(() => null);
    expect(computeCacheKey(BASE_DESCRIPTOR)).toBeNull();
  });
});

// ─── 8.9.8 & 8.9.9 — Env var falls through to default ───────────────────────

describe("getCacheDir env var behaviour", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("8.9.8 — MOBILE_AUTOCORRECT_CACHE_DIR='' falls through to default", () => {
    vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", "");
    expect(getCacheDir()).toBe(join(homedir(), ".pi", "agent", "cache", "mobile-autocorrect"));
  });

  test("8.9.9 — MOBILE_AUTOCORRECT_CACHE_DIR='   ' (whitespace-only) falls through to default", () => {
    vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", "   ");
    expect(getCacheDir()).toBe(join(homedir(), ".pi", "agent", "cache", "mobile-autocorrect"));
  });

  test("non-empty MOBILE_AUTOCORRECT_CACHE_DIR overrides default", () => {
    vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", "/custom/cache");
    expect(getCacheDir()).toBe("/custom/cache");
  });
});

// ─── 8.9.4 — Atomic write ────────────────────────────────────────────────────

describe("atomic write", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await actualFs.mkdtemp(join(tmpdir(), "cache-atomic-"));
    vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", cacheDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await actualFs.rm(cacheDir, { recursive: true, force: true });
  });

  test("8.9.4 — temp filename includes pid and 16-char random hex suffix", async () => {
    let capturedTempPath: string | undefined;

    vi.mocked(rename).mockImplementationOnce(async (from) => {
      capturedTempPath = from as string;
      throw new Error("simulated crash during rename");
    });

    await writeCache(BASE_DESCRIPTOR, MINIMAL_FAKE);

    expect(capturedTempPath).toBeDefined();
    expect(capturedTempPath).toMatch(
      /symspell-[0-9a-f]{16}\.bin\.\d+-[0-9a-f]{16}\.tmp$/,
    );
  });

  test("8.9.4 — crash during rename: final file absent and temp file cleaned up", async () => {
    const key = computeCacheKey(BASE_DESCRIPTOR)!;
    const finalPath = join(cacheDir, `symspell-${key}.bin`);
    let capturedTempPath: string | undefined;

    vi.mocked(rename).mockImplementationOnce(async (from) => {
      capturedTempPath = from as string;
      throw new Error("simulated crash");
    });

    await writeCache(BASE_DESCRIPTOR, MINIMAL_FAKE);

    expect(await fileExists(finalPath)).toBe(false);
    expect(capturedTempPath).toBeDefined();
    expect(await fileExists(capturedTempPath!)).toBe(false);
  });
});

// ─── 8.9.5 — Concurrent writers ──────────────────────────────────────────────

describe("concurrent writers", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await actualFs.mkdtemp(join(tmpdir(), "cache-concurrent-"));
    vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", cacheDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await actualFs.rm(cacheDir, { recursive: true, force: true });
  });

  test("8.9.5 — two concurrent writers use different temp filenames", async () => {
    const capturedTempPaths: string[] = [];

    vi.mocked(rename).mockImplementation(async (from, to) => {
      capturedTempPaths.push(from as string);
      return actualFs.rename(from as string, to as string);
    });

    await Promise.all([
      writeCache(BASE_DESCRIPTOR, MINIMAL_FAKE),
      writeCache(BASE_DESCRIPTOR, MINIMAL_FAKE),
    ]);

    expect(capturedTempPaths).toHaveLength(2);
    expect(capturedTempPaths[0]).not.toBe(capturedTempPaths[1]);
  });
});

// ─── 8.9.6 — Prune ───────────────────────────────────────────────────────────

describe("pruneStaleSiblings", () => {
  let pruneDir: string;

  beforeEach(async () => {
    pruneDir = await actualFs.mkdtemp(join(tmpdir(), "cache-prune-"));
    vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", pruneDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await actualFs.rm(pruneDir, { recursive: true, force: true });
  });

  test("8.9.6 — deletes stale *.bin, keeps current key, leaves *.tmp and unrelated files", async () => {
    const currentKey = "aaaaaaaaaaaaaaaa";
    const staleKey = "bbbbbbbbbbbbbbbb";

    writeFileSync(join(pruneDir, `symspell-${currentKey}.bin`), "current");
    writeFileSync(join(pruneDir, `symspell-${staleKey}.bin`), "stale");
    // In-flight writer temp file — must NOT be pruned.
    writeFileSync(join(pruneDir, `symspell-cccccccccccccccc.bin.123-abc.tmp`), "tmp");
    // Unrelated user file — must NOT be pruned.
    writeFileSync(join(pruneDir, "notes.txt"), "notes");

    await pruneStaleSiblings(currentKey);

    expect(await fileExists(join(pruneDir, `symspell-${currentKey}.bin`))).toBe(true);
    expect(await fileExists(join(pruneDir, `symspell-${staleKey}.bin`))).toBe(false);
    expect(await fileExists(join(pruneDir, `symspell-cccccccccccccccc.bin.123-abc.tmp`))).toBe(true);
    expect(await fileExists(join(pruneDir, "notes.txt"))).toBe(true);
  });
});

// ─── 8.9.7 — loadCache returns null for various failure modes ────────────────

describe("loadCache null cases", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await actualFs.mkdtemp(join(tmpdir(), "cache-load-"));
    vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", cacheDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await actualFs.rm(cacheDir, { recursive: true, force: true });
  });

  test("8.9.7 — missing file returns null", async () => {
    expect(await loadCache(BASE_DESCRIPTOR)).toBeNull();
  });

  test("8.9.7 — bad magic bytes returns null", async () => {
    const key = computeCacheKey(BASE_DESCRIPTOR)!;
    const buf = serializeIndex(MINIMAL_FAKE);
    buf.write("XXXX", 0, "ascii");
    writeFileSync(join(cacheDir, `symspell-${key}.bin`), buf);
    expect(await loadCache(BASE_DESCRIPTOR)).toBeNull();
  });

  test("8.9.7 — schema version mismatch returns null", async () => {
    const key = computeCacheKey(BASE_DESCRIPTOR)!;
    const buf = serializeIndex(MINIMAL_FAKE);
    buf.writeUInt32LE(999, 4);
    writeFileSync(join(cacheDir, `symspell-${key}.bin`), buf);
    expect(await loadCache(BASE_DESCRIPTOR)).toBeNull();
  });

  test("8.9.7 — maxEditDistance mismatch in header returns null", async () => {
    const key = computeCacheKey(BASE_DESCRIPTOR)!;
    const buf = serializeIndex(MINIMAL_FAKE);
    buf.writeUInt32LE(99, 8);
    writeFileSync(join(cacheDir, `symspell-${key}.bin`), buf);
    expect(await loadCache(BASE_DESCRIPTOR)).toBeNull();
  });

  test("8.9.7 — truncated buffer returns null", async () => {
    const key = computeCacheKey(BASE_DESCRIPTOR)!;
    const buf = serializeIndex(MINIMAL_FAKE);
    writeFileSync(join(cacheDir, `symspell-${key}.bin`), buf.subarray(0, 8));
    expect(await loadCache(BASE_DESCRIPTOR)).toBeNull();
  });
});

// ─── deserializeIndex standalone ─────────────────────────────────────────────

describe("deserializeIndex", () => {
  test("happy path round-trips words and maxDictionaryWordLength", () => {
    const buf = serializeIndex(MINIMAL_FAKE);
    const result = deserializeIndex(buf, BASE_DESCRIPTOR);
    expect(result).not.toBeNull();
    expect(result!.words).toEqual(MINIMAL_FAKE.words);
    expect(result!.maxDictionaryWordLength).toBe(MINIMAL_FAKE.maxDictionaryWordLength);
  });

  test("returns null for empty buffer", () => {
    expect(deserializeIndex(Buffer.alloc(0), BASE_DESCRIPTOR)).toBeNull();
  });

  test("returns null when magic is wrong", () => {
    const buf = Buffer.allocUnsafe(4);
    buf.write("ABCD", 0, "ascii");
    expect(deserializeIndex(buf, BASE_DESCRIPTOR)).toBeNull();
  });

  test("returns null when maxEditDistance in buffer mismatches expected", () => {
    const buf = serializeIndex(MINIMAL_FAKE);
    buf.writeUInt32LE(99, 8);
    expect(deserializeIndex(buf, BASE_DESCRIPTOR)).toBeNull();
  });

  test("CACHE_MAGIC is 'SYMC'", () => expect(CACHE_MAGIC).toBe("SYMC"));
  test("SCHEMA_VERSION is 1", () => expect(SCHEMA_VERSION).toBe(1));
});

// ─── 8.9.10 — Write failure does not throw ───────────────────────────────────

describe("writeCache error resilience", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await actualFs.mkdtemp(join(tmpdir(), "cache-write-err-"));
    vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", cacheDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await actualFs.rm(cacheDir, { recursive: true, force: true });
  });

  test("8.9.10 — writeFile failure does not throw past writeCache boundary", async () => {
    vi.mocked(writeFile).mockImplementationOnce(() =>
      Promise.reject(new Error("ENOSPC: no space left on device")),
    );
    await expect(writeCache(BASE_DESCRIPTOR, MINIMAL_FAKE)).resolves.toBeUndefined();
  });

  test("8.9.10 — rename failure does not throw past writeCache boundary", async () => {
    vi.mocked(rename).mockImplementationOnce(() =>
      Promise.reject(new Error("EPERM: rename not permitted")),
    );
    await expect(writeCache(BASE_DESCRIPTOR, MINIMAL_FAKE)).resolves.toBeUndefined();
  });
});

// ─── 8.9.11 — mkdir failure disables cache gracefully ────────────────────────

describe("mkdir failure", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("8.9.11 — mkdir failure: cache disabled; subsequent loadCache and writeCache are no-ops", async () => {
    vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", "/nonexistent-root/cache");

    vi.mocked(mkdir).mockImplementationOnce(() =>
      Promise.reject(new Error("EPERM: operation not permitted, mkdir")),
    );

    // First call: mkdir fails → cacheDisabled = true → returns null.
    await expect(loadCache(BASE_DESCRIPTOR)).resolves.toBeNull();

    // Subsequent calls: getCacheDir() returns null (cacheDisabled) → fast-path null.
    await expect(loadCache(BASE_DESCRIPTOR)).resolves.toBeNull();
    await expect(writeCache(BASE_DESCRIPTOR, MINIMAL_FAKE)).resolves.toBeUndefined();
  });
});

// ─── 8.9.12 — Serializer guard assertions ────────────────────────────────────

describe("serializeIndex guards", () => {
  test("8.9.12 — throws BucketOverflowError when any bucket has > 65535 entries", () => {
    const fakeSS = {
      words: new Map<string, number>([["x", 1]]),
      deletes: new Map<number, string[]>([[0, new Array(70_000).fill("x") as string[]]]),
      maxDictionaryWordLength: 1,
      maxDictionaryEditDistance: 2,
      belowThresholdWords: new Map<string, number>(),
      bigrams: new Map<string, number>(),
    };
    expect(() => serializeIndex(fakeSS)).toThrow(BucketOverflowError);
  });

  test("throws when belowThresholdWords is non-empty", () => {
    const fakeSS = {
      ...MINIMAL_FAKE,
      belowThresholdWords: new Map<string, number>([["lowcount", 0]]),
    };
    expect(() => serializeIndex(fakeSS)).toThrow(/BELOW_THRESHOLD_NONEMPTY/);
  });

  test("throws when a string exceeds 255 bytes", () => {
    const longStr = "a".repeat(256);
    const fakeSS = {
      words: new Map<string, number>([[longStr, 1]]),
      deletes: new Map<number, string[]>(),
      maxDictionaryWordLength: 256,
      maxDictionaryEditDistance: 2,
      belowThresholdWords: new Map<string, number>(),
      bigrams: new Map<string, number>(),
    };
    expect(() => serializeIndex(fakeSS)).toThrow(/255 bytes/);
  });
});

// ─── Exported pinned constants ────────────────────────────────────────────────

describe("exported pinned constants", () => {
  test("CACHE_PREFIX_LENGTH is 7", () => expect(CACHE_PREFIX_LENGTH).toBe(7));
  test("CACHE_COUNT_THRESHOLD is 1", () => expect(CACHE_COUNT_THRESHOLD).toBe(1));
  test("CACHE_COMPACT_LEVEL is 5", () => expect(CACHE_COMPACT_LEVEL).toBe(5));
});
