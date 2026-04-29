## Context

Identity-correction suppression in the v1 design (see `openspec/changes/archive/improve-autocorrect-context-and-segmentation/design.md` Decision 5) was placed *inside* the rerank module so that the engine and the rerank stayed decoupled and only one component owned the rule. The rule fires when `winner.term === token.toLowerCase()` AND `token === token.toLowerCase()` — i.e., the rerank has *picked* the identity candidate.

That contract is sound when the rerank ranking is dominated by edit distance: the identity candidate is at ED=0 and any neighbor is at ED≥1, so even a modest `rerankEditDistancePenalty` keeps the identity at the top. But the rerank's `total = log10(P) + α₁·bigram + α₂·trigram − δ·ed` is a weighted sum, and for high-frequency function words like `the`, the unigram frequency gap to a slightly-less-common neighbor (like `they`) can outpace `δ·1`. Empirically:

| token  | identity unigram log10(P) | top neighbor log10(P) | gap | δ=1.0 net for neighbor |
|--------|--------------------------:|----------------------:|----:|-----------------------:|
| they   | -3.05                     | -1.64 (the)           | 1.42 | +0.42 → neighbor wins |
| makes  | -4.07                     | -3.40 (make)          | 0.66 | -0.34 → tied; bigram tips |
| their  | -3.42                     | -1.64 (the)           | 1.78 | +0.78 → neighbor wins |
| does   | -3.95                     | -3.27 (doe ~ rare; no — doesn't apply) | n/a | safe |

Once the rerank picks `the` for input `they`, the post-hoc identity check sees `winner.term === "the" !== "they"` and lets the rewrite through. The bug is structural, not a parameter-tuning issue.

The cleanest fix is to make the engine treat its three dictionaries as authoritative: if the user typed a word that the engine knows, don't run lookup. This matches the README's documented behavior and matches what users intuitively expect from "autocorrect."

## Goals / Non-Goals

**Goals:**
- Prevent any all-lowercase token that exists in {learned dict, tech dict, SymSpell unigram words map} from being rewritten by the lookup-rerank path.
- Preserve the mixed-case normalization contract (`tHe → the`, `TEH → THE`, `Teh → The`) — these inputs are NOT in the dictionary as-typed, so the guard does not fire and case-normalization keeps working.
- Preserve the segmentation path's existing behavior: the early guard short-circuits the entire `shouldCorrect()` call, including segmentation, since a token already in the unigram dictionary is by definition a single valid word and should not be split.
- Emit telemetry so we can measure how often the new guard fires (validates that real users were hitting this).

**Non-Goals:**
- Re-architect the rerank scoring formula or weights. Those are independently tunable and address a different concern (which neighbor to pick *when* a correction is warranted).
- Touch the learned-word reject/accept feedback loop. The guard is upstream of any learning logic.
- Change cache format, config schema, or persisted state. This is a pure runtime guard.

## Decisions

### Decision 1: Place the guard in the engine, not the rerank

**Choice**: Add the guard to `correction-engine.ts:shouldCorrect()` immediately after the eligibility regex check, before `SymSpell.lookup()`.

**Alternatives considered:**
- *Push the rule deeper into the rerank* (e.g., make rerank check the candidate list for an identity entry and force-pick it). Rejected: this still runs the full Verbosity.All lookup — wasted work — and conflates two distinct rules ("identity wins if present" vs. "pick the best non-identity neighbor"). It also leaves the door open for a future change that bypasses rerank to re-introduce the bug.
- *Bump `rerankEditDistancePenalty` default to 2.0 instead*. Rejected as the only fix: it papers over the gap for `they/the` (1.42 < 2.0) but doesn't make the contract honest. A future high-frequency word with a gap > 2.0 would still leak. Bumping the default is a separate, valid tuning improvement that can ship alongside or after this fix; not part of this change.

**Rationale**: The engine is the natural owner of "is this token in any of my dictionaries." The rerank is the natural owner of "given a candidate set, which is best." Conflating them in the rerank module was the original design's economy mistake.

### Decision 2: Guard only fires for all-lowercase input

**Choice**: The guard checks `token === token.toLowerCase()` AND `lower in any-dict`. Mixed-case input flows through to lookup-rerank as today.

**Alternative**: Guard fires for any input whose lowercased form is in a dictionary. Rejected because it would break the existing `tHe → the` / `Teh → The` case-normalization contract, which the rerank module explicitly preserves by *not* identity-suppressing mixed-case identities.

### Decision 3: Check all three dictionaries, not just SymSpell unigrams

**Choice**: The guard checks learned dict → tech dict → SymSpell `words` map (in that order, short-circuit on first hit).

**Rationale**: Symmetric with the existing layered-dictionary semantics documented in the README ("learned words first, bundled tech terms second, bundled SymSpell English last"). Tech words like `kubernetes` are already protected from being rewritten today because they're filtered by the post-rerank `isLearned || techDict` check (`correction-engine.ts:374`), but that check still pays for the lookup. The guard makes the protection earlier and cheaper, and crucially also covers the SymSpell unigram dictionary which is what fixes the `they/makes` reports.

### Decision 4: Skip segmentation too when the guard fires

**Choice**: The guard returns `{ corrected: false }` immediately, bypassing both the lookup-rerank and word-segmentation paths.

**Rationale**: A token that is already a valid single word in the unigram dictionary should not be split into two words. The current code path *already* skips segmentation for learned/tech words via `inAnyDict` (`correction-engine.ts:386`), but skipped lookup separately. This decision unifies "is in dict ⇒ not corrected, period."

### Decision 5: Emit `correction.skipped` with reason `in_dictionary`

**Choice**: Reuse the existing `correction.skipped` event with a new `reason` value.

**Rationale**: The `reason` field is already an open-ended string in the telemetry schema; aggregation in `telemetry-aggregate.ts` groups by reason. New value slots in cleanly with no schema break. Distinguishing `in_dictionary` from `not_eligible` lets us measure how often the guard activates in real usage.

## Risks / Trade-offs

- **[Risk]** A user might *want* `they → the` if they consistently type the wrong word out of habit. → **Mitigation**: that's a per-user learning signal, not an engine-wide default. The current learned-dictionary mechanism is for *protecting* user words from correction, not the inverse; we don't have a mechanism for "always rewrite X to Y" and shouldn't add one for this. Users who want aggressive rewriting can keep `rerankEditDistancePenalty` low and tolerate the false positives.
- **[Risk]** A tech-dict word that *is* a typo of a more-common English word (e.g., a hypothetical tech term `te`) would no longer be auto-corrected. → **Mitigation**: token eligibility already requires length ≥ minWordLength (default 2), and the tech dict is curated. We're not aware of any current tech-dict entry that's a typo of a more-common word; if one surfaces it can be removed from the tech dict.
- **[Risk]** The README's "identity-suppression rule" wording becomes mildly inaccurate (the suppression is no longer the rerank's responsibility for the common case). → **Mitigation**: README text updated as part of this change.
- **[Trade-off]** The rerank module's "sole owner of identity suppression" claim is weakened. The rerank rule is retained as defensive (what if a future caller bypasses the engine guard and calls rerank directly?), but in the engine's lowercase-input flow it becomes unreachable code. We accept this redundancy because the rerank rule is also the load-bearing rule for *mixed-case* identity (where it returns the candidate rather than null), so it can't be deleted outright.

## Migration Plan

1. Land code + tests + spec deltas + README update in one commit.
2. Run `npm test` to confirm the existing 25-scenario validation suite still passes — the guard cannot regress mixed-case normalization, learned/tech protection, or segmentation acceptance gates.
3. Manual live-validation pass per `docs/live-validation-checklist.md`: type `they`, `makes`, `their`, `does`, `where`, `there` and verify none are rewritten. Type `tHe`, `TEH`, `Teh` and verify case-normalization still applies. Type `teh` and verify it still corrects to `the`.
4. No rollback plan needed — guard is additive and behind no flag; if it caused unexpected breakage the commit can be reverted cleanly.
