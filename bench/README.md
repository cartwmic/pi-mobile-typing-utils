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

## Notes

- All scripts import from `src/` and must be run from the **repo root** (`/path/to/pi-mobile-typing-utils`).
- Bench scripts use `process.env.MOBILE_AUTOCORRECT_CACHE_DIR` to redirect cache writes to temp directories — they do not modify `~/.pi/agent/cache/mobile-autocorrect/`.
- Times vary significantly by hardware. Termux/phone hardware is typically 3–10× slower than a developer laptop.
- For `--expose-gc` heap measurements: `node --expose-gc $(which tsx) bench/build-time.ts`
