#!/usr/bin/env tsx
/**
 * build-trigrams.ts — One-shot builder for data/trigram-top500k.tsv
 *
 * Source dataset: Google Books English 3-grams, snapshot 20120701 (2012-07-01).
 * Dataset page:   http://storage.googleapis.com/books/ngrams/books/datasetsv2.html
 * License:        Creative Commons Attribution 3.0 Unported (CC BY 3.0)
 *
 * ⚠ KNOWN ISSUE — SOURCE URL ROT (2026-04-28 verification):
 *
 * The v2 snapshot URLs `http://storage.googleapis.com/books/ngrams/books/
 * googlebooks-eng-all-3gram-20120701-{NN}.gz` returned 404 as of 2026-04-28.
 * Google has migrated the dataset to v3 (snapshot 20200217) at
 * `http://storage.googleapis.com/books/ngrams/books/20200217/eng/3-{NNNNN}-of-06881.gz`.
 * The v3 dataset is ~2.4 TB total (6 881 files × ~350 MB each), making the
 * full download infeasible on a developer workstation. Adapting this script
 * to v3 also requires verifying the per-line format (column ordering may
 * have changed between v2 and v3) and is out of scope for the
 * `improve-autocorrect-context-and-segmentation` change.
 *
 * Path forward (v1.1 candidate):
 *   (a) Adapt this script to consume the v3 layout AND a sampled subset
 *       (e.g., 1% of files ≈ 24 GB) and accept some sampling bias in the
 *       top-500K aggregation.
 *   (b) Or swap source to a smaller, more terminal-relevant corpus
 *       (Stack Exchange, Wikipedia, conversational chat) per the v2-to-v2.x
 *       "Trigram corpus is sourced from English Google Books n-grams…" entry
 *       in `README.md` Known limitations.
 *
 * The trigram side-table is a pure performance lift; without it the
 * autocorrect engine still operates correctly via the bigram tier and
 * unigram fallback (the singleton accessor resolves to null and the
 * rerank module's trigram tier is a strict no-op per design.md Decision 6).
 *
 * DO NOT run this script in CI, npm test, or npm run build.
 * It is a one-shot maintainer script (~60–120 min wall time).
 * See scripts/README.md for download instructions and runtime expectations.
 *
 * Usage:
 *   npx tsx scripts/build-trigrams.ts [options] <source-files.gz ...>
 *
 * Options:
 *   --shard-dir <path>  Directory for shard files (default: temp dir)
 *   --keep-shards       Do not delete shard files after completion
 */

// ─── Source URL constants ─────────────────────────────────────────────────────

/**
 * Base URL for the Google Books English 3-gram files (snapshot 20120701).
 * Files are named googlebooks-eng-all-3gram-20120701-{NN}.gz for NN in 00–99.
 *
 * TODO: Verify these URLs are still accessible before running. If they have
 * changed, update GOOGLE_BOOKS_NGRAMS_BASE to reflect the new location.
 * See scripts/README.md for the latest known URL and download instructions.
 */
const GOOGLE_BOOKS_NGRAMS_BASE =
  "http://storage.googleapis.com/books/ngrams/books/googlebooks-eng-all-3gram-20120701-";
const GOOGLE_BOOKS_NGRAMS_SNAPSHOT_DATE = "2012-07-01";
const GOOGLE_BOOKS_NGRAMS_SHARD_COUNT = 100; // files 00–99

/** Snapshot URLs for all 100 source shard files. */
export const GOOGLE_BOOKS_SOURCE_URLS: readonly string[] = Array.from(
  { length: GOOGLE_BOOKS_NGRAMS_SHARD_COUNT },
  (_, i) => `${GOOGLE_BOOKS_NGRAMS_BASE}${String(i).padStart(2, "0")}.gz`,
);

// ─── Algorithm constants ──────────────────────────────────────────────────────

/** Number of internal shard files used during Pass 1. Must be a power of 2 for
 *  best distribution, but any positive integer works. 64 gives ~46 MB/shard at
 *  ~3 GB total filtered data.                                                 */
const NUM_SHARDS = 64;

/** Number of trigrams to retain in the final output. */
const TOP_K = 500_000;

/** Minimum year a Google Books row must have to be retained. */
const MIN_YEAR = 1990;

// ─── Node.js imports ─────────────────────────────────────────────────────────

import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ─── Path helpers ─────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const TECH_DICT_PATH = join(PROJECT_ROOT, "data", "tech-dictionary.txt");
const OUTPUT_PATH = join(PROJECT_ROOT, "data", "trigram-top500k.tsv");

// ─── Dictionary loading ───────────────────────────────────────────────────────

/**
 * Walk up from the symspell-ts entrypoint until we find its package.json
 * and return the package root. Mirrors src/symspell-paths.ts.
 */
function findSymspellRoot(): string {
  const req = createRequire(import.meta.url);
  let dir = dirname(req.resolve("symspell-ts"));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
      };
      if (pkg.name === "symspell-ts") return dir;
    } catch {
      /* no package.json here — keep walking */
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("symspell-ts package root not found");
    dir = parent;
  }
}

/**
 * Load the SymSpell unigram dictionary into a Set<string>.
 * File format: `word count` (one per line). Strips BOM if present.
 */
function loadUnigramSet(): Set<string> {
  const symspellRoot = findSymspellRoot();
  const dictPath = join(symspellRoot, "data", "frequency_dictionary_en_82_765.txt");
  const content = readFileSync(dictPath, "utf8").replace(/^\uFEFF/, ""); // strip BOM
  const words = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const spaceIdx = line.indexOf(" ");
    const word = (spaceIdx !== -1 ? line.slice(0, spaceIdx) : line).trim().toLowerCase();
    if (word) words.add(word);
  }
  console.error(
    `[build-trigrams] Loaded ${words.size} unigrams from ${dictPath}`,
  );
  return words;
}

/**
 * Load the shipped tech dictionary into a Set<string>.
 * File format: one lowercase word per line; lines starting with # are comments.
 */
function loadTechDict(): Set<string> {
  const content = readFileSync(TECH_DICT_PATH, "utf8");
  const words = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const word = line.trim();
    if (word && !word.startsWith("#")) words.add(word.toLowerCase());
  }
  console.error(
    `[build-trigrams] Loaded ${words.size} tech-dict words from ${TECH_DICT_PATH}`,
  );
  return words;
}

// ─── Filter helpers ───────────────────────────────────────────────────────────

/** Returns true iff the string contains only lowercase ASCII letters. */
function isLowercaseASCIIOnly(s: string): boolean {
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 97 || c > 122) return false; // a–z only
  }
  return true;
}

// ─── FNV-1a hash (fast shard assignment) ─────────────────────────────────────

/** FNV-1a 32-bit hash of a string. Used to assign triples to shards. */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV-1a prime, keep as u32
  }
  return h;
}

/** Compute the shard index (0..NUM_SHARDS-1) for a given (w1, w2, w3) triple. */
function tripleShardIndex(w1: string, w2: string, w3: string): number {
  // Separate words with \0 which can't appear in lowercase-ASCII words.
  return fnv1a32(`${w1}\x00${w2}\x00${w3}`) % NUM_SHARDS;
}

// ─── Shard writer ─────────────────────────────────────────────────────────────

/**
 * Buffers shard lines and flushes in batches for efficiency.
 * Each line written is `w1<TAB>w2<TAB>w3<TAB>count\n`.
 */
class ShardWriter {
  private buffer: string[] = [];
  private bufferBytes = 0;
  private static readonly FLUSH_BYTES = 256 * 1024; // 256 KB batches
  private readonly stream: ReturnType<typeof createWriteStream>;

  constructor(filePath: string) {
    this.stream = createWriteStream(filePath, { flags: "w" });
  }

  writeLine(w1: string, w2: string, w3: string, count: number): void {
    const line = `${w1}\t${w2}\t${w3}\t${count}\n`;
    this.buffer.push(line);
    this.bufferBytes += line.length;
    if (this.bufferBytes >= ShardWriter.FLUSH_BYTES) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    this.stream.write(this.buffer.join(""));
    this.buffer = [];
    this.bufferBytes = 0;
  }

  async close(): Promise<void> {
    this.flush();
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

// ─── Min-heap (top-K by count) ────────────────────────────────────────────────

interface HeapEntry {
  /** Tab-separated triple key: `w1<TAB>w2<TAB>w3`. */
  key: string;
  count: number;
}

/**
 * A fixed-capacity min-heap that maintains the top-K entries by count.
 *
 * Push semantics:
 *   - If size < capacity: insert unconditionally.
 *   - If size == capacity and count > heap.min: evict the minimum, insert.
 *   - Otherwise: discard.
 *
 * The heap root is always the minimum (smallest count in the top-K set).
 */
class MinHeap {
  private readonly data: HeapEntry[] = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get size(): number {
    return this.data.length;
  }

  get minCount(): number {
    return this.data.length > 0 ? this.data[0]!.count : 0;
  }

  push(key: string, count: number): void {
    if (this.data.length < this.capacity) {
      this.data.push({ key, count });
      this.bubbleUp(this.data.length - 1);
    } else if (this.data.length > 0 && count > this.data[0]!.count) {
      this.data[0] = { key, count };
      this.sinkDown(0);
    }
  }

  /** Return all entries sorted by count descending. */
  toSortedArray(): HeapEntry[] {
    return [...this.data].sort((a, b) => b.count - a.count);
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (this.data[parent]!.count <= this.data[i]!.count) break;
      const tmp = this.data[parent]!;
      this.data[parent] = this.data[i]!;
      this.data[i] = tmp;
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.data[left]!.count < this.data[smallest]!.count) smallest = left;
      if (right < n && this.data[right]!.count < this.data[smallest]!.count) smallest = right;
      if (smallest === i) break;
      const tmp = this.data[smallest]!;
      this.data[smallest] = this.data[i]!;
      this.data[i] = tmp;
      i = smallest;
    }
  }
}

// ─── Pass 1: sharding ─────────────────────────────────────────────────────────

interface Pass1Stats {
  totalRows: number;
  retainedRows: number;
  shardCounts: number[];
}

/**
 * Stream a single (optionally gzipped) Google Books 3-gram source file,
 * filter rows, and distribute retained rows to shard writers.
 *
 * Source file format (one line per row):
 *   `w1 w2 w3<TAB>year<TAB>match_count<TAB>volume_count`
 *
 * Retention criteria:
 *   - year >= MIN_YEAR (1990)
 *   - All three words are lowercase ASCII only (a–z)
 *   - All three words are present in the SymSpell unigram dict OR tech dict
 */
async function processSourceFile(
  filePath: string,
  unigramSet: Set<string>,
  techSet: Set<string>,
  shardWriters: ShardWriter[],
  stats: Pass1Stats,
): Promise<void> {
  const isGzip = filePath.endsWith(".gz");
  const fileStream = createReadStream(filePath);
  const inputStream = isGzip
    ? (fileStream.pipe(createGunzip()) as NodeJS.ReadableStream)
    : (fileStream as unknown as NodeJS.ReadableStream);

  const rl = createInterface({
    input: inputStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    stats.totalRows++;

    // Format: "w1 w2 w3\tyear\tcount\tvolume_count"
    const t1 = line.indexOf("\t");
    if (t1 === -1) continue;
    const ngram = line.slice(0, t1);
    const rest = line.slice(t1 + 1);

    const t2 = rest.indexOf("\t");
    if (t2 === -1) continue;
    const year = parseInt(rest.slice(0, t2), 10);
    if (isNaN(year) || year < MIN_YEAR) continue;

    const rest2 = rest.slice(t2 + 1);
    const t3 = rest2.indexOf("\t");
    const countStr = t3 === -1 ? rest2 : rest2.slice(0, t3);
    const count = parseInt(countStr, 10);
    if (isNaN(count) || count <= 0) continue;

    // Parse ngram: "w1 w2 w3"
    const sp1 = ngram.indexOf(" ");
    if (sp1 === -1) continue;
    const sp2 = ngram.indexOf(" ", sp1 + 1);
    if (sp2 === -1) continue;

    const w1 = ngram.slice(0, sp1).toLowerCase();
    const w2 = ngram.slice(sp1 + 1, sp2).toLowerCase();
    const w3 = ngram.slice(sp2 + 1).toLowerCase();

    // Filter: lowercase ASCII only
    if (!isLowercaseASCIIOnly(w1) || !isLowercaseASCIIOnly(w2) || !isLowercaseASCIIOnly(w3)) {
      continue;
    }
    // Filter: all words present in unigram dict OR tech dict
    const inDict = (w: string): boolean => unigramSet.has(w) || techSet.has(w);
    if (!inDict(w1) || !inDict(w2) || !inDict(w3)) continue;

    stats.retainedRows++;

    const shardIdx = tripleShardIndex(w1, w2, w3);
    shardWriters[shardIdx]!.writeLine(w1, w2, w3, count);
    stats.shardCounts[shardIdx]!++;
  }
}

// ─── Pass 2: shard merge + aggregation ───────────────────────────────────────

/**
 * Read a shard file, aggregate counts per triple using a Map (exact within
 * shard — all occurrences of a triple land in the same shard by hash), and
 * push the aggregated pairs into the global min-heap.
 */
async function processShard(shardPath: string, heap: MinHeap): Promise<number> {
  const shardMap = new Map<string, number>();

  const rl = createInterface({
    input: createReadStream(shardPath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    // Format: "w1\tw2\tw3\tcount"
    const lastTab = line.lastIndexOf("\t");
    if (lastTab === -1) continue;
    const triple = line.slice(0, lastTab); // "w1\tw2\tw3"
    const count = parseInt(line.slice(lastTab + 1), 10);
    if (isNaN(count)) continue;
    shardMap.set(triple, (shardMap.get(triple) ?? 0) + count);
  }

  for (const [key, count] of shardMap.entries()) {
    heap.push(key, count);
  }

  return shardMap.size;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Parse CLI arguments
  let shardDir: string | null = null;
  let keepShards = false;
  const sourceFiles: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--shard-dir" && i + 1 < argv.length) {
      shardDir = argv[++i]!;
    } else if (arg === "--keep-shards") {
      keepShards = true;
    } else if (arg && !arg.startsWith("--")) {
      sourceFiles.push(arg);
    }
  }

  if (sourceFiles.length === 0) {
    console.error("build-trigrams.ts — Google Books 3-gram extractor");
    console.error(`Snapshot date: ${GOOGLE_BOOKS_NGRAMS_SNAPSHOT_DATE}`);
    console.error("");
    console.error("Usage:");
    console.error(
      "  npx tsx scripts/build-trigrams.ts [--shard-dir <dir>] [--keep-shards] <source.gz ...>",
    );
    console.error("");
    console.error("See scripts/README.md for download instructions.");
    console.error("Expected source URLs:");
    for (const url of GOOGLE_BOOKS_SOURCE_URLS.slice(0, 3)) {
      console.error(`  ${url}`);
    }
    console.error("  ... (100 files total)");
    process.exit(1);
  }

  const wallStart = Date.now();
  console.error(`[build-trigrams] Starting. ${sourceFiles.length} source files.`);
  console.error(
    `[build-trigrams] Snapshot: ${GOOGLE_BOOKS_NGRAMS_SNAPSHOT_DATE}. NUM_SHARDS=${NUM_SHARDS}, TOP_K=${TOP_K}.`,
  );

  // ── Load dictionaries ────────────────────────────────────────────────────────
  const unigramSet = loadUnigramSet();
  const techSet = loadTechDict();

  // ── Create shard directory ───────────────────────────────────────────────────
  const ownShardDir = shardDir === null;
  const resolvedShardDir = shardDir ?? mkdtempSync(join(tmpdir(), "trigram-shards-"));
  mkdirSync(resolvedShardDir, { recursive: true });
  const shardPaths = Array.from(
    { length: NUM_SHARDS },
    (_, i) => join(resolvedShardDir, `shard-${String(i).padStart(2, "0")}.tsv`),
  );

  // ── Pass 1: shard ────────────────────────────────────────────────────────────
  console.error(`[build-trigrams] Pass 1: sharding into ${resolvedShardDir} ...`);
  const shardWriters = shardPaths.map((p) => new ShardWriter(p));
  const stats: Pass1Stats = {
    totalRows: 0,
    retainedRows: 0,
    shardCounts: new Array<number>(NUM_SHARDS).fill(0),
  };

  for (let i = 0; i < sourceFiles.length; i++) {
    const file = sourceFiles[i]!;
    const fileStart = Date.now();
    console.error(
      `[build-trigrams]   [${i + 1}/${sourceFiles.length}] ${file}`,
    );
    await processSourceFile(file, unigramSet, techSet, shardWriters, stats);
    console.error(
      `[build-trigrams]     done in ${((Date.now() - fileStart) / 1000).toFixed(1)}s` +
        ` — total rows so far: ${stats.totalRows.toLocaleString()}, retained: ${stats.retainedRows.toLocaleString()}`,
    );
  }

  // Close all shard writers
  await Promise.all(shardWriters.map((w) => w.close()));
  console.error(
    `[build-trigrams] Pass 1 complete: scanned ${stats.totalRows.toLocaleString()} rows, ` +
      `retained ${stats.retainedRows.toLocaleString()} rows.`,
  );

  const shardSizes = stats.shardCounts.slice().sort((a, b) => a - b);
  console.error(
    `[build-trigrams] Shard sizes: min=${shardSizes[0]?.toLocaleString()}, ` +
      `max=${shardSizes[shardSizes.length - 1]?.toLocaleString()}, ` +
      `median=${shardSizes[Math.floor(shardSizes.length / 2)]?.toLocaleString()}`,
  );

  // ── Pass 2: merge into top-K heap ────────────────────────────────────────────
  console.error(`[build-trigrams] Pass 2: merging shards into top-${TOP_K} heap ...`);
  const heap = new MinHeap(TOP_K);

  for (let i = 0; i < NUM_SHARDS; i++) {
    const uniqueInShard = await processShard(shardPaths[i]!, heap);
    if ((i + 1) % 16 === 0) {
      console.error(
        `[build-trigrams]   shards processed: ${i + 1}/${NUM_SHARDS}, ` +
          `unique triples seen: ${uniqueInShard.toLocaleString()}, heap size: ${heap.size.toLocaleString()}`,
      );
    }
  }

  console.error(`[build-trigrams] Pass 2 complete. Final heap size: ${heap.size.toLocaleString()}`);

  // ── Write output ─────────────────────────────────────────────────────────────
  const sorted = heap.toSortedArray();
  console.error(`[build-trigrams] Writing ${sorted.length.toLocaleString()} trigrams to ${OUTPUT_PATH} ...`);

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  const lines = sorted
    .map(({ key, count }) => `${key}\t${count}`) // key is already "w1\tw2\tw3"
    .join("\n");
  writeFileSync(OUTPUT_PATH, lines + "\n", "utf8");

  // ── Print top 10 ─────────────────────────────────────────────────────────────
  console.error("[build-trigrams] Top 10 trigrams:");
  for (const { key, count } of sorted.slice(0, 10)) {
    console.error(`  ${key.replace(/\t/g, " ")} — ${count.toLocaleString()}`);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────
  if (!keepShards && ownShardDir) {
    await rm(resolvedShardDir, { recursive: true, force: true });
    console.error(`[build-trigrams] Cleaned up shard dir ${resolvedShardDir}`);
  } else {
    console.error(`[build-trigrams] Shard dir kept: ${resolvedShardDir}`);
  }

  const wallSec = (Date.now() - wallStart) / 1000;
  console.error(
    `[build-trigrams] Done in ${wallSec.toFixed(1)}s. Output: ${OUTPUT_PATH}`,
  );
  console.error(
    `[build-trigrams] Next: run task 3.2 — commit data/trigram-top500k.tsv and data/LICENSES.md.`,
  );
}

main().catch((err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`[build-trigrams] FATAL: ${message}`);
  process.exit(1);
});
