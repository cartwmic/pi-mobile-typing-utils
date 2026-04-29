# word-segmentation Specification

## Purpose
TBD - created by archiving change improve-autocorrect-context-and-segmentation. Update Purpose after archive.
## Requirements
### Requirement: Word-segmentation correction path
The correction engine SHALL include a word-segmentation correction path that recovers from accidentally-concatenated words (e.g., `thequick` → `the quick`, `wantto` → `want to`). The path SHALL be invoked by the engine on every `shouldCorrect(token, ctx)` call where ALL of the following conditions are true:

1. The token has passed all eligibility gates (length ≥ `minWordLength`, regex match, learned/tech/English dictionary lookup all returned no match).
2. `enableSegmentation` is `true`.
3. The token's character length is at least `segmentationMinLength`.

The segmentation path runs **head-to-head with the lookup-then-rerank path** (per the `autocorrect-engine` spec's "Lookup and segmentation run head-to-head" requirement); both paths execute when their respective eligibility gates pass, and the engine compares their scores to pick the winner. Segmentation is no longer a fallback that runs only when lookup fails; the engine always evaluates both.

When invoked, the engine SHALL call `SymSpell.wordSegmentation(token, segmentationMaxEditDistance)` and inspect the returned `WordSegmentationResult`. SymSpell's `wordSegmentation()` is a Norvig-style dynamic-programming search over the **unigram dictionary only**; it does not consume the bigram map. Bigrams are loaded by this change for the rerank module's bigram tier (see `autocorrect-engine` and `ngram-rerank` specs); their presence is independent of segmentation correctness.

**Known limitation — tech-prose concatenations:** Because `wordSegmentation()` consumes only the SymSpell unigram dictionary and the extension's tech dictionary is layered ON TOP of SymSpell at the `shouldCorrect` boundary (not fed into the SymSpell index itself), a concatenation containing tech-prose words (e.g., `kubernetespod`, `dockerimage`) cannot be split: SymSpell does not know `kubernetes` or `docker` exist as candidate substrings. This is a documented v1 limitation; tests SHALL assert that such concatenations remain unsegmented (validating the limitation, not asserting a fix). A v2 candidate is to feed tech-dict words into the SymSpell unigram index, but that would change the no-correct semantics for tech-dict words at the `shouldCorrect` boundary and is therefore out of scope for v1.

The segmentation result SHALL be accepted if ALL of the following are true:

- The result's `correctedString` contains at least one space (i.e., the result has at least two segments).
- Every segment, after splitting `correctedString` on whitespace, has length ≥ `minWordLength`.
- Every segment matches the regex `/^[A-Za-z]+$/` (alphabetic only). Segments containing apostrophes, digits, or other non-letter characters from SymSpell's lookup hits SHALL cause the segmentation to be rejected. This gate is independent of `minWordLength` and matches the existing `ELIGIBLE_TOKEN` shape used by the editor's token extractor; a segmentation cannot output a segment that the editor would not accept as input.
- The result's `probabilityLogSum` is greater than or equal to `segmentationLogProbFloor`.
- The result's `correctedString.toLowerCase()` differs from the original token (segmentation that produces the same lowercased string with one space inserted but no character changes is still accepted; segmentation that produces an identical string is rejected as a no-op).

When accepted, the segmentation path produces `S_segmentation = result.probabilityLogSum + segmentationVsLookupBias` (live config float, default `0.0`). This score is compared against the lookup-rerank score `S_lookup` per the `autocorrect-engine` spec's head-to-head rule. When the segmentation path wins the head-to-head comparison, the engine SHALL return:

```
{
  corrected: true,
  kind: "segmentation",
  suggestion: result.correctedString,
  segments: result.correctedString.split(/\s+/),
}
```

When rejected, the engine SHALL return `{ corrected: false }`.

The segmentation path SHALL preserve the original token's leading-letter case via the existing `preserveCase()` helper applied to the **first segment only**: if the original token's first character was uppercase, the first segment of `correctedString` SHALL be capitalized; remaining segments SHALL be returned in the engine's default case (lowercase from the frequency dictionary).

#### Scenario: Concatenated common words split with confident probability
- **WHEN** the user types `thequick ` (token `thequick`, length 8) with `enableSegmentation: true`, `segmentationMinLength: 6`, default thresholds, and the SymSpell unigram + bigram dictionaries are loaded
- **THEN** the engine SHALL invoke `wordSegmentation()`, receive a result whose `correctedString` is `the quick`, and (assuming `probabilityLogSum >= segmentationLogProbFloor`) return `{ corrected: true, kind: "segmentation", suggestion: "the quick", segments: ["the", "quick"] }`

#### Scenario: Concatenation with a typo in one segment (ED=1 per segment)
- **WHEN** the user types `wantto ` with `segmentationMaxEditDistance: 1` (default) and the corpus contains `(want, to)` as a high-frequency bigram
- **THEN** the engine SHALL invoke `wordSegmentation(token, 1)`, accept the result `want to` if its `probabilityLogSum` clears the floor, and return a `kind: "segmentation"` correction

#### Scenario: Token below segmentationMinLength is not segmented
- **WHEN** the user types `imho ` (token `imho`, length 4) with `segmentationMinLength: 6`
- **THEN** the engine SHALL NOT invoke `wordSegmentation()`; the eligibility gate fails and the engine returns `{ corrected: false }` (assuming the token is not in any dictionary)

#### Scenario: Single-segment "split" rejected
- **WHEN** `wordSegmentation()` returns a `correctedString` that contains no whitespace (no actual split occurred — the function returned a single corrected word at distance ≤ `segmentationMaxEditDistance`)
- **THEN** the engine SHALL reject the segmentation (the lookup path is what handles single-word corrections; segmentation must produce ≥ 2 segments) and return `{ corrected: false }`

#### Scenario: Segmentation with a too-short segment is rejected
- **WHEN** `wordSegmentation()` returns `correctedString` `"a quick"` for input `"aquick"` and the configured `minWordLength` is `2`
- **THEN** the segmentation path SHALL set `S_segmentation = -Infinity` (segment `"a"` has length 1 < `minWordLength`); the engine's final result is determined by the head-to-head comparison — if the lookup path produces no winner either, the engine returns `{ corrected: false }`

#### Scenario: Segmentation with a non-alphabetic segment is rejected
- **WHEN** `wordSegmentation()` returns a `correctedString` whose space-split segments include any token containing a digit, apostrophe, hyphen, or other non-letter character (e.g., a segment `"don't"` or `"v1"`)
- **THEN** the segmentation path SHALL set `S_segmentation = -Infinity` (the alphabetic-only gate fails); the engine's final result is determined by the head-to-head comparison; this prevents segmentation from emitting tokens the editor's existing eligibility rules would reject

#### Scenario: Segmentation below logProbFloor is rejected
- **WHEN** `wordSegmentation()` returns a result with `probabilityLogSum: -25.0` and the configured `segmentationLogProbFloor` is `-12.0`
- **THEN** the segmentation path SHALL set `S_segmentation = -Infinity`; the engine's final result is determined by the head-to-head comparison

#### Scenario: enableSegmentation false skips the path entirely
- **WHEN** `enableSegmentation` is `false`
- **THEN** the engine SHALL NOT invoke `wordSegmentation()` for any token; the lookup path is the only correction source

#### Scenario: Segmentation runs head-to-head with lookup; lookup wins on score
- **WHEN** the token is not in any dictionary, the SymSpell `Verbosity.All` lookup returned a candidate the rerank picked with score `S_lookup`, AND the segmentation path produced an accepted result with `S_segmentation < S_lookup`
- **THEN** the engine SHALL return the lookup result (`kind: "lookup"`); both `wordSegmentation()` and the lookup-rerank path were invoked; the segmentation candidate is recorded in `debug`-mode telemetry under `scoresVsAlt.segmentationScore` but not surfaced to the user. (See the `autocorrect-engine` capability spec's "Lookup and segmentation run head-to-head" requirement for the full comparison rule.)

#### Scenario: First-segment case preservation matches the original token
- **WHEN** the user types `Thequick ` (token `Thequick`, leading uppercase) and segmentation accepts `the quick`
- **THEN** the engine SHALL return `suggestion: "The quick"` (first segment capitalized, remaining segments lowercase)

#### Scenario: All-uppercase input case-preserved on first segment only
- **WHEN** the user types `THEQUICK ` and segmentation accepts `the quick`
- **THEN** the engine SHALL return `suggestion: "THE quick"` (only the first segment receives the all-uppercase pattern; remaining segments stay in default case to avoid corrupting them)

#### Scenario: Tech-prose concatenation does not segment under default config
- **WHEN** the user types `kubernetespod ` (a concatenation of two tech-dict words, neither in the SymSpell unigram dictionary)
- **THEN** `wordSegmentation()` SHALL NOT find a high-probability split (`S_segmentation` falls below the floor or produces a single-segment result, setting `S_segmentation = -Infinity`); assuming the lookup path also produces no winner, the engine SHALL return `{ corrected: false }`; the input remains in the editor unchanged; this validates the documented v1 limitation that tech-prose concatenations are not split

### Requirement: Editor handles segmentation results identically to lookup corrections
The `AutocorrectEditor.maybeApplyCorrection` method SHALL handle `CorrectionResult` of `kind: "segmentation"` using the same eat-and-reinsert mechanism as `kind: "lookup"`. The eat length SHALL be `result.suggestion.length + trigger.length` (where `result.suggestion` includes any internal spaces), and the reinsert SHALL be `result.suggestion + trigger`. The `lastCorrection` state field SHALL store the original concatenated token (the user's input) and the full segmented suggestion so backspace-undo can restore the original.

#### Scenario: Backspace undoes a segmentation back to the concatenated original
- **WHEN** the user types `thequick `, the engine corrects it to `the quick `, and the user immediately presses Backspace
- **THEN** the editor SHALL eat all characters of `the quick ` (length 10) and reinsert `thequick`; the trigger character (` `) SHALL NOT be reinserted (matching existing behavior); the `recordRejection("thequick")` learning path SHALL fire

#### Scenario: Two rejections of a segmentation add the original to learned dict
- **WHEN** the user types `thequick `, presses Backspace to undo, then types `thequick ` again, presses Backspace to undo again
- **THEN** the second rejection SHALL add `thequick` to the learned dictionary; subsequent typing of `thequick ` SHALL leave the token unsegmented (the learned dict layer in the engine prevents both lookup and segmentation paths)

#### Scenario: Status indicator distinguishes split corrections
- **WHEN** the engine returns `{ corrected: true, kind: "segmentation", suggestion: "the quick", ... }`
- **THEN** the editor's status flash SHALL include the text `(split)` after the correction (e.g., `Corrected: thequick → the quick (split)`); when `kind` is `"lookup"`, the `(split)` suffix SHALL NOT appear

### Requirement: Segmentation respects the layered dictionary lookup
A token that exists in any dictionary layer (learned, tech, English) SHALL NOT be subjected to segmentation. The engine SHALL apply the existing layered dictionary check before considering segmentation, identical to the lookup path.

#### Scenario: Tech-dictionary word is not segmented
- **WHEN** the user types `kubernetes ` (a token that exists in the tech dictionary)
- **THEN** the engine SHALL return `{ corrected: false }` without invoking `wordSegmentation()`, even if `wordSegmentation()` would have produced a high-probability split

#### Scenario: Learned word is not segmented
- **WHEN** the user has previously added `thequick` to the learned dictionary (e.g., via two backspace rejections) and types `thequick ` again
- **THEN** the engine SHALL return `{ corrected: false }` without invoking `wordSegmentation()`

