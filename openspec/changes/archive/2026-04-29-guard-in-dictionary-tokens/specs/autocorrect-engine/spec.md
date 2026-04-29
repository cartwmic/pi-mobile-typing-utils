## ADDED Requirements

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

## MODIFIED Requirements

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
