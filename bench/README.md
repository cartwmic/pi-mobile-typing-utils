# bench/

Performance and correctness benchmark scripts for pi-mobile-typing-utils.

These scripts are **not part of the automated test suite** — they are for manual benchmarking and developer verification. They print human-readable reports to stdout.

## Prerequisites

All scripts use TypeScript and require `tsx` (included as a dev dependency):

```bash
npm install
```

## Scripts

### `build-time.ts` — Engine build time and heap delta

Builds `CorrectionEngine` at each `maxEditDistance` from 1 to 4. Reports wall time and heap delta using `process.memoryUsage()`. Uses a fresh temp dir for each build so every run is a genuine cache-miss build.

```bash
npx tsx bench/build-time.ts
```

**What it measures:** How long it takes to build the SymSpell deletion index from scratch (dictionary load + deletion-table construction) at each edit distance. These numbers are the primary motivation for the index cache.

---

### `cache-load-time.ts` — Fresh build vs cache-hit comparison

Runs two initializations against the same temp cache directory:
1. First run: cache miss (fresh build + cache write).
2. Second run: cache hit (load from disk).

```bash
npx tsx bench/cache-load-time.ts
```

**What it measures:** The cache speedup factor. Design goal: ~17× speedup (measured ~3 263 ms fresh → ~189 ms cached at ED=4 on a developer laptop).

---

### `format-size.ts` — On-disk cache file size

Builds the cache for each `maxEditDistance` from 1 to 4 and measures the resulting `.bin` file size.

```bash
npx tsx bench/format-size.ts
```

**What it measures:** Disk footprint of the binary cache format (deduplicated string table, schema v1). Design target: ~30 MB at ED=4.

---

### `unigram-vs-full-dict-parity.ts` — Unigram-only vs full-dict correctness

Builds two engines:
- Default path: unigram-only loader (no bigrams).
- Fallback path: upstream `loadDefaultDictionaries` (bigrams loaded as side effect), forced by injecting `_resolveSymspellPackageRoot: () => null`.

Runs `shouldCorrect()` on every word in `tests/fixtures/cache-fidelity-corpus.txt` against both engines and reports any divergent results. There should be zero.

```bash
npx tsx bench/unigram-vs-full-dict-parity.ts
```

**What it measures:** Correctness invariant — dropping bigrams must not change `lookup()` behavior.

---

### `resolver-correctness.ts` — Symspell package-root resolver

Calls `resolveSymspellPackageRoot()` and asserts the returned path contains `data/frequency_dictionary_en_82_765.txt`. Reports the resolved path.

```bash
npx tsx bench/resolver-correctness.ts
```

**What it measures:** Whether the package-root walk correctly locates the symspell-ts data directory. A failure here means the unigram-only loader will fall through to `loadDefaultDictionaries` (suboptimal but correct).

---

---

## Context-rerank + segmentation benches

These scripts were added for the `improve-autocorrect-context-and-segmentation` change (Phase 12/13). All soft targets are **informational and do not gate CI**. Record results in `NOTES.md` under §19.5–19.6.

---

### `rerank-latency.ts` — shouldCorrect() latency with context rerank

Builds a real `CorrectionEngine` with bigrams loaded and drives `shouldCorrect()` with
a surrounding-context fixture across token-length buckets (3, 5, 7, 10, 15 chars).
Reports p50 / p95 / p99 wall time (µs) per bucket via `console.table`.

```bash
npx tsx bench/rerank-latency.ts
```

**Soft target:** p95 ≤ 2.0 ms on macOS. Termux numbers are typically 3–10× higher.

---

### `segmentation-latency.ts` — wordSegmentation() latency

Drives the segmentation correction path via `shouldCorrect()` on a corpus of 1,000
concatenated token fixtures. Reports p50 / p95 / p99 (µs).

```bash
npx tsx bench/segmentation-latency.ts
```

**Soft target:** p95 ≤ 10 ms on macOS. Termux numbers are typically 3–10× higher.

---

### `memory-residency.ts` — Post-init resident memory

Builds an engine, awaits `ready`, awaits the trigram lazy-attach (if
`data/trigram-top500k.tsv` exists), settles 10 s, then reports
`process.memoryUsage().rss` and `heapUsed`.

```bash
# Without --expose-gc:
npx tsx bench/memory-residency.ts

# With explicit GC for tighter numbers:
node --expose-gc $(which tsx) bench/memory-residency.ts
```

**Soft targets:** rss delta ≤ 150 MB on macOS; ≤ 100 MB on Termux.

If `data/trigram-top500k.tsv` is absent (deferred), the script warns and
measures bigram-only residency.

---

### `cache-hydrate-latency.ts` — Warm-cache initialization latency

Phase 1 writes a warm cache (cold build). Phase 2 times `engine.initialize()` against
the warm cache for 10 runs and reports the median. Compares against the prior
unigram-only baseline (~189 ms at ED=4 on macOS).

```bash
npx tsx bench/cache-hydrate-latency.ts
```

**Soft targets:** ≤ 500 ms on macOS; ≤ 2 s on Termux. The new v2 cache includes bigrams;
expect slightly higher than the unigram-only baseline.

---

### `segmentation-logprob-baselines.ts` — Validate segmentationLogProbFloor default

Drives `SymSpell.wordSegmentation()` at ED=0 and ED=1 against a locked fixture set
and prints each fixture’s `probabilityLogSum`. Classifies fixtures as“should-accept”
(≥ -12.0) or “should-reject” (< -12.0).

```bash
npx tsx bench/segmentation-logprob-baselines.ts
```

After running, copy the observed numbers into the “COMMITTED BASELINES” block at the top
of the script and commit. If any fixture is on the wrong side of the floor, see the
flagging instructions in the script header.

**Purpose:** justifies the `segmentationLogProbFloor: -12.0` default (Decision 12 in
`openspec/changes/improve-autocorrect-context-and-segmentation/design.md`).

---

## Notes

- All scripts import from `src/` and must be run from the **repo root** (`/path/to/pi-mobile-typing-utils`).
- Bench scripts use `process.env.MOBILE_AUTOCORRECT_CACHE_DIR` to redirect cache writes to temp directories — they do not modify `~/.pi/agent/cache/mobile-autocorrect/`.
- Times vary significantly by hardware. Termux/phone hardware is typically 3–10× slower than a developer laptop.
- For `--expose-gc` heap measurements: `node --expose-gc $(which tsx) bench/build-time.ts`
- The context-rerank + segmentation benches are informational only. Soft targets are design goals, not merge gates.
