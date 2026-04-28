## MODIFIED Requirements

### Requirement: SymSpell correction with configurable edit distance and frequency ranking
The engine SHALL use the SymSpell algorithm (Damerau-Levenshtein distance, where transpositions count as 1 edit) with `Verbosity.Top` mode to find the single best correction for unknown words, ranked by word frequency. The maximum edit distance SHALL be configurable per the `maxEditDistance` extension config (integer in `[1, 4]`, default `2`) and SHALL be baked into the SymSpell index at engine construction time. At lookup time, the engine SHALL compute a per-word effective edit distance from the adaptive curve (see "Adaptive per-word-length edit distance" requirement below) and pass that value — not the index ceiling — to `SymSpell.lookup`. The per-call distance is permitted to be smaller than the index ceiling; SymSpell tolerates this and returns only candidates within the per-call distance.

#### Scenario: Common mobile typo with single transposition
- **WHEN** the user types "teh" (1 transposition from "the")
- **THEN** the engine SHALL suggest "the" as the correction

#### Scenario: Typo with multiple possible corrections
- **WHEN** the user types a word that has multiple corrections within the configured edit distance
- **THEN** the engine SHALL return the correction with the highest frequency count

#### Scenario: Word beyond the per-word effective edit distance
- **WHEN** the user types a word whose effective edit distance (from the adaptive curve) yields no match within that distance
- **THEN** the engine SHALL return no correction (it SHALL NOT widen the per-call lookup beyond the curve's value, even though the index ceiling may be larger)

#### Scenario: maxEditDistance change requires engine rebuild
- **WHEN** the user changes `maxEditDistance` via `/typos config maxEditDistance <n>`
- **THEN** the cached engine SHALL be discarded and the next engine instance SHALL be constructed with the new value (see toggle-command spec for the user-facing flow); the running engine SHALL continue using its construction-time value until replaced

#### Scenario: maxEditDistance value of 4 is permitted
- **WHEN** the user sets `maxEditDistance` to `4`
- **THEN** the engine SHALL accept the value, build the SymSpell index at that ceiling, and successfully serve lookups; the engine SHALL NOT impose a soft cap below 4 even though false-positive rates are documented to climb sharply at that distance

#### Scenario: Identity correction suppressed
- **WHEN** SymSpell returns the same word as the input (e.g., "the" → "the" at distance 0)
- **THEN** the engine SHALL return `{ corrected: false }`, NOT fire a correction event

### Requirement: Bundled English frequency dictionary
The engine SHALL load the symspell-ts bundled English frequency dictionary (~82K words with frequency counts). Loading SHALL happen lazily on first `/typos on` (or, when `defaultMode === "on"`, on extension load via pre-warm — see toggle-command spec), not on every session start. When loading from the bundled dictionary the engine SHALL load only the unigram (word/frequency) data; the bigram dictionary SHALL NOT be loaded because the engine only calls `lookup()`, which does not consult bigrams, and skipping the bigram pass measurably reduces both build time and resident memory. The bundled unigram file path SHALL be derived from the symspell-ts package root using the same package-root resolution rule as the index-cache spec (resolve `"symspell-ts"`, walk up to `package.json` matching `name === "symspell-ts"`, then `<pkgRoot>/data/frequency_dictionary_en_82_765.txt`).

#### Scenario: Lazy dictionary initialization
- **WHEN** the user runs `/typos on` for the first time in a session
- **THEN** the engine SHALL load the English frequency dictionary (unigrams only) and be ready for lookups

#### Scenario: Initialization timing
- **WHEN** dictionary loading is in progress
- **THEN** the engine SHALL indicate it is not yet ready, and all correction requests SHALL return no correction until loading completes

#### Scenario: No cost when unused
- **WHEN** the user never runs `/typos on` in a session
- **THEN** the engine SHALL NOT load dictionaries or consume memory for them

#### Scenario: Bigrams are not loaded via the unigram-only path (default)
- **WHEN** the engine initializes via the unigram-only loader (the default path; resolver succeeded) or via cache hydration
- **THEN** no bigram entries SHALL be present in the SymSpell instance, and the engine SHALL NOT call `loadBigramDictionary` or any equivalent path

#### Scenario: Bigrams MAY be present after the resolver-failure fallback
- **WHEN** `resolveSymspellPackageRoot()` returns `null` and the engine falls back to upstream `loadDefaultDictionaries(symspell)`
- **THEN** the engine SHALL still reach `ready` and serve correct lookups; bigrams MAY be present in the SymSpell instance as a side effect of the fallback. This is a documented degradation of the optimization (the cache subsystem is also disabled in this branch via `computeCacheKey() === null`); correctness is preserved.

## ADDED Requirements

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
