## Why

Common, valid English words are being "corrected" to higher-frequency neighbors when typed in a Pi terminal session — observed cases: `they → the`, `makes → make`. The current contract (defined jointly by `autocorrect-engine` §6.7.4 and `ngram-rerank` §3.2) defines identity-correction suppression as a post-rerank check applied to the **winner** the rerank picks. When the rerank chooses a non-identity candidate over the identity candidate (because the neighbor's `unigram + α₁·bigram + α₂·trigram − δ·ed` score is higher), the suppression rule never fires and a perfectly valid in-dictionary word is replaced.

This is a behavioral regression vs. what the README documents and what users reasonably expect: a word that exists in the bundled SymSpell unigram dictionary, the tech dictionary, or the user's learned dictionary should never be silently rewritten. It also re-introduces a class of false positive (`their → the`, `makes → make`, `does → doe`) that is highly visible in prose-heavy mobile use.

## What Changes

- **BREAKING (spec)**: `autocorrect-engine` SHALL short-circuit `shouldCorrect()` and return `{ corrected: false }` when the lowercased token is present in any of the three dictionaries (learned, tech, SymSpell unigram words map) AND the input is already all-lowercase. This guard runs **before** `SymSpell.lookup()`, not after rerank.
- **BREAKING (spec)**: `ngram-rerank`'s identity-suppression rule is narrowed in scope: it remains the sole owner of the **mixed-case identity** non-suppression contract (so `tHe → the` still normalizes case), but it is no longer the sole owner of suppression for all-lowercase identity inputs — the engine guard fires first for that case. The rerank rule continues to fire defensively if reached (e.g., for tokens not in the engine's dictionaries but matched at distance 0 in a future hypothetical), but in practice the engine guard makes it dead code for all-lowercase inputs.
- **CODE**: Add the in-dictionary guard to `correction-engine.ts:shouldCorrect()` immediately after the eligibility gate.
- **CODE**: Add tests covering the new guard for each of the three dictionaries (`they`, `kubernetes`-like tech word, learned word) plus mixed-case regression coverage.
- **DOC**: Update README §"How it works → Three-layer dictionary lookup" to describe the early-return guard instead of relying on identity-suppression to remove exact matches post-rerank.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `autocorrect-engine`: adds an early-return contract for in-dictionary tokens; updates §6.7.4 and §6 (Verbosity.All / rerank coupling) to reflect that all-lowercase identity is owned by the engine guard.
- `ngram-rerank`: relaxes the "sole owner" claim for all-lowercase identity suppression; retains sole ownership of the mixed-case non-suppression rule.

## Impact

- **Affected code**: `src/correction-engine.ts` (new guard, new tests), `src/correction-engine.test.ts`, possibly `src/ngram-rerank.test.ts` (no behavior change but doc comments may shift).
- **Affected specs**: `openspec/specs/autocorrect-engine/spec.md`, `openspec/specs/ngram-rerank/spec.md`.
- **Affected docs**: `README.md` "How it works" section.
- **Telemetry**: a new `correction.skipped` reason code (`in_dictionary`) is emitted when the guard fires; existing `not_eligible` and rerank-null paths are unchanged. Aggregation in `telemetry-aggregate.ts` will surface this as a new bucket; no schema break since `reason` is already an open string field.
- **Performance**: net positive — the guard avoids a `SymSpell.lookup(Verbosity.All)` call on every in-dictionary token, which is the common case for prose. Three Map lookups (`O(1)` each) replace one SymSpell tree walk.
- **No data migrations.** No config changes. No cache invalidation needed.
