/**
 * index-cache.ts — Persistent on-disk cache for the SymSpell deletion index.
 *
 * Binary format (schema v2):
 *   Header:       4 bytes magic "SYMC" | u32 schema | u32 maxEditDistance | u32 maxDictWordLen
 *   String table: u32 count | (u8 len + utf-8 bytes) * count
 *   Words:        u32 count | (u32 strIdx + f64 freq) * count
 *   Deletes:      u32 count | (i32 hash + u16 bucketLen + u32 strIdx * bucketLen) * count
 *   Bigrams:      f64 bigramCountMin | u32 count | (u32 w1Idx + u32 w2Idx + f64 count) * count
 *
 * The `symspell` parameter throughout uses `any` to avoid coupling this module
 * to the upstream SymSpell type — callers pass a real SymSpell instance that
 * structurally satisfies the field accesses below. The serializer reaches into
 * nominally-private fields (words, deletes, maxDictionaryWordLength,
 * maxDictionaryEditDistance, belowThresholdWords, bigrams, bigramCountMin)
 * whose names are pinned to symspell-ts v0.0.2 and verified in
 * node_modules/symspell-ts/dist/symspell.js.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSymspellPackageRoot } from "./symspell-paths.js";

// ─── Public interfaces ──────────────────────────────────────────────────────

export interface CacheDescriptor {
  maxEditDistance: number;
  prefixLength: number;
  compactLevel: number;
  countThreshold: number;
}

export interface HydrationResult {
  words: Map<string, number>;
  deletes: Map<number, string[]>;
  maxDictionaryWordLength: number;
  bigrams: Map<string, number>;
  bigramCountMin: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 2;
export const CACHE_MAGIC = "SYMC";
export const FILENAME_PATTERN = /^symspell-[0-9a-f]{16}\.bin$/;

/**
 * Pinned engine constants — cross-referenced from correction-engine.ts so a
 * future change to one fails CI alongside the other.
 */
export const CACHE_PREFIX_LENGTH = 7;
export const CACHE_COUNT_THRESHOLD = 1;
export const CACHE_COMPACT_LEVEL = 5;

// ─── Error classes ───────────────────────────────────────────────────────────

export class BucketOverflowError extends Error {
  constructor(bucketSize: number) {
    super(
      `[index-cache] BUCKET_OVERFLOW: delete bucket has ${bucketSize} entries, ` +
        `which exceeds u16 max (65535). Bump the schema version to support larger buckets.`,
    );
    this.name = "BucketOverflowError";
  }
}

// ─── Module-level state ──────────────────────────────────────────────────────

let cacheDisabled = false;
let dirEnsured = false;

/**
 * Module-level bigram dictionary hash cache.
 *
 * Pre-computed lazily on the first call to getBigramDictHash() and cached
 * for the lifetime of the module, so computeCacheKey() stays synchronous.
 * undefined = not yet computed; null = resolution failed (fail-closed).
 *
 * Design rationale: making computeCacheKey() async would require updating all
 * callers (loadCache, writeCache, the engine, test call sites). Instead, we
 * pre-compute the hash synchronously via readdirSync + readFileSync (the same
 * pattern computeCacheKey already uses for package.json). The result is cached
 * to avoid reading the 4.9 MB bigram file on every cache-key computation.
 */
let bigramDictHashCache: string | null | undefined = undefined;

/**
 * Lazily resolve and hash the symspell-ts bigram dictionary file.
 * Uses synchronous I/O (readdirSync, readFileSync) for the same reason
 * computeCacheKey uses readFileSync for package.json.
 * Returns null if the glob finds 0 or 2+ matches, or if any I/O fails.
 */
function getBigramDictHash(): string | null {
  if (bigramDictHashCache !== undefined) return bigramDictHashCache;
  try {
    const pkgRoot = resolveSymspellPackageRoot();
    if (pkgRoot === null) {
      bigramDictHashCache = null;
      return null;
    }
    const dataDir = join(pkgRoot, "data");
    const files = readdirSync(dataDir);
    const matches = files.filter((f) => /^frequency_bigramdictionary_en_.*\.txt$/.test(f));
    if (matches.length !== 1) {
      console.info(
        `[mobile-autocorrect] cache disabled: expected exactly 1 bigram dict file, found ${matches.length}`,
      );
      bigramDictHashCache = null;
      return null;
    }
    const bytes = readFileSync(join(dataDir, matches[0]));
    bigramDictHashCache = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    return bigramDictHashCache;
  } catch (err) {
    console.info(
      `[mobile-autocorrect] cache disabled: cannot hash bigram dict: ${formatError(err)}`,
    );
    bigramDictHashCache = null;
    return null;
  }
}

/**
 * Reset module-level cache state. FOR TESTS ONLY — production code must not
 * call this. Allows tests to re-exercise the mkdir path without module reload.
 */
export function __resetCacheDisabledForTests(): void {
  cacheDisabled = false;
  dirEnsured = false;
  bigramDictHashCache = undefined;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Cache directory ─────────────────────────────────────────────────────────

/**
 * Return the configured cache directory path, or null if caching is disabled.
 * Does NOT create the directory. Truthy-checks the trimmed env var so that
 * MOBILE_AUTOCORRECT_CACHE_DIR="" and whitespace-only both fall through to the
 * default location.
 */
export function getCacheDir(): string | null {
  if (cacheDisabled) return null;
  const env = process.env.MOBILE_AUTOCORRECT_CACHE_DIR?.trim();
  return env ? env : join(homedir(), ".pi", "agent", "cache", "mobile-autocorrect");
}

async function ensureCacheDir(): Promise<string | null> {
  const dir = getCacheDir();
  if (!dir) return null;
  if (dirEnsured) return dir;
  try {
    await mkdir(dir, { recursive: true });
    dirEnsured = true;
    return dir;
  } catch (err) {
    console.info(
      `[mobile-autocorrect] cache disabled: cannot create cache dir ${dir}: ${formatError(err)}`,
    );
    cacheDisabled = true;
    return null;
  }
}

// ─── Cache key ───────────────────────────────────────────────────────────────

/**
 * Compute the 16-character hex cache key for the given descriptor.
 * Returns null if the symspell-ts package root cannot be resolved (cache
 * is disabled for this process).
 */
export function computeCacheKey(descriptor: CacheDescriptor): string | null {
  const pkgRoot = resolveSymspellPackageRoot();
  if (pkgRoot === null) {
    console.info("[mobile-autocorrect] cache disabled: symspell-ts package root not resolvable");
    return null;
  }

  let version: string;
  try {
    const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof pkgJson.version !== "string") {
      console.info(
        "[mobile-autocorrect] cache disabled: symspell-ts package.json has no version string",
      );
      return null;
    }
    version = pkgJson.version;
  } catch (err) {
    console.info(
      `[mobile-autocorrect] cache disabled: cannot read symspell-ts package.json: ${formatError(err)}`,
    );
    return null;
  }

  // Resolve the bigram dict hash (lazy, cached at module level so this
  // function stays synchronous). Fail-closed: if the bigram dict cannot be
  // found or hashed, the cache is disabled for this process.
  const bigramDictHash = getBigramDictHash();
  if (bigramDictHash === null) {
    console.info(
      "[mobile-autocorrect] cache disabled: bigram dictionary file not resolvable",
    );
    return null;
  }

  const canonical = JSON.stringify({
    maxED: descriptor.maxEditDistance,
    prefixLen: descriptor.prefixLength,
    compactLevel: descriptor.compactLevel,
    countThreshold: descriptor.countThreshold,
    libVersion: version,
    schemaVersion: SCHEMA_VERSION,
    bigramsPresent: true,
    bigramDictHash,
  });

  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// ─── File path ───────────────────────────────────────────────────────────────

/**
 * Return the full path to the cache file for the given key, or null if the
 * cache directory is disabled. Never throws.
 */
export function getCacheFilePath(key: string): string | null {
  const dir = getCacheDir();
  if (!dir) return null;
  return join(dir, `symspell-${key}.bin`);
}

// ─── Serializer ──────────────────────────────────────────────────────────────

/**
 * Serialize a SymSpell instance to a binary buffer (schema v2).
 *
 * MAY throw:
 *  - BucketOverflowError  — any delete bucket has > 65535 entries (u16 max)
 *  - Error (BELOW_THRESHOLD_NONEMPTY) — belowThresholdWords is non-empty
 *  - Error — any string's UTF-8 encoding exceeds 255 bytes (u8 length prefix)
 *
 * Uses Buffer.allocUnsafe + manual cursor writes for performance.
 */
export function serializeIndex(symspell: any): Buffer {
  // Access nominally-private fields of SymSpell (symspell-ts v0.0.2).
  // Field names verified against node_modules/symspell-ts/dist/symspell.js.
  const words = symspell.words as Map<string, number>;
  const deletes = (symspell.deletes ?? new Map()) as Map<number, string[]>;
  const maxDictionaryWordLength = symspell.maxDictionaryWordLength as number;
  const maxDictionaryEditDistance = symspell.maxDictionaryEditDistance as number;
  const belowThresholdWords = symspell.belowThresholdWords as
    | Map<string, number>
    | undefined
    | null;
  const bigrams = (symspell.bigrams ?? new Map()) as Map<string, number>;
  const bigramCountMin = (symspell.bigramCountMin ?? Number.MAX_SAFE_INTEGER) as number;

  // Assertion (b): schema v2 does not serialize belowThresholdWords.
  // With countThreshold=1 and a standard English unigram load this is always
  // empty. If it isn't, something changed that the format can't represent.
  if (belowThresholdWords && belowThresholdWords.size > 0) {
    throw new Error(
      `[index-cache] BELOW_THRESHOLD_NONEMPTY: belowThresholdWords has ` +
        `${belowThresholdWords.size} entries. Schema v2 does not serialize this map. ` +
        `Bump the schema version if countThreshold > 1 is needed.`,
    );
  }

  // Assertion (a): bucket length must fit in u16.
  for (const [, suggestions] of deletes.entries()) {
    if (suggestions.length > 65535) {
      throw new BucketOverflowError(suggestions.length);
    }
  }

  // Pre-process bigrams: parse "w1 w2" keys and keep only well-formed entries
  // (exactly one space separator). This ensures the size calculation matches
  // the bytes written.
  const bigramEntries: [string, string, number][] = [];
  for (const [key, count] of bigrams.entries()) {
    const spaceIdx = key.indexOf(" ");
    if (spaceIdx === -1 || spaceIdx !== key.lastIndexOf(" ")) continue;
    bigramEntries.push([key.slice(0, spaceIdx), key.slice(spaceIdx + 1), count]);
  }

  // Build deduplicated string table in insertion order: first all word keys,
  // then any new strings found in delete bucket suggestion lists, then any
  // new strings referenced by bigram entries.
  const stringTable = new Map<string, number>(); // string → index

  function intern(s: string): number {
    let idx = stringTable.get(s);
    if (idx === undefined) {
      idx = stringTable.size;
      stringTable.set(s, idx);
    }
    return idx;
  }

  for (const word of words.keys()) intern(word);
  for (const suggestions of deletes.values()) {
    for (const s of suggestions) intern(s);
  }
  for (const [w1, w2] of bigramEntries) {
    intern(w1);
    intern(w2);
  }

  // Pre-encode strings and validate the u8 length prefix constraint.
  const stringBuffers: Buffer[] = [];
  for (const s of stringTable.keys()) {
    const buf = Buffer.from(s, "utf8");
    if (buf.length > 255) {
      // Assertion (c): English unigrams are all ASCII; this catches exotic inputs.
      throw new Error(
        `[index-cache] String table entry exceeds 255 bytes: "${s}" (${buf.length} bytes). ` +
          `Schema v1 uses a u8 length prefix.`,
      );
    }
    stringBuffers.push(buf);
  }

  // ── Compute total buffer size ──────────────────────────────────────────────

  // Header: 4 magic + 4 schema + 4 maxED + 4 maxDictWordLen = 16 bytes
  const headerSize = 16;

  // String table: 4 count + sum(1 + len) per entry
  let stringTableSize = 4;
  for (const buf of stringBuffers) stringTableSize += 1 + buf.length;

  // Words: 4 count + (4 u32 idx + 8 f64 freq) per entry
  const wordsSize = 4 + words.size * 12;

  // Deletes: 4 count + (4 i32 hash + 2 u16 len + 4 u32 idx * len) per bucket
  let deletesSize = 4;
  for (const [, suggestions] of deletes.entries()) {
    deletesSize += 4 + 2 + 4 * suggestions.length;
  }

  // Bigrams: 8 (bigramCountMin f64) + 4 (count u32) + 16 per entry (u32+u32+f64)
  const bigramsSize = 8 + 4 + bigramEntries.length * 16;

  const totalSize = headerSize + stringTableSize + wordsSize + deletesSize + bigramsSize;
  const buf = Buffer.allocUnsafe(totalSize);
  let cursor = 0;

  // ── Write header ──────────────────────────────────────────────────────────
  buf.write(CACHE_MAGIC, cursor, "ascii");
  cursor += 4;
  buf.writeUInt32LE(SCHEMA_VERSION, cursor);
  cursor += 4;
  buf.writeUInt32LE(maxDictionaryEditDistance, cursor);
  cursor += 4;
  buf.writeUInt32LE(maxDictionaryWordLength, cursor);
  cursor += 4;

  // ── Write string table ────────────────────────────────────────────────────
  buf.writeUInt32LE(stringTable.size, cursor);
  cursor += 4;
  for (const strBuf of stringBuffers) {
    buf.writeUInt8(strBuf.length, cursor);
    cursor += 1;
    strBuf.copy(buf, cursor);
    cursor += strBuf.length;
  }

  // ── Write words ───────────────────────────────────────────────────────────
  buf.writeUInt32LE(words.size, cursor);
  cursor += 4;
  for (const [word, freq] of words.entries()) {
    buf.writeUInt32LE(stringTable.get(word)!, cursor);
    cursor += 4;
    buf.writeDoubleLE(freq, cursor);
    cursor += 8;
  }

  // ── Write delete buckets ──────────────────────────────────────────────────
  buf.writeUInt32LE(deletes.size, cursor);
  cursor += 4;
  for (const [hash, suggestions] of deletes.entries()) {
    buf.writeInt32LE(hash, cursor);
    cursor += 4;
    buf.writeUInt16LE(suggestions.length, cursor);
    cursor += 2;
    for (const s of suggestions) {
      buf.writeUInt32LE(stringTable.get(s)!, cursor);
      cursor += 4;
    }
  }

  // ── Write bigrams section ────────────────────────────────────────────────
  // bigramCountMin is written FIRST (before count) so it is restored before
  // iterating bigram entries, matching SymSpell’s internal load-order invariant.
  buf.writeDoubleLE(bigramCountMin, cursor);
  cursor += 8;
  buf.writeUInt32LE(bigramEntries.length, cursor);
  cursor += 4;
  for (const [w1, w2, bigramCount] of bigramEntries) {
    buf.writeUInt32LE(stringTable.get(w1)!, cursor);
    cursor += 4;
    buf.writeUInt32LE(stringTable.get(w2)!, cursor);
    cursor += 4;
    buf.writeDoubleLE(bigramCount, cursor);
    cursor += 8;
  }

  if (cursor !== totalSize) {
    throw new Error(
      `[index-cache] Buffer size mismatch: wrote ${cursor} bytes but allocated ${totalSize} bytes`,
    );
  }

  return buf;
}

// ─── Deserializer ─────────────────────────────────────────────────────────────

/**
 * Deserialize a binary buffer into a HydrationResult.
 *
 * Returns null (does NOT throw) on any parse error — the load path treats all
 * corruption identically and falls through to a fresh build.
 *
 * In contrast to the serializer, which throws to catch our own bugs at write
 * time, the deserializer is conservative: any unexpected byte pattern → null.
 */
export function deserializeIndex(
  buffer: Buffer,
  expected: CacheDescriptor,
): HydrationResult | null {
  try {
    let cursor = 0;

    function readBytes(n: number): Buffer | null {
      if (cursor + n > buffer.length) return null;
      const slice = buffer.subarray(cursor, cursor + n);
      cursor += n;
      return slice;
    }

    function readU8(): number | null {
      if (cursor + 1 > buffer.length) return null;
      return buffer.readUInt8(cursor++);
    }

    function readU16(): number | null {
      if (cursor + 2 > buffer.length) return null;
      const v = buffer.readUInt16LE(cursor);
      cursor += 2;
      return v;
    }

    function readU32(): number | null {
      if (cursor + 4 > buffer.length) return null;
      const v = buffer.readUInt32LE(cursor);
      cursor += 4;
      return v;
    }

    function readI32(): number | null {
      if (cursor + 4 > buffer.length) return null;
      const v = buffer.readInt32LE(cursor);
      cursor += 4;
      return v;
    }

    function readF64(): number | null {
      if (cursor + 8 > buffer.length) return null;
      const v = buffer.readDoubleLE(cursor);
      cursor += 8;
      return v;
    }

    // ── Header ───────────────────────────────────────────────────────────────

    const magicBytes = readBytes(4);
    if (magicBytes === null || magicBytes.toString("ascii") !== CACHE_MAGIC) return null;

    const schemaVersion = readU32();
    if (schemaVersion === null || schemaVersion !== SCHEMA_VERSION) return null;

    const storedMaxED = readU32();
    if (storedMaxED === null || storedMaxED !== expected.maxEditDistance) return null;

    const maxDictionaryWordLength = readU32();
    if (maxDictionaryWordLength === null) return null;

    // ── String table ─────────────────────────────────────────────────────────

    const stringCount = readU32();
    if (stringCount === null) return null;

    const strings: string[] = [];
    for (let i = 0; i < stringCount; i++) {
      const len = readU8();
      if (len === null) return null;
      const strBytes = readBytes(len);
      if (strBytes === null) return null;
      strings.push(strBytes.toString("utf8"));
    }

    // ── Words ─────────────────────────────────────────────────────────────────

    const wordCount = readU32();
    if (wordCount === null) return null;

    const words = new Map<string, number>();
    for (let i = 0; i < wordCount; i++) {
      const idx = readU32();
      if (idx === null || idx >= strings.length) return null;
      const freq = readF64();
      if (freq === null) return null;
      words.set(strings[idx], freq);
    }

    // ── Delete buckets ────────────────────────────────────────────────────────

    const bucketCount = readU32();
    if (bucketCount === null) return null;

    const deletes = new Map<number, string[]>();
    for (let i = 0; i < bucketCount; i++) {
      const hash = readI32();
      if (hash === null) return null;
      const bucketLen = readU16();
      if (bucketLen === null) return null;
      const suggestions: string[] = [];
      for (let j = 0; j < bucketLen; j++) {
        const idx = readU32();
        if (idx === null || idx >= strings.length) return null;
        suggestions.push(strings[idx]);
      }
      deletes.set(hash, suggestions);
    }

    // ── Bigrams section ────────────────────────────────────────────────
    // bigramCountMin is read FIRST (serialized before the entry list).
    const bigramCountMin = readF64();
    if (bigramCountMin === null) return null;

    const bigramCount = readU32();
    if (bigramCount === null) return null;

    const bigrams = new Map<string, number>();
    for (let i = 0; i < bigramCount; i++) {
      const w1Idx = readU32();
      if (w1Idx === null || w1Idx >= strings.length) return null;
      const w2Idx = readU32();
      if (w2Idx === null || w2Idx >= strings.length) return null;
      const count = readF64();
      if (count === null) return null;
      bigrams.set(`${strings[w1Idx]} ${strings[w2Idx]}`, count);
    }

    return { words, deletes, maxDictionaryWordLength, bigrams, bigramCountMin };
  } catch {
    // Any unexpected exception (e.g., buffer.readXxx out of bounds) → corrupt.
    return null;
  }
}

// ─── Load ────────────────────────────────────────────────────────────────────

/**
 * Try to load a cached SymSpell index for the given descriptor.
 * Returns null on cache miss, stale key, corrupt data, or disabled cache.
 * Never throws.
 */
export async function loadCache(descriptor: CacheDescriptor): Promise<HydrationResult | null> {
  const key = computeCacheKey(descriptor);
  if (key === null) return null;

  const dir = await ensureCacheDir();
  if (!dir) return null;

  const filePath = join(dir, `symspell-${key}.bin`);
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.info(`[mobile-autocorrect] cache load: read failed: ${formatError(err)}`);
    }
    return null;
  }

  try {
    return deserializeIndex(buffer, descriptor);
  } catch (err) {
    console.info(`[mobile-autocorrect] cache load: parse failed: ${formatError(err)}`);
    return null;
  }
}

// ─── Write ───────────────────────────────────────────────────────────────────

/**
 * Serialize `symspell` and atomically write it to the cache file for
 * `descriptor`. Never throws past this boundary — write failures are logged
 * at info level so engine readiness is not affected.
 *
 * Atomic-write: write to a unique per-writer temp file, then rename().
 * POSIX-only semantics: on POSIX, rename() atomically replaces an existing
 * target. On Windows, rename() throws EEXIST when the target already exists.
 * The cache subsystem MAY be skipped on Windows at a higher level.
 */
export async function writeCache(descriptor: CacheDescriptor, symspell: any): Promise<void> {
  const key = computeCacheKey(descriptor);
  if (key === null) return;

  const dir = await ensureCacheDir();
  if (!dir) return;

  let buffer: Buffer;
  try {
    buffer = serializeIndex(symspell);
  } catch (err) {
    console.info(`[mobile-autocorrect] cache write failed: ${formatError(err)}`);
    return;
  }

  const baseFilename = `symspell-${key}.bin`;
  // Unique per-writer suffix prevents two concurrent writers from using the
  // same temp path and interleaving bytes. PID + 8 random bytes = 16 hex chars.
  const tempName = `${baseFilename}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
  const tempPath = join(dir, tempName);
  const finalPath = join(dir, baseFilename);

  try {
    await writeFile(tempPath, buffer);
    await rename(tempPath, finalPath);
  } catch (err) {
    console.info(`[mobile-autocorrect] cache write failed: ${formatError(err)}`);
    // Best-effort cleanup of the temp file if rename failed.
    await unlink(tempPath).catch(() => undefined);
  }
}

// ─── Prune ───────────────────────────────────────────────────────────────────

/**
 * Delete stale sibling cache files in the cache directory.
 * Only removes files matching `symspell-*.bin` whose name differs from the
 * current key's filename. Skips *.tmp files and unrelated user files.
 * Per-file errors are logged and swallowed — pruning is best-effort.
 */
export async function pruneStaleSiblings(currentKey: string): Promise<void> {
  const dir = await ensureCacheDir();
  if (!dir) return;

  const currentFilename = `symspell-${currentKey}.bin`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    console.info(`[mobile-autocorrect] prune: readdir failed: ${formatError(err)}`);
    return;
  }

  for (const name of entries) {
    if (!FILENAME_PATTERN.test(name)) continue; // skip *.tmp and unrelated files
    if (name === currentFilename) continue;
    try {
      await unlink(join(dir, name));
    } catch (err) {
      console.info(`[mobile-autocorrect] prune: unlink ${name} failed: ${formatError(err)}`);
    }
  }
}
