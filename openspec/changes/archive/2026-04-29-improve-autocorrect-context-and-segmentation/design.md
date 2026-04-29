# Design

## Context

The mobile-autocorrect extension wraps Pi's editor with a SymSpell-driven, word-by-word correction layer. The previously-archived change (`improve-autocorrect-quality-and-startup`) shipped:

- Adaptive edit-distance curve (`minEditDistance`, `editDistanceStepEvery`, `maxEditDistance`).
- Lazy/non-blocking engine initialization with orphan-generation guard.
- On-disk SymSpell index cache for ~17× faster steady-state startup.
- A deliberate decision to **drop the bigram dictionary** at engine load time, saving ~24 MB resident memory and ~30% cold-start parse time. Justification at the time: word-by-word `Verbosity.Top` lookup did not consume bigrams.

That decision is being reversed in this change. The reversal is not a mistake-correction — it was the right call for the unigram-only ranking model — but a deliberate trade now that the algorithmic value of bigrams (segmentation + context rerank) exceeds the resident-memory savings for this user's mobile/Termux target.

The previously-shipped `CorrectionEngine.shouldCorrect(token)` API is a pure function of one token: no surrounding context, no multi-word output. It returns `{ corrected: false } | { corrected: true; suggestion: string }`. Both shapes need to expand: context flows in, segmentation results flow out, and a multi-candidate rerank step sits between SymSpell's lookup and the chosen suggestion.

The editor (`AutocorrectEditor.maybeApplyCorrection`) already has all the line text and cursor information needed to derive the previous one or two words. The engine just doesn't accept them today. The change is mostly about widening the API and adding a rerank module — the surrounding plumbing already exists.

A complicating factor: there is **no real-failure corpus** to validate threshold defaults against. The user has experienced failures of the kinds we are fixing but does not have written examples to feed into a test fixture. Defaults must be conservative, and post-merge telemetry is the validation surface. This drives several decisions toward "every threshold is a knob" and "metrics-mode telemetry is on by default."

## Goals / Non-Goals

**Goals:**

- Fix the two specific failure modes the user has experienced: short-token disambiguation that needs surrounding context, and concatenated-word inputs that need segmentation.
- Ship a small curated trigram side-table in v1 so common-phrase contexts ("I want to", "as soon as", "out of the") get the trigram-strength rerank lift without paying for the full long-tail of trigram data.
- Bundle a privacy-tiered telemetry capability so future threshold tuning is data-driven, not guess-driven.
- Preserve the existing API contract at `CorrectionEngine.shouldCorrect()`: still returns at most one chosen correction per call. Multi-candidate handling is internal.
- Preserve the engine's existing pre-warm and lazy-init behavior. Trigrams must not gate readiness.
- Keep the editor hot path under ~2 ms p95 per keystroke after rerank and segmentation are added.
- Keep the resident-memory ceiling under 100 MB on a freshly-warmed Termux process; allow up to ~50 MB of additional residency over the post-§3 baseline (enough headroom for bigram + top-500K trigrams in idiomatic JavaScript representations).
- Cleanly invalidate stale on-disk caches that pre-date bigram-aware code.

**Non-Goals:**

- **Real-word error correction** (mutating words that ARE in the dictionary based on context). Out of scope; the trust cost is too high without a stronger language model.
- **Suggestion-strip UX** offering alternates the user can hotkey-swap. Out of scope; autocorrect remains forced.
- **Neural language models** of any kind. Termux constraint.
- **Adaptive ED defaults retuning.** v1 leaves the §1 defaults from the prior change in place. Tuning is deferred to v1.1 once telemetry produces baseline data.
- **Larger or alternative trigram corpus** (Stack Exchange dump, CommonCrawl, Wikipedia n-grams). v1 ships a single Google Books slice; alternative corpora are a v2 candidate gated on telemetry.
- **Beneath-token spatial models** or any per-character mistype probability. Terminal input is text, not touch.
- **Cross-language correction.** English-only. Same as today.
- **A separate `/typos benchmark` command.** v1 ships bench scripts under `bench/` runnable with `npx tsx`, not a Pi command.
- **Auto-tuning thresholds** based on telemetry. Tuning remains manual via `/typos config`. Auto-tuning is a v2 candidate.

## Decisions

### Decision 1: Reverse the §3 bigram-drop optimization (eagerly, not lazily)

**Decision:** Re-enable bigram loading in `CorrectionEngine.initialize()`. Replace the unigram-only path (`symspell.loadDictionary(text, 0, 1)`) with the upstream `loadDefaultDictionaries(symspell)` call from `symspell-ts`, which loads both unigrams and bigrams. Bigrams load eagerly as part of the synchronous initialization that gates the engine's `ready` transition.

**Why bigrams are needed at all:** The new context-rerank module's bigram tier (`α₁·log P(c | prev)`) consumes counts directly from SymSpell's `bigrams` map. Without bigrams loaded, the rerank module's bigram tier always backs off to unigram, eliminating most of the disambiguation value this change exists to deliver. Bigrams are also required by `SymSpell.lookupCompound()`; this change does not call `lookupCompound()`, but loading bigrams keeps the door open if a future change wants to (locked by an explicit invariant in the autocorrect-engine spec).

**Why NOT for word segmentation:** Reading `node_modules/symspell-ts/dist/symspell.js`, `SymSpell.wordSegmentation()` consumes only the unigram dictionary (it calls `lookup()` against a substring and uses `Math.log10(results[0].count / SymSpell.N)` for scoring). It does not reference the `bigrams` map. The previous draft of this design doc incorrectly claimed `wordSegmentation()` would crash without bigrams; that claim has been corrected. Word segmentation in this change works correctly against the unigram dictionary alone.

**Alternatives considered:**

- **Keep §3 path; reproduce bigrams in our own table.** Rejected: re-implementing the bigram-tier scoring against an external table is implementation-equivalent (we'd build the same map) but loses any future option to call SymSpell's own bigram-aware APIs (`lookupCompound`). Marginal cost difference.
- **Curated/truncated bigram subset.** Rejected for v1: the size delta between the full 243k bigram set and a top-K truncation is minor (~5 MB on disk vs ~2 MB at K=100k). Truncation is a v2 micro-optimization if memory becomes a hard limit.
- **Lazy bigram attach (mirror the trigram path).** *Re-evaluated under round-1 review now that the previously-cited blocker — `wordSegmentation` needing bigrams — is gone.* Lazy bigram attach would restore most of the cold-start parse-time savings from the prior §3 change (`loadDefaultDictionaries` is dominated by the bigram dictionary on cold start). **Rejected for v1** because: (a) until bigrams attach, the rerank's bigram tier is a no-op and corrections produced in the lazy window differ from corrections produced after attach — a subtle quality discontinuity the user would experience as "the autocorrect picked X just now but Y two seconds later for the same input." (b) The attach window is exactly the period right after `/typos on` when the user is most actively typing and most likely to notice. (c) The cache hides the cold-start cost on subsequent sessions; pre-warm hides it on the active session. (d) Eager bigram load keeps the engine state space simple — one `ready` transition, not two. The lazy-bigram option is documented here so a future change can revisit if the cold-start cost becomes a measured problem; v1 ships eager.

**Rationale:** The §3 decision was correct for unigram-only `Verbosity.Top` lookup. The new algorithmic surface needs bigrams for the rerank bigram tier. The 24 MB resident-memory cost is the right price for the rerank quality lift. Pre-warm + cache hide most of the cold-start parse-time hit on subsequent sessions; the active-session quality discontinuity argument rules out lazy-bigram-attach for v1.

### Decision 2: Trigram source — Google Books English n-grams, year ≥ 1990, top 500k

**Decision:** Ship `data/trigram-top500k.tsv` extracted from Google Books English 3-gram data, restricted to year ≥ 1990, aggregated to total counts per `(w1, w2, w3)` triple, filtered so all three words exist in the unigram dictionary, sorted descending by count, truncated to top 500k. Build script at `scripts/build-trigrams.ts` runs once by maintainers; output is committed under `data/`. Attribution per CC-BY-SA 3.0 in `data/LICENSES.md` and the package README.

**Alternatives considered:**

- **Stack Exchange data dump → trigrams.** Better register fit (technical/conversational matches terminal use). Rejected for v1: requires a multi-stage build pipeline (download → clean → tokenize → count → top-K). At top 500k the register difference is dominated by ultra-common phrases that appear at high frequency in any English corpus. Documented as a v2 candidate gated on telemetry.
- **Project Gutenberg.** Rejected: archaic/literary register too far from terminal use. Cheap to extract but the long tail is full of vocabulary that would never appear in a modern terminal.
- **Norvig `big.txt` (compute trigrams locally).** Rejected: too small (~6 MB raw); trigram counts are too sparse for stupid-backoff to find hits often enough to matter.
- **Google Web 1T 5-gram (LDC).** Rejected: paywalled; license incompatible with shipping the data file in an OSS extension.
- **Wikipedia n-grams.** Decent register, free, but extraction requires a build pipeline. Documented as v2 candidate.
- **No trigrams in v1, defer to v2.** The user explicitly requested trigrams in v1. Honored.
- **Larger top-K (e.g. 1M, 2M).** Rejected: marginal quality gain past 500k is small (Zipf's law) and resident-memory cost grows linearly. 500k is the sweet spot. Knob to revisit if telemetry shows trigram hit rate is too low.

**Rationale:** Google Books is the cheapest source we can ship today that gives us top-500k coverage of the common phrases that drive most context-rerank value. Register is approximate, not perfect — explicitly documented in the README as a known limitation, with the v2 swap path noted.

### Decision 3: Smoothing — stupid backoff (α = 0.4)

**Decision:** Use the Brants et al. stupid-backoff smoothing scheme:

```
S(c | w₁ w₂) = count(w₁,w₂,c) / count(w₁,w₂)        if count(w₁,w₂,c) > 0
             = 0.4 · S(c | w₂)                       otherwise
S(c | w₂)    = count(w₂,c)    / count(w₂)           if count(w₂,c) > 0
             = 0.4 · P(c)                            otherwise
```

`P(c)` is the unigram log-probability already maintained by SymSpell.

**Alternatives considered:**

- **Kneser-Ney smoothing.** Rejected: significantly more code (continuation counts, discount estimation), more memory (intermediate tables), and the literature shows stupid backoff's quality gap closes rapidly with corpus size. At 500k trigrams + 243k bigrams + 82k unigrams, stupid backoff is competitive.
- **Linear interpolation with EM-trained weights.** Rejected: requires training data we don't have. Manual weight knobs (`rerankBigramWeight`, `rerankTrigramWeight`) cover the same purpose with less infrastructure.
- **Add-one (Laplace) smoothing.** Rejected: too coarse; assigns equal mass to all unseen events.

**Rationale:** Stupid backoff is dead simple, tunable via the α constant, and well-documented. The α = 0.4 default is from the paper. We expose `rerankBigramWeight` and `rerankTrigramWeight` as the user-facing tuning surface; α stays internal and hardcoded for v1.

### Decision 4: Lookup verbosity — switch to `Verbosity.All`, with rerank as the discriminator

**Decision:** `CorrectionEngine` calls `symspell.lookup(token, Verbosity.All, adaptiveED(token.length))`. The result list is passed through the n-gram rerank module which returns the single best correction. `Verbosity.Top` is no longer used in production paths.

**Alternatives considered:**

- **Continued `Verbosity.Top`, fall back to `Verbosity.All` only on low-confidence Top results.** Rejected: defining "low-confidence" without already running the rerank is circular. Two-pass adds complexity, branching, and a cache-locality penalty for marginal compute savings.
- **`Verbosity.Closest`.** Returns all candidates within the *minimum* edit distance found, not all up to max. Rejected: too restrictive; in many cases the right answer is at ED+1 with much higher contextual probability than the ED-min candidate.

**Rationale:** `Verbosity.All` over `Verbosity.Top` adds bounded latency cost (the SymSpell prefix-deletion lookup is the same; the difference is iteration over the result set, which is typically small for short ED). Bench expectations: p95 lookup latency rises from ~0.5 ms to ~1 ms before rerank scoring is added.

### Decision 5: Trigrams lazy-attach in the background

**Decision:** Engine reaches `ready` state once unigrams + bigrams are loaded. Trigrams load in a background promise spawned at the end of `initialize()`. Until they finish, the rerank module's trigram tier is treated as a **strict no-op** (returns zero contribution to the weighted score; the bigram-tier and unigram-tier contributions remain unchanged). This is distinct from the case of an *attached but empty-for-this-context* trigram table, where stupid backoff fires its α=0.4 fallback chain producing a non-zero (just smaller) contribution. The two cases must produce different scores so the lazy-attach window is **score-monotonic**: post-attach scores are always ≤ pre-attach scores for the same candidate, so a candidate that was the winner pre-attach can only be displaced by another candidate that *gains* score from the trigram table — not by spurious score motion in unrelated candidates. When the trigram load finishes, a single atomic field swap (`this.trigramTable = loadedTable`) makes them visible to subsequent rerank calls. No event, no UI state change.

This tightens the original "no-op or backoff" ambiguity flagged in round 1 review. The implementation-level rule is: in the rerank module's `scoreCandidate`, if `this.trigramTable === null` the trigram-tier contribution to the weighted sum is exactly `0` (skip the term entirely). If `this.trigramTable !== null` and `getTrigramCount(prevPrev, prev, c) === 0`, then stupid backoff to bigram applies and the trigram-tier contribution is `α₂ × log(0.4 × bigramTierProbability)`.

If trigram loading fails, a single warning is logged to `console.warn` once per engine instance, and the trigram tier remains a no-op for the lifetime of that engine. Subsequent sessions retry from disk.

**Alternatives considered:**

- **Block readiness on trigram load.** Rejected: pushes another 2–4 seconds onto cold-start. The user-perceptible benefit of having trigrams in the first second of typing is much smaller than the cost of a longer "loading…" state. Bigrams already give most of the rerank value.
- **A separate `enginePartial → enginePartial+trigrams` readiness state with UI exposure.** Rejected: overengineered. Telemetry will tell us if the lazy-attach window matters.
- **Synchronous trigram load with binary cache only (skip text parse).** The cache hit case is already fast; the cache miss case is the slow one. Lazy-attach hides the cache-miss case too.

**Rationale:** Cold-start hostility is the user's other historical pain point. Trigrams are a quality nice-to-have, not a quality must-have. Decoupling them from readiness preserves the §7 pre-warm contract from the prior change.

**Trigram table ownership:** The trigram side-table is a **process singleton**, not a per-engine instance. Engine instances reference the singleton via `getTrigramTableSingleton(): Promise<TrigramTable | null>`. Rationale: (1) the table contents depend only on the shipped TSV file, which does not vary across engine reconfigurations; (2) rapid `maxEditDistance` reconfigures otherwise multiply resident memory linearly with the rebuild count, since each orphan engine retains its own attached table until garbage collected. The singleton's lazy-load promise is shared across engines; multiple concurrent engines wait on the same promise.

**Single emitter for `trigram.lazy_attached`:** The singleton accessor is the *sole* emitter of the `trigram.lazy_attached` telemetry event — emitted exactly once per process when the singleton's load promise resolves (success or failure). Engine instances do NOT emit this event from their per-engine `.then` callbacks. This avoids duplicate events on the first ready engine and zero events for orphan engines.

**Orphan-generation guard for trigram attach:** The trigram-attach path SHALL respect the orphan-generation token established by the prior change (`improve-autocorrect-quality-and-startup`). The orphan-generation token is owned by `commands.ts` (where `state.generation` lives), not by the engine. When the engine schedules its trigram attach via `getTrigramTableSingleton().then(...)`, it captures `ownerGeneration = state.generation` at scheduling time (passed in via a constructor option or accessor) and verifies `ownerGeneration === currentGeneration()` before assigning to the rerank module. On mismatch, the callback returns silently. This preserves the prior change's invariant that no promise touching engine-owned state outlives a generation bump.

### Decision 6a: Telemetry emit ownership

**Decision:** The engine emits `correction.applied`, `correction.skipped`, `lookup.latency`, `engine.init`, `trigram.lazy_attached`, and `segmentation.attempt` because these events have fields the engine knows natively (candidate counts, score breakdowns, edit distance, lookup latency, build time). The editor emits only `correction.rejected` because it owns the timing of the backspace-undo relative to the original `correction.applied` event. Both surfaces share the same `TelemetryWriter` instance constructed once in `index.ts` and threaded through `CorrectionEngineOptions` and `AutocorrectEditorOptions`.

This resolves the round-1 review finding that an editor-emitted `correction.applied` event would have no clean channel to receive the engine-internal score breakdown. By moving the emit point to the engine, no diagnostic payload needs to flow through `CorrectionResult` — the engine emits with the data it already has.

**Alternatives considered:**

- **Editor emits all events with a diagnostics payload threaded through `CorrectionResult`.** Rejected: the diagnostics payload would have to be optional (`metrics`-mode emits structural fields only; `debug`-mode emits content + scores), forcing the engine to construct it conditionally on telemetry level — a coupling that contaminates `CorrectionResult` with telemetry concerns.
- **Engine emits everything including `correction.rejected`.** Rejected: the engine has no way to know if/when a correction was backspaced. The editor owns that timing.

### Decision 6: Telemetry — three privacy levels, `metrics` as default

**Decision:** Config knob `telemetry: "off" | "metrics" | "debug"` with default `metrics`. Events emit to `~/.pi/agent/cache/mobile-autocorrect/telemetry/events-YYYY-MM-DD.ndjson` (override via existing `MOBILE_AUTOCORRECT_CACHE_DIR`). Daily rotation; 30-day retention cap.

Privacy semantics:

| Level | Counters & latency | Token strings | Suggestion strings | Candidate list |
|---|---|---|---|---|
| `off` | — | — | — | — |
| `metrics` (default) | yes | **no** | **no** | **no** |
| `debug` | yes | yes | yes | yes |

`metrics` mode logs structural fields only (event type, timestamps, counts, lengths, latencies, score components, kind discriminator). `debug` mode is opt-in for the user's own tuning use; not recommended for shared machines.

**Alternatives considered:**

- **Default `off`.** Rejected: zero telemetry means zero data for v1.1 tuning; defeats the bundling-with-algorithm rationale.
- **Default `debug`.** Rejected: privacy cost too high for default. User must opt-in.
- **Single boolean (`telemetry: on | off`).** Rejected: conflates two privacy decisions. The user might want metrics-level visibility without their typed text in a log file.

**Rationale:** Three levels is the minimum that respects "I want to know how the autocorrect is performing without leaking my prose to a file."

### Decision 7: Telemetry storage — append-only NDJSON, fire-and-forget writes

**Decision:** Each event is one JSON line, written via `fs.appendFile` (Node's promises API). Writes are unawaited from the editor hot path; `Promise.catch` swallows errors so a full or read-only filesystem cannot break correction.

**Directory creation:** The telemetry directory (`<cacheDir>/telemetry/`) is created lazily by `TelemetryWriter` on first emit at any non-`off` level. The `mkdir(..., { recursive: true })` call happens before the first `appendFile`. When level is `off`, no directory is created. This addresses the round-1 finding that `appendFile` does not implicitly create the parent directory; without explicit mkdirp, the first event silently fails ENOENT and no telemetry is ever written.

**Single-writer in-memory queue:** Each `TelemetryWriter` instance maintains a serialized in-memory promise chain so that multiple `emit()` calls from the same process do not race their `appendFile` calls. The chain is per-process (cross-process interleaving is not protected against, but `O_APPEND` semantics handle that case for short single-line writes on POSIX). The caller surface remains fire-and-forget; the queue is internal to the writer. This addresses the round-1 finding that Node's `fs.appendFile` does not guarantee atomic interleaving for concurrent intra-process writes.

**Daily rotation** by filename pattern (`events-YYYY-MM-DD.ndjson`) — no in-process rotation logic, just date-stamped filenames. **Retention cap:** when the writer detects that the local date has changed since the last prune (or on first emit of a writer instance), it scans the directory and unlinks any `events-*.ndjson` older than 30 days. The previous-draft phrasing "at most once per engine instance" was too narrow — long-lived sessions crossing midnight would never re-prune. The new rule is *date-aware*: the writer caches `lastPruneDate` and re-prunes whenever the current local date differs. Prune failures with `ENOENT` are silent (multiple processes may race the same unlink); other failures are logged at info level.

**Alternatives considered:**

- **SQLite.** Overkill for a single-writer single-reader log; adds a native dep.
- **In-memory ring buffer flushed on shutdown.** Rejected: shutdown in a TUI is sometimes ungraceful (Ctrl+C, terminal close). Data loss likely.
- **Synchronous writes.** Rejected: a slow disk would block typing.

**Rationale:** NDJSON is human-readable, grep-able, and the `/typos stats` aggregator can stream it line-by-line. Fire-and-forget keeps the hot path safe.

### Decision 8: `/typos stats` aggregation

**Decision:** `/typos stats [24h | 7d | all]` (default `24h`) reads telemetry NDJSON files from disk, aggregates in memory, and prints a fixed summary to a notification block. No graphical TUI overlay; same UX surface as `/typos dict` listing.

Summary contents:
- Total `correction.applied` count, broken down by `kind: lookup | segmentation`.
- Acceptance rate: `1 - (correction.rejected / correction.applied)`.
- Lookup latency p50, p95.
- Segmentation latency p50, p95 (separate from lookup).
- `engine.init` average from-cache vs from-scratch ms, trigram-attach ms.
- Cache hit rate: `from_cache_count / total_init_count`.
- Telemetry file size summary; oldest event date.

`/typos stats reset` removes all `events-*.ndjson` files in the telemetry directory after a confirmation prompt.

**Alternatives considered:**

- **Live counters in memory.** Rejected: lost across sessions. NDJSON-on-disk is the source of truth.
- **External tool that the user pipes the file into.** Rejected: friction; `/typos stats` should work out of the box.

### Decision 9: Cache key — bigram presence is part of the SymSpell index cache; trigrams are a separate cache file

**Decision:** Extend `computeCacheKey()` in `src/index-cache.ts` to incorporate:
- bigram presence (boolean) and bigram dict file content hash
- This forces an automatic rebuild for any cache file written before this change.

The trigram side-table has its own binary cache file `trigram-{key}.bin` keyed on the trigram TSV file's content hash plus a schema version. Loaded lazily. Independent of the SymSpell cache: stale trigram cache does not invalidate the SymSpell cache and vice versa.

Old `symspell-*.bin` cache files are detected as stale because the new key won't match any old key (the key prefix changes when bigram presence is added). They are silently ignored and overwritten on the next successful build.

**Alternatives considered:**

- **One combined cache file containing SymSpell + trigrams.** Rejected: trigrams lazy-attach independently; combining forces them into the synchronous load path.
- **Cache version-stamp manual bump.** Rejected: hash-based keying naturally invalidates without manual coordination.
- **Migrate old caches by reading them and adding bigrams in-place.** Rejected: over-engineered. The cache is fundamentally a derived artifact; rebuilding is the right reset.

### Decision 10: Editor handling of segmentation result

**Decision:** `CorrectionResult` becomes a tagged union:

```
type CorrectionResult =
  | { corrected: false }
  | { corrected: true; kind: "lookup";       suggestion: string }
  | { corrected: true; kind: "segmentation"; suggestion: string; segments: string[] }
```

The editor's `maybeApplyCorrection` already uses `result.suggestion.length` for the eat-and-reinsert math; it works unchanged for both kinds (segmentation suggestion is one string with internal spaces). The `kind` is used only for status flash text and telemetry tagging.

Backspace-undo restores `lastCorrection.original` (the concatenated original token, e.g. `thequick`). Unchanged from today. The `recordRejection` learning path records the original concatenated token; the learned dictionary will then suppress future segmentation attempts on that exact token. This is desirable: if the user wants `thequick` to remain `thequick`, two rejections add it to the learned dict.

**Alternatives considered:**

- **Two API methods (`shouldCorrect` and `attemptSegmentation`) with editor-side orchestration.** Rejected: forces the editor to know the head-to-head comparison rule and own the `segmentationVsLookupBias` accessor. Encapsulating the head-to-head comparison inside the engine keeps the lookup-vs-segmentation tradeoff in one place and lets the bias knob and any future scoring refinements evolve without editor changes.
- **Multi-segment replacement at the editor layer (separate space inserts per segment).** Rejected: unnecessary. The suggestion is one string; the editor's existing `insertTextAtCursor` handles internal spaces. Backspace-undo works because `corrected.length` includes the spaces.

### Decision 11: Status flash — disambiguate kind, keep the existing UX

**Decision:** Status indicator shows `Corrected: <orig> → <sugg>` for `kind: "lookup"` and `Corrected: <orig> → <sugg> (split)` for `kind: "segmentation"`. Same `STATUS_KEY` and `STATUS_DURATION_MS` from today.

**Rationale:** The user has a heuristic for trusting/distrusting splits separately from typo fixes; surfacing the kind helps them notice. Minimal code: existing `showCorrectionStatus(orig, sugg)` becomes `showCorrectionStatus(orig, sugg, kind?)`.

### Decision 12: v1 default values are conservative; v1.1 tunes against telemetry

**Decision:** Ship the following defaults:

| Knob | Default | Stance |
|---|---|---|
| `enableSegmentation` | `true` | On — that's the point. |
| `segmentationMinLength` | `6` | Below 6, search space includes too much noise. |
| `segmentationMaxEditDistance` | `1` | One typo per segment, conservative. |
| `segmentationLogProbFloor` | `-12.0` | Empirical threshold from a quick test on common splits; very conservative — would rather miss splits than fire false ones. |
| `enableContextRerank` | `true` | On. |
| `rerankBigramWeight` | `0.5` | β coefficient on log P(c \| prev). Half-weight vs unigram. |
| `rerankTrigramWeight` | `0.3` | γ coefficient on log P(c \| prev,prevPrev). Less than bigram because trigram coverage is sparser. |
| `rerankEditDistancePenalty` | `1.0` | δ. One log-probability unit per ED step. |
| `telemetry` | `"metrics"` | On at safe level by default. |

A v1.1 tuning targets section in this doc lists thresholds to revisit after one week of `metrics`-mode data. The tuning step is a separate change, not bundled here.

**Alternatives considered:** Aggressive defaults (lower segmentation floor, higher trigram weight). Rejected without a corpus to validate against.

### Decision 13: Build-trigrams script is a one-shot maintainer tool

**Decision:** `scripts/build-trigrams.ts` is run by maintainers. Its inputs are downloaded from the Google Books n-gram bucket on demand; output `data/trigram-top500k.tsv` is committed. End-users never run the script. CI does not run it.

The script is not idempotent in input fetch — each run downloads multi-GB of source data — so it is not part of `npm test` or `npm run build`. The committed TSV is the contract.

**Rationale:** A 10 MB committed data file is acceptable in the package; a pipeline that fetches multi-GB at install time is not. The build-time vs runtime asymmetry is fundamental.

### Decision 14: Engine API — additive `CorrectionContext` parameter

**Decision:** `shouldCorrect(token: string, ctx?: CorrectionContext): CorrectionResult`. The `ctx` parameter is optional. When omitted (e.g., from existing tests, third-party callers), the engine behaves as if `prev` and `prevPrev` are undefined; the rerank module's no-context bypass (Decision 14a) then returns SymSpell's frequency top-1 directly, preserving the prior change's behavioral contract.

**Alternatives considered:**

- **New method `shouldCorrectWithContext()`.** Rejected: forces every caller migration; doubles the API surface; the optional-parameter pattern with sensible undefined fallback is idiomatic and backward compatible.

### Decision 14a: No-context fallback preserves prior-change behavior

**Decision:** When `ctx.prev === undefined` AND `ctx.prevPrev === undefined` (no surrounding-word context is available, e.g., the corrected token is the first eligible word on a line, or the caller invoked `shouldCorrect(token)` without a `ctx` argument), the rerank module SHALL bypass score computation entirely and return `candidates[0]` (the SymSpell `Verbosity.All` result list's first entry, which by SymSpell's internal ordering is the highest-frequency candidate at the lowest edit distance). This restores the prior change's behavioral contract that callers without context observe identical winner selection to the pre-change `Verbosity.Top` ranking.

When `ctx.prev` IS defined but `ctx.prevPrev` is undefined (the corrected token is the second eligible word on a line), the bigram tier contributes normally and the trigram tier's contribution is `0`; full scoring applies. The no-context bypass is reserved for the strict case of zero context tokens.

**Alternatives considered:**

- **Apply the full scoring formula even with no context (rerank reduces to `α₀·logP(c) − δ·editDistance`).** Rejected: this changes ranking versus the old `Verbosity.Top` behavior — a candidate with higher unigram frequency could lose to a candidate with lower edit distance because of the `δ·ED` term. The bypass keeps the contract.
- **Drop δ·ED from the formula entirely.** Rejected: the ED penalty is valuable when context IS available because it offsets the temptation to pick a high-bigram-coverage candidate at distance 2 over a near-tie candidate at distance 1. Removing it neuters the rerank.

**Rationale:** Keeps the existing contract narrowly while still giving the rerank full power when context is supplied.

### Decision 15: Lookup and segmentation run head-to-head; higher score wins

**Decision:** When a token passes engine eligibility gates AND segmentation eligibility gates, the engine runs **both** the lookup-then-rerank path AND the `wordSegmentation` path, then compares their scores and returns the path with the higher score. This replaces the previously-considered "lookup-first; segmentation only on lookup failure" priority.

**Comparison rule:**

```
S_lookup        = rerank.scoreCandidate(rerank_winner)            // -Infinity if rerank winner is null
S_segmentation  = result.probabilityLogSum + segmentationVsLookupBias  // -Infinity if segmentation rejected
result          = S_segmentation > S_lookup ? segmentation : lookup
if both are -Infinity: return { corrected: false }
ties (equal scores) prefer lookup (conservative single-word change over multi-word split)
```

The new config knob `segmentationVsLookupBias: number` (default `0.0`, range `[-10, 10]`) is a live-applied float that tunes the cross-scale comparison. Default `0.0` compares raw log-prob magnitudes; positive bias prefers segmentation; negative bias prefers lookup (recovering the prior "lookup-first" behavior at large negative values).

**Why head-to-head over lookup-first:** Cases like `theway` exposed that lookup-first could return a low-confidence single-word neighbor (`their` at ED 2) when segmentation would have produced `the way` with much higher coverage. Head-to-head with a tunable bias lets the user (and telemetry-driven tuning) decide where the preference lies, rather than baking lookup-priority in.

**Alternatives considered:**

- **Lookup-first.** Rejected: hides good segmentations behind weak lookups for tokens that legitimately should be split.
- **Segmentation-first (always prefer split).** Rejected: too aggressive; will turn many short non-concatenated typos into wrong-shape splits.
- **Run only segmentation when lookup score is below a threshold.** Rejected: introduces a second comparison constant and requires lookup to fully run first anyway. Head-to-head is simpler and costs the same `wordSegmentation` call.
- **Per-segment rerank scoring of segmentation result.** Most principled (compute the equivalent rerank score for each segment and sum). Rejected for v1 complexity; the bias knob provides 90% of the value at 10% of the complexity. v1.1 candidate.

**Tie-breaking:** When `S_segmentation === S_lookup` exactly (rare in practice given float math), lookup wins. This biases toward the smaller change when the comparison is genuinely undecidable.

**Telemetry:** When both paths produced a viable result, the engine's `correction.applied` event records both scores at `debug` level (`scoresVsAlt: { lookupScore, segmentationScore }`) so v1.1 tuning can study the distribution and pick a better default bias.

### Decision 16: Stupid-backoff denominators come from a single corpus per tier

**Decision:** The stupid-backoff scoring formula in the rerank module uses denominators sourced from a single corpus per tier:

- **Trigram tier**: `count(w₁, w₂, c)` from the trigram TSV (top-500k Google Books); `count(w₁, w₂)` from the trigram TSV's accompanying `bigramPrefixCounts` map (sum of trigram counts sharing the `(w₁, w₂)` prefix). Both numerator and denominator are from the same Google Books corpus, but **with a known truncation bias**: `bigramPrefixCounts` sums counts only over the top-500k retained trigrams, not over all trigrams in the source. For a `(w₁, w₂)` whose tail beyond rank 500K is large in the source, the prefix sum understates the true `count(w₁, w₂)` and inflates `S(c | w₁, w₂)`. This is documented bias, not a bug; the user-tunable `α₂` (`rerankTrigramWeight`) is expected to absorb it along with the cross-tier corpus mismatch. A v2 candidate is shipping a separate full-corpus bigram-prefix-count file alongside the trigram TSV, but that's deferred.
- **Bigram tier**: `count(w₂, c)` from SymSpell's bigram map (`symspell.bigrams.get("w₂ c")`); `count(w₂)` from the SymSpell unigram dictionary (`symspell.words.get("w₂")`). Both numerator and denominator are from the SymSpell-bundled corpus.
- **Unigram tier**: `count(c) / SymSpell.N` from the SymSpell unigram dictionary. Single-corpus.

Documented as an **ad-hoc score, not a calibrated probability.** Mixing two corpora (Google Books for trigrams, SymSpell-bundled for bigrams/unigrams) means the absolute log-prob magnitudes are not directly comparable across tiers; the user-tunable weights (`α₁`, `α₂`) are how the corpus mismatch is absorbed.

The stupid-backoff α=0.4 is unchanged.

**Logarithm base:** All log-probabilities in the rerank scoring formula SHALL use base 10 (`Math.log10`). This matches SymSpell's existing `wordSegmentation().probabilityLogSum` convention. Mixing bases across the segmentation floor and rerank scores would create a mental-model trap for anyone debugging telemetry score breakdowns. Base-10 throughout the rerank module and the segmentation acceptance gate.

**Score-monotonicity at lazy-attach (fixed weights only):** Under the assumption that `rerankBigramWeight`, `rerankTrigramWeight`, and `rerankEditDistancePenalty` are not changed mid-session, once trigrams attach every candidate's score either stays the same (if the candidate's `(prevPrev, prev, c)` triple is in the table with high enough count to not back off) or *decreases* (because `α₂ · log(probability < 1) < 0`). No candidate's score increases at attach time. A winner can therefore flip in favor of a candidate that *loses less score* than the pre-attach winner. When the user changes weights mid-session, monotonicity does not hold across the weight change — but the discontinuity is user-initiated and observable via telemetry, so it's acceptable.

**Alternatives considered:**

- **Build trigram-tier denominators from SymSpell's bigram map.** Rejected: would not be the correct denominator when the numerator is from a different corpus.
- **Build a single combined corpus.** Out of scope; would require reprocessing the SymSpell corpus into trigrams.

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Resident-memory budget exceeded on Termux (target ≤ +50 MB over post-§3 baseline) | Bench task in §17: measure heap after `engine.initialize()` resolves, after trigram lazy-attach, and after a 1-minute idle settle. Acceptance gate before merge. |
| Cache hydration latency grows when bigrams are added to the binary cache (~243k entries × string-table indices + `f64` count) | Bench task `bench/cache-hydrate-latency.ts` measures hydration time for the bigram-inclusive cache. Soft target: ≤ 500 ms on macOS, ≤ 2 s on Termux (best-effort). Pre-warm hides this from the user on warm-cache runs; first-ever cold-cache install is the worst case. |
| `bigramCountMin` (SymSpell internal field used by `lookupCompound`) silently defaults to `Number.MAX_SAFE_INTEGER` after cache rehydration if not serialized | Cache binary format includes `bigramCountMin` as an `f64` field at the head of the Bigrams section (after the count). Round-trip fidelity test asserts `original.bigramCountMin === rehydrated.bigramCountMin`. |
| Trigram corpus filter ("all three words must be in the symspell-ts unigram dict") drops technical phrases the user actually cares about (`docker`, `kubernetes`, etc., are in the tech dictionary, not the unigram dict) | Loosen the filter at trigram-build time: `word ∈ unigram_dict ∪ tech_dictionary`. This is a one-line change in `scripts/build-trigrams.ts`; the resulting TSV gains a few thousand technical-phrase trigrams. Documented in README as a known limitation when the v2 corpus swap is considered. |
| **Word segmentation cannot split tech-prose concatenations** (`kubernetespod`, `dockerimage`) because `SymSpell.wordSegmentation()` consumes only SymSpell's unigram dictionary, and the tech dictionary is layered on top of SymSpell at the `shouldCorrect` boundary, not fed into the SymSpell index | This is a v1 known limitation. Tests assert that tech-prose concatenations remain unsegmented (validating the limitation, not asserting a fix). README documents the limitation. A v2 candidate is to also feed tech-dict words into the SymSpell unigram index at engine construction so segmentation considers them; out of scope for v1 because it would change the `shouldCorrect` no-correct semantics for tech-dict words (currently they are recognized via the layered check, not via SymSpell). |
| **Cross-scale comparison between lookup-rerank score and segmentation `probabilityLogSum`.** The two paths produce numbers on different scales: lookup-rerank is a weighted sum across unigram/bigram/trigram tiers plus ED penalty; segmentation is `Math.log10` summed over per-segment unigram lookups. Direct comparison is principled only loosely | Add a tunable bias knob `segmentationVsLookupBias` (default `0.0`, range `[-10, 10]`) added to `S_segmentation` before comparison. The bias absorbs the scale difference; telemetry's `correction.applied` event records both scores in `debug` mode so v1.1 tuning has data. Default `0.0` means "compare raw log-prob magnitudes"; positive bias prefers segmentation; negative prefers lookup. |
| **Doubled hot-path latency from running both paths.** Each `shouldCorrect` call now runs SymSpell.lookup + rerank AND `SymSpell.wordSegmentation` (when eligibility gates pass) instead of segmentation only on lookup failure. Estimated p95 increase: ~10 ms → ~12–15 ms in the worst case (long-token concatenation eligible for both paths) | Acceptable within the editor's inter-keystroke budget. Bench `bench/segmentation-latency.ts` measures the combined cost. Segmentation is still gated by `segmentationMinLength` so short tokens skip the path entirely; pre-2-character-typing latency is unchanged. |
| `Verbosity.All` lookup adds latency past acceptable hot-path budget | Bench task: p95 lookup latency under ED=2 and ED=4. Hard limit ≤ 2 ms before merge. If exceeded, fall back to capped candidate list (`lookup` returns up to N=8 results). |
| Rerank scores ambiguity case wrongly because the trigram corpus's register diverges from the user's prose | (a) Document register limitation in README. (b) v1.1 swap to better corpus is a planned escape hatch. (c) Telemetry event includes score components per candidate so failures are diagnosable in `debug` mode. |
| Stupid backoff α = 0.4 hardcoded is wrong for our corpus mix | Knob exists conceptually but not exposed to user. If telemetry shows persistent over- or under-weighting of the backoff tiers, exposing α is a one-line v1.1 change. |
| Word segmentation fires false splits on borderline tokens (`andro`, `imadog`) | (a) `segmentationMinLength` floor. (b) `segmentationLogProbFloor` floor. (c) Two rejections add the original to learned dict, suppressing future splits. (d) Test corpus for known-bad inputs (synthetic, since no real corpus). |
| Lazy trigram attach race: a correction fires after `ready` but before trigrams attach, gets bigram-only score that wins, then trigrams arrive that would have flipped it | This is by-design. Documented as expected behavior. The window is brief (1–4 s); the priority is keeping cold-start fast. |
| Stale on-disk caches get loaded on a user upgrading without rebuild | Cache key includes bigram-presence bit; old caches cannot match. Tested via cache-hash-mismatch scenario. Worst case: one extra cold-start build per user per upgrade. |
| Telemetry log fills disk if user types extremely heavily for years | 30-day retention cap; daily rotation; a single `metrics`-level event is < 200 bytes. At 1000 corrections/day that's ~200 KB/day, ~6 MB/30-day-window. Negligible. |
| Telemetry write failure (full disk, read-only fs) breaks editor | Fire-and-forget writes with swallowed promises. No code path on the editor hot path awaits a telemetry write. Tested by injecting a write-failure stub. |
| User's expectations of "Gboard-like" exceed what n-grams alone can deliver, leading to disappointment | README sets expectation: "n-gram quality, not neural-LM quality. Real-word errors not corrected." Telemetry-driven v1.1 tuning can lift quality further. Real-word errors are a v2 conversation. |
| Reversing the §3 decision creates a documentation inconsistency between this design and the archived prior change | This design's Context section explicitly references the prior decision and explains why the trade-off is now different. The prior change's design.md remains valid for that change's scope. README adds a "previously dropped, now restored" note. |
| The build-trigrams script breaks because Google changes the n-gram bucket layout | The committed `data/trigram-top500k.tsv` is the contract; the script breaking only blocks a future re-extraction. Source URL hard-coded in script with a comment naming the snapshot we built from. |
| `wordSegmentation()` returns surprising splits because the bigram dictionary's vocabulary excludes our tech dictionary | Tech-dict words are **not** in SymSpell's bigram map, so a phrase like `kubernetespod` splits to `kubernetes pod` only if `kubernetes` is in the unigram dict (it is, via tech-dictionary.txt). But `kubernetes` won't appear as a bigram neighbor of anything. Effect: technical splits are correct but their probability score may be artificially low. Mitigation: `segmentationLogProbFloor` is permissive enough; tech words pass via unigram-only frequency contribution. Validated in scenario test. |
| `prevPrev` extraction at line start is undefined; rerank trigram tier never fires for first-line corrections | Acceptable; rerank gracefully degrades to bigram-only at line start via stupid backoff. Documented. |

## Migration Plan

### Deployment

This is an extension upgrade, not a service deploy. Migration steps for an end user upgrading:

1. New version installs; old version uninstalls. Standard.
2. First start: `defaultMode` config persists from prior version.
3. New config keys (`enableSegmentation`, etc.) are read from the persisted config; missing keys default to bootstrap values from `Config`'s schema (the existing inline normalization block in `Config.load()` that calls `normalizeIntInRange` / `normalizeDefaultMode` per key, extended in this change to also call `normalizeBoolean` / `normalizeNumberInRange` / `normalizeEnum` for the new key shapes). No migration of the config file itself; it's already versionless and schema-tolerant.
4. First start hits an old `symspell-*.bin` cache (unigram-only). Cache key mismatch → cache miss → rebuild from text → write new `symspell-{newkey}.bin`. The orphaned old cache file remains; existing prune logic from the prior change cleans it on the next eligible boot.
5. Trigram cache absent on first start → build from `data/trigram-top500k.tsv` → write `trigram-{key}.bin`. Subsequent starts hit the binary cache.
6. Telemetry directory created on first event. `metrics` level by default.

### Rollback

The change is a single git revert away. End users on the new version cannot trivially "downgrade" their persisted configs (new keys are written), but the prior version's `Config.load()` normalization ignores unknown keys, so a downgrade is safe.

### Cache-state matrix

| Before upgrade | After upgrade, first run | After upgrade, second run |
|---|---|---|
| No cache | Build SymSpell (now with bigrams), build trigram cache | Hit both caches |
| Cache from §3 era (unigram-only) | Detect mismatch, rebuild SymSpell, build trigram cache | Hit both caches |
| Cache from this era | Hit SymSpell cache; trigram cache loads | Hit both caches |

### Telemetry rollout

Default `metrics` level activates immediately on upgrade. README explains how to switch to `off` for fully-private mode. A first-week of telemetry data informs v1.1 tuning targets.

## v1.1 Tuning Targets

After one week of `metrics`-mode telemetry, revisit:

- `segmentationLogProbFloor`: tune up if false splits dominate, tune down if real splits are missed.
- `rerankBigramWeight` and `rerankTrigramWeight`: rebalance based on which tier dominates winning corrections.
- `rerankEditDistancePenalty`: increase if rerank picks ED+1 candidates that should have stayed at ED-min; decrease if it always picks ED-min.
- Adaptive ED defaults from the prior change (`minEditDistance`, `editDistanceStepEvery`): the new context rerank may make `minEditDistance: 1` for short tokens unnecessarily strict. Possibly relax.
- `segmentationMinLength`: tune based on segmentation precision/recall at boundary lengths.
- Whether to expose stupid-backoff α (currently hardcoded 0.4).

These tuning steps land as a separate small change, not in this proposal.

## Open Questions

None blocking. The following are resolvable during implementation without re-litigating decisions:

- Exact binary format for the trigram cache (mirror `index-cache.ts`'s format or use a simpler format since trigrams are smaller). Implementation detail; covered in the relevant task.
- Whether the trigram TSV ships gzipped (`data/trigram-top500k.tsv.gz`) or raw (`.tsv`). Implementation detail; raw if size is acceptable, gzip if it's a problem on `npm publish` package size.
- Exact telemetry event field names (event-type-specific schema). Locked in during implementation; documented in `src/telemetry.ts`.
