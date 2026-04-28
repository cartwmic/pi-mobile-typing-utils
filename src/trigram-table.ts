/**
 * trigram-table.ts — In-memory trigram side-table with optional binary cache.
 *
 * Binary cache format (schema v1):
 *   Header:             4 bytes magic "TRIG" | u32 schema version
 *   String table:       u32 count | (u8 len + utf-8 bytes) * count
 *   Trigrams:           u32 count | (u32 w1Idx + u32 w2Idx + u32 w3Idx + f64 count) * count
 *   Bigram-prefix cnt:  u32 count | (u32 w1Idx + u32 w2Idx + f64 count) * count
 *
 * All numerics are little-endian, matching index-cache.ts.
 *
 * Map key separator: U+0001 (0x01) — cannot appear in lowercase-ASCII words,
 * guaranteeing no false key collisions in either map.
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { TelemetryWriter } from "./telemetry.js";

// ─── Constants ───────────────────────────────────────────────────────────────

export const TRIGRAM_SCHEMA_VERSION = 1;
export const TRIGRAM_CACHE_MAGIC = "TRIG";

/**
 * Matches `trigram-<64 lowercase hex chars>.bin` — the exact filename pattern
 * written by writeCache. Skips *.tmp files and unrelated files during pruning.
 */
export const TRIGRAM_FILENAME_PATTERN = /^trigram-[0-9a-f]{64}\.bin$/;

/** Byte 0x01 — safe separator between words in map keys (can't appear in lowercase-ASCII). */
const SEP = "\x01";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Serialization ───────────────────────────────────────────────────────────

function serializeTrigramTable(table: TrigramTable): Buffer {
  // Build a deduplicated string table in insertion order.
  const stringTable = new Map<string, number>();

  function intern(s: string): number {
    let idx = stringTable.get(s);
    if (idx === undefined) {
      idx = stringTable.size;
      stringTable.set(s, idx);
    }
    return idx;
  }

  // Intern words from trigrams (three words per entry).
  for (const key of table.trigrams.keys()) {
    const sep1 = key.indexOf(SEP);
    const sep2 = key.indexOf(SEP, sep1 + 1);
    intern(key.slice(0, sep1));
    intern(key.slice(sep1 + 1, sep2));
    intern(key.slice(sep2 + 1));
  }
  // Intern words from bigramPrefixCounts. Words from trigrams already cover
  // these in the normal case, but intern again to be safe.
  for (const key of table.bigramPrefixCounts.keys()) {
    const sep1 = key.indexOf(SEP);
    intern(key.slice(0, sep1));
    intern(key.slice(sep1 + 1));
  }

  // Pre-encode strings and validate the u8 length prefix constraint.
  const stringBuffers: Buffer[] = [];
  for (const s of stringTable.keys()) {
    const buf = Buffer.from(s, "utf8");
    if (buf.length > 255) {
      throw new Error(
        `[trigram-table] String table entry exceeds 255 bytes: "${s}" (${buf.length} bytes). ` +
          `Schema v1 uses a u8 length prefix.`,
      );
    }
    stringBuffers.push(buf);
  }

  // ── Compute total buffer size ──────────────────────────────────────────────

  // Header: 4 magic + 4 schema = 8 bytes
  const headerSize = 8;

  // String table: 4 count + sum(1 + len) per entry
  let stringTableSize = 4;
  for (const buf of stringBuffers) stringTableSize += 1 + buf.length;

  // Trigrams: 4 count + (3×u32 + f64) = (12 + 8) = 20 bytes per entry
  const trigramsSize = 4 + table.trigrams.size * 20;

  // Bigram prefix counts: 4 count + (2×u32 + f64) = (8 + 8) = 16 bytes per entry
  const bigramsSize = 4 + table.bigramPrefixCounts.size * 16;

  const totalSize = headerSize + stringTableSize + trigramsSize + bigramsSize;
  const buf = Buffer.allocUnsafe(totalSize);
  let cursor = 0;

  // ── Write header ──────────────────────────────────────────────────────────
  buf.write(TRIGRAM_CACHE_MAGIC, cursor, "ascii");
  cursor += 4;
  buf.writeUInt32LE(TRIGRAM_SCHEMA_VERSION, cursor);
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

  // ── Write trigrams ────────────────────────────────────────────────────────
  buf.writeUInt32LE(table.trigrams.size, cursor);
  cursor += 4;
  for (const [key, count] of table.trigrams.entries()) {
    const sep1 = key.indexOf(SEP);
    const sep2 = key.indexOf(SEP, sep1 + 1);
    const w1 = key.slice(0, sep1);
    const w2 = key.slice(sep1 + 1, sep2);
    const w3 = key.slice(sep2 + 1);
    buf.writeUInt32LE(stringTable.get(w1)!, cursor);
    cursor += 4;
    buf.writeUInt32LE(stringTable.get(w2)!, cursor);
    cursor += 4;
    buf.writeUInt32LE(stringTable.get(w3)!, cursor);
    cursor += 4;
    buf.writeDoubleLE(count, cursor);
    cursor += 8;
  }

  // ── Write bigram prefix counts ────────────────────────────────────────────
  buf.writeUInt32LE(table.bigramPrefixCounts.size, cursor);
  cursor += 4;
  for (const [key, count] of table.bigramPrefixCounts.entries()) {
    const sep1 = key.indexOf(SEP);
    const w1 = key.slice(0, sep1);
    const w2 = key.slice(sep1 + 1);
    buf.writeUInt32LE(stringTable.get(w1)!, cursor);
    cursor += 4;
    buf.writeUInt32LE(stringTable.get(w2)!, cursor);
    cursor += 4;
    buf.writeDoubleLE(count, cursor);
    cursor += 8;
  }

  if (cursor !== totalSize) {
    throw new Error(
      `[trigram-table] Buffer size mismatch: wrote ${cursor} bytes but allocated ${totalSize} bytes`,
    );
  }

  return buf;
}

// ─── Deserialization ──────────────────────────────────────────────────────────

/**
 * Deserialize a binary buffer into a TrigramTable.
 *
 * Returns null (does NOT throw) on any parse error — the load path treats all
 * corruption identically and falls through to a fresh build. Schema version
 * mismatch also returns null so that an upgrade triggers a cache rebuild.
 */
function deserializeTrigramTable(buf: Buffer): TrigramTable | null {
  try {
    let cursor = 0;

    function readU8(): number | null {
      if (cursor + 1 > buf.length) return null;
      return buf.readUInt8(cursor++);
    }

    function readU32(): number | null {
      if (cursor + 4 > buf.length) return null;
      const v = buf.readUInt32LE(cursor);
      cursor += 4;
      return v;
    }

    function readF64(): number | null {
      if (cursor + 8 > buf.length) return null;
      const v = buf.readDoubleLE(cursor);
      cursor += 8;
      return v;
    }

    // ── Header ────────────────────────────────────────────────────────────────

    if (buf.length < 4) return null;
    const magic = buf.subarray(0, 4).toString("ascii");
    cursor = 4;
    if (magic !== TRIGRAM_CACHE_MAGIC) return null;

    const version = readU32();
    if (version === null || version !== TRIGRAM_SCHEMA_VERSION) return null;

    // ── String table ─────────────────────────────────────────────────────────

    const stringCount = readU32();
    if (stringCount === null) return null;

    const strings: string[] = [];
    for (let i = 0; i < stringCount; i++) {
      const len = readU8();
      if (len === null) return null;
      if (cursor + len > buf.length) return null;
      strings.push(buf.subarray(cursor, cursor + len).toString("utf8"));
      cursor += len;
    }

    // ── Trigrams ──────────────────────────────────────────────────────────────

    const trigramCount = readU32();
    if (trigramCount === null) return null;

    const trigrams = new Map<string, number>();
    for (let i = 0; i < trigramCount; i++) {
      const i1 = readU32();
      const i2 = readU32();
      const i3 = readU32();
      const count = readF64();
      if (i1 === null || i2 === null || i3 === null || count === null) return null;
      if (i1 >= strings.length || i2 >= strings.length || i3 >= strings.length) return null;
      trigrams.set(`${strings[i1]}${SEP}${strings[i2]}${SEP}${strings[i3]}`, count);
    }

    // ── Bigram prefix counts ──────────────────────────────────────────────────

    const bigramCount = readU32();
    if (bigramCount === null) return null;

    const bigramPrefixCounts = new Map<string, number>();
    for (let i = 0; i < bigramCount; i++) {
      const i1 = readU32();
      const i2 = readU32();
      const count = readF64();
      if (i1 === null || i2 === null || count === null) return null;
      if (i1 >= strings.length || i2 >= strings.length) return null;
      bigramPrefixCounts.set(`${strings[i1]}${SEP}${strings[i2]}`, count);
    }

    return new TrigramTable(trigrams, bigramPrefixCounts);
  } catch {
    // Any unexpected exception (e.g., readUInt8 out of bounds) → treat as corrupt.
    return null;
  }
}

// ─── TrigramTable ─────────────────────────────────────────────────────────────

/**
 * In-memory trigram side-table.
 *
 * Keys use U+0001 (0x01) as a word separator:
 *   trigrams:          `w1\x01w2\x01w3` → count
 *   bigramPrefixCounts: `w1\x01w2`       → sum of counts over all w3
 */
export class TrigramTable {
  trigrams: Map<string, number>;
  bigramPrefixCounts: Map<string, number>;

  constructor(trigrams: Map<string, number>, bigramPrefixCounts: Map<string, number>) {
    this.trigrams = trigrams;
    this.bigramPrefixCounts = bigramPrefixCounts;
  }

  // ── Factory: load from TSV ────────────────────────────────────────────────

  /**
   * Parse a TSV file (`w1<TAB>w2<TAB>w3<TAB>count` per line) into a
   * TrigramTable. Populates both `trigrams` and `bigramPrefixCounts`.
   */
  static async loadFromTsv(path: string): Promise<TrigramTable> {
    const trigrams = new Map<string, number>();
    const bigramPrefixCounts = new Map<string, number>();

    const rl = createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line) continue;

      // Expected format: w1<TAB>w2<TAB>w3<TAB>count
      const t1 = line.indexOf("\t");
      if (t1 === -1) continue;
      const t2 = line.indexOf("\t", t1 + 1);
      if (t2 === -1) continue;
      const t3 = line.indexOf("\t", t2 + 1);
      if (t3 === -1) continue;

      const w1 = line.slice(0, t1);
      const w2 = line.slice(t1 + 1, t2);
      const w3 = line.slice(t2 + 1, t3);
      const count = parseInt(line.slice(t3 + 1), 10);

      if (!w1 || !w2 || !w3 || isNaN(count)) continue;

      const trigramKey = `${w1}${SEP}${w2}${SEP}${w3}`;
      const bigramKey = `${w1}${SEP}${w2}`;

      trigrams.set(trigramKey, count);
      bigramPrefixCounts.set(bigramKey, (bigramPrefixCounts.get(bigramKey) ?? 0) + count);
    }

    return new TrigramTable(trigrams, bigramPrefixCounts);
  }

  // ── Factory: load from binary cache ──────────────────────────────────────

  /**
   * Try to load a TrigramTable from a binary cache file.
   * Returns null on ENOENT, schema mismatch, or any corruption.
   * Never throws.
   */
  static async loadFromCache(path: string): Promise<TrigramTable | null> {
    let buf: Buffer;
    try {
      buf = await readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.info(
          `[mobile-autocorrect] trigram cache load: read failed: ${formatError(err)}`,
        );
      }
      return null;
    }

    const result = deserializeTrigramTable(buf);
    if (result === null) {
      console.info(
        `[mobile-autocorrect] trigram cache load: parse failed or schema version mismatch`,
      );
    }
    return result;
  }

  // ── Write binary cache ────────────────────────────────────────────────────

  /**
   * Serialize this table and atomically write it to `path`.
   *
   * Atomic-write pattern (mirrors index-cache.ts):
   *   1. Serialize to a Buffer.
   *   2. Write to a unique per-writer temp file (`path.<pid>-<random8bytes>.tmp`).
   *   3. `rename(temp, path)` — POSIX-atomic replacement.
   *   4. On any error: log at info level, best-effort unlink the temp file.
   *
   * Never throws past this boundary — write failures are silent to callers.
   */
  async writeCache(path: string): Promise<void> {
    let buf: Buffer;
    try {
      buf = serializeTrigramTable(this);
    } catch (err) {
      console.info(`[mobile-autocorrect] trigram cache write failed: ${formatError(err)}`);
      return;
    }

    // Unique per-writer suffix: PID + 8 random bytes = 16 hex chars.
    const tempPath = `${path}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;

    try {
      await writeFile(tempPath, buf);
      await rename(tempPath, path);
    } catch (err) {
      console.info(`[mobile-autocorrect] trigram cache write failed: ${formatError(err)}`);
      // Best-effort cleanup of the temp file if rename failed.
      await unlink(tempPath).catch(() => undefined);
    }
  }

  // ── Lookups ───────────────────────────────────────────────────────────────

  /** Returns the trigram count for (w1, w2, w3), or 0 if not in the table. */
  getTrigramCount(w1: string, w2: string, w3: string): number {
    return this.trigrams.get(`${w1}${SEP}${w2}${SEP}${w3}`) ?? 0;
  }

  /** Returns the bigram-prefix count for (w1, w2), or 0 if not in the table. */
  getBigramPrefixCount(w1: string, w2: string): number {
    return this.bigramPrefixCounts.get(`${w1}${SEP}${w2}`) ?? 0;
  }
}

// ─── Cache key ───────────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 cache key for the trigram table.
 *
 * The key is the hex-encoded SHA-256 of the TSV file content streamed via
 * `createReadStream` (to avoid loading multi-MB content into memory) combined
 * with the schema version. A schema bump or TSV change invalidates the key.
 *
 * Returns a 64-character lowercase hex string.
 */
export async function computeTrigramCacheKey(
  tsvPath: string,
  schemaVersion: number,
): Promise<string> {
  const hash = createHash("sha256");
  // Seed with schema version so a schema bump invalidates any existing cache.
  hash.update(`schema:${schemaVersion}\n`);

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(tsvPath);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  return hash.digest("hex");
}

// ─── Cache pruning ────────────────────────────────────────────────────────────

/**
 * Delete stale trigram cache files in `cacheDir`.
 *
 * Only removes files matching `TRIGRAM_FILENAME_PATTERN` (`trigram-<64hex>.bin`)
 * whose name differs from `trigram-{currentKey}.bin`. Skips `*.tmp` files and
 * unrelated files. Per-file errors are logged at info level and swallowed —
 * pruning is best-effort.
 */
export async function pruneStaleTrigramCaches(
  cacheDir: string,
  currentKey: string,
): Promise<void> {
  const currentFilename = `trigram-${currentKey}.bin`;
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch (err) {
    console.info(
      `[mobile-autocorrect] trigram prune: readdir failed: ${formatError(err)}`,
    );
    return;
  }

  for (const name of entries) {
    if (!TRIGRAM_FILENAME_PATTERN.test(name)) continue; // skip *.tmp and unrelated files
    if (name === currentFilename) continue;
    try {
      await unlink(join(cacheDir, name));
    } catch (err) {
      console.info(
        `[mobile-autocorrect] trigram prune: unlink ${name} failed: ${formatError(err)}`,
      );
    }
  }
}

// ─── Process-wide singleton ───────────────────────────────────────────────────

/**
 * Process-wide trigram singleton. Multiple concurrent engines (during a
 * `maxEditDistance`-rebuild orphan window) share the same in-flight load;
 * rebuilds do NOT trigger redundant TSV parses or duplicated resident memory.
 */

let pendingPromise: Promise<TrigramTable | null> | undefined;
let firstCallerTelemetry: TelemetryWriter | undefined;
let lazyAttachedEmitted = false;

export interface TrigramSingletonOptions {
  cacheDir: string;
  tsvPath: string;
  /** Schema version for the binary cache key. Defaults to TRIGRAM_SCHEMA_VERSION. */
  schemaVersion?: number;
  telemetry?: TelemetryWriter;
}

/**
 * Reset the process-wide singleton state. ONLY for use in vitest fixtures.
 * Resets pendingPromise, firstCallerTelemetry, and lazyAttachedEmitted.
 */
export function __resetTrigramSingletonForTests(): void {
  pendingPromise = undefined;
  firstCallerTelemetry = undefined;
  lazyAttachedEmitted = false;
}

function emitLazyAttachedOnce(
  writer: TelemetryWriter | undefined,
  loadMs: number,
  outcome: "ready" | "failed",
  trigramCount: number | null,
): void {
  if (lazyAttachedEmitted) return;
  if (!writer) return;
  lazyAttachedEmitted = true;
  writer.emit({
    event: "trigram.lazy_attached",
    timestamp: new Date().toISOString(),
    loadMs,
    outcome,
    trigramCount,
  });
}

/**
 * Process-wide trigram singleton accessor. Multiple concurrent engines (during
 * a `maxEditDistance`-rebuild orphan window) share the same in-flight load;
 * rebuilds do NOT trigger redundant TSV parses or duplicated resident memory.
 *
 * First call kicks off the load and stores `pendingPromise`. Subsequent calls
 * return the same promise — no re-load, no second TSV parse, no duplicate emit.
 *
 * On load failure (file missing, parse error, OOM), the promise resolves to
 * `null` (does NOT reject). Callers can branch on `null` without try/catch.
 *
 * The `trigram.lazy_attached` telemetry event is emitted at most once per
 * process when the singleton resolves, using the first caller's TelemetryWriter
 * reference. Subsequent callers' writer references are ignored.
 */
export function getTrigramTableSingleton(
  opts: TrigramSingletonOptions,
): Promise<TrigramTable | null> {
  if (pendingPromise !== undefined) {
    return pendingPromise;
  }

  // First call: capture telemetry reference and start loading.
  firstCallerTelemetry = opts.telemetry;
  const loadStart = Date.now();
  const schemaVersion = opts.schemaVersion ?? TRIGRAM_SCHEMA_VERSION;

  pendingPromise = (async (): Promise<TrigramTable | null> => {
    try {
      const key = await computeTrigramCacheKey(opts.tsvPath, schemaVersion);
      const cachePath = join(opts.cacheDir, `trigram-${key}.bin`);

      // Step 1: try binary cache.
      const cached = await TrigramTable.loadFromCache(cachePath);
      if (cached !== null) {
        emitLazyAttachedOnce(
          firstCallerTelemetry,
          Date.now() - loadStart,
          "ready",
          cached.trigrams.size,
        );
        void pruneStaleTrigramCaches(opts.cacheDir, key).catch(() => undefined);
        return cached;
      }

      // Step 2: cache miss → parse TSV; write cache and prune fire-and-forget.
      const table = await TrigramTable.loadFromTsv(opts.tsvPath);
      void table.writeCache(cachePath).catch(() => undefined);
      void pruneStaleTrigramCaches(opts.cacheDir, key).catch(() => undefined);
      emitLazyAttachedOnce(
        firstCallerTelemetry,
        Date.now() - loadStart,
        "ready",
        table.trigrams.size,
      );
      return table;
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      console.info(`[mobile-autocorrect] trigram singleton: load failed: ${cause}`);
      emitLazyAttachedOnce(firstCallerTelemetry, Date.now() - loadStart, "failed", null);
      return null;
    }
  })();

  return pendingPromise;
}
