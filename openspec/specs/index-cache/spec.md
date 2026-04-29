# index-cache Specification

## Purpose
TBD - created by archiving change improve-autocorrect-quality-and-startup. Update Purpose after archive.
## Requirements
### Requirement: Persistent on-disk index cache
The extension SHALL serialize the built SymSpell index to a binary file under `~/.pi/agent/cache/mobile-autocorrect/` after a successful fresh build, and SHALL load from that file on subsequent engine initializations when the cache key matches. The cache directory SHALL be overridable via the `MOBILE_AUTOCORRECT_CACHE_DIR` environment variable; an unset, empty, or whitespace-only value SHALL fall through to the default location. The directory SHALL be created with `recursive: true` semantics so concurrent sessions cannot race on directory creation. User-owned files (`mobile-autocorrect-config.json`, `mobile-autocorrect-dictionary.json`) SHALL remain at `~/.pi/agent/`; the cache directory SHALL be used exclusively for derived, regeneratable data.

#### Scenario: Fresh build writes a cache file
- **WHEN** the engine builds the SymSpell index from scratch (no cache existed for the current key) and the build completes successfully
- **THEN** the engine SHALL write the serialized index to `~/.pi/agent/cache/mobile-autocorrect/symspell-{key}.bin` for use by subsequent sessions

#### Scenario: Cache write failure does not block engine readiness
- **WHEN** a fresh build completes successfully but the subsequent cache write fails (e.g., disk full, permission denied, cache directory unwritable)
- **THEN** the engine's readiness state SHALL still transition to `ready` and lookups SHALL be served normally; the write failure SHALL be logged at info level (not error) and SHALL NOT propagate as an initialization failure

#### Scenario: Cache directory create failure does not block engine readiness
- **WHEN** the cache directory cannot be created (e.g., `MOBILE_AUTOCORRECT_CACHE_DIR` points to a read-only location or the parent directory is not writable)
- **THEN** the engine SHALL log the failure at info level, skip both cache load and cache write for this process, build fresh, and still reach `ready`; the failure SHALL NOT propagate as an initialization failure

#### Scenario: Cached load is preferred over fresh build
- **WHEN** the engine initializes and a cache file exists at the path computed from the current cache key
- **THEN** the engine SHALL load the cached index instead of calling the unigram-only loader (the default fresh-build path) or upstream `loadDefaultDictionaries` (the resolver-failure fallback path); both fresh-build paths SHALL be skipped on a successful cache hit

#### Scenario: Cache directory is overridable via environment variable
- **WHEN** `MOBILE_AUTOCORRECT_CACHE_DIR` is set to a value that is non-empty after trimming whitespace
- **THEN** the engine SHALL read and write cache files under that directory instead of `~/.pi/agent/cache/mobile-autocorrect/`

#### Scenario: Empty environment variable falls through to default
- **WHEN** `MOBILE_AUTOCORRECT_CACHE_DIR` is set to the empty string `""` or whitespace-only
- **THEN** the engine SHALL ignore the override and use the default location `~/.pi/agent/cache/mobile-autocorrect/`

### Requirement: Cache key embeds all inputs that can affect lookup correctness
The cache filename SHALL embed a key derived from `maxEditDistance`, `prefixLength`, `compactLevel`, `countThreshold`, the symspell-ts library version, the cache schema version, AND a `bigramsPresent` boolean plus the bigram dictionary file's content hash. The library version SHALL be obtained by resolving the symspell-ts package entrypoint via `createRequire(import.meta.url).resolve("symspell-ts")` (NOT `"symspell-ts/package.json"` — the upstream `exports` map intentionally blocks the subpath) and then walking up directories from the resolved entrypoint to find the `package.json` whose `name === "symspell-ts"`. The data directory used for the unigram and bigram bundles SHALL be derived from the same package root. The implementation SHALL NOT use any hardcoded `node_modules/...` path. If the package root cannot be resolved (e.g., highly unusual layout), the implementation SHALL skip cache load and write (fail closed, fresh build only); the engine SHALL still reach `ready`.

The `bigramsPresent` bit SHALL be `true` for caches written by this version of the extension (which always loads bigrams). It is included in the key so that any cache file written by an earlier version of the extension (when `bigramsPresent` was effectively `false` because the §3 optimization was active) cannot be loaded as if it were valid by the current code. The bigram dictionary content hash SHALL be the SHA-256 (or equivalent) of the bytes of the bigram dictionary file resolved from the symspell-ts package root via a glob match `frequency_bigramdictionary_en_*.txt` (NOT a hardcoded `_243_342_` filename). If the glob finds zero or multiple matches, the implementation SHALL treat it as a resolver failure consistent with the existing fail-closed cache rules (skip cache load and write; engine still reaches `ready`).

The cache schema version SHALL be incremented (one-time bump) as part of this change to reflect that the cache file now includes bigram state. Old caches written under the previous schema version SHALL be silently invalidated by the version mismatch alone, independent of the new key components.

Any change to any of these inputs SHALL produce a different filename, so a stale cache cannot be loaded as if it were valid.

#### Scenario: Different maxEditDistance values use different cache files
- **WHEN** the user has previously built and cached the index at `maxEditDistance=2` and then changes the configured value to `maxEditDistance=3`
- **THEN** the engine SHALL NOT load the existing cache file (its key embeds `maxEditDistance=2`); it SHALL build fresh and write a new cache file whose key embeds `maxEditDistance=3`

#### Scenario: Library upgrade invalidates existing caches
- **WHEN** the symspell-ts package version changes (e.g., due to an `npm install` that updates the dependency)
- **THEN** any cache files written under the previous library version SHALL no longer match the cache key and SHALL be ignored on load

#### Scenario: Schema version bump invalidates existing caches
- **WHEN** the cache schema version is incremented (e.g., when adding bigrams in this change, or for any future schema modification)
- **THEN** all cache files written under the previous schema version SHALL no longer match and SHALL be ignored on load

#### Scenario: Caches predating bigram support are invalidated
- **WHEN** a user upgrades from a version that wrote unigram-only caches (the prior `improve-autocorrect-quality-and-startup` change) to this version
- **THEN** every existing `symspell-*.bin` cache file SHALL be detected as having a mismatched key (because `bigramsPresent` differs and/or the schema version is bumped) and SHALL be ignored on load; the engine SHALL build fresh and write a new key

#### Scenario: Bigram dict content hash change invalidates caches
- **WHEN** the symspell-ts package update ships a different `frequency_bigramdictionary_en_243_342.txt` (different content hash)
- **THEN** caches written under the prior bigram content hash SHALL no longer match the key

#### Scenario: Unresolvable package root disables the cache safely
- **WHEN** `createRequire(import.meta.url).resolve("symspell-ts")` throws or the upward walk for `package.json` finds no match
- **THEN** the engine SHALL skip both cache load and cache write, build fresh, and still reach `ready`; an info-level log SHALL note that caching is disabled for the current process

### Requirement: Binary cache format with deduplicated string table
The cache file SHALL use a custom binary format with the following layout:

1. **Header**: 4-byte ASCII magic `"SYMC"`, then the cache schema version (`u32` little-endian), then `maxEditDistance` (`u32`), then `maxDictionaryWordLength` (`u32`).
2. **String table**: count (`u32`), then per entry: length-prefixed UTF-8 (`u8` length byte + bytes). The table SHALL contain every unique string that appears in `words`, in the value-lists of `deletes`, OR in any bigram entry, deduplicated.
3. **Words**: count (`u32`), then per entry: string-table index (`u32`) + frequency (`f64`).
4. **Delete buckets**: count (`u32`), then per entry: hash (`i32`) + bucket length (`u16`) + per-suggestion string-table index (`u32`).
5. **Bigrams** (NEW): `bigramCountMin` (`f64`) is serialized FIRST in this section so it is restored before the bigram entries (it is consulted internally by `SymSpell.lookupCompound` and any future bigram-aware path). Then count (`u32`), then per entry: word-1 string-table index (`u32`) + word-2 string-table index (`u32`) + count (`f64`). When this section is absent (legacy caches written before the bigram update), the loader SHALL reject the cache on schema-version mismatch alone — there is no backward-compatible read path for pre-bigram caches.

The format SHALL include bigrams (the engine now uses them for context rerank and segmentation) but SHALL NOT include `belowThresholdWords` (still empty under the default `countThreshold=1` after `loadDefaultDictionaries`). Bucket length SHALL remain `u16`.

#### Scenario: Magic bytes identify the file format
- **WHEN** the engine opens a cache file
- **THEN** the engine SHALL read the first 4 bytes and verify they spell `"SYMC"`; if not, the file SHALL be treated as corrupt

#### Scenario: Cache includes bigrams and bigramCountMin
- **WHEN** the engine writes a cache file
- **THEN** the file SHALL contain the bigram section after the delete buckets, and the bigram section SHALL begin with `bigramCountMin` (`f64`) before the bigram-entry list; the load path SHALL read and restore both `bigramCountMin` and the bigram entries into the SymSpell instance

#### Scenario: Round-trip preserves lookup behavior
- **WHEN** the engine builds an index, serializes it to cache, and a separate engine loads from that cache
- **THEN** for every input word in a fixed test corpus, both engines SHALL return the same `lookup` result (same suggested term and same edit distance), AND `wordSegmentation()` SHALL return the same `correctedString` for a fixed segmentation test corpus, AND `original.bigramCountMin === rehydrated.bigramCountMin`

#### Scenario: Cache fidelity test exercises bigram round-trip
- **WHEN** the cache fidelity CI test runs
- **THEN** in addition to the existing `lookup` assertions, the test SHALL assert that `original.wordSegmentation("thequick", 0).correctedString === rehydrated.wordSegmentation("thequick", 0).correctedString`; this confirms the bigram section is faithfully serialized and restored

### Requirement: Atomic write prevents torn cache files
The cache writer SHALL write the serialized data to a temporary file whose name is unique per writer — specifically, `symspell-{key}.bin.{pid}-{random}.tmp` where `{pid}` is the current process id and `{random}` is at least 8 hex characters of randomness — and then `rename()` the temp file to `symspell-{key}.bin`. The unique suffix SHALL prevent two concurrent writers from interleaving bytes into a shared temp path. The `rename()` SHALL be the only atomic step. Cache durability across power loss is explicitly not required (the cache is regeneratable), so `fsync` before rename is not required.

The atomic-rename guarantee assumes POSIX `rename()` semantics (atomic overwrite of an existing target). The cache subsystem SHALL be supported on POSIX-compatible platforms (Linux, macOS, Termux). Behavior on Windows is unspecified — implementations MAY skip the cache subsystem on Windows entirely (treating every load as a miss and every write as a no-op) rather than degrade to non-atomic semantics.

#### Scenario: Crash mid-write does not produce a half-written cache
- **WHEN** the writing process is interrupted between buffer allocation and the rename step
- **THEN** the final cache filename `symspell-{key}.bin` SHALL NOT exist (only the writer's per-process `.tmp` file may exist); the next session SHALL treat the cache as missing and build fresh

#### Scenario: Concurrent writers each use their own temp file
- **WHEN** two sessions both build fresh and both attempt to write the cache for the same key at overlapping times
- **THEN** each writer SHALL allocate its own unique temp filename (different `{pid}-{random}` suffixes); both writes SHALL succeed without interleaving; the final `symspell-{key}.bin` SHALL be the bytes from whichever rename happened last; the bytes are deterministic for a given key, so the outcome is correct regardless of order

### Requirement: Stale sibling caches pruned on every successful load
After a successful cache load, the engine SHALL list sibling files in the cache directory and `unlink()` any matching the pattern `symspell-*.bin` whose filename does not equal the current cache key's filename. Pruning SHALL only target this filename pattern; unrelated files in the cache directory (including `*.tmp` files belonging to in-flight writers from other processes, and any user-placed files) SHALL NOT be touched. This SHALL bound the cache directory's `symspell-*.bin` set to one file per active configuration in steady state.

#### Scenario: Old maxEditDistance cache pruned after switching
- **WHEN** the user previously built `symspell-{keyA}.bin` (for `maxEditDistance=2`) and now configures `maxEditDistance=3`, builds fresh, writes `symspell-{keyB}.bin`, and on the next session loads `symspell-{keyB}.bin` successfully
- **THEN** the engine SHALL delete `symspell-{keyA}.bin` from the cache directory

#### Scenario: Prune ignores non-matching filenames
- **WHEN** the cache directory contains user-placed files or files matching other patterns (e.g., `notes.txt`, `symspell-{key}.bin.{pid}-{rand}.tmp` from an in-flight peer writer)
- **THEN** the prune step SHALL leave those files alone; only files matching exactly `symspell-*.bin` (no additional suffix) and not equal to the current key SHALL be unlinked

#### Scenario: Prune failures do not abort initialization
- **WHEN** an `unlink()` of a stale sibling fails (e.g., permission denied, file locked, or already removed by another process)
- **THEN** the engine SHALL log the failure at info level and continue initialization successfully; pruning is best-effort and SHALL NOT cause the cache subsystem to error

### Requirement: Cache load failures fall through to fresh build
Any failure during cache load — missing file, wrong magic bytes, version mismatch, parse error, truncated buffer, etc. — SHALL be caught, logged at info level (not error), and SHALL trigger a fresh build via the default fresh-build path defined by the autocorrect-engine spec (the unigram-only loader; with the resolver-failure fallback to upstream `loadDefaultDictionaries` as a deeper safety net). The fresh build SHALL then attempt to write a new cache file, overwriting the bad one. The user-visible behavior SHALL be a slightly slower first session after the corruption event; autocorrect SHALL otherwise behave identically.

#### Scenario: Corrupt cache file falls back to fresh build
- **WHEN** the cache file exists but contains bytes that do not parse as the expected format (e.g., truncated, wrong magic, invalid string-table count)
- **THEN** the engine SHALL discard the partial parse, build the index from scratch, and overwrite the cache file with the new, valid bytes

#### Scenario: Missing cache file is not an error
- **WHEN** no cache file exists for the current cache key (e.g., first run after install, or after a config change)
- **THEN** the engine SHALL build from scratch silently (no error notification) and write the cache for next time

### Requirement: Cache fidelity verified in CI
The repository SHALL include an automated test that builds a fresh SymSpell index, serializes it to the cache format, deserializes it into a new SymSpell instance, and asserts that `lookup()` AND `wordSegmentation()` return identical results for fixed, version-controlled corpora of test words and segmentation inputs. This test SHALL run on every CI build so that any breaking change to symspell-ts internals (renamed fields, restructured maps, changed hashing) is detected at upgrade time rather than silently corrupting user lookups or segmentations.

The fixed lookup corpus SHALL be committed to the repository (already at `tests/fixtures/cache-fidelity-corpus.txt`) and SHALL include at least: short words (length 2–3), medium words, long words (length 10+), known typos at ED 1–3, in-dictionary words, and known landmines (`vitest`, `termux`, `kbuernetes`).

A new fixed segmentation corpus SHALL be committed at `tests/fixtures/cache-segmentation-corpus.txt` containing at least: classic concatenations (`thequick`, `wantto`, `helloworld`), tech-prose concatenations (`kubernetespod`, `dockerimage`), and rejected-by-design concatenations (`andro`, `imho`).

#### Scenario: Round-trip lookup fidelity test
- **WHEN** the test builds a fresh `SymSpell(undefined, maxED)`, calls `loadDefaultDictionaries`, serializes via the cache writer, and rehydrates a new instance via the cache reader
- **THEN** for each word in the committed corpus file, `original.lookup(w, Verbosity.All, maxED)[0]` and `rehydrated.lookup(w, Verbosity.All, maxED)[0]` SHALL return the same suggested term and the same edit distance

#### Scenario: Round-trip segmentation fidelity test
- **WHEN** the same test rehydrates the cache and runs `wordSegmentation()` on each entry of the segmentation corpus
- **THEN** `original.wordSegmentation(w, 1).correctedString` and `rehydrated.wordSegmentation(w, 1).correctedString` SHALL be equal for every entry

#### Scenario: Round-trip exercises buckets larger than 255 entries
- **WHEN** the cache fidelity test runs against a freshly built index
- **THEN** the test SHALL assert that at least one delete bucket has more than 255 entries (forcing the `u16` bucket-length codepath); if no such bucket exists, the test SHALL fail with a message indicating the corpus or the format is inadequate to exercise the `u16` requirement

#### Scenario: Round-trip preserves bigramCountMin for lookupCompound future-option
- **WHEN** the cache fidelity test rehydrates the cache
- **THEN** the test SHALL assert `rehydrated.bigramCountMin === original.bigramCountMin` (failing the test if it is `Number.MAX_SAFE_INTEGER`, which would indicate the field was not serialized and SymSpell defaulted it post-hydration)

### Requirement: Trigram side-table has its own binary cache file
The trigram side-table SHALL have an independent binary cache file at `<cache-dir>/trigram-{key}.bin`, where `<cache-dir>` is the same directory as the SymSpell index cache (`~/.pi/agent/cache/mobile-autocorrect/` or the override). The trigram cache key SHALL embed:

1. The SHA-256 (or equivalent) content hash of `data/trigram-top500k.tsv`.
2. A trigram-cache schema version constant.

The trigram cache SHALL be loaded asynchronously after the engine reaches `ready` (per the autocorrect-engine spec's "Trigram side-table lazy-attaches without gating readiness" requirement). On cache miss (file absent or key mismatch), the trigram table SHALL be parsed from the TSV and a fresh cache file SHALL be written. The trigram cache SHALL be independent of the SymSpell index cache: a stale `trigram-*.bin` SHALL NOT invalidate the SymSpell cache, and vice versa.

Atomic write semantics from the SymSpell cache (per-writer unique temp file, `rename()` step) SHALL apply identically to the trigram cache writer.

#### Scenario: Trigram cache hit hydrates the side-table without re-parsing TSV
- **WHEN** the trigram lazy-attach path runs and finds a `trigram-{key}.bin` file matching the current trigram cache key
- **THEN** the side-table SHALL be hydrated from the binary file without reading `data/trigram-top500k.tsv`

#### Scenario: Trigram TSV content change invalidates trigram cache only
- **WHEN** the maintainer rebuilds `data/trigram-top500k.tsv` and ships a new content hash
- **THEN** any existing `trigram-{old-key}.bin` SHALL no longer match and SHALL be ignored on load; a fresh `trigram-{new-key}.bin` SHALL be built; the SymSpell index cache files SHALL NOT be affected

#### Scenario: Stale trigram cache files pruned alongside SymSpell pruning
- **WHEN** a trigram cache load succeeds for the current key
- **THEN** the cache subsystem SHALL list sibling files in the cache directory and `unlink()` any matching `trigram-*.bin` whose filename does not equal the current trigram key's filename; pruning rules and best-effort failure handling mirror the SymSpell prune step

#### Scenario: Trigram cache load failure falls through to TSV parse
- **WHEN** the trigram cache file is corrupt, missing, or has a non-matching key
- **THEN** the loader SHALL fall through to parsing `data/trigram-top500k.tsv`; the failure SHALL be logged at info level and SHALL NOT degrade the engine's readiness state

