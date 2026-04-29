# Proposal

## Why

The autocorrect engine still has two structural quality gaps after the previous change shipped:

1. **No surrounding-word awareness.** SymSpell's `Verbosity.Top` lookup ranks candidates purely by unigram frequency. For ambiguous tokens at the engine's per-call edit distance, the engine cannot use the previous word to disambiguate. Real failures like `i want te → i want to` (where SymSpell returns `to`, `ten`, `tea`, etc. as ED-1 neighbors of `te` and unigram frequency picks the wrong one for the context) go uncorrected.

   **Scope note:** the per-call edit distance for short tokens is bounded by the adaptive ED curve from the prior change (`minEditDistance = 1`, `editDistanceStepEvery = 4`). For a length-2 token like `te`, the per-call ED is 1, so SymSpell only enumerates ED-1 neighbors. Insertions at ED=2 such as `te → the` are NOT in v1's deliverable set because SymSpell never returns `the` as a candidate to rerank. The deliverable disambiguation cases are within the current per-call ED bound: tie-breaking among ED-1 candidates (`te → to` vs `te → ten`) and reduced false-fires from rerank's edit-distance penalty. Adaptive-ED retuning to widen the per-call ED for short tokens is explicitly out of scope and deferred to a v1.1 telemetry-driven change.

2. **No word-segmentation correction.** When the user types two or more words concatenated by an accidentally-omitted space (`thequick`, `wantto`, `helloworld`), the token is not in the dictionary and the SymSpell lookup either fails or returns a noisy single-word neighbor. SymSpell ships a `wordSegmentation()` API that recovers the intended split using a Norvig-style dynamic-programming search over the unigram dictionary; it is currently unused because no caller invokes it. **Scope note:** segmentation works against the SymSpell unigram dictionary only; tech-prose concatenations like `kubernetespod` cannot be split in v1 because `kubernetes` lives in the layered tech dictionary, not in the SymSpell index. This is documented as a known v1 limitation; tests assert tech-prose concatenations remain unsegmented to validate the limitation.

Re-loading bigrams (independent of segmentation, which uses unigrams only) and adding a small curated trigram side-table together lift the rerank module's disambiguation quality on common phrases (`I want to`, `as soon as`). The change is forward-looking: there is no hard memory pressure today blocking it, and the user has experienced the failures often enough to justify the resident-memory cost (~30–50 MB total versus current baseline). The previous change's "drop bigrams" decision is being deliberately reversed because the algorithmic value (rerank bigram tier; future-proofing for any caller of `lookupCompound`) now exceeds the memory savings.

The change also lands a long-missing **telemetry** capability so future tuning of correction thresholds, n-gram weights, and segmentation defaults can be driven by real data rather than guessing. Telemetry is bundled into this change rather than landed first because the new mechanisms (rerank scoring, segmentation acceptance, lazy trigram attach) are exactly what telemetry needs to instrument; doing both in one change avoids re-touching the same code paths twice.

## What Changes

### Engine-level

- Re-enable SymSpell bigram loading in `CorrectionEngine.initialize()`. Reverse the §3 "drop bigrams" optimization from the prior change. Update the unigram-only path to load both unigram and bigram dictionaries.
- Switch the engine lookup from `Verbosity.Top` to `Verbosity.All` so the rerank pass has multiple candidates to choose from. The single-best-suggestion contract on `CorrectionEngine.shouldCorrect()` is preserved at the API surface; the multi-candidate set is internal.
- Add a `CorrectionContext` argument to `CorrectionEngine.shouldCorrect()` carrying `prev`, `prevPrev`, `lineText`, and `cursor`. The editor populates it from the line text immediately before the trigger character.
- Introduce a new in-process **n-gram rerank module** (`src/ngram-rerank.ts`) that consumes the SymSpell candidate set plus a `CorrectionContext` and returns a single best correction. Scoring is a weighted sum of unigram log-probability, bigram log-probability via SymSpell's already-loaded bigrams, trigram log-probability via a side table (when loaded), and an edit-distance penalty. Smoothing is **stupid backoff** with α = 0.4 between trigram → bigram → unigram tiers.
- Add a **trigram side-table** loaded from a new shipped data file `data/trigram-top500k.tsv` (TSV: `w1<TAB>w2<TAB>w3<TAB>count`). Source: Google Books English n-grams, year ≥ 1990, top 500k by aggregated count, with a one-shot build script `scripts/build-trigrams.ts`. License: CC-BY-SA 3.0 with attribution in `data/LICENSES.md` and the package README.
- Add a **word-segmentation correction path** that runs **head-to-head with the lookup-then-rerank path**. When the token length is at or above `segmentationMinLength` AND `enableSegmentation: true`, the engine calls `SymSpell.wordSegmentation()` *in parallel with* the lookup-rerank path. The segmentation result is accepted by its own gates (`probabilityLogSum >= segmentationLogProbFloor`, every segment passes `minWordLength` and is alphabetic, at least two segments). When both paths produce viable results, the engine picks the higher score using a tunable bias `segmentationVsLookupBias`.
- Extend the `CorrectionResult` type with a tagged `kind: "lookup" | "segmentation"` discriminator so the editor and telemetry can distinguish single-word swaps from multi-word splits.

### Engine readiness

- The engine becomes `ready` once unigrams + bigrams are loaded. Trigrams **lazy-attach in the background** and silently upgrade the rerank scoring when they finish; their absence does not gate readiness, does not show a "loading" state, and does not block any correction. If trigram load fails, scoring falls back to bigram + unigram with no user-visible error (a single warning is logged at most once per engine instance).

### Editor

- `AutocorrectEditor.maybeApplyCorrection` computes `prev` and `prevPrev` from the current line text immediately before the trigger character (using the same boundary rules as the existing token extractor) and passes them through `CorrectionContext` to the engine.
- The editor handles the new `kind: "segmentation"` correction result. Backspace-undo restores the original concatenated token (the existing length-based eat-and-reinsert logic is structurally compatible — eat `corrected.length + trigger.length`, reinsert `original`).
- The status-flash text distinguishes split corrections: `Corrected: thequick → the quick (split)` versus `Corrected: teh → the`.

### Configuration

- Add new config knobs to `Config`'s persisted shape:
  - `enableSegmentation: boolean` (default `true`)
  - `segmentationMinLength: integer` (default `6`, range `[4, 12]`)
  - `segmentationMaxEditDistance: integer` (default `1`, range `[0, 2]`)
  - `segmentationLogProbFloor: number` (default `-12.0`, range `[-30, 0]`)
  - `segmentationVsLookupBias: number` (default `0.0`, range `[-10, 10]`) — head-to-head bias added to segmentation score before comparing against lookup score
  - `enableContextRerank: boolean` (default `true`)
  - `rerankBigramWeight: number` (default `0.5`, range `[0, 1]`)
  - `rerankTrigramWeight: number` (default `0.3`, range `[0, 1]`)
  - `rerankEditDistancePenalty: number` (default `1.0`, range `[0, 5]`)
  - `telemetry: "off" | "metrics" | "debug"` (default `"metrics"`)
- Extend `/typos config <key> <value>` to accept the new keys with the same validation pattern as existing keys (range checks, persistence, hot-apply where the engine doesn't need a rebuild).

### Commands

- Add `/typos stats` summary command displaying counters and latency percentiles aggregated over `24h | 7d | all` from the local telemetry log. Default range: `24h`.
- Add `/typos stats reset` to wipe local telemetry files for the active scope.
- Extend the `/typos config` argument auto-completion with the new keys.

### Telemetry

- New `src/telemetry.ts` module emitting NDJSON events to `~/.pi/agent/cache/mobile-autocorrect/telemetry/events-YYYY-MM-DD.ndjson`. Override directory via existing `MOBILE_AUTOCORRECT_CACHE_DIR` env var.
- Three privacy levels:
  - `off`: no events written.
  - `metrics` (default): counters, latency, and structural fields only — no token strings, no suggestion strings, no line text.
  - `debug`: full event content including token, suggestion, candidate list. Opt-in for tuning.
- Daily rotation, 30-day retention cap (older files deleted on next telemetry write).
- Event types: `correction.applied`, `correction.rejected`, `correction.skipped`, `engine.init`, `lookup.latency`, `segmentation.attempt`, `trigram.lazy_attached`.
- Event emission **must never block** the editor hot path. Writes are fire-and-forget; failures swallowed.

### Cache layer

- The on-disk SymSpell cache key (`computeCacheKey()` in `src/index-cache.ts`) is extended to include bigram presence and the bigram dictionary file's content hash. Old `symspell-*.bin` cache files keyed only on unigrams are detected as stale (key mismatch on prefix) and silently rebuilt.
- The trigram side-table gets its own optional binary cache file `trigram-{key}.bin` under the same cache directory, parsed-Map representation, schema-versioned. Trigram cache is independent of the SymSpell index cache (separate file, separate key) so an invalidation in one does not invalidate the other.

### Tests

- Unit tests for n-gram rerank scoring, stupid-backoff smoothing, segmentation acceptance gates, lazy trigram attach, telemetry level masking, cache key invalidation.
- Scenario tests **T26–T34** added to `tests/scenarios/SCENARIOS.md` and `tests/scenarios/scripts/`, covering segmentation, context-rerank, telemetry on/off/debug, and `/typos stats` rendering.

### Documentation

- README updated with the new knobs, `/typos stats` command, register expectations ("English Google Books n-grams, post-1990; technical-prose register approximate; learned dictionary covers personal vocabulary"), telemetry privacy levels, and a "previously decided to drop bigrams; now restored" note pointing back to the prior change's design.md.
- CHANGELOG entry under `## [Unreleased]`.
- A v1.1 tuning targets section is included in `design.md` listing thresholds to revisit after one week of `metrics`-mode data.

### Out of scope

- **Real-word error correction** (correcting words that ARE in the dictionary based on context) is explicitly out of scope. Adding it would mutate words the user typed correctly based only on n-gram evidence; the trust cost is too high without a stronger language model. Future v2 candidate.
- **Suggestion-strip UX** (showing alternates the user can swap to via hotkey) is out of scope. Autocorrect remains forced.
- **A neural language model** is out of scope. The Termux mobile target rules out the cold-start cost and resident memory of even quantized models.
- **Adaptive ED defaults retuning** is out of scope. The new context rerank may make `minEditDistance: 1` for short tokens unnecessarily conservative, but defaults are not changed in this proposal — tuning is deferred to v1.1 once telemetry has produced one week of baseline data.
- **A larger or alternative trigram corpus** (Stack Exchange dump, CommonCrawl, Wikipedia n-grams) is out of scope. Documented as a v2 candidate if telemetry shows trigram quality is the bottleneck.

## Capabilities

### New Capabilities

- `ngram-rerank`: Multi-candidate scoring that combines unigram, bigram, and trigram log-probabilities with stupid-backoff smoothing and an edit-distance penalty to pick a single best correction from a SymSpell candidate set, given the surrounding word context.
- `word-segmentation`: Detection of accidentally-concatenated words (e.g. `thequick`) using SymSpell's `wordSegmentation()` plus an acceptance gate, and replacement of the typed token with the multi-segment suggestion.
- `telemetry`: Privacy-tiered local event logging of correction events, lookup latencies, and engine-init metrics, with a `/typos stats` summary command and explicit `off | metrics | debug` levels.

### Modified Capabilities

- `autocorrect-engine`: Lookup verbosity changes, `CorrectionContext` parameter added, lookup-or-segmentation result discriminator, bigram dictionary re-loaded, lazy trigram attachment.
- `index-cache`: Cache key now incorporates bigram and (optionally) trigram presence and content hashes; new sibling cache file for the trigram side-table; stale-cache detection for caches predating the bigram-presence bit.
- `toggle-command`: New `/typos config` keys (segmentation knobs, rerank weights, telemetry level), new `/typos stats` and `/typos stats reset` subcommands, autocomplete extended.

## Impact

**Affected source files (modified):**
- `src/correction-engine.ts` — load bigrams, accept context, lazy trigram attach, segmentation path, multi-candidate result, telemetry hooks.
- `src/autocorrect-editor.ts` — derive context, handle segmentation result, status-flash for split corrections.
- `src/commands.ts` — new config keys, `/typos stats` subcommand, autocomplete extensions, telemetry hooks.
- `src/config.ts` — new persisted config shape, ranges, accessors.
- `src/index-cache.ts` — cache key incorporates bigram + trigram presence.

**New source files:**
- `src/ngram-rerank.ts` — rerank module with stupid-backoff scoring.
- `src/trigram-table.ts` — trigram loader and lookup wrapper.
- `src/telemetry.ts` — privacy-tiered event logging.

**New build/data artifacts:**
- `scripts/build-trigrams.ts` — one-shot extraction script (run by maintainers, output committed).
- `data/trigram-top500k.tsv` — committed trigram corpus (~8 MB raw, ~3–5 MB gzipped if we choose to gzip).
- `data/LICENSES.md` — CC-BY-SA attribution for Google Books n-grams.

**External dependencies:**
- No new runtime npm dependencies. `symspell-ts` is already a dependency; we use its `wordSegmentation()` and `loadBigramDictionary()` APIs that are already present.
- The build script may use `node:https` and `node:zlib` (built-ins). No new dev dependencies expected.

**Memory and latency budget (target ranges; verify in benchmarks during implementation):**
- Resident memory: +30–50 MB total over current §3 baseline (bigrams ~24 MB; trigrams top-500K ~6–25 MB depending on representation).
- Cold-start dictionary parse: 5–9 s on Termux (was 3–5 s post-§3). Pre-warm + cache hide steady-state.
- Lookup p95: ~1.5 ms (was ~0.5 ms post-§3) including rerank, trigram lookup, and segmentation attempt.

**User-visible behavior changes:**
- Splits like `thequick → the quick` now happen.
- Some short-token corrections that previously refused (e.g. `te` in `te quick`) now succeed when surrounding context supports them.
- New status-line variant `(split)` appears for segmentation corrections.
- New `/typos stats` command and new `/typos config` keys appear in autocomplete.
- Local telemetry files written by default under `~/.pi/agent/cache/mobile-autocorrect/telemetry/`. Privacy-safe at the default `metrics` level; users wanting fully-off must run `/typos config telemetry off`.

**Risk summary (full list in design.md):**
- Reversal of the prior change's bigram-drop decision must be documented and justified.
- `Verbosity.All` is more expensive than `Verbosity.Top`; latency budget must be measured.
- Without a real-failure corpus, threshold defaults are educated guesses validated only by telemetry post-merge.
- Stale on-disk caches must be cleanly invalidated to avoid bigram-aware code reading a unigram-only cache.
