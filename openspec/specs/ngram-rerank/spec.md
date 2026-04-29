# ngram-rerank Specification

## Purpose
TBD - created by archiving change improve-autocorrect-context-and-segmentation. Update Purpose after archive.
## Requirements
### Requirement: Multi-candidate rerank with stupid-backoff scoring
The extension SHALL include an in-process n-gram rerank module (`src/ngram-rerank.ts`) that consumes a list of SymSpell candidate suggestions plus a `CorrectionContext` and returns a single best correction. All log-probabilities in the rerank scoring formula SHALL use base 10 (`Math.log10`), matching SymSpell's existing `wordSegmentation().probabilityLogSum` convention. Scoring SHALL be a weighted sum of unigram log-probability, bigram log-probability, trigram log-probability (when the trigram side-table is loaded), and an edit-distance penalty:

```
score(c) = α₀·logP(c)
        + α₁·logP(c | prev)
        + α₂·logP(c | prevPrev, prev)
        − δ·editDistance(token, c)
```

where:

- `α₀` is a fixed constant `1.0` (unigram is always the floor; not user-tunable in v1).
- `α₁` is the live config value `rerankBigramWeight`, default `0.5`, range `[0, 1]`.
- `α₂` is the live config value `rerankTrigramWeight`, default `0.3`, range `[0, 1]`.
- `δ` is the live config value `rerankEditDistancePenalty`, default `1.0`, range `[0, 5]`.

The bigram and trigram conditional log-probabilities SHALL be computed via the **stupid backoff** smoothing scheme with `α = 0.4`:

```
S(c | w₁ w₂) = countₜ(w₁,w₂,c) / countₜ(w₁,w₂)    if countₜ(w₁,w₂,c) > 0
             = 0.4 · S(c | w₂)                        otherwise
S(c | w₂)    = count_b(w₂,c) / count_u(w₂)            if count_b(w₂,c) > 0
             = 0.4 · P(c)                              otherwise
P(c)         = count_u(c) / SymSpell.N                  (always available)
```

Denominator and numerator sources SHALL be locked to a **single corpus per tier** to keep the within-tier ratio meaningful:

- **Trigram tier (`S(c | w₁ w₂)`)**: `countₜ` is from the trigram TSV (top-500k Google Books). `countₜ(w₁,w₂,c)` reads the trigram side-table's `Map<"w₁\u0001w₂\u0001w₃", number>`. `countₜ(w₁,w₂)` reads the trigram side-table's accompanying `bigramPrefixCounts: Map<"w₁\u0001w₂", number>` (sum of trigram counts sharing the `(w₁,w₂)` prefix).
- **Bigram tier (`S(c | w₂)`)**: `count_b(w₂,c)` is from SymSpell's loaded bigram map (`symspell.bigrams.get("w₂ c")` keyed with a single space per SymSpell convention). `count_u(w₂)` is from SymSpell's unigram dictionary (`symspell.words.get("w₂")`). Both come from the same SymSpell-bundled corpus.
- **Unigram tier (`P(c)`)**: from SymSpell's unigram dictionary; `SymSpell.N` is the total token count maintained by SymSpell.

This is documented as an **ad-hoc multi-corpus score, not a calibrated probability.** The trigram tier (Google Books) and bigram tier (SymSpell-bundled) come from different corpora, so the absolute log-prob magnitudes across tiers are not directly comparable; the user-tunable weights `α₁` and `α₂` absorb the cross-corpus mismatch. The stupid-backoff `α = 0.4` is hardcoded.

When `count_u(w₂) === 0` (the prev word is not in the unigram dictionary at all), the bigram tier reduces to `0.4 · P(c)` (full backoff). When the trigram side-table has not yet attached (lazy load not complete), see the "Trigram side-table lazy-attaches to the engine" requirement below.

The rerank SHALL operate on a candidate list of any size (including a single candidate or zero candidates). When the candidate list is empty, the rerank SHALL return `{ corrected: false }`. When the candidate list has one entry, the rerank SHALL still compute the score and apply identity-correction suppression before returning.

The rerank module SHALL be the **single owner of identity-correction suppression**. The autocorrect-engine relies on the rerank's null-winner output for this case; the engine does NOT separately apply identity suppression. The rule the rerank applies is: when the chosen candidate's term equals `token.toLowerCase()` AND `token === token.toLowerCase()` (input is already lowercase), set winner to `null`. When the chosen candidate's term equals `token.toLowerCase()` AND `token !== token.toLowerCase()` (mixed-case input matches a lowercase dict entry), the rerank does NOT suppress — it returns the candidate so the engine's case-normalizing path can produce a correction. This split ensures the prior change's mixed-case-normalization contract is preserved.

The rerank SHALL truncate the candidate list to **exactly 16** entries (`MAX_RERANK_CANDIDATES = 16`, top by SymSpell frequency) before scoring. This is a hard truncation, not an optional optimization. The truncation choice is locked at this constant in v1; tuning is a v1.1 candidate.

The rerank backoff α (`0.4`) is not exposed as a user config knob in v1; it is a module-level constant.

#### Scenario: Single candidate returned unchanged
- **WHEN** SymSpell returns exactly one candidate `c` for token `t` and the rerank module is called with `ctx`
- **THEN** the rerank SHALL compute `score(c)` and return `{ corrected: true, kind: "lookup", suggestion: c.term }` unless the existing identity-correction-suppression rule applies (in which case it returns `{ corrected: false }`)

#### Scenario: Multiple candidates ranked by combined score
- **WHEN** SymSpell returns multiple candidates `[c₁, c₂, c₃]` for token `t` and the rerank module is called with `ctx`
- **THEN** the rerank SHALL compute `score(cᵢ)` for each candidate and return the candidate with the highest score; ties SHALL be broken by SymSpell's original frequency ordering (i.e., the order in which candidates appeared in the lookup result)

#### Scenario: Bigram tier hits when trigram side-table is attached but lacks the (prevPrev, prev, c) entry
- **WHEN** the trigram side-table is attached (lazy load completed successfully) AND it contains no entry for `(prevPrev, prev, c)` AND SymSpell's bigram map contains an entry for `(prev, c)`
- **THEN** the rerank SHALL compute `S(c | prevPrev, prev) = 0.4 · S(c | prev) = 0.4 · count_b(prev, c) / count_u(prev)` (using the bigram-tier score); the trigram tier's contribution to the final weighted sum SHALL be `α₂ · log(0.4 · S(c | prev))`, NOT skipped or zeroed

#### Scenario: Trigram tier is a strict no-op when the trigram side-table is null (lazy load not yet complete)
- **WHEN** the trigram side-table is `null` (the lazy-load promise has not yet resolved, or it failed)
- **THEN** the trigram tier's contribution to the final weighted sum SHALL be exactly `0` (the term is skipped entirely; backoff is NOT applied); this is distinct from the case of an attached-but-empty-for-this-context table, and ensures the lazy-attach window is score-monotonic (post-attach scores are ≤ pre-attach for any candidate); the bigram and unigram tier contributions are unaffected

#### Scenario: Unigram tier reached when both higher tiers miss (trigram table attached)
- **WHEN** the trigram side-table is attached AND neither the trigram table nor SymSpell's bigram map contains any entry for the given context-candidate combination
- **THEN** the rerank SHALL fall through to the unigram probability, multiplied by `0.4²` for trigram-tier backoff and `0.4` for bigram-tier backoff; both higher-tier weighted contributions remain part of the final score (just with backed-off probabilities)

#### Scenario: Bigram-tier denominator missing (prev not in unigram dict)
- **WHEN** `count_u(prev)` is zero (the prev word is not in the SymSpell unigram dictionary, e.g., a tech-dict-only word like `kubernetes`)
- **THEN** the bigram tier SHALL back off to `0.4 · P(c)` (full backoff to unigram), avoiding division by zero; the trigram tier (if applicable) similarly backs off through this path

#### Scenario: prev is undefined (no-context bypass for backward compatibility)
- **WHEN** `ctx.prev` is `undefined` AND `ctx.prevPrev` is `undefined` (no surrounding-word context is available, e.g., the corrected token is the first eligible word on the line OR `ctx` was omitted by the caller)
- **THEN** the rerank SHALL bypass score computation entirely and return `candidates[0]` (the SymSpell `Verbosity.All` result list's first entry, which is the highest-frequency candidate at the lowest edit distance per SymSpell's internal ordering); this preserves the prior change's behavioral contract that callers without context observe identical winner selection to the pre-change `Verbosity.Top` ranking

#### Scenario: prevPrev is undefined (second token on a line)
- **WHEN** `ctx.prev` is defined but `ctx.prevPrev` is `undefined` (the corrected token is the second eligible word on the line)
- **THEN** the rerank SHALL set `α₂·logP(c|prevPrev,prev)` to zero (no contribution); the bigram contribution `α₁·logP(c|prev)` is still computed normally with stupid-backoff to unigram

#### Scenario: Empty candidate list returns no correction
- **WHEN** SymSpell returns zero candidates within the per-call edit distance
- **THEN** the rerank SHALL return `{ corrected: false }` without calling the engine's segmentation path (the engine's segmentation gate is independent of the rerank result; see word-segmentation spec)

#### Scenario: Rerank is observable via debug telemetry
- **WHEN** the user has set `telemetry: "debug"` and a correction is applied
- **THEN** the `correction.applied` event SHALL include each candidate's score breakdown (unigram, bigram, trigram, ED-penalty contributions) so the user can diagnose unexpected wins

### Requirement: Trigram side-table loaded from a shipped data file
The extension SHALL ship a trigram corpus at `data/trigram-top500k.tsv` containing the top 500,000 English trigrams by aggregated count, sourced from Google Books English n-grams (year ≥ 1990). The file format SHALL be tab-separated with one trigram per line: `w1<TAB>w2<TAB>w3<TAB>count<NEWLINE>`. Words SHALL be lowercase ASCII. The file SHALL be accompanied by `data/LICENSES.md` containing the CC-BY-SA 3.0 attribution required by the source. A one-shot build script `scripts/build-trigrams.ts` SHALL be committed to the repository to document and reproduce the extraction; the script SHALL NOT be invoked by `npm test`, `npm run build`, or CI.

The trigram side-table SHALL also maintain bigram-prefix counts (a `Map` from `"w1\u0001w2"` to total count of trigrams beginning with that bigram prefix). These counts SHALL be derived at load time from the trigram TSV (sum over `w3` for each `(w1, w2)` pair) and SHALL be used as the denominator in the stupid-backoff trigram-tier scoring.

#### Scenario: Trigram TSV file ships in the package
- **WHEN** the extension package is installed
- **THEN** the file `data/trigram-top500k.tsv` SHALL exist in the package directory and SHALL be readable

#### Scenario: Trigram file is loaded into a Map keyed by w1<U+0001>w2<U+0001>w3
- **WHEN** the trigram table loader runs
- **THEN** it SHALL parse each TSV line into a Map entry whose key is `w1<U+0001>w2<U+0001>w3` (using the byte `0x01` as a separator that cannot appear in lowercase-ASCII words) and whose value is the integer count

#### Scenario: Bigram-prefix counts are derived from the trigram table
- **WHEN** the trigram table loader runs
- **THEN** it SHALL also populate a Map from `w1<U+0001>w2` to the sum of counts across all trigrams beginning with that bigram prefix; this map SHALL be the denominator for stupid-backoff trigram-tier scoring

#### Scenario: License attribution shipped alongside the data file
- **WHEN** the extension package is installed
- **THEN** the file `data/LICENSES.md` SHALL exist and SHALL include attribution text matching the CC-BY-SA 3.0 requirements for the Google Books n-gram source

### Requirement: Trigram side-table lazy-attaches to the engine as a process-wide singleton
The trigram side-table SHALL be loaded as a **process-wide singleton** — one shared `TrigramTable` instance per process, owned outside any individual engine. Engine instances SHALL acquire the singleton via `getTrigramTableSingleton(): Promise<TrigramTable | null>` which lazy-initializes on first call and returns the same promise to every subsequent caller. Multiple concurrent engines (during a `maxEditDistance`-rebuild orphan window) SHALL share the same in-flight load; rebuilds SHALL NOT trigger redundant TSV parses or duplicated resident memory.

The singleton SHALL load asynchronously after the *first* engine reaches `ready` state. The engine SHALL NOT block its `ready` transition on trigram loading. While the trigram side-table is `null` (singleton not yet resolved), the rerank module's trigram tier SHALL be a **strict no-op**: the term `α₂ · logP(c | prevPrev, prev)` is skipped entirely from the weighted score (contribution is exactly `0`). When the trigram singleton resolves successfully, an atomic field assignment on the rerank module (`this.trigramTable = loadedTable`) SHALL make it visible to subsequent rerank calls. No UI event, status change, or notification SHALL fire on trigram attach success.

The attach callback SHALL respect the engine's orphan-generation token (established by the prior `improve-autocorrect-quality-and-startup` change). When the singleton resolves, the engine's attach callback SHALL verify that the engine's owning generation still matches `state.generation` before assigning to the rerank module's trigram table field. On generation mismatch, the callback SHALL return silently (the orphan engine remains pre-attach and is no longer reachable from `state.engine`).

If trigram loading fails (file missing, parse error, out-of-memory), the rerank SHALL continue to operate in bigram-only mode for the lifetime of every engine instance in the process. A single info-level log message SHALL be emitted (process-wide, not per-engine); no error notification SHALL appear in the TUI.

#### Scenario: Engine reaches ready before trigrams load
- **WHEN** `engine.initialize()` resolves (unigrams + bigrams loaded) but the trigram-singleton lazy-load promise is still in flight
- **THEN** the engine's readiness state SHALL be `ready`; correction lookups SHALL be served; rerank SHALL operate with the trigram tier as a strict no-op (zero contribution), bigram and unigram tiers unaffected

#### Scenario: Multiple engines share the singleton
- **WHEN** the user runs `/typos config maxEditDistance` causing a rebuild while the trigram singleton's load promise is still in flight
- **THEN** the orphan and replacement engines SHALL both await the same singleton promise; only one TSV parse SHALL occur in the process; only one `TrigramTable` instance SHALL exist in resident memory

#### Scenario: Orphan engine attach callback no-ops on generation mismatch
- **WHEN** the trigram singleton resolves AND the calling engine's owning generation no longer matches `state.generation` (it has been orphaned by a config-driven rebuild)
- **THEN** the engine's attach callback SHALL verify the generation, detect the mismatch, and return silently without assigning to the rerank module's trigram table field

#### Scenario: Trigrams attach silently after engine is ready
- **WHEN** the trigram lazy-load promise resolves successfully
- **THEN** subsequent rerank calls SHALL consult the trigram table; no `setStatus` call, no `notify` call, and no readiness-state change SHALL occur

#### Scenario: Trigram load failure does not break the engine
- **WHEN** the trigram lazy-load promise rejects (e.g., `data/trigram-top500k.tsv` not found, parse error)
- **THEN** the engine SHALL remain in `ready` state, the rerank SHALL operate without the trigram tier for the engine's lifetime, and a single `console.info` (or equivalent low-severity log) message SHALL describe the failure; no error notification SHALL be shown in the TUI

#### Scenario: Trigram load is non-blocking on cold start
- **WHEN** the extension is freshly installed (no trigram cache yet) and the engine pre-warms at extension load with `defaultMode: "on"`
- **THEN** the engine SHALL reach `ready` based on unigrams + bigrams alone; trigrams SHALL load in parallel without delaying the user's first available correction

