## ADDED Requirements

### Requirement: Engine accepts a CorrectionContext for surrounding-word awareness
The engine's `shouldCorrect` method signature SHALL accept an optional second parameter `ctx: CorrectionContext` carrying the surrounding-word context derived from the editor's line text. The `CorrectionContext` shape SHALL be:

```
type CorrectionContext = {
  prev?: string;        // previous eligible token, lowercased; undefined at line start
  prevPrev?: string;    // token before prev, lowercased; undefined when not available
  lineText?: string;    // full current line at trigger time (debug telemetry only)
  cursor?: { line: number; col: number };  // cursor position at trigger time (debug telemetry only)
};
```

When `ctx` is omitted (e.g., from existing tests, third-party callers, or any code path that does not supply context), the engine SHALL behave as if `prev` and `prevPrev` are `undefined`. The rerank module SHALL gracefully fall through to unigram-only ranking in that case (per the ngram-rerank spec). Behavior in the no-context case SHALL match the engine's pre-context behavior modulo the existing `Verbosity.Top` → `Verbosity.All` switch (single-best result returned in both cases).

The editor SHALL populate `ctx.prev` and `ctx.prevPrev` by scanning the line text immediately to the left of the trigger character, applying the same boundary rules used for the current-token extraction (alphabetic-only, `SAFE_BOUNDARY_CHARS` between tokens, lowercased). Extraction SHALL skip the just-typed token (the one being corrected) and start at its left boundary.

#### Scenario: shouldCorrect without ctx falls through to unigram ranking
- **WHEN** a caller invokes `engine.shouldCorrect("teh")` with no `ctx` argument
- **THEN** the engine SHALL run `Verbosity.All` lookup, pass the candidates through rerank with `prev: undefined, prevPrev: undefined`, and return the single best correction; the rerank's bigram and trigram tier contributions are zero in this case

#### Scenario: Editor extracts prev token from line text
- **WHEN** the user types `i want te ` (cursor after space following `te`) and the trigger is the space
- **THEN** the editor SHALL extract `prev: "want"` and `prevPrev: "i"` from the line text and pass them in `ctx` to `shouldCorrect("te", ctx)`

#### Scenario: Editor handles line-start prev as undefined
- **WHEN** the user's just-typed token is the first eligible token on the line (e.g., the line starts with `te `)
- **THEN** the editor SHALL pass `ctx.prev: undefined`; the engine SHALL pass this through to the rerank, which falls back to unigram

#### Scenario: Editor lowercases context tokens
- **WHEN** the line text contains `I Want te` and the trigger fires after `te`
- **THEN** the editor SHALL pass `ctx.prev: "want"` and `ctx.prevPrev: "i"` (both lowercased), so the rerank's bigram/trigram lookups can match the lowercased corpus keys

### Requirement: Multi-candidate lookup with rerank
The engine SHALL invoke `SymSpell.lookup(token, Verbosity.All, effectiveED)` (instead of `Verbosity.Top`) when looking up corrections. The returned candidate list SHALL be passed through the n-gram rerank module (see `ngram-rerank` capability spec) along with the `CorrectionContext`. The rerank's single best candidate SHALL be the engine's chosen correction, subject to the existing identity-correction-suppression rule (which still applies: if the chosen candidate equals the input lowercased, return `{ corrected: false }`).

The rerank module (per `ngram-rerank` spec) SHALL truncate the candidate list to exactly 16 entries (`MAX_RERANK_CANDIDATES = 16`, top by SymSpell frequency) before scoring. This is a hard requirement, not optional, and is owned by the rerank module — the engine does not perform truncation separately.

#### Scenario: Verbosity.All replaces Verbosity.Top in production paths
- **WHEN** the engine performs any correction lookup
- **THEN** the SymSpell call SHALL use `Verbosity.All`; `Verbosity.Top` SHALL NOT be called from any production code path (test code MAY still reference it for round-trip fidelity validation)

#### Scenario: Identity suppression delegated to rerank module
- **WHEN** the SymSpell `Verbosity.All` lookup returns candidates AND the rerank module's identity-suppression rule applies (chosen candidate's term equals `token.toLowerCase()` AND input is already lowercase)
- **THEN** the rerank returns a null winner; the engine receives null, recognizes lookup produced no winner, falls through to the segmentation gate (per the segmentation-runs-when-all-candidates-identity-suppressed scenario), and if segmentation gates fail, returns `{ corrected: false }`. The engine does NOT separately apply identity suppression — the rerank module is the sole owner of that rule.

#### Scenario: Mixed-case exact-match input is normalized to lowercase, NOT identity-suppressed
- **WHEN** the SymSpell lookup returns one candidate `c` where `c.term === token.toLowerCase()` AND the original `token !== token.toLowerCase()` (e.g., user typed `tHe` and the dictionary has `the`)
- **THEN** the rerank module's identity-suppression rule does NOT fire (because input is mixed-case, not all-lowercase); the rerank returns `c` as winner; the engine returns a correction normalizing the case, preserving the prior change's mixed-case-normalization contract

#### Scenario: Candidate list is bounded
- **WHEN** the SymSpell `Verbosity.All` lookup returns more than 16 candidates
- **THEN** the engine MAY truncate the list to 16 entries (top by frequency) before passing to rerank; the truncation SHALL be a documented optimization, not a correctness requirement, and the choice of N SHALL be a module-level constant

### Requirement: Engine constructs and consults the n-gram rerank module
The engine SHALL hold a reference to an `NgramRerankModule` instance constructed during `initialize()`. The module receives the live config accessors for `rerankBigramWeight`, `rerankTrigramWeight`, `rerankEditDistancePenalty`, and `enableContextRerank`. When `enableContextRerank` is `false`, the rerank module SHALL bypass scoring and return the SymSpell list's first entry (preserving prior behavior: SymSpell's frequency ranking wins). When `enableContextRerank` is `true` (default), the rerank's full scoring formula applies.

The bigram source for the rerank's bigram tier SHALL be SymSpell's already-loaded bigram map (accessible via the SymSpell instance now that bigrams are loaded). The trigram source SHALL be the lazy-attached trigram side-table (see ngram-rerank spec).

#### Scenario: Rerank module attached during initialize
- **WHEN** `engine.initialize()` resolves successfully
- **THEN** the engine SHALL hold a non-null reference to an `NgramRerankModule` configured with live accessors for the four config knobs

#### Scenario: enableContextRerank false bypasses scoring
- **WHEN** `enableContextRerank` is `false` and the engine performs a lookup that returns multiple candidates
- **THEN** the rerank module SHALL return the first candidate (SymSpell's top-by-frequency entry) without computing the bigram/trigram/penalty contributions

### Requirement: Lookup and segmentation run head-to-head; engine picks the higher-scoring path
The engine SHALL run BOTH the lookup-then-rerank path AND the `wordSegmentation` path when their respective eligibility gates pass, then compare their scores and return the path with the higher score. This replaces a previous "lookup-first; segmentation only on lookup failure" priority.

The lookup path produces `S_lookup`:
- If the rerank returns a non-null winner, `S_lookup = rerank.scoreCandidate(winner)` (the same weighted-sum number the rerank uses internally, expressed as a single float).
- If the rerank returns null (no candidates from SymSpell, OR all candidates suppressed by identity rule), `S_lookup = -Infinity`.

The segmentation path produces `S_segmentation`:
- If `wordSegmentation()` returns a result that satisfies all acceptance gates from the `word-segmentation` capability spec (multi-segment, segments alphabetic and meet `minWordLength`, `probabilityLogSum >= segmentationLogProbFloor`), `S_segmentation = result.probabilityLogSum + segmentationVsLookupBias`. The `segmentationVsLookupBias` is a live config float (default `0.0`, range `[-10, 10]`) that absorbs the cross-scale difference between rerank weighted sums and segmentation log-prob sums.
- Otherwise, `S_segmentation = -Infinity`.

The engine SHALL then compare:

- If `S_segmentation > S_lookup`, return the segmentation result (`kind: "segmentation"`).
- Else if `S_lookup > -Infinity`, return the lookup result (`kind: "lookup"`).
- Else (both are `-Infinity`), return `{ corrected: false }`.
- Ties (`S_segmentation === S_lookup` exactly) SHALL be broken in favor of `lookup` — prefer the smaller change when comparison is genuinely undecidable.

When both paths produced a viable result (neither score is `-Infinity`), the engine's `correction.applied` telemetry event SHALL include both scores at `debug` level via a `scoresVsAlt: { lookupScore, segmentationScore }` field so v1.1 tuning can study the distribution.

When segmentation eligibility gates fail at the `enableSegmentation`/`segmentationMinLength` check (token too short or feature disabled), `wordSegmentation()` SHALL NOT be invoked at all (saving the latency of the call); `S_segmentation` is treated as `-Infinity` and only the lookup path competes.

#### Scenario: Both paths produce results; segmentation wins on score
- **WHEN** a token passes both eligibility gates, the lookup-rerank produces `S_lookup` (e.g., `-9.2`), and `wordSegmentation()` produces `S_segmentation` (e.g., `-7.5` after bias) which is greater
- **THEN** the engine SHALL return the segmentation result with `kind: "segmentation"`; the lookup winner is recorded in `debug`-mode telemetry under `scoresVsAlt.lookupScore` but not surfaced to the user

#### Scenario: Both paths produce results; lookup wins on score
- **WHEN** a token passes both eligibility gates, the lookup-rerank produces `S_lookup` (e.g., `-6.0`), and `wordSegmentation()` produces `S_segmentation` (e.g., `-8.5` after bias) which is lower
- **THEN** the engine SHALL return the lookup result with `kind: "lookup"`; the segmentation candidate is recorded in `debug`-mode telemetry under `scoresVsAlt.segmentationScore` but not surfaced to the user

#### Scenario: Only lookup path produces a result
- **WHEN** the lookup-rerank produces a winner but segmentation is rejected by its acceptance gates (or `enableSegmentation: false` or token below `segmentationMinLength`)
- **THEN** the engine SHALL return the lookup result with `kind: "lookup"`; `S_segmentation = -Infinity`

#### Scenario: Only segmentation path produces a result
- **WHEN** the lookup-rerank returns a null winner (no candidates or all identity-suppressed) AND segmentation passes its acceptance gates
- **THEN** the engine SHALL return the segmentation result with `kind: "segmentation"`; `S_lookup = -Infinity`

#### Scenario: Tie-breaking prefers lookup
- **WHEN** `S_segmentation` and `S_lookup` are exactly equal (both finite)
- **THEN** the engine SHALL return the lookup result; ties favor the smaller change

#### Scenario: Tunable bias shifts head-to-head outcome
- **WHEN** the user runs `/typos config segmentationVsLookupBias 5.0` and a previously-lookup-winning case is re-tried
- **THEN** the live bias accessor SHALL be read on the next `shouldCorrect` call; segmentation's score is now `result.probabilityLogSum + 5.0`; if this new score exceeds `S_lookup`, segmentation wins; this proves the knob is live-applied without an engine rebuild

#### Scenario: enableSegmentation false skips the segmentation path entirely
- **WHEN** `enableSegmentation` is `false`
- **THEN** the engine SHALL NOT invoke `wordSegmentation()` for any token; only the lookup path competes; `S_segmentation` is implicitly `-Infinity`

### Requirement: Trigram side-table lazy-attaches without gating readiness
The engine SHALL spawn a background promise to load the trigram side-table after the synchronous `initialize()` work completes. The engine SHALL transition to `ready` based on unigrams + bigrams loaded; trigram loading SHALL NOT delay readiness. When the trigram load finishes, the engine SHALL atomically attach the loaded table to the rerank module so subsequent rerank calls consult it. Failure of the trigram load SHALL NOT degrade the engine's readiness state.

This requirement is detailed in the `ngram-rerank` capability spec ("Trigram side-table lazy-attaches to the engine"). The autocorrect-engine spec restates it here only to make the `ready` transition contract explicit at the engine level.

#### Scenario: Engine ready state independent of trigram load
- **WHEN** the engine has loaded unigrams and bigrams but the trigram lazy-load promise is still in flight
- **THEN** `engine.getReadiness()` SHALL return `"ready"`; correction lookups SHALL succeed; the rerank's trigram tier SHALL contribute zero log-prob until trigrams attach

## MODIFIED Requirements

### Requirement: SymSpell correction with configurable edit distance and frequency ranking
The engine SHALL use the SymSpell algorithm (Damerau-Levenshtein distance, where transpositions count as 1 edit) with `Verbosity.All` mode to enumerate every correction candidate within the configured edit distance. The maximum edit distance SHALL be configurable per the `maxEditDistance` extension config (integer in `[1, 4]`, default `2`) and SHALL be baked into the SymSpell index at engine construction time. At lookup time, the engine SHALL compute a per-word effective edit distance from the adaptive curve (see "Adaptive per-word-length edit distance" requirement below) and pass that value — not the index ceiling — to `SymSpell.lookup`. The per-call distance is permitted to be smaller than the index ceiling; SymSpell tolerates this and returns only candidates within the per-call distance.

Candidate selection from the multi-result list SHALL be performed by the n-gram rerank module (see the `ngram-rerank` capability spec), which takes the candidate list plus a `CorrectionContext` and returns a single best correction. When `enableContextRerank` is `false`, the rerank module bypasses scoring and returns SymSpell's frequency-ordered top-1; this preserves the prior single-candidate-by-frequency contract for users who disable context awareness. The previous use of `Verbosity.Top` is no longer permitted in production code paths.

#### Scenario: Common mobile typo with single transposition
- **WHEN** the user types "teh" (1 transposition from "the")
- **THEN** the engine SHALL suggest "the" as the correction (chosen via rerank from the `Verbosity.All` candidate list)

#### Scenario: Typo with multiple possible corrections, context absent
- **WHEN** the user types a word that has multiple corrections within the configured edit distance and `enableContextRerank` is `false` (or `ctx` is not supplied)
- **THEN** the engine SHALL return the correction with the highest unigram frequency count (preserving the prior frequency-ranking contract)

#### Scenario: Typo with multiple possible corrections, context available
- **WHEN** the user types a word with multiple corrections within distance, `enableContextRerank` is `true`, and `ctx.prev` is supplied
- **THEN** the engine SHALL return the candidate with the highest combined rerank score (unigram + α₁·bigram + α₂·trigram − δ·ED), where `α₁`, `α₂`, `δ` are the live config values; the chosen candidate MAY differ from SymSpell's frequency top-1

#### Scenario: Word beyond the per-word effective edit distance
- **WHEN** the user types a word whose effective edit distance (from the adaptive curve) yields no match within that distance, so `S_lookup = -Infinity`
- **THEN** the engine's final result is determined by the head-to-head comparison: if the segmentation path produced an accepted result (`S_segmentation > -Infinity`), segmentation wins by default; otherwise the engine returns `{ corrected: false }`

#### Scenario: maxEditDistance change requires engine rebuild
- **WHEN** the user changes `maxEditDistance` via `/typos config maxEditDistance <n>`
- **THEN** the cached engine SHALL be discarded and the next engine instance SHALL be constructed with the new value (see toggle-command spec for the user-facing flow); the running engine SHALL continue using its construction-time value until replaced

#### Scenario: maxEditDistance value of 4 is permitted
- **WHEN** the user sets `maxEditDistance` to `4`
- **THEN** the engine SHALL accept the value, build the SymSpell index at that ceiling, and successfully serve lookups; the engine SHALL NOT impose a soft cap below 4 even though false-positive rates are documented to climb sharply at that distance

#### Scenario: Identity correction suppressed
- **WHEN** the rerank's chosen candidate's term equals the lowercased input (i.e., the candidate at distance 0 with the highest score is the input itself)
- **THEN** the engine SHALL return `{ corrected: false }`, NOT fire a correction event

### Requirement: Bundled English frequency dictionary
The engine SHALL load the symspell-ts bundled English frequency dictionary (~82K words with frequency counts) AND the symspell-ts bundled English bigram dictionary (~243K bigrams with counts). Loading SHALL happen lazily on first `/typos on` (or, when `defaultMode === "on"`, on extension load via pre-warm — see toggle-command spec), not on every session start. The engine SHALL load bigram data because:

- The new context-rerank path's bigram tier consumes counts directly from SymSpell's `bigrams` map (`count_b(w₂, c)`); without bigrams loaded, the rerank's bigram tier always backs off to unigram, eliminating most of the disambiguation value this change exists to deliver.
- Future code paths that wish to call `SymSpell.lookupCompound()` are unblocked.

Bigrams are NOT required by `SymSpell.wordSegmentation()` — the SymSpell implementation of `wordSegmentation()` is a Norvig-style dynamic-programming search over the unigram dictionary only and does not reference the `bigrams` map. The previous draft of this requirement claimed otherwise; the claim has been corrected.

Bigram loading SHALL be performed via the upstream `loadDefaultDictionaries(symspell)` API from `symspell-ts`, which loads both unigrams and bigrams from the package's bundled data files. The engine SHALL NOT load bigrams via a separate path that could diverge from the upstream-supported one. The bundled data file paths SHALL be derived from the symspell-ts package root using the same package-root resolution rule as the index-cache spec.

This requirement REVERSES the prior change's "drop bigrams" optimization. The prior decision was correct for unigram-only `Verbosity.Top` ranking; it is no longer correct now that the engine consumes bigrams at the rerank's bigram tier. The resident-memory cost (~24 MB) is accepted in exchange for the algorithmic value.

#### Scenario: Lazy dictionary initialization loads both unigrams and bigrams
- **WHEN** the user runs `/typos on` for the first time in a session
- **THEN** the engine SHALL load the English frequency dictionary AND the English bigram dictionary, then be ready for lookups, segmentation, and bigram-tier rerank

#### Scenario: Bigrams populated after successful initialize
- **WHEN** `engine.initialize()` resolves and the readiness state is `ready`
- **THEN** the SymSpell instance SHALL have non-empty `bigrams` (the internal bigram map populated by `loadBigramDictionary`); `SymSpell.wordSegmentation()` calls SHALL function correctly

#### Scenario: Initialization timing
- **WHEN** dictionary loading is in progress
- **THEN** the engine SHALL indicate it is not yet ready, and all correction requests SHALL return no correction until loading completes

#### Scenario: No cost when unused
- **WHEN** the user never runs `/typos on` in a session
- **THEN** the engine SHALL NOT load dictionaries or consume memory for them

#### Scenario: Cache hydration does not skip bigram loading
- **WHEN** the engine loads from a successful binary index cache hit
- **THEN** the bigrams SHALL be available in the SymSpell instance after hydration — included as a serialized section in the cache file itself (per the `index-cache` spec); the rerank module's bigram tier SHALL function correctly post-hydration; `SymSpell.wordSegmentation()` SHALL also function correctly post-hydration (it depends only on unigrams, which are always restored)

#### Scenario: Engine SHALL NOT call SymSpell.lookupCompound
- **WHEN** any production code path inside `CorrectionEngine` runs
- **THEN** it SHALL NOT invoke `SymSpell.lookupCompound()`; corrections are produced via `lookup()` + rerank or `wordSegmentation()`; `lookupCompound()` is reserved as a future-option that may be enabled by a separate change with its own scenarios
