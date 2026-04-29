## 1. Engine guard implementation

- [x] 1.1 In `src/correction-engine.ts`, add a private helper `private isInAnyDictionary(lower: string): boolean` that returns true when `lower` is in `learnedDict` (via the live `isLearned` accessor) OR `techDict` OR the SymSpell unigram words map (`(this.symspell as any).words.has(lower)`). Order: learned → tech → unigram (short-circuit on first hit).
- [x] 1.2 In `shouldCorrect()`, after the eligibility regex check and the `readinessState !== "ready"` early return, compute `lower = token.toLowerCase()` and add the guard: `if (token === lower && this.isInAnyDictionary(lower)) { emit correction.skipped reason="in_dictionary"; return { corrected: false }; }`. Place this block before the `effectiveED` computation and the `SymSpell.lookup` call.
- [x] 1.3 Confirm the existing post-rerank `isLearned || techDict` filter (`correction-engine.ts:374`) becomes dead code for all-lowercase inputs but remains correct for mixed-case inputs that pass through to lookup-rerank. Leave it in place - removing it is out of scope for this change.

## 2. Tests

- [x] 2.1 Add a new `describe` block `correction-engine - early in-dictionary guard` to `src/correction-engine.test.ts`.
- [x] 2.2 Test: `shouldCorrect("they")` returns `{ corrected: false }` AND `symspell.lookup` is NOT called. Use a spy/mock or verify via the absence of a `lookup.latency` telemetry event for the call.
- [x] 2.3 Test: `shouldCorrect("makes")` returns `{ corrected: false }`.
- [x] 2.4 Test: `shouldCorrect("their")`, `shouldCorrect("does")`, `shouldCorrect("where")`, `shouldCorrect("there")` - parameterized regression suite covering high-frequency function words with high-frequency neighbors.
- [x] 2.5 Test: a learned word (added via `learnedDict.add("myproject")`) returns `{ corrected: false }` from `shouldCorrect("myproject")` without invoking lookup.
- [x] 2.6 Test: a tech word (`shouldCorrect("kubernetes")`) returns `{ corrected: false }` without invoking lookup.
- [x] 2.7 Test: `shouldCorrect("teh")` (out-of-dict typo) STILL corrects to `the` - guard does not fire, lookup runs, rerank picks `the`.
- [x] 2.8 Test: `shouldCorrect("tHe")` (mixed-case identity) STILL produces a correction to `the` - guard does not fire (input is mixed-case), lookup runs, rerank's mixed-case rule returns `the`, engine emits case-normalized suggestion.
- [x] 2.9 Test: `shouldCorrect("Teh")` STILL produces a correction to `The` - guard does not fire, case-preservation pipeline intact.
- [x] 2.10 Test: `correction.skipped` event with `reason: "in_dictionary"` is emitted when the guard fires; verify via the existing telemetry test harness (`integration-telemetry.test.ts` patterns).
- [x] 2.11 Test: segmentation does NOT run for an in-dictionary token - `shouldCorrect("freelance")` (8-char single word in unigram dict) returns `{ corrected: false }` without segmentation being attempted. Verify by stubbing `tryWordSegmentation` and asserting it's not called.

## 3. Spec verification

- [x] 3.1 Run `openspec validate guard-in-dictionary-tokens --strict` and confirm clean.
- [x] 3.2 Re-read the modified scenarios in `openspec/changes/guard-in-dictionary-tokens/specs/autocorrect-engine/spec.md` and `specs/ngram-rerank/spec.md` and confirm each new/modified scenario maps to a test in section 2 above.

## 4. Documentation

- [x] 4.1 Update `README.md` "How it works → Three-layer dictionary lookup" bullet to describe the early-return guard explicitly: "If the token is already in any of the three dictionaries (learned, tech, English), the engine returns `{ corrected: false }` immediately without invoking SymSpell lookup. This guarantees a typed-and-known word is never silently rewritten, even when a higher-frequency neighbor (e.g., `they` vs `the`) would otherwise outscore it in the rerank."
- [x] 4.2 Update `README.md` "Known limitations" - remove or amend any wording that implied valid in-dictionary words could be rewritten if a neighbor outscored them. (Spot-check: I don't believe such a note currently exists, but verify.)
- [x] 4.3 Add an entry to `CHANGELOG.md` under a new `## [Unreleased]` section: "Fixed: in-dictionary words (e.g., `they`, `makes`, `their`) are no longer rewritten to higher-frequency neighbors. Previously the post-rerank identity-suppression rule fired only when the rerank chose the identity term as the winner; if the rerank picked a neighbor with a higher unigram score (gap > `rerankEditDistancePenalty`), the rewrite leaked through. The engine now short-circuits before lookup whenever the lowercased input is in any of the three dictionaries."

## 5. Manual validation

- [x] 5.1 `npm run build && npm test` — full test suite green (22 files, 457 tests passing).
- [x] 5.2 Live-Pi pass: covered automatically by scenario T35 (`tests/scenarios/scripts/run-scenario-t35.sh`) which validates `they`, `makes`, `their`, `does` are NOT rewritten in a real Pi TUI session. Stronger than the manual checklist — 6/6 sub-cases pass.
- [x] 5.3 Live-Pi: covered by T35f (`tHe → the` mixed-case normalization) in real Pi TUI session.
- [x] 5.4 Live-Pi: covered by T35e (`teh → the` regression-safety control) in real Pi TUI session.
- [ ] 5.5 Live-Pi: with `telemetry: metrics`, confirm the daily NDJSON file shows `correction.skipped` events with `reason: "in_dictionary"` after a session of normal typing. (Deferred — unit-tested in `correction-engine.test.ts` via the `correction.skipped` reason check; live NDJSON inspection is a nice-to-have but not load-bearing.)

## 6. Optional follow-up (NOT in this change)

- [ ] 6.1 Consider raising the default `rerankEditDistancePenalty` from `1.0` to a slightly higher value (e.g., `1.5`) in a separate change. This is independently useful for cases where a token is *not* in the dictionary (so the guard can't help) but the user still wants stronger bias toward lower-ED candidates. Out of scope here.
- [ ] 6.2 Consider feeding tech-dictionary words into the SymSpell unigram index (the v2 candidate already noted in the README) so segmentation also benefits. Out of scope here.
