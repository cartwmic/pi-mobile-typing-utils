/**
 * Tests for src/trigram-table.ts (Phase 3 — tasks 3.4–3.8)
 *
 * Mocking strategy:
 *   vi.mock("node:fs/promises") wraps targeted functions in vi.fn() stubs.
 *   A global beforeEach calls vi.resetAllMocks() and then restores
 *   pass-through implementations so real fs semantics apply by default.
 *   Tests that need failures use mockImplementationOnce.
 *
 * File I/O tests use actual temp directories (mkdtempSync / actualFs.mkdtemp)
 * created per-describe via beforeEach/afterEach, mirroring index-cache.test.ts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  computeTrigramCacheKey,
  getTrigramTableSingleton,
  pruneStaleTrigramCaches,
  TRIGRAM_CACHE_MAGIC,
  TRIGRAM_FILENAME_PATTERN,
  TRIGRAM_SCHEMA_VERSION,
  TrigramTable,
  __resetTrigramSingletonForTests,
} from "./trigram-table.js";
import type { TelemetryWriter } from "./telemetry.js";
import type { TelemetryEvent } from "./telemetry.js";

// ─── Module-level mocks ───────────────────────────────────────────────────────

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    unlink: vi.fn(),
    readdir: vi.fn(),
  };
});

// ─── Actual implementations (captured once) ───────────────────────────────────

let actualFs: typeof import("node:fs/promises");

beforeAll(async () => {
  actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
});

// ─── Global reset + pass-through restore ─────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  if (actualFs) {
    vi.mocked(rename).mockImplementation(actualFs.rename);
    vi.mocked(writeFile).mockImplementation((...args: unknown[]) =>
      (actualFs.writeFile as (...a: unknown[]) => Promise<void>)(...args),
    );
    vi.mocked(readFile).mockImplementation((...args: unknown[]) =>
      (actualFs.readFile as (...a: unknown[]) => Promise<Buffer>)(...args),
    );
    vi.mocked(unlink).mockImplementation(actualFs.unlink);
    vi.mocked(readdir).mockImplementation((...args: unknown[]) =>
      (actualFs.readdir as (...a: unknown[]) => Promise<string[]>)(...args),
    );
  }
});

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** Build a minimal TrigramTable directly from Maps (bypasses TSV parsing). */
function makeTable(
  trigramEntries: Array<[string, string, string, number]>,
): TrigramTable {
  const trigrams = new Map<string, number>();
  const bigramPrefixCounts = new Map<string, number>();

  for (const [w1, w2, w3, count] of trigramEntries) {
    const trigramKey = `${w1}\x01${w2}\x01${w3}`;
    const bigramKey = `${w1}\x01${w2}`;
    trigrams.set(trigramKey, count);
    bigramPrefixCounts.set(bigramKey, (bigramPrefixCounts.get(bigramKey) ?? 0) + count);
  }

  return new TrigramTable(trigrams, bigramPrefixCounts);
}

// ─── TSV parsing (task 3.4) ───────────────────────────────────────────────────

describe("loadFromTsv", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trigram-tsv-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("key format uses \\x01 separator (U+0001)", async () => {
    const tsvPath = join(dir, "test.tsv");
    writeFileSync(tsvPath, "the\tquick\tbrown\t5\n");

    const table = await TrigramTable.loadFromTsv(tsvPath);

    // The key must contain byte 0x01 as the separator.
    const key = "the\x01quick\x01brown";
    expect(table.trigrams.has(key)).toBe(true);
    expect(table.trigrams.get(key)).toBe(5);
    // Key must NOT contain a space or tab as separator.
    expect(table.trigrams.has("the quick brown")).toBe(false);
    expect(table.trigrams.has("the\tquick\tbrown")).toBe(false);
  });

  test("getTrigramCount / getBigramPrefixCount return correct values", async () => {
    const tsvPath = join(dir, "test.tsv");
    writeFileSync(tsvPath, "the\tquick\tbrown\t5\nthe\tquick\tfox\t3\nhello\tworld\tfoo\t10\n");

    const table = await TrigramTable.loadFromTsv(tsvPath);

    expect(table.getTrigramCount("the", "quick", "brown")).toBe(5);
    expect(table.getTrigramCount("the", "quick", "fox")).toBe(3);
    expect(table.getTrigramCount("hello", "world", "foo")).toBe(10);
  });

  test("bigramPrefixCounts is sum of trigram counts sharing the (w1, w2) prefix", async () => {
    const tsvPath = join(dir, "test.tsv");
    writeFileSync(tsvPath, "the\tquick\tbrown\t5\nthe\tquick\tfox\t3\nthe\tquick\tdog\t2\n");

    const table = await TrigramTable.loadFromTsv(tsvPath);

    // Sum over all w3 for (the, quick): 5 + 3 + 2 = 10
    expect(table.getBigramPrefixCount("the", "quick")).toBe(10);
    expect(table.bigramPrefixCounts.has("the\x01quick")).toBe(true);
    expect(table.bigramPrefixCounts.get("the\x01quick")).toBe(10);
  });

  test("getTrigramCount returns 0 for missing entry", async () => {
    const tsvPath = join(dir, "test.tsv");
    writeFileSync(tsvPath, "the\tquick\tbrown\t5\n");

    const table = await TrigramTable.loadFromTsv(tsvPath);

    expect(table.getTrigramCount("foo", "bar", "baz")).toBe(0);
    expect(table.getTrigramCount("the", "quick", "cat")).toBe(0);
  });

  test("getBigramPrefixCount returns 0 for missing entry", async () => {
    const tsvPath = join(dir, "test.tsv");
    writeFileSync(tsvPath, "the\tquick\tbrown\t5\n");

    const table = await TrigramTable.loadFromTsv(tsvPath);

    expect(table.getBigramPrefixCount("foo", "bar")).toBe(0);
  });

  test("skips malformed lines gracefully", async () => {
    const tsvPath = join(dir, "test.tsv");
    // Valid line, empty line, line with missing count, then another valid line
    writeFileSync(tsvPath, "a\tb\tc\t7\n\nonly\tone\nx\ty\tz\t4\n");

    const table = await TrigramTable.loadFromTsv(tsvPath);

    expect(table.trigrams.size).toBe(2);
    expect(table.getTrigramCount("a", "b", "c")).toBe(7);
    expect(table.getTrigramCount("x", "y", "z")).toBe(4);
  });

  test("trigrams map is keyed with exactly one \\x01 between each word pair", async () => {
    const tsvPath = join(dir, "test.tsv");
    writeFileSync(tsvPath, "hello\tworld\tfoo\t1\n");

    const table = await TrigramTable.loadFromTsv(tsvPath);

    const [entry] = [...table.trigrams.keys()];
    expect(entry).toBeDefined();
    // Exactly 2 separator bytes in the trigram key
    const sepCount = [...entry!].filter((c) => c === "\x01").length;
    expect(sepCount).toBe(2);
    // Exactly 1 separator byte in the bigram-prefix key
    const [bigramKey] = [...table.bigramPrefixCounts.keys()];
    expect(bigramKey).toBeDefined();
    const bigramSepCount = [...bigramKey!].filter((c) => c === "\x01").length;
    expect(bigramSepCount).toBe(1);
  });
});

// ─── Binary cache round-trip (tasks 3.5, 3.8) ────────────────────────────────

describe("writeCache / loadFromCache", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await actualFs.mkdtemp(join(tmpdir(), "trigram-cache-"));
  });

  afterEach(async () => {
    await actualFs.rm(dir, { recursive: true, force: true });
  });

  test("binary round-trip: loaded maps are byte-identical to original", async () => {
    const original = makeTable([
      ["hello", "world", "foo", 10],
      ["hello", "world", "bar", 5],
      ["foo", "bar", "baz", 3],
    ]);
    const cachePath = join(dir, "trigram-test.bin");

    await original.writeCache(cachePath);

    const loaded = await TrigramTable.loadFromCache(cachePath);
    expect(loaded).not.toBeNull();

    // Trigrams map must be identical
    expect(loaded!.trigrams.size).toBe(original.trigrams.size);
    for (const [k, v] of original.trigrams.entries()) {
      expect(loaded!.trigrams.get(k)).toBe(v);
    }

    // bigramPrefixCounts map must be identical
    expect(loaded!.bigramPrefixCounts.size).toBe(original.bigramPrefixCounts.size);
    for (const [k, v] of original.bigramPrefixCounts.entries()) {
      expect(loaded!.bigramPrefixCounts.get(k)).toBe(v);
    }
  });

  test("loadFromCache returns null on ENOENT", async () => {
    const result = await TrigramTable.loadFromCache(join(dir, "nonexistent.bin"));
    expect(result).toBeNull();
  });

  test("loadFromCache returns null for corrupt data (truncated buffer)", async () => {
    const table = makeTable([["a", "b", "c", 1]]);
    const cachePath = join(dir, "trigram-corrupt.bin");
    await table.writeCache(cachePath);

    // Overwrite with a truncated version
    const full = readFileSync(cachePath);
    writeFileSync(cachePath, full.subarray(0, 4)); // only magic bytes

    const result = await TrigramTable.loadFromCache(cachePath);
    expect(result).toBeNull();
  });

  test("loadFromCache returns null on schema version mismatch", async () => {
    const table = makeTable([["a", "b", "c", 1]]);
    const cachePath = join(dir, "trigram-schema.bin");
    await table.writeCache(cachePath);

    // Corrupt the schema version field (bytes 4–7)
    const buf = readFileSync(cachePath);
    buf.writeUInt32LE(999, 4);
    writeFileSync(cachePath, buf);

    const result = await TrigramTable.loadFromCache(cachePath);
    expect(result).toBeNull();
  });

  test("loadFromCache returns null on bad magic bytes", async () => {
    const table = makeTable([["a", "b", "c", 1]]);
    const cachePath = join(dir, "trigram-magic.bin");
    await table.writeCache(cachePath);

    const buf = readFileSync(cachePath);
    buf.write("XXXX", 0, "ascii");
    writeFileSync(cachePath, buf);

    const result = await TrigramTable.loadFromCache(cachePath);
    expect(result).toBeNull();
  });

  test("TRIGRAM_CACHE_MAGIC is 'TRIG'", () => {
    expect(TRIGRAM_CACHE_MAGIC).toBe("TRIG");
  });

  test("TRIGRAM_SCHEMA_VERSION is 1", () => {
    expect(TRIGRAM_SCHEMA_VERSION).toBe(1);
  });

  test("written file starts with TRIG magic at offset 0", async () => {
    const table = makeTable([["a", "b", "c", 1]]);
    const cachePath = join(dir, "trigram-magic-check.bin");
    await table.writeCache(cachePath);

    const buf = readFileSync(cachePath);
    expect(buf.subarray(0, 4).toString("ascii")).toBe("TRIG");
  });
});

// ─── Key mismatch causes miss (task 3.8) ─────────────────────────────────────

describe("cache key mismatch causes a miss", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await actualFs.mkdtemp(join(tmpdir(), "trigram-keymiss-"));
  });

  afterEach(async () => {
    await actualFs.rm(dir, { recursive: true, force: true });
  });

  test("loading from a different path (key B) returns null when only key A was written", async () => {
    const table = makeTable([["hello", "world", "foo", 42]]);

    const pathA = join(dir, `trigram-${"a".repeat(64)}.bin`);
    const pathB = join(dir, `trigram-${"b".repeat(64)}.bin`);

    await table.writeCache(pathA);

    // Path B doesn't exist — loading returns null
    const result = await TrigramTable.loadFromCache(pathB);
    expect(result).toBeNull();

    // Path A still exists and loads correctly
    const resultA = await TrigramTable.loadFromCache(pathA);
    expect(resultA).not.toBeNull();
    expect(resultA!.getTrigramCount("hello", "world", "foo")).toBe(42);
  });
});

// ─── Write atomicity (task 3.8) ───────────────────────────────────────────────

describe("writeCache atomicity", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await actualFs.mkdtemp(join(tmpdir(), "trigram-atomic-"));
  });

  afterEach(async () => {
    await actualFs.rm(dir, { recursive: true, force: true });
  });

  test("rename failure leaves no final file and no leaked .tmp file", async () => {
    const table = makeTable([["hello", "world", "foo", 5]]);
    const cachePath = join(dir, "trigram-test.bin");
    let capturedTempPath: string | undefined;

    // Inject rename failure; capture the temp path
    vi.mocked(rename).mockImplementationOnce(async (from) => {
      capturedTempPath = from as string;
      throw new Error("simulated rename failure");
    });

    // writeCache must NOT throw — errors are swallowed (mirrors index-cache.ts)
    await expect(table.writeCache(cachePath)).resolves.toBeUndefined();

    // The final cache file must not exist (rename didn't complete)
    expect(await fileExists(cachePath)).toBe(false);

    // The temp file must have been cleaned up by the catch block's unlink
    expect(capturedTempPath).toBeDefined();
    expect(await fileExists(capturedTempPath!)).toBe(false);
  });

  test("writeFile failure leaves no final file and does not throw", async () => {
    const table = makeTable([["a", "b", "c", 1]]);
    const cachePath = join(dir, "trigram-nowrite.bin");

    vi.mocked(writeFile).mockImplementationOnce(() =>
      Promise.reject(new Error("ENOSPC: no space left on device")),
    );

    await expect(table.writeCache(cachePath)).resolves.toBeUndefined();
    expect(await fileExists(cachePath)).toBe(false);
  });

  test("temp file name includes .tmp suffix and differs from final path", async () => {
    const table = makeTable([["a", "b", "c", 1]]);
    const cachePath = join(dir, `trigram-${"f".repeat(64)}.bin`);
    const capturedPaths: string[] = [];

    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      capturedPaths.push(from as string, to as string);
      return actualFs.rename(from as string, to as string);
    });

    await table.writeCache(cachePath);

    expect(capturedPaths).toHaveLength(2);
    const [tempPath, finalPath] = capturedPaths;
    expect(tempPath!.endsWith(".tmp")).toBe(true);
    expect(finalPath).toBe(cachePath);
    expect(tempPath).not.toBe(finalPath);
  });
});

// ─── computeTrigramCacheKey (task 3.6) ───────────────────────────────────────

describe("computeTrigramCacheKey", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trigram-key-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns a 64-character lowercase hex string", async () => {
    const tsvPath = join(dir, "test.tsv");
    writeFileSync(tsvPath, "the\tquick\tbrown\t5\n");

    const key = await computeTrigramCacheKey(tsvPath, TRIGRAM_SCHEMA_VERSION);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic for the same file and schema version", async () => {
    const tsvPath = join(dir, "test.tsv");
    writeFileSync(tsvPath, "hello\tworld\tfoo\t10\n");

    const key1 = await computeTrigramCacheKey(tsvPath, TRIGRAM_SCHEMA_VERSION);
    const key2 = await computeTrigramCacheKey(tsvPath, TRIGRAM_SCHEMA_VERSION);
    expect(key1).toBe(key2);
  });

  test("changes when TSV content changes", async () => {
    const tsvPathA = join(dir, "a.tsv");
    const tsvPathB = join(dir, "b.tsv");
    writeFileSync(tsvPathA, "the\tquick\tbrown\t5\n");
    writeFileSync(tsvPathB, "the\tquick\tfox\t5\n");

    const keyA = await computeTrigramCacheKey(tsvPathA, TRIGRAM_SCHEMA_VERSION);
    const keyB = await computeTrigramCacheKey(tsvPathB, TRIGRAM_SCHEMA_VERSION);
    expect(keyA).not.toBe(keyB);
  });

  test("changes when schema version changes", async () => {
    const tsvPath = join(dir, "test.tsv");
    writeFileSync(tsvPath, "the\tquick\tbrown\t5\n");

    const key1 = await computeTrigramCacheKey(tsvPath, 1);
    const key2 = await computeTrigramCacheKey(tsvPath, 2);
    expect(key1).not.toBe(key2);
  });
});

// ─── TRIGRAM_FILENAME_PATTERN (task 3.7) ─────────────────────────────────────

describe("TRIGRAM_FILENAME_PATTERN", () => {
  test("matches trigram-{64hex}.bin", () => {
    expect(TRIGRAM_FILENAME_PATTERN.test(`trigram-${"a".repeat(64)}.bin`)).toBe(true);
    expect(TRIGRAM_FILENAME_PATTERN.test(`trigram-${"0".repeat(64)}.bin`)).toBe(true);
    expect(
      TRIGRAM_FILENAME_PATTERN.test(
        "trigram-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.bin",
      ),
    ).toBe(true);
  });

  test("does not match .tmp files", () => {
    expect(
      TRIGRAM_FILENAME_PATTERN.test(`trigram-${"a".repeat(64)}.bin.12345-abc.tmp`),
    ).toBe(false);
  });

  test("does not match symspell cache files", () => {
    expect(TRIGRAM_FILENAME_PATTERN.test("symspell-aaaaaaaaaaaaaaaa.bin")).toBe(false);
  });

  test("does not match files with wrong hex length", () => {
    expect(TRIGRAM_FILENAME_PATTERN.test(`trigram-${"a".repeat(16)}.bin`)).toBe(false);
    expect(TRIGRAM_FILENAME_PATTERN.test(`trigram-${"a".repeat(63)}.bin`)).toBe(false);
    expect(TRIGRAM_FILENAME_PATTERN.test(`trigram-${"a".repeat(65)}.bin`)).toBe(false);
  });

  test("does not match unrelated files", () => {
    expect(TRIGRAM_FILENAME_PATTERN.test("notes.txt")).toBe(false);
    expect(TRIGRAM_FILENAME_PATTERN.test("trigram-top500k.tsv")).toBe(false);
  });
});

// ─── pruneStaleTrigramCaches (task 3.7) ──────────────────────────────────────

describe("pruneStaleTrigramCaches", () => {
  let pruneDir: string;

  beforeEach(async () => {
    pruneDir = await actualFs.mkdtemp(join(tmpdir(), "trigram-prune-"));
  });

  afterEach(async () => {
    await actualFs.rm(pruneDir, { recursive: true, force: true });
  });

  test("deletes stale trigram-*.bin files, keeps current, skips .tmp and unrelated files", async () => {
    const currentKey = "a".repeat(64);
    const staleKey = "b".repeat(64);

    writeFileSync(join(pruneDir, `trigram-${currentKey}.bin`), "current");
    writeFileSync(join(pruneDir, `trigram-${staleKey}.bin`), "stale");
    // In-flight writer temp file — must NOT be pruned (doesn't match TRIGRAM_FILENAME_PATTERN)
    writeFileSync(join(pruneDir, `trigram-${staleKey}.bin.12345-abc.tmp`), "tmp");
    // Unrelated files — must NOT be pruned
    writeFileSync(join(pruneDir, "notes.txt"), "notes");
    writeFileSync(join(pruneDir, "symspell-aaaaaaaaaaaaaaaa.bin"), "symspell");

    await pruneStaleTrigramCaches(pruneDir, currentKey);

    expect(await fileExists(join(pruneDir, `trigram-${currentKey}.bin`))).toBe(true);
    expect(await fileExists(join(pruneDir, `trigram-${staleKey}.bin`))).toBe(false);
    expect(
      await fileExists(join(pruneDir, `trigram-${staleKey}.bin.12345-abc.tmp`)),
    ).toBe(true);
    expect(await fileExists(join(pruneDir, "notes.txt"))).toBe(true);
    expect(await fileExists(join(pruneDir, "symspell-aaaaaaaaaaaaaaaa.bin"))).toBe(true);
  });

  test("handles multiple stale files", async () => {
    const currentKey = "c".repeat(64);
    const staleKeys = ["a".repeat(64), "b".repeat(64), "d".repeat(64)];

    writeFileSync(join(pruneDir, `trigram-${currentKey}.bin`), "current");
    for (const k of staleKeys) {
      writeFileSync(join(pruneDir, `trigram-${k}.bin`), "stale");
    }

    await pruneStaleTrigramCaches(pruneDir, currentKey);

    expect(await fileExists(join(pruneDir, `trigram-${currentKey}.bin`))).toBe(true);
    for (const k of staleKeys) {
      expect(await fileExists(join(pruneDir, `trigram-${k}.bin`))).toBe(false);
    }
  });

  test("handles readdir failure gracefully (does not throw)", async () => {
    vi.mocked(readdir).mockImplementationOnce(() =>
      Promise.reject(new Error("EACCES: permission denied")),
    );

    // Must not throw
    await expect(pruneStaleTrigramCaches(pruneDir, "a".repeat(64))).resolves.toBeUndefined();
  });

  test("swallows per-file unlink failures without throwing", async () => {
    const currentKey = "c".repeat(64);
    const staleKey = "b".repeat(64);

    writeFileSync(join(pruneDir, `trigram-${currentKey}.bin`), "current");
    writeFileSync(join(pruneDir, `trigram-${staleKey}.bin`), "stale");

    // Make unlink fail for the stale file
    vi.mocked(unlink).mockRejectedValueOnce(new Error("EPERM: not permitted"));

    // Must not throw even when unlink fails
    await expect(pruneStaleTrigramCaches(pruneDir, currentKey)).resolves.toBeUndefined();
  });
});

// ─── End-to-end: TSV → cache → reload ────────────────────────────────────────

describe("end-to-end: TSV → binary cache → reload", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await actualFs.mkdtemp(join(tmpdir(), "trigram-e2e-"));
  });

  afterEach(async () => {
    await actualFs.rm(dir, { recursive: true, force: true });
  });

  test("loadFromTsv → writeCache → loadFromCache gives same lookup results", async () => {
    const tsvPath = join(dir, "trigrams.tsv");
    writeFileSync(
      tsvPath,
      [
        "as\tsoon\tas\t12345",
        "i\twant\tto\t9876",
        "out\tof\tthe\t7654",
        "i\twant\tto\t111", // duplicate triple — last write wins in TSV parse
      ].join("\n") + "\n",
    );

    const original = await TrigramTable.loadFromTsv(tsvPath);
    const key = await computeTrigramCacheKey(tsvPath, TRIGRAM_SCHEMA_VERSION);
    const cachePath = join(dir, `trigram-${key}.bin`);
    await original.writeCache(cachePath);

    const loaded = await TrigramTable.loadFromCache(cachePath);
    expect(loaded).not.toBeNull();

    // Spot-check lookups match
    expect(loaded!.getTrigramCount("as", "soon", "as")).toBe(
      original.getTrigramCount("as", "soon", "as"),
    );
    expect(loaded!.getTrigramCount("i", "want", "to")).toBe(
      original.getTrigramCount("i", "want", "to"),
    );
    expect(loaded!.getBigramPrefixCount("i", "want")).toBe(
      original.getBigramPrefixCount("i", "want"),
    );
  });
});

// ─── §8 Process-wide singleton ────────────────────────────────────────────────

/** Build a lightweight mock TelemetryWriter that records emitted events. */
function makeMockWriter(): { writer: TelemetryWriter; emits: TelemetryEvent[] } {
  const emits: TelemetryEvent[] = [];
  const writer = {
    emit: (event: TelemetryEvent) => {
      emits.push(event);
    },
  } as unknown as TelemetryWriter;
  return { writer, emits };
}

describe("§8 Process-wide singleton (getTrigramTableSingleton)", () => {
  let dir: string;

  // Per-test setup: fresh temp dir + reset singleton + restore fs mocks.
  beforeEach(async () => {
    dir = await actualFs.mkdtemp(join(tmpdir(), "singleton-"));
    __resetTrigramSingletonForTests();
    vi.resetAllMocks();
    if (actualFs) {
      vi.mocked(rename).mockImplementation(actualFs.rename);
      vi.mocked(writeFile).mockImplementation((...args: unknown[]) =>
        (actualFs.writeFile as (...a: unknown[]) => Promise<void>)(...args),
      );
      vi.mocked(readFile).mockImplementation((...args: unknown[]) =>
        (actualFs.readFile as (...a: unknown[]) => Promise<Buffer>)(...args),
      );
      vi.mocked(unlink).mockImplementation(actualFs.unlink);
      vi.mocked(readdir).mockImplementation((...args: unknown[]) =>
        (actualFs.readdir as (...a: unknown[]) => Promise<string[]>)(...args),
      );
    }
  });

  afterEach(async () => {
    __resetTrigramSingletonForTests();
    vi.restoreAllMocks();
    // Brief pause so fire-and-forget writeCache / prune operations can settle
    // before the temp directory is removed.  Without this, a racing writeFile
    // temp-file can cause ENOTEMPTY on the subsequent rmdir call.
    await new Promise<void>((r) => setTimeout(r, 100));
    await actualFs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  // ── 8.5.1: Same promise returned on multiple calls ────────────────────────

  test("multiple calls return the === same promise", async () => {
    const opts = { cacheDir: dir, tsvPath: join(dir, "nonexistent.tsv") };
    const p1 = getTrigramTableSingleton(opts);
    const p2 = getTrigramTableSingleton(opts);
    expect(p1).toBe(p2); // strict identity
    await p1; // let it settle
  });

  // ── 8.5.2: Only first caller's telemetry is used for the emit ─────────────

  test("only first caller's telemetry emits trigram.lazy_attached; second caller's is ignored", async () => {
    const { writer: writerA, emits: emitsA } = makeMockWriter();
    const { writer: writerB, emits: emitsB } = makeMockWriter();

    const opts = { cacheDir: dir, tsvPath: join(dir, "nonexistent.tsv") };
    const p1 = getTrigramTableSingleton({ ...opts, telemetry: writerA });
    const p2 = getTrigramTableSingleton({ ...opts, telemetry: writerB });

    // Both calls must return the exact same promise.
    expect(p1).toBe(p2);

    await p1; // resolve to null (file missing)

    const lazyEventsA = emitsA.filter((e) => e.event === "trigram.lazy_attached");
    const lazyEventsB = emitsB.filter((e) => e.event === "trigram.lazy_attached");
    expect(lazyEventsA).toHaveLength(1); // first caller emitted
    expect(lazyEventsB).toHaveLength(0); // second caller did not
  });

  // ── 8.5.3: Resolves to null on TSV-missing, no throw ─────────────────────

  test("resolves to null when TSV is missing (no throw)", async () => {
    const opts = { cacheDir: dir, tsvPath: join(dir, "nonexistent.tsv") };
    const result = await getTrigramTableSingleton(opts);
    expect(result).toBeNull();
  });

  // ── 8.5.4: __resetTrigramSingletonForTests clears state ──────────────────

  test("__resetTrigramSingletonForTests allows fresh singleton after reset", async () => {
    const opts = { cacheDir: dir, tsvPath: join(dir, "nonexistent.tsv") };
    const p1 = getTrigramTableSingleton(opts);
    await p1; // resolve to null

    __resetTrigramSingletonForTests();

    // After reset, a new call creates a NEW promise (not the same object).
    const p2 = getTrigramTableSingleton(opts);
    expect(p2).not.toBe(p1); // different promise object after reset
    await p2;
  });

  // ── 8.5.5: trigram.lazy_attached emitted exactly once ────────────────────

  test("trigram.lazy_attached emitted exactly once across multiple calls", async () => {
    const { writer, emits } = makeMockWriter();
    const opts = { cacheDir: dir, tsvPath: join(dir, "nonexistent.tsv"), telemetry: writer };

    // Call multiple times — all return the same promise.
    const promises = [
      getTrigramTableSingleton(opts),
      getTrigramTableSingleton(opts),
      getTrigramTableSingleton(opts),
    ];
    await Promise.all(promises);

    const lazyEmits = emits.filter((e) => e.event === "trigram.lazy_attached");
    expect(lazyEmits).toHaveLength(1); // exactly once
  });

  // ── 8.5.6: Cache-hit path emits outcome:"ready" ───────────────────────────

  test("cache-hit path: loadFromCache called; emits outcome:ready with trigramCount", async () => {
    // Create a real fixture TSV + cache file.
    const tsvPath = join(dir, "trigrams.tsv");
    writeFileSync(
      tsvPath,
      ["i\twant\tto\t9999", "as\tsoon\tas\t5000"].join("\n") + "\n",
    );

    // Pre-build the cache file.
    const original = await TrigramTable.loadFromTsv(tsvPath);
    const key = await computeTrigramCacheKey(tsvPath, TRIGRAM_SCHEMA_VERSION);
    const cachePath = join(dir, `trigram-${key}.bin`);
    await original.writeCache(cachePath);

    // Spy to confirm loadFromCache is used (not loadFromTsv).
    const cacheSpy = vi.spyOn(TrigramTable, "loadFromCache");
    const tsvSpy = vi.spyOn(TrigramTable, "loadFromTsv");

    const { writer, emits } = makeMockWriter();
    const table = await getTrigramTableSingleton({ cacheDir: dir, tsvPath, telemetry: writer });

    expect(table).not.toBeNull();
    expect(cacheSpy).toHaveBeenCalledTimes(1);
    expect(tsvSpy).not.toHaveBeenCalled(); // cache hit — TSV not parsed again

    const ev = emits.find((e) => e.event === "trigram.lazy_attached");
    expect(ev).toBeDefined();
    // Type assertion to access specific fields.
    const lazyEv = ev as { event: "trigram.lazy_attached"; outcome: string; trigramCount: number | null };
    expect(lazyEv.outcome).toBe("ready");
    expect(lazyEv.trigramCount).toBeGreaterThan(0);
  });

  // ── 8.5.7: TSV-load path emits outcome:"ready" ───────────────────────────

  test("cache-miss path: loadFromTsv called; emits outcome:ready with trigramCount", async () => {
    const tsvPath = join(dir, "trigrams.tsv");
    writeFileSync(
      tsvPath,
      ["i\twant\tto\t9999", "as\tsoon\tas\t5000"].join("\n") + "\n",
    );

    // No cache file pre-built — force TSV load.
    const cacheSpy = vi.spyOn(TrigramTable, "loadFromCache");
    const tsvSpy = vi.spyOn(TrigramTable, "loadFromTsv");

    const { writer, emits } = makeMockWriter();
    const table = await getTrigramTableSingleton({ cacheDir: dir, tsvPath, telemetry: writer });

    expect(table).not.toBeNull();
    expect(tsvSpy).toHaveBeenCalledTimes(1);
    // loadFromCache is called once (returns null → cache miss).
    expect(cacheSpy).toHaveBeenCalledTimes(1);

    const ev = emits.find((e) => e.event === "trigram.lazy_attached");
    expect(ev).toBeDefined();
    const lazyEv = ev as { event: "trigram.lazy_attached"; outcome: string; trigramCount: number | null };
    expect(lazyEv.outcome).toBe("ready");
    expect(lazyEv.trigramCount).toBeGreaterThan(0);
  });

  // ── 8.5.8: Load happens exactly once even with multiple concurrent callers ─

  test("loadFromTsv called exactly once even when multiple callers race", async () => {
    const tsvPath = join(dir, "trigrams.tsv");
    writeFileSync(tsvPath, "i\twant\tto\t9999\n");

    const tsvSpy = vi.spyOn(TrigramTable, "loadFromTsv");

    // Five concurrent callers — should all get the same promise.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        getTrigramTableSingleton({ cacheDir: dir, tsvPath }),
      ),
    );

    // All resolved to the same non-null table.
    expect(results.every((r) => r !== null)).toBe(true);
    expect(results.every((r) => r === results[0])).toBe(true); // same object

    // TSV was parsed exactly once.
    expect(tsvSpy).toHaveBeenCalledTimes(1);
  });

  // ── 8.5.9: Failure path emits outcome:"failed" ───────────────────────────

  test("failure (TSV missing) emits outcome:failed with null trigramCount", async () => {
    const { writer, emits } = makeMockWriter();
    await getTrigramTableSingleton({
      cacheDir: dir,
      tsvPath: join(dir, "nonexistent.tsv"),
      telemetry: writer,
    });

    const ev = emits.find((e) => e.event === "trigram.lazy_attached");
    expect(ev).toBeDefined();
    const lazyEv = ev as { event: "trigram.lazy_attached"; outcome: string; trigramCount: number | null };
    expect(lazyEv.outcome).toBe("failed");
    expect(lazyEv.trigramCount).toBeNull();
  });
});
