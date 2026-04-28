# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/) and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Word segmentation:** `/typos config enableSegmentation` (default `true`), `segmentationMinLength` (default `6`, range `[4, 12]`), `segmentationMaxEditDistance` (default `1`, range `[0, 2]`), `segmentationLogProbFloor` (default `-12.0`, range `[-30, 0]`), `segmentationVsLookupBias` (default `0.0`, range `[-10, 10]`) config keys. When enabled, accidentally-concatenated words (e.g. `thequick`) are detected and split into `the quick`. Split corrections include a `kind: "segmentation"` discriminator in the result and show a `(split)` label in the status flash. Segmentation runs against the SymSpell unigram dictionary only; tech-prose concatenations like `kubernetespod` are not split (documented known limitation).
- **Context rerank:** `/typos config enableContextRerank` (default `true`), `rerankBigramWeight` (default `0.5`, range `[0, 1]`), `rerankTrigramWeight` (default `0.3`, range `[0, 1]`), `rerankEditDistancePenalty` (default `1.0`, range `[0, 5]`) config keys. The engine now calls `Verbosity.All` and passes the full candidate set through a stupid-backoff n-gram rerank module that uses the previous word(s) to disambiguate. Bigram tier reads from the SymSpell-bundled corpus; trigram tier reads from a new Google Books–sourced side-table.
- **Trigram side-table:** `data/trigram-top500k.tsv` (Google Books English n-grams, year ≥ 1990, top 500k by count). Loaded as a process-wide singleton that lazy-attaches in the background after the engine reaches `ready`. Trigram absence does not gate readiness. Build script: `scripts/build-trigrams.ts`. License: CC-BY-SA 3.0 (see `data/LICENSES.md`).
- **Telemetry:** `/typos config telemetry` (`off` | `metrics` | `debug`, default `metrics`). Events are written to `<cacheDir>/telemetry/events-YYYY-MM-DD.ndjson` with 30-day retention. `metrics` (default) logs counters and latency only — no token strings, no suggestion strings, no line text. `debug` is opt-in and logs full content for tuning; see README warning. Writes are fire-and-forget and never block the editor hot path.
- **`/typos stats [24h|7d|all|reset]`** subcommand: displays correction counters and latency percentiles aggregated from local telemetry logs. Default range: `24h`. `reset` prompts for two-step confirmation before deleting telemetry files.

- `/typos default [on|off]` subcommand and persistent extension configuration (`~/.pi/agent/mobile-autocorrect-config.json`, override with `MOBILE_AUTOCORRECT_CONFIG_PATH`) to control the autocorrect mode new sessions start in. The bootstrap value is `off`, preserving prior per-session behavior; setting it to `on` reconciles every `session_start` event to enabled. Reconciliation is bidirectional and silent when state already matches.
- `/typos config [defaultMode|maxEditDistance|minWordLength|minEditDistance|editDistanceStepEvery] [<value>]` flat key/value tuning surface, persisted to the same config file. `maxEditDistance` (integer `1`–`4`, default `2`) is baked into the SymSpell index at engine build time — changing it drops the cached engine and, when autocorrect is currently enabled, hot-reloads it. `minWordLength` (integer `2`–`8`, default `2`) is read live by the correction engine on every lookup, no rebuild required. All values are range-validated; out-of-range or non-integer inputs are rejected without modifying the persisted config. Out-of-range *persisted* values fall back to the bootstrap default for that key on load.
- Two new `/typos config` knobs: `minEditDistance` (integer `0`–`maxEditDistance`, default `1`) and `editDistanceStepEvery` (integer `1`–`8`, default `4`). Together with `maxEditDistance`, these drive an adaptive per-word-length edit distance curve `ED(L) = clamp(minED + floor((L - minWordLength) / step), minED, maxED)` that is tighter on short words (reducing false positives) and more permissive on long words (catching more typos). Both knobs are read live by the engine — no rebuild required when changed.
- Expanded `maxEditDistance` range from `[1, 3]` to `[1, 4]`. Default unchanged at `2`. ED=4 is experimental: lookups are ~7× slower and false positives climb sharply; see README for details.
- Faster startup via lazy/non-blocking engine initialization. `/typos on` returns immediately; a persistent status indicator shows `Autocorrect loading…` while the engine initializes in the background, then transitions to `✓ Autocorrect` (or `Autocorrect unavailable` on failure). When `defaultMode: on`, the engine pre-warms at extension load to overlap initialization with extension startup, reducing perceived cold-start time.
- Persistent on-disk SymSpell index cache at `~/.pi/agent/cache/mobile-autocorrect/symspell-{key}.bin` (override via `MOBILE_AUTOCORRECT_CACHE_DIR`). A cache hit (~200 ms on macOS) replaces the multi-second fresh build. Stale sibling cache files are pruned on every successful load. Cache load failures fall through to a fresh build transparently.
- Bigram dictionary no longer loaded — the extension only calls `lookup()`, not `lookupCompound()` or `wordSegmentation()`, which are the only bigram consumers. Dropping bigrams saves ~24 MB of resident memory and approximately 30% of build time on a fresh build.

### Changed

- **Bigrams re-enabled (reverses the §3 unigram-only optimization from `improve-autocorrect-quality-and-startup`).** `CorrectionEngine.initialize()` now calls `loadDefaultDictionaries()`, loading both unigrams and bigrams. This costs ~24 MB additional resident memory and approximately 30% more cold-start parse time, but enables the context-rerank bigram tier and keeps the door open for future `lookupCompound()` callers. The prior decision was correct for a `Verbosity.Top` unigram-only pipeline; the new rerank surface changes the trade-off. Cache hydration hides most of the parse cost on steady-state sessions.
- **Index cache schema bumped to v2.** Bigrams are now serialized into the SymSpell binary cache (including `bigramCountMin`). Existing v1 cache files (keyed without `bigramsPresent`) are detected as stale on load and silently rebuilt. The new key also includes the SHA-256 hash of the bigram dictionary file, so an upstream symspell-ts data-file change auto-invalidates without a version bump.
- **Lookup verbosity changed from `Verbosity.Top` to `Verbosity.All`.** The engine now enumerates all candidates within the adaptive edit-distance bound and passes the full set to the n-gram rerank module. The external API (`shouldCorrect()`) still returns at most one correction per call.

### Removed

- (none)

## [0.1.0] - 2026-04-26

### Added

- Real-time mobile-friendly autocorrect for Pi's editor with word-by-word correction on space and punctuation triggers.
- A layered dictionary system combining a learned dictionary, a bundled tech-term whitelist, and SymSpell English suggestions.
- Learned-dictionary persistence with manual `/typos dict` management commands.
- `/typos`, `/typos on`, and `/typos off` commands for per-session enable/disable control.
- Gboard-style immediate backspace undo for the most recent correction, including rejection-based auto-learning.
- Automated integration coverage for autocomplete non-interference, toggle lifecycle behavior, token eligibility, and case preservation.

### Notes

- Tag with `git tag v0.1.0 && git push --tags` once integration tests pass on the user's mobile setup.
