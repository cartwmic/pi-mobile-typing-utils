# Specification

## Purpose

The correction engine maps eligible mistyped tokens to corrected forms using a layered dictionary lookup (learned, tech, English) and SymSpell distance-1 search. It is the pure function at the core of the mobile-autocorrect extension: given a word, return either no correction or a casing-preserved suggestion. It owns dictionary loading, identity-correction suppression, and case-preservation rules; it does NOT decide which tokens are eligible (the editor does) or persist anything (the learned dictionary does).

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

### Requirement: SymSpell correction with edit distance 1 and frequency ranking
The engine SHALL use the SymSpell algorithm (Damerau-Levenshtein distance, where transpositions count as 1 edit) with a maximum edit distance of 1 and Verbosity.Top mode to find the single best correction for unknown words, ranked by word frequency.

#### Scenario: Common mobile typo with single transposition
- **WHEN** the user types "teh" (1 transposition from "the")
- **THEN** the engine SHALL suggest "the" as the correction

#### Scenario: Typo with multiple possible corrections
- **WHEN** the user types a word that has multiple corrections at edit distance 1
- **THEN** the engine SHALL return the correction with the highest frequency count

#### Scenario: Word requiring edit distance 2 or more
- **WHEN** the user types a word that has no match within edit distance 1
- **THEN** the engine SHALL return no correction (not attempt distance 2)

#### Scenario: Identity correction suppressed
- **WHEN** SymSpell returns the same word as the input (e.g., "the" → "the" at distance 0)
- **THEN** the engine SHALL return `{ corrected: false }`, NOT fire a correction event

### Requirement: Verify Damerau-Levenshtein before building on distance-1 assumption
Before the engine is built, the implementation SHALL verify that symspell-ts uses Damerau-Levenshtein (transpositions = 1 edit), not plain Levenshtein (transpositions = 2 edits). If plain Levenshtein, the max edit distance or the library choice SHALL be revisited.

#### Scenario: Verification test
- **WHEN** the engine is initialized with the English dictionary
- **THEN** `lookup("teh", Verbosity.Top, 1)` SHALL return "the" with distance 1, confirming transpositions are counted as a single edit

### Requirement: Short words are not corrected
The engine SHALL NOT attempt to correct words shorter than 2 characters, regardless of whether they match any dictionary.

#### Scenario: One-character input
- **WHEN** the user types any word with fewer than 2 characters (i.e., a single character)
- **THEN** the engine SHALL return no correction

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
The engine SHALL load the symspell-ts bundled English frequency dictionary (~82K words with frequency counts). Loading SHALL happen lazily on first `/typos on`, not on every session start.

#### Scenario: Lazy dictionary initialization
- **WHEN** the user runs `/typos on` for the first time in a session
- **THEN** the engine SHALL load the English frequency dictionary and be ready for lookups

#### Scenario: Initialization timing
- **WHEN** dictionary loading is in progress
- **THEN** the engine SHALL indicate it is not yet ready, and all correction requests SHALL return no correction until loading completes

#### Scenario: No cost when unused
- **WHEN** the user never runs `/typos on` in a session
- **THEN** the engine SHALL NOT load dictionaries or consume memory for them

### Requirement: Bundled tech dictionary
The engine SHALL load a pre-compiled tech/developer dictionary (~23K words aggregated from cspell-dicts) as a known-word set (not a correction source). Words in this dictionary SHALL be recognized but never suggested as corrections for other words.

#### Scenario: Tech word recognized
- **WHEN** the user types "kubernetes" which exists in the tech dictionary
- **THEN** the engine SHALL recognize it as valid and not correct it

#### Scenario: Tech dictionary is not a correction source
- **WHEN** the user types "kubernetse" (typo of kubernetes)
- **THEN** the engine SHALL only suggest corrections from the English frequency dictionary, not from the tech dictionary
