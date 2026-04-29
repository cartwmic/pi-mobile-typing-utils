## MODIFIED Requirements

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

The rerank module SHALL apply identity-correction suppression as a **defensive backstop**, not as the sole owner. The autocorrect-engine's early in-dictionary guard (see `autocorrect-engine` spec, "Early in-dictionary guard short-circuits before SymSpell lookup") is the primary owner of identity protection for all-lowercase tokens that exist in any of the three engine dictionaries; for those inputs the rerank is never invoked because lookup is skipped. The rerank module retains the identity rule because (a) it remains the sole owner of the **mixed-case identity non-suppression** contract (so `tHe → the` case-normalization works), and (b) it provides defense-in-depth if a future caller bypasses the engine guard. The rule the rerank applies is: when the chosen candidate's term equals `token.toLowerCase()` AND `token === token.toLowerCase()` (input is already lowercase), set winner to `null`. When the chosen candidate's term equals `token.toLowerCase()` AND `token !== token.toLowerCase()` (mixed-case input matches a lowercase dict entry), the rerank does NOT suppress — it returns the candidate so the engine's case-normalizing path can produce a correction.

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

#### Scenario: Identity suppression remains as defensive backstop for callers that bypass the engine guard
- **WHEN** the rerank module is called directly (e.g., from a unit test or future caller) with an all-lowercase token whose candidate list contains an identity entry, AND the rerank's chosen winner equals the lowercased input
- **THEN** the rerank SHALL still return a null winner per the rule above; the engine's early in-dictionary guard is the primary owner for the typical production flow, but the rerank rule remains in force defensively
