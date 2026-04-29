# Specification

## Purpose

The correction engine maps eligible mistyped tokens to corrected forms using a layered dictionary lookup (learned, tech, English) and SymSpell edit-distance search. It is the pure function at the core of the mobile-autocorrect extension: given a word, return either no correction or a casing-preserved suggestion. It owns dictionary loading, identity-correction suppression, and case-preservation rules; it does NOT decide which tokens are eligible by length (the editor and the user-configurable `minWordLength` do) or persist anything (the learned dictionary does). The engine accepts two tuning parameters at construction — `maxEditDistance` (baked into the SymSpell index) and a live `getMinWordLength()` accessor (read on every lookup) — both fed by the persisted extension config.
## Requirements
### Requirement: Layered dictionary lookup prevents correction of known words
The correction engine SHALL check words against three dictionary layers in order: learned dictionary, tech dictionary, English dictionary. If ANY layer contains an exact match for the word (case-insensitive), the engine SHALL NOT suggest a correction. **Case normalization**: the engine SHALL lowercase the candidate word before each layer lookup. The learned dictionary SHALL be queried via a live lookup function (not a snapshot), so that words added or removed mid-session are immediately reflected without engine re-initialization.

#### Scenario: Word exists in learned dictionary
- **WHEN** the user types a word that exists in the learned dictionary
- **THEN** the engine SHALL return no correction for that word

#### Scenario: Newly learned word is immediately recognized
- **WHEN** the user's correction rejection causes "termux" to be auto-learned during a session
- **THEN** subsequent typing of "termux" SHALL NOT be corrected, without requiring engine reload or re-initialization

#### Scenario: Word exists in tech dictionary
- **WHEN** the user types "nginx", "kubectl", "zellij", or any word in the tech dictionary
- **THEN** the engine SHALL return no correction for that word

#### Scenario: Capitalized tech word recognized
- **WHEN** the user types "Nginx", "NGINX", or "nginx"
- **THEN** the engine SHALL recognize all variants as valid (via lowercase normalization) and return no correction

#### Scenario: Word exists in English dictionary
- **WHEN** the user types "authorization", "function", or any word with an exact match in the English dictionary
- **THEN** the engine SHALL return no correction for that word

### Requirement: SymSpell correction with configurable edit distance and frequency ranking
The engine SHALL use the SymSpell algorithm (Damerau-Levenshtein distance, where transpositions count as 1 edit) with `Verbosity.All` mode to enumerate every correction candidate within the configured edit distance. The maximum edit distance SHALL be configurable per the `maxEditDistance` extension config (integer in `[1, 4]`, default `2`) and SHALL be baked into the SymSpell index at engine construction time. At lookup time, the engine SHALL compute a per-word effective edit distance from the adaptive curve (see "Adaptive per-word-length edit distance" requirement below) and pass that value — not the index ceiling — to `SymSpell.lookup`. The per-call distance is permitted to be smaller than the index ceiling; SymSpell tolerates this and returns only candidates within the per-call distance.

Candidate selection from the multi-result list SHALL be performed by the n-gram rerank module (see the `ngram-rerank` capability spec), which takes the candidate list plus a `CorrectionContext` and returns a single best correction. When `enableContextRerank` is `false`, the rerank module bypasses scoring and returns SymSpell's frequency-ordered top-1; this preserves the prior single-candidate-by-frequency contract for users who disable context awareness. The previous use of `Verbosity.Top` is no longer permitted in production code paths.

Lookup is **only** invoked when the early in-dictionary guard does NOT fire (see "Early in-dictionary guard short-circuits before SymSpell lookup"). For all-lowercase tokens that are already in any of the three dictionaries, lookup is skipped entirely; the engine guard is the sole owner of identity protection in that case. The rerank module's identity-correction-suppression rule remains in effect as a defensive backstop for any candidate path that reaches the rerank with an identity match — but for the all-lowercase in-dictionary case, the rerank rule is unreachable because lookup is not called.

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

#### Scenario: Identity correction suppressed at engine guard for all-lowercase in-dictionary input
- **WHEN** the user types an all-lowercase word that is present in the learned, tech, or SymSpell unigram dictionary (e.g., `they`, `make`, `kubernetes`)
- **THEN** the engine's early in-dictionary guard SHALL fire and the engine SHALL return `{ corrected: false }` without invoking lookup; this supersedes the prior "rerank winner-equals-input" check for this case (the rerank could otherwise have picked a higher-scoring neighbor over the identity term)

#### Scenario: Identity correction defensively suppressed at rerank for residual paths
- **WHEN** for any reason a candidate list reaches the rerank where the chosen candidate's term equals the lowercased input AND the input is all-lowercase (this case is no longer reachable for in-dictionary tokens but the rerank rule is retained defensively)
- **THEN** the rerank SHALL return a null winner per the rerank spec; the engine SHALL treat this as `S_lookup = -Infinity` and apply head-to-head with segmentation as today

### Requirement: Verify Damerau-Levenshtein semantics
Before the engine is built, the implementation SHALL verify that symspell-ts uses Damerau-Levenshtein (transpositions = 1 edit), not plain Levenshtein (transpositions = 2 edits). If plain Levenshtein were used, the practical reach of any given `maxEditDistance` would shrink by half on transposition-style typos.

#### Scenario: Verification test
- **WHEN** the engine is initialized with the English dictionary
- **THEN** `lookup("teh", Verbosity.Top, 1)` SHALL return "the" with distance 1, confirming transpositions are counted as a single edit

### Requirement: Short words are not corrected
The engine SHALL NOT attempt to correct words shorter than the configured `minWordLength` (integer in `[2, 8]`, default `2`), regardless of whether they match any dictionary. The threshold SHALL be read live on every `shouldCorrect` call via the `getMinWordLength` accessor passed at construction, so updates from `/typos config minWordLength <n>` take effect on the next lookup without rebuilding the engine. The internal eligibility regex MAY be cached so long as the cache is invalidated when the accessor's return value changes.

#### Scenario: Word shorter than the threshold
- **WHEN** the user types a word shorter than the configured `minWordLength`
- **THEN** the engine SHALL return no correction

#### Scenario: minWordLength change is observed live
- **WHEN** the user changes `minWordLength` via `/typos config minWordLength <n>` while autocorrect is running
- **THEN** the next correction lookup SHALL use the new threshold without the engine being rebuilt

### Requirement: Case preservation on corrections
When the engine returns a correction, it SHALL preserve the case pattern of the original word. Specifically: if the original word starts with an uppercase letter followed by lowercase, the correction SHALL have the same leading-uppercase pattern.

#### Scenario: Leading uppercase preserved
- **WHEN** the user types "Teh" (capital T) and the engine corrects to "the"
- **THEN** the engine SHALL return "The" (preserving the leading capital)

#### Scenario: All-uppercase preserved
- **WHEN** the user types "TEH" and the engine corrects to "the"
- **THEN** the engine SHALL return "THE"

#### Scenario: All-lowercase unchanged
- **WHEN** the user types "teh" and the engine corrects to "the"
- **THEN** the engine SHALL return "the"

#### Scenario: Mixed-case fallback
- **WHEN** the user types "tHe" or "tEh" or any case pattern not matching Title-case, ALL-UPPER, or all-lower
- **THEN** the engine SHALL return the correction in the engine's default case (lowercase from the frequency dictionary)

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

### Requirement: Bundled tech dictionary
The engine SHALL load a pre-compiled tech/developer dictionary (~23K words aggregated from cspell-dicts) as a known-word set (not a correction source). Words in this dictionary SHALL be recognized but never suggested as corrections for other words.

#### Scenario: Tech word recognized
- **WHEN** the user types "kubernetes" which exists in the tech dictionary
- **THEN** the engine SHALL recognize it as valid and not correct it

#### Scenario: Tech dictionary is not a correction source
- **WHEN** the user types "kubernetse" (typo of kubernetes)
- **THEN** the engine SHALL only suggest corrections from the English frequency dictionary, not from the tech dictionary

### Requirement: Adaptive per-word-length edit distance
The engine SHALL compute a per-word effective edit distance using the formula:

```
ED(L) = clamp(minEditDistance + floor((L - minWordLength) / editDistanceStepEvery),
              minEditDistance,
              maxEditDistance)
```

where `L` is the word's character length, `minEditDistance` and `editDistanceStepEvery` are new configurable knobs (see toggle-command spec for `/typos config` exposure), and `maxEditDistance` is the index ceiling. The result SHALL be passed as the per-call `maxEditDistance` argument to `SymSpell.lookup`. The formula SHALL be evaluated on every `shouldCorrect` call, after eligibility (length and regex) checks have passed.

The default values SHALL be `minEditDistance = 1` (range `[0, maxEditDistance]`) and `editDistanceStepEvery = 4` (range `[1, 8]`). With the default `maxEditDistance = 2` and `minWordLength = 2`, the resulting curve maps lengths 2–5 → ED 1, lengths 6+ → ED 2. With `maxEditDistance = 4`, lengths 10+ map to ED 3, lengths 14+ to ED 4.

#### Scenario: Short word uses lower edit distance than long word
- **WHEN** the user has configured `maxEditDistance=3`, `minEditDistance=1`, `editDistanceStepEvery=4`, `minWordLength=2`, and types "te" (length 2)
- **THEN** the engine SHALL pass effective edit distance `1` to `SymSpell.lookup`, not `3`

#### Scenario: Long word uses higher edit distance
- **WHEN** the user has configured `maxEditDistance=3`, `minEditDistance=1`, `editDistanceStepEvery=4`, `minWordLength=2`, and types a length-10 word
- **THEN** the engine SHALL pass effective edit distance `3` to `SymSpell.lookup`

#### Scenario: Effective ED is capped at maxEditDistance
- **WHEN** the formula's intermediate value exceeds `maxEditDistance` for a very long input
- **THEN** the engine SHALL clamp the per-call distance to `maxEditDistance`; it SHALL NEVER pass a per-call distance greater than the index ceiling

#### Scenario: Defensive clamp when live accessors briefly disagree
- **WHEN** the live `getMinEditDistance()` accessor returns a value greater than the live `getMaxEditDistance()` value at the moment of a single `shouldCorrect` call (a transient inconsistency that can occur during a config rebuild between the persist step and the engine reconstruction)
- **THEN** the engine SHALL snapshot both values once at the top of the lookup and compute the effective floor as `Math.min(snapshotMin, snapshotMax)` so the clamped per-call distance never exceeds the index ceiling and never throws; the lookup SHALL still return a valid `CorrectionResult`

#### Scenario: Effective ED is floored at minEditDistance
- **WHEN** the formula's intermediate value is less than `minEditDistance` (e.g., a word at exactly `minWordLength`)
- **THEN** the engine SHALL clamp the per-call distance up to `minEditDistance`

#### Scenario: minEditDistance of 0 with lowercase exact-match input returns no correction
- **WHEN** the user has configured `minEditDistance=0` and types `"the"` (lowercase exact match in the dictionary at distance 0)
- **THEN** the engine SHALL pass `0` to `SymSpell.lookup`, find the exact match, and return `{ corrected: false }` (the existing identity-correction-suppression rule applies)

#### Scenario: minEditDistance of 0 with mixed-case exact-match input returns case-normalized correction
- **WHEN** the user has configured `minEditDistance=0` and types `"tHe"` (mixed case, exact match for `"the"` in the dictionary at distance 0)
- **THEN** the engine SHALL pass `0` to `SymSpell.lookup`, find the exact match, and return a correction normalizing the case to `"the"`; this is consistent with the existing "Mixed-case fallback" scenario which is unchanged by the adaptive curve

#### Scenario: minEditDistance of 0 with non-dictionary input returns no correction
- **WHEN** the user has configured `minEditDistance=0` and types a word that is NOT an exact match in any dictionary layer
- **THEN** the engine SHALL pass `0` to `SymSpell.lookup`, find no exact match (because no candidates exist within distance 0), and return `{ corrected: false }`

#### Scenario: Curve knob change is observed live
- **WHEN** the user changes `minEditDistance` or `editDistanceStepEvery` via `/typos config` while autocorrect is running
- **THEN** the next correction lookup SHALL use the new values without rebuilding the engine (the curve is evaluated per-call from live accessors, analogous to `getMinWordLength`)

### Requirement: Engine may be hydrated from a cached index
The engine SHALL support an alternative initialization path that loads the SymSpell deletion table and word frequencies from a previously serialized binary cache file (see the `index-cache` capability spec) instead of calling the unigram-only loader. A cache-hydrated engine SHALL produce lookup results that are byte-for-byte identical to a freshly built engine for the same `(maxEditDistance, prefixLength, compactLevel, countThreshold, library version)` tuple.

#### Scenario: Cache-hydrated engine matches fresh engine on lookups
- **WHEN** an engine is hydrated from a valid cache file built under the current cache key
- **THEN** for any input word, `engine.shouldCorrect(word)` SHALL return the same `CorrectionResult` it would return from a freshly built engine using the same configuration

#### Scenario: Hydration failure falls back to fresh build
- **WHEN** the cache file is missing, corrupt, or has a non-matching key
- **THEN** the engine SHALL fall back to the fresh-build path (the unigram-only loader described in the "Bundled English frequency dictionary" requirement, with the resolver-failure fallback as a deeper safety net); the user-visible behavior SHALL be a slower-but-successful initialization rather than an error

### Requirement: Engine pins all SymSpell constructor inputs that affect lookup correctness or cache validity
The engine SHALL construct `SymSpell` with all five positional constructor arguments pinned to module-level constants: `initialCapacity` (the upstream default is acceptable; pinning is for code-locality), `maxDictionaryEditDistance` (driven by config), `prefixLength`, `countThreshold`, and `compactLevel`. The implementation SHALL NOT rely on upstream defaults for `prefixLength`, `countThreshold`, or `compactLevel`, because (a) `prefixLength > maxEditDistance` is a correctness invariant that must hold at `maxEditDistance = 4`, and (b) `compactLevel` and `countThreshold` affect the SymSpell internal state that the cache subsystem serializes — silent upstream default changes would corrupt cached lookups without invalidating the cache key. The same five constants SHALL be the inputs to `computeCacheKey()` (with `initialCapacity` excluded since it does not affect built-state).

#### Scenario: prefixLength is explicitly passed and accommodates maxEditDistance up to 4
- **WHEN** the engine constructs `SymSpell` with `maxEditDistance = 4`
- **THEN** the engine SHALL pass an explicit `prefixLength` value that satisfies `prefixLength > maxEditDistance` (i.e., `prefixLength ≥ 5`); the implementation MUST NOT rely on the upstream default value

#### Scenario: compactLevel is locked to a constant
- **WHEN** the engine constructs `SymSpell`
- **THEN** the engine SHALL pass an explicit `compactLevel` value defined as a module-level constant (e.g., `COMPACT_LEVEL`); the constant SHALL be referenced in both the engine constructor and `computeCacheKey()` so a future change to one fails CI alongside the other

#### Scenario: countThreshold is locked to a constant
- **WHEN** the engine constructs `SymSpell`
- **THEN** the engine SHALL pass an explicit `countThreshold` value defined as a module-level constant; the constant SHALL be referenced in both the engine constructor and `computeCacheKey()`

### Requirement: Engine surfaces a readiness state
The engine SHALL expose a readiness state with at least three observable values: `building` (initialization in progress), `ready` (initialization completed successfully), and `degraded` (initialization completed with an error and the engine is unable to serve lookups). The state SHALL be queryable by callers (the toggle-command layer reads it to drive the `/typos` notification surface and the persistent status indicator). Lookups against an engine in the `building` or `degraded` state SHALL return `{ corrected: false }`, preserving the existing graceful-degradation behavior. The engine's `initialize()` method SHALL be idempotent under concurrent in-flight calls: if `initialize()` is called while the engine is in `building` state, the second call SHALL return the existing in-flight promise rather than starting a second initialization.

#### Scenario: State is `building` during init
- **WHEN** the engine has been constructed and `initialize()` has been called but has not yet resolved
- **THEN** the engine's readiness state SHALL be `building` and `shouldCorrect()` SHALL return `{ corrected: false }`

#### Scenario: State becomes `ready` on success
- **WHEN** `initialize()` resolves successfully (whether by fresh build or cache hydration)
- **THEN** the engine's readiness state SHALL be `ready` and `shouldCorrect()` SHALL serve corrections normally

#### Scenario: State becomes `degraded` on init failure
- **WHEN** `initialize()` rejects (e.g., bundled dictionary file unreadable AND cache load also failed)
- **THEN** the engine's readiness state SHALL be `degraded`, `shouldCorrect()` SHALL return `{ corrected: false }`, and callers SHALL be able to observe the failure to surface it to the user

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
The engine SHALL invoke `SymSpell.lookup(token, Verbosity.All, effectiveED)` (instead of `Verbosity.Top`) when looking up corrections, BUT ONLY when the early in-dictionary guard does not fire (see "Early in-dictionary guard short-circuits before SymSpell lookup"). The returned candidate list SHALL be passed through the n-gram rerank module (see `ngram-rerank` capability spec) along with the `CorrectionContext`. The rerank's single best candidate SHALL be the engine's chosen correction, subject to the rerank module's identity-correction-suppression rule (defensive: if the chosen candidate equals the input lowercased AND the input is all-lowercase, the rerank returns a null winner and the engine treats `S_lookup = -Infinity`).

The rerank module (per `ngram-rerank` spec) SHALL truncate the candidate list to exactly 16 entries (`MAX_RERANK_CANDIDATES = 16`, top by SymSpell frequency) before scoring. This is a hard requirement, not optional, and is owned by the rerank module — the engine does not perform truncation separately.

#### Scenario: Verbosity.All replaces Verbosity.Top in production paths
- **WHEN** the engine performs any correction lookup (i.e., the early in-dictionary guard did not fire)
- **THEN** the SymSpell call SHALL use `Verbosity.All`; `Verbosity.Top` SHALL NOT be called from any production code path (test code MAY still reference it for round-trip fidelity validation)

#### Scenario: Identity suppression for all-lowercase in-dictionary tokens is owned by the engine guard
- **WHEN** the user types an all-lowercase token that is present in any of the three dictionaries
- **THEN** the engine's early in-dictionary guard SHALL fire and lookup SHALL NOT be invoked; the rerank module's identity-suppression rule is unreachable for this input class because no candidate list ever reaches the rerank

#### Scenario: Mixed-case exact-match input is normalized to lowercase, NOT identity-suppressed
- **WHEN** the SymSpell lookup returns one candidate `c` where `c.term === token.toLowerCase()` AND the original `token !== token.toLowerCase()` (e.g., user typed `tHe` and the dictionary has `the`)
- **THEN** the early in-dictionary guard does NOT fire (because the input is mixed-case); the rerank module's identity-suppression rule does NOT fire (because the input is mixed-case, not all-lowercase); the rerank returns `c` as winner; the engine returns a correction normalizing the case, preserving the prior change's mixed-case-normalization contract

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

### Requirement: Early in-dictionary guard short-circuits before SymSpell lookup
The engine SHALL evaluate an early in-dictionary guard immediately after the eligibility regex check and before invoking `SymSpell.lookup`. The guard fires when **all** of the following hold:

1. The lowercased token is present in the learned dictionary, OR the tech dictionary, OR the SymSpell unigram words map (i.e., any of the three layers).
2. The original `token === token.toLowerCase()` (input is all-lowercase).

When the guard fires, the engine SHALL return `{ corrected: false }` immediately, without invoking `SymSpell.lookup`, the rerank, or the segmentation path. The engine SHALL emit a `correction.skipped` telemetry event with `reason: "in_dictionary"` for observability.

When the guard does NOT fire (because the input is mixed-case, or because the lowercased token is in none of the three dictionaries), the engine SHALL proceed to lookup-then-rerank as today, preserving the mixed-case normalization contract (`tHe → the`, `Teh → The`, `TEH → THE`).

#### Scenario: All-lowercase token in SymSpell unigram dictionary skips lookup
- **WHEN** the user types `they` (an all-lowercase word present in the bundled SymSpell unigram dictionary)
- **THEN** the engine SHALL return `{ corrected: false }` without invoking `SymSpell.lookup`; the user's input is preserved verbatim regardless of any higher-frequency neighbor like `the` that the rerank might otherwise have picked

#### Scenario: All-lowercase token in tech dictionary skips lookup
- **WHEN** the user types `kubernetes` (present in the tech dictionary)
- **THEN** the engine SHALL return `{ corrected: false }` without invoking `SymSpell.lookup`

#### Scenario: All-lowercase token in learned dictionary skips lookup
- **WHEN** the user has previously taught the engine the word `myproject` via the rejection-learning loop, and types `myproject` again
- **THEN** the engine SHALL return `{ corrected: false }` without invoking `SymSpell.lookup`

#### Scenario: Mixed-case in-dictionary token still flows through lookup-rerank for case normalization
- **WHEN** the user types `tHe` (input not all-lowercase, lowercased form present in the unigram dictionary)
- **THEN** the early guard SHALL NOT fire (the all-lowercase precondition is not met); the engine SHALL proceed to lookup-then-rerank, where the rerank's mixed-case identity rule returns the candidate `the`, and the engine produces the case-normalized suggestion `the`

#### Scenario: Out-of-dictionary all-lowercase token proceeds to lookup
- **WHEN** the user types `teh` (all-lowercase but not present in any of the three dictionaries)
- **THEN** the early guard SHALL NOT fire; the engine SHALL invoke `SymSpell.lookup` and return the rerank's chosen correction (`the`)

#### Scenario: Skipped event emitted with in_dictionary reason
- **WHEN** the early guard fires for any in-dictionary all-lowercase token
- **THEN** the engine SHALL emit `correction.skipped` with `reason: "in_dictionary"` so that telemetry aggregation can distinguish guard activations from `not_eligible` skips and from rerank-null skips

