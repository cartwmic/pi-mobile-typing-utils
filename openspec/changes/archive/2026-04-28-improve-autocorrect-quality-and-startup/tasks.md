## 1. Config layer (foundations the rest depends on)

- [x] 1.1 Add `minEditDistance` and `editDistanceStepEvery` to `Config`'s persisted shape with documented bootstrap defaults (`1` and `4`)
- [x] 1.2 Export range constants `MIN_EDIT_DISTANCE_RANGE` and `EDIT_DISTANCE_STEP_EVERY_RANGE` from `src/config.ts` (the latter is `[1, 8]`; `MIN_EDIT_DISTANCE_RANGE` upper bound is dynamic — the validator must read current `maxEditDistance`)
- [x] 1.3 Widen `MAX_EDIT_DISTANCE_RANGE` from `[1, 3]` to `[1, 4]`
- [x] 1.4 Add live accessors `getMinEditDistance()` and `getEditDistanceStepEvery()` on `Config` (read on every lookup, no rebuild)
- [x] 1.5 Update config load path: fall back to defaults for missing or out-of-range values for the new keys; if the persisted file has `minEditDistance > maxEditDistance`, **preserve the persisted `maxEditDistance`** (it is itself a valid value the user may have set deliberately) and replace `minEditDistance` with `min(bootstrap_default_minEditDistance, persisted_maxEditDistance)` so the runtime invariant `minEditDistance ≤ maxEditDistance` always holds (per the toggle-command spec scenario "Persisted minEditDistance > persisted maxEditDistance preserves user's maxEditDistance")
- [x] 1.6 Unit tests:
  - 1.6.1 Defaults applied when keys absent
  - 1.6.2 Out-of-range values reject and fall back
  - 1.6.3 `minEditDistance` write validation rejects values greater than current `maxEditDistance`
  - 1.6.4 Persisted `minEditDistance > maxEditDistance` preserves the user's `maxEditDistance` and only repairs `minEditDistance` to `min(default, persisted_max)`
  - 1.6.5 Existing config files (without the new keys) load unchanged

## 2. Adaptive edit-distance curve in correction engine

- [x] 2.1 Extend `CorrectionEngineOptions` with `getMinEditDistance: () => number` and `getEditDistanceStepEvery: () => number` (both with `FALLBACK_*` constants for omitted accessors, mirroring `getMinWordLength`)
- [x] 2.2 Implement `effectiveEditDistance(wordLength: number): number` private method using `clamp(minED + floor((L − minWordLength) / step), minED, maxED)`; clamp handles the L < minWordLength edge case (already gated by eligibility regex but defensive)
- [x] 2.3 Replace the hardcoded `this.maxEditDistance` argument to `this.symspell.lookup(...)` with `this.effectiveEditDistance(word.length)`
- [x] 2.4 Handle `minEditDistance === 0` correctly: a per-call distance of 0 means SymSpell returns only exact-match candidates; combined with the existing identity-correction-suppression rule, this yields no correction
- [x] 2.5 Unit tests:
  - 2.5.1 Default curve (minED=1, step=4, minWL=2, maxED=2) maps lengths to expected ED per the table in design.md
  - 2.5.2 Long-word ED is capped at `maxEditDistance`
  - 2.5.3 Short-word ED is floored at `minEditDistance`
  - 2.5.4 minED=0 + lowercase exact-match input → no correction (identity-correction-suppression). minED=0 + mixed-case exact-match input → case-normalized correction (existing mixed-case-fallback behavior preserved at distance 0). minED=0 + non-dictionary input → no correction. (Three sub-tests; matches the three split scenarios in autocorrect-engine spec.)
  - 2.5.5 Live curve change is observed without rebuild (mutate the accessor's return value, verify next lookup uses the new curve)
  - 2.5.6 Defensive clamp: an accessor returning `getMinEditDistance() > getMaxEditDistance()` (transient inconsistency simulation) does NOT cause `lookup()` to throw or pass a per-call distance greater than the index ceiling — the snapshotted floor is `min(snapshotMin, snapshotMax)`
  - 2.5.7 Existing scenarios continue to pass (teh→the, identity-suppression, case preservation, layered dict, etc.)

## 3. Drop bigram loading

- [x] 3.1 Add a `resolveSymspellPackageRoot(): string | null` helper (in `src/index-cache.ts` or a new `src/symspell-paths.ts`) that:
  - 3.1.1 Calls `createRequire(import.meta.url).resolve("symspell-ts")` (the bare entrypoint — NOT `"symspell-ts/package.json"`, which fails under the upstream `exports` map with `ERR_PACKAGE_PATH_NOT_EXPORTED`)
  - 3.1.2 Walks up directories from the resolved path until it finds a `package.json` whose parsed `name === "symspell-ts"`; returns that directory
  - 3.1.3 Returns `null` (caller treats as "caching disabled, use upstream `loadDefaultDictionaries`") if any step throws or the upward walk exhausts
- [x] 3.2 Build a custom unigram-only loader: `loadUnigramOnly(symspell)` that reads `<pkgRoot>/data/frequency_dictionary_en_82_765.txt` (path derived from helper 3.1) and calls `symspell.loadDictionary(text, 0, 1)`. If `resolveSymspellPackageRoot()` returns `null`, fall back to upstream `loadDefaultDictionaries(symspell)` (which loads bigrams as a side effect; suboptimal but correct) and log info.
- [x] 3.3 Add a unit test asserting `resolveSymspellPackageRoot()` returns a directory containing `data/frequency_dictionary_en_82_765.txt` against the actually-installed package layout (catches packaging-layout regressions early)
- [x] 3.4 Add an assertion in tests that `engine.symspell.bigrams.size === 0` after initialization via the unigram-only path
- [x] 3.5 Add a parity test: build one engine via upstream `loadDefaultDictionaries` and another via `loadUnigramOnly`; assert `lookup()` returns identical results across the cache-fidelity corpus (confirms bigram absence does not affect `lookup()` behavior)
- [x] 3.6 Measure and document the build-time / memory delta in a code comment

## 4. Engine readiness state (must land before Section 5)

- [x] 4.1 Replace the boolean `ready` field on `CorrectionEngine` with a `readinessState: 'building' | 'ready' | 'degraded'` field; expose a public getter and an optional getter for the stored error (used by the toggle layer's degraded notification)
- [x] 4.2 Set `readinessState = 'building'` in the constructor; set to `'ready'` on successful `initialize()` resolve; set to `'degraded'` on rejection (and store the error for later inspection)
- [x] 4.3 Update `shouldCorrect()` guard from `!this.ready` to `this.readinessState !== 'ready'` (preserves graceful degradation)
- [x] 4.4 Unit tests for each state transition

## 5. Lazy/non-blocking engine initialization (depends on Section 4)

- [x] 5.1 Add to the toggle command state struct: `state.initInFlight: Promise<void> | undefined` (the currently-tracked init), `state.generation: number` (monotonically increasing; bumped by `disable()` and by config-change rebuilds), and an internal helper to capture-and-check generation on every `.then`/`.catch` callback per the design's "Orphan-promise generation guard" decision.
- [x] 5.2 Refactor `enable()` to dispatch on the current `state.engine`'s readiness (the pre-warmed engine, if any, was seeded into `state.engine` and `state.initInFlight` by Section 7's handle handoff — there is no separate "pre-warmed handle" branch in `enable()`):
  - 5.2.1 Dispatch on `state.engine`:
    - **`undefined`** → construct a fresh `CorrectionEngine`, capture `currentGen = state.generation`, call `engine.initialize()` (returns the in-flight promise), store as `state.initInFlight`, attach callbacks per 5.2.2, set the editor, notify `"Autocorrect ON (loading…)"`.
    - **`ready`** → reuse, set the editor, notify `"Autocorrect ON"` (no "loading…" suffix).
    - **`building`** → reuse the engine and the existing `state.initInFlight` (do NOT start a second initialization), set the editor, notify `"Autocorrect ON (loading…)"`. The existing in-flight callbacks (already generation-guarded) continue to drive the persistent indicator.
    - **`degraded`** → fall through to Section 5.6 (bump generation, discard, construct fresh).
  - 5.2.2 The `currentGen`-aware callbacks attached to `state.initInFlight`:
    - `.then(() => onInitResolved(currentGen))` → if `currentGen !== state.generation` OR `state.enabled === false`, return immediately. Otherwise update the persistent `"typos"` indicator to `"✓ Autocorrect"`.
    - `.catch((err) => onInitFailed(currentGen, err))` → same generation/enabled guard. Otherwise update the indicator to `"Autocorrect unavailable"` and surface the error notification once.
  - 5.2.3 `onInitResolved` clears the loading state of the persistent `"typos"` indicator and updates it to `"✓ Autocorrect"`. `onInitFailed` updates the indicator to `"Autocorrect unavailable"` and surfaces the error notification once.
  - 5.2.4 Set the editor component immediately (do not block on init).
  - 5.2.5 Notify `"Autocorrect ON"` if the engine is already `ready` at toggle time, OR `"Autocorrect ON (loading…)"` if still `building` (matches the toggle-command spec scenario "Enable autocorrect (first time, engine still building)").
  - 5.2.6 Do NOT call `setStatus("typos-loading", ...)` anywhere — the persistent `"typos"` indicator is the sole source of truth (per the spec scenario "typos-loading status key is no longer set").
- [x] 5.3 Refactor `disable()`: do NOT await `state.initInFlight`. Bump `state.generation` (orphaning any in-flight init's callbacks via 5.2.2's guard), set `state.enabled = false`, restore the editor immediately, and clear the persistent `"typos"` status indicator. The orphaned `initialize()` MAY complete in the background but its result SHALL NOT be retained — always discard, let next enable rebuild from scratch (per the design.md "Orphan-promise generation guard" decision).
- [x] 5.4 Refactor `handleSetMaxEditDistance()`:
  - 5.4.1 Validate `<n>`: if not an integer in `[1, 4]`, reject. If less than the persisted `minEditDistance`, reject with the actionable error per the spec scenario, BEFORE persisting or touching engine state.
  - 5.4.2 Persist the new value.
  - 5.4.3 Bump `state.generation` (orphaning any in-flight init's callbacks). Drop `state.engine` and `state.initInFlight`.
  - 5.4.4 **If `state.enabled === true`**, internally invoke the lazy enable path so the new build runs in the background (per the spec scenario "Hot-reload the engine when maxEditDistance changes while enabled"). The internal invocation SHALL NOT emit `"Autocorrect OFF"`/`"Autocorrect ON (loading…)"` notifications — only the existing `"maxEditDistance set to <n>"` notification fires.
  - 5.4.5 **If `state.enabled === false`**, do NOT install the editor or set the persistent `"typos"` indicator (per the spec scenario "maxEditDistance change while disabled does not enable autocorrect"). The new value takes effect on the next `/typos on`.
- [x] 5.5 Dedupe concurrent enable: if `state.initInFlight` is set AND `state.engine !== undefined` AND its construction-time config matches the current persisted config when `enable()` is called again, attach to the existing promise instead of starting a second build. Defense-in-depth: the engine's `initialize()` is also internally idempotent (Section 9.4) so a second construction wouldn't duplicate the build either.
- [x] 5.6 Refactor `enable()` so that when the engine is in `degraded` state and currently disabled, the next `enable()` bumps `state.generation` (orphaning any late callbacks from the prior degraded init), discards the engine, and constructs a fresh one (matching the spec scenario "`/typos on` while degraded retries initialization").
- [x] 5.7 Unit / integration tests:
  - 5.7.1 `/typos on` returns immediately (test asserts editor is set within a few ms; init promise resolves later)
  - 5.7.2 `/typos off` immediately after `/typos on` returns within a few ms WHILE init is still pending; the orphaned init's `.then` SHALL NOT fire any UI calls (assert no `setStatus` or `notify` after the disable)
  - 5.7.3 Double `/typos on` does not start a second build (whether via toggle-layer dedupe or engine-layer idempotency)
  - 5.7.4 `/typos config maxEditDistance N` during in-flight init returns within a few ms; a fresh init is started; the prior in-flight init's `.then` SHALL NOT touch UI when its captured generation no longer matches `state.generation`
  - 5.7.5 `/typos config maxEditDistance <n>` where `<n> < minEditDistance` is rejected with the actionable error and does NOT modify config or engine
  - 5.7.6 Init failure transitions engine to `degraded` and surfaces a notify; `state.enabled` stays true; subsequent corrections no-op gracefully; the persistent `"typos"` indicator shows "Autocorrect unavailable"
  - 5.7.7 `/typos on` while degraded discards the engine and starts a fresh init
  - 5.7.8 Notification text reflects readiness: `"Autocorrect ON (loading…)"` when building, `"Autocorrect ON"` when already ready (e.g., second `/typos on` in the session)
  - 5.7.9 Rapid `on → off → on` while a cold init is pending: only the final state's UI is presented; orphaned callbacks from the first `on` make no UI calls

## 6. Command surface for new config knobs and status indicator

- [x] 6.1 Wire the `"typos"` persistent status key to the engine's readiness state: `building → "Autocorrect loading…"`, `ready → "✓ Autocorrect"`, `degraded → "Autocorrect unavailable"`. The persistent indicator carries the live story; the enable-time notify (covered in Section 5) carries the one-shot snapshot.
- [x] 6.2 Update the persistent status whenever the engine's readiness state changes (subscribe via the init promise's resolve/reject handlers AND any subsequent rebuild paths). Updates SHALL be guarded by the orphan-generation check (Section 5.2.2) so a late-arriving callback for an orphaned engine cannot clobber the indicator.
- [x] 6.3 Remove all uses of `setStatus("typos-loading", ...)` from the codebase — the persistent `"typos"` indicator is now the sole source of truth (per the spec scenario "typos-loading status key is no longer set"). Update existing tests that assert on the `"typos-loading"` key to assert on the `"typos"` key with value `"Autocorrect loading…"` instead.
- [x] 6.4 Add `minEditDistance` and `editDistanceStepEvery` to `CONFIG_KEYS` (and the usage string) in `src/commands.ts` so they are recognized by the `/typos config` router.
- [x] 6.5 Add `Config` setters: `setMinEditDistance(value: number)` and `setEditDistanceStepEvery(value: number)` in `src/config.ts`, mirroring the existing `setMaxEditDistance` / `setMinWordLength` shape (range-validate, persist, return).
- [x] 6.6 Add command handlers `handleSetMinEditDistance` and `handleSetEditDistanceStepEvery` in `src/commands.ts`, mirroring the existing `handleSetMinWordLength` shape (validate via Section 1's range constants, persist via 6.5 setters, emit `"<key> set to <n>"` notification, NO engine rebuild because the engine reads these accessors live per Section 2).
- [x] 6.7 Update the bare `/typos config` listing handler to include `minEditDistance = <value> (range 0-<currentMaxEditDistance>)` and `editDistanceStepEvery = <value> (range 1-8)`.
- [x] 6.8 Update the single-key display handler to handle both new keys (`"minEditDistance = <value> (range 0-<maxEditDistance>)"`, `"editDistanceStepEvery = <value> (range 1-8)"`).
- [x] 6.9 Update `getArgumentCompletions` to suggest both new keys at the second-level completion of `/typos config`, and to provide third-level value completions per the spec scenario (`minEditDistance` suggests `0` through current `maxEditDistance`; `editDistanceStepEvery` suggests `1` through `8`; `maxEditDistance` filtered to `[currentMinEditDistance, 4]`).
- [x] 6.10 Tests for each persistent status indicator value (building / ready / degraded / cleared), the bare-listing format, the single-key display for each new key, the SET handler success path for each new key (valid integer in range → persisted + notification), the SET handler rejection paths (out-of-range, non-integer, `minEditDistance > maxEditDistance`), and the completion-suggestion sets for each key.

## 7. Pre-warm at extension load (depends on Sections 4–6 and Section 9 — the cache-aware factory must exist before pre-warm can use it)

- [x] 7.1 In `index.ts`, after `config.load()` resolves, check `config.getDefaultMode()`; if `"on"`, construct a `CorrectionEngine` via the same constructor `commands.ts` uses (cache-aware initialization is in-line in `initialize()` per Section 9.2 — there is no separate factory) and kick off `engine.initialize()` without awaiting. Capture the in-flight promise.
- [x] 7.2 Hand a pre-warm handle off to the `createTyposCommand` factory — not just the engine instance, but a struct `{ engine, initPromise }` so `enable()` can attach to the same in-flight promise instead of starting a second one. The toggle command's state initializer SHALL seed `state.engine` and `state.initInFlight` from this handle.
- [x] 7.3 If pre-warm fails before any UI context exists, the engine SHALL transition to `degraded` and the failure SHALL be silently captured (no notify possible without a `ctx`); the first `enable()` will discard and retry per Section 5.6.
- [x] 7.4 Tests:
  - [x] 7.4.1 With `defaultMode: on`, extension load schedules an init; the toggle command's state struct picks up the pre-warmed engine and in-flight promise on construction
  - [x] 7.4.2 With `defaultMode: off`, no init is scheduled
  - [x] 7.4.3 Pre-warm hit (engine already `ready` by the time `applyDefaultMode` runs): `enable()` notifies `"Autocorrect ON"` (no "loading…" suffix), no second initialization is started
  - [x] 7.4.4 Pre-warm in flight (engine still `building` when `applyDefaultMode` runs): `enable()` reuses the existing in-flight promise; only one initialization total
  - [x] 7.4.5 Pre-warm failure: engine reaches `degraded` silently; first `enable()` retries per the degraded-recovery scenario

## 8. New `index-cache` module

- [x] 8.1 Create `src/index-cache.ts` exporting:
  - `interface CacheDescriptor { maxEditDistance: number; prefixLength: number; compactLevel: number; countThreshold: number; }` (the inputs that affect built-state; library version + schema version are derived inside the module)
  - `serializeIndex(symspell): Buffer`
  - `deserializeIndex(buffer, expectedDescriptor): { words, deletes, maxLen } | null` (returns null if header descriptor doesn't match expectations — catches drift)
  - `computeCacheKey(descriptor): string | null` (returns `null` if package root cannot be resolved — caller treats this as cache disabled)
  - `getCacheFilePath(key): string`
  - `loadCache(descriptor): Promise<HydrationResult | null>`
  - `writeCache(descriptor, symspell): Promise<void>` (returns void; never throws past the boundary, only logs)
  - `pruneStaleSiblings(currentKey): Promise<void>`
- [x] 8.2 Implement the binary format from the spec exactly (header, string table, words, delete buckets — `u16` bucket length, NOT `u8`). Add two serializer-side assertions: (a) if any delete bucket has length > 65535 (would overflow `u16`), throw `BUCKET_OVERFLOW` with a clear message rather than silently truncating; (b) if `symspell.belowThresholdWords.size > 0`, throw `BELOW_THRESHOLD_NONEMPTY` with a message naming the schema-version requirement (the v1 format does not serialize that map; if `COUNT_THRESHOLD > 1` ever ships, the format must be extended and the schema version bumped). Both are defense-in-depth that catch silent corruption at build time.
- [x] 8.3 Implement `computeCacheKey(descriptor): string | null` as: hash via `crypto.createHash("sha256")` over the canonical string `JSON.stringify({maxED: descriptor.maxEditDistance, prefixLen: descriptor.prefixLength, compactLevel: descriptor.compactLevel, countThreshold: descriptor.countThreshold, libVersion: <version>, schemaVersion: <const>})`, then truncate to the first 16 hex characters. The resulting filename is `symspell-{hex16}.bin` — short enough for filesystem ergonomics, collision-safe enough for this use. Resolve the symspell-ts version via the `resolveSymspellPackageRoot()` helper from task 3.1 (NOT a hardcoded `node_modules/...` path, and NOT `resolve("symspell-ts/package.json")` which fails under the `exports` map). If resolution returns `null`, return `null` from `computeCacheKey` and log info that caching is disabled.
- [x] 8.4 Resolve cache directory: `const env = process.env.MOBILE_AUTOCORRECT_CACHE_DIR?.trim(); const dir = env ? env : join(homedir(), ".pi", "agent", "cache", "mobile-autocorrect");` (truthy check on the trimmed value, NOT `??` which would honor an empty string). Wrap `mkdir(..., { recursive: true })` in try/catch; on failure, log info, mark caching as disabled for this process, and return early. Cache load and write paths SHALL respect this disable flag.
- [x] 8.5 Implement atomic write: build a unique temp filename `{path}.{pid}-{random}.tmp` (use `crypto.randomBytes(8).toString("hex")` for the random part), write to it, then `rename()` to final path. Catch and log (info level) any write/rename failure; never throw past the `writeCache` boundary so callers don't see cache failures as engine failures. Document inline that the cache subsystem is POSIX-only (Linux/macOS/Termux); on Windows the implementation MAY short-circuit to no-op.
- [x] 8.6 Implement prune: list directory, `unlink()` files matching exactly `symspell-*.bin` (no additional suffixes — do NOT touch `*.tmp` files or unrelated user files) whose name does not equal current key's filename; swallow per-file errors (log info)
- [x] 8.7 Implement load: try open + parse; on any failure (ENOENT, bad magic, version mismatch, parse error, schema mismatch, truncated buffer), return `null` (caller falls through to fresh build); on `computeCacheKey() === null`, return `null` immediately without filesystem access
- [x] 8.8 Commit a fixed fidelity corpus at `tests/fixtures/cache-fidelity-corpus.txt` containing at minimum: short words (length 2–3), medium words, long words (length 10+), known typos at ED 1–3, in-dict words, and known landmines (`vitest`, `termux`, `kbuernetes`, `kubrnetes`)
- [x] 8.9 Module tests:
  - [x] 8.9.1 Round-trip fidelity: build fresh, serialize, deserialize into new SymSpell, compare lookup results across the committed corpus file (per the spec's "Round-trip fidelity test" scenario)
  - [x] 8.9.2 Round-trip explicitly covers a delete bucket >255 entries (per the spec's "Round-trip exercises buckets larger than 255 entries" scenario); test fails if no such bucket exists in the corpus
  - [x] 8.9.3 Cache key changes when each input changes (one assertion per: maxEditDistance, prefixLength, compactLevel, countThreshold, schema version; lib version covered by mocking the resolver helper if practical)
  - [x] 8.9.4 Atomic write: temp filename includes pid and random suffix; simulate crash between write and rename — final path does not exist; only the per-process temp file remains
  - [x] 8.9.5 Concurrent writers each use their own temp file (no collision)
  - [x] 8.9.6 Prune deletes only mismatched `symspell-*.bin` keys; leaves `*.tmp` files and unrelated files alone
  - [x] 8.9.7 Load returns `null` for: missing file, bad magic, version mismatch, truncated buffer, schema mismatch
  - [x] 8.9.8 `MOBILE_AUTOCORRECT_CACHE_DIR=""` (empty string) falls through to default location
  - [x] 8.9.9 `MOBILE_AUTOCORRECT_CACHE_DIR="   "` (whitespace-only) falls through to default location
  - [x] 8.9.10 Write failure (simulated unwritable cache dir) does not throw past the `writeCache` boundary
  - [x] 8.9.11 `mkdir` failure (simulated read-only cache parent) does not throw past the cache-dir-resolution boundary; engine still reaches `ready`
  - [x] 8.9.12 Bucket-overflow guard: serializer throws `BUCKET_OVERFLOW` when fed a synthetic SymSpell with a >65535-entry bucket

## 9. Engine ↔ cache integration

- [x] 9.1 Define module-level engine constants pinned to the symspell-ts 0.0.2 upstream defaults (verified against `node_modules/symspell-ts/dist/symspell.js`): `PREFIX_LENGTH = 7` (`defaultPrefixLength`), `COUNT_THRESHOLD = 1` (`defaultCountThreshold`), `COMPACT_LEVEL = 5` (`defaultCompactLevel`). Pass all five SymSpell constructor arguments explicitly when constructing: `new SymSpell(undefined, maxEditDistance, PREFIX_LENGTH, COUNT_THRESHOLD, COMPACT_LEVEL)`. Reference the same constants from `index-cache.ts`'s `CacheDescriptor` defaults so a future change to one fails CI alongside the other.
- [x] 9.2 Implement cache-aware initialization IN-LINE inside `CorrectionEngine.initialize()` (no separate `fromCacheOrBuild` static factory — keeps the engine's public surface minimal). The flow:
  - 9.2.1 Build a `CacheDescriptor` from the engine's options + the module-level constants; call `computeCacheKey(descriptor)`; if `null` (resolver failed), skip cache entirely and go straight to fresh build (which uses the resolver-failure fallback path documented in Section 3.2)
  - 9.2.2 Call `loadCache(descriptor)` first; if hit, hydrate the SymSpell instance via the cache's deserialized state and run `pruneStaleSiblings(currentKey)` fire-and-forget
  - 9.2.3 On miss, call `loadUnigramOnly(symspell)` (per Section 3), then call `writeCache(descriptor, symspell)` (fire-and-forget; failures logged but never propagate — readiness reaches `ready` regardless). Do NOT prune on a fresh-build path; only prune after a successful cache *load*. This avoids the multi-session-thrash variant where a fresh-build session evicts a peer's cache.
  - 9.2.4 In both branches, also read the tech dictionary file (existing logic)
- [x] 9.3 Hydration sets the SymSpell private fields (`words`, `deletes`, `maxDictionaryWordLength`) directly; document with an inline comment that this reaches into nominally-private state
- [x] 9.4 Make `CorrectionEngine.initialize()` idempotent under concurrent in-flight calls: if called while `readinessState === "building"`, return the existing in-flight promise rather than starting a second initialization. Add a unit test in Section 4 covering double-init.
- [x] 9.5 Integration tests:
  - 9.5.1 First init: cache miss → fresh build → cache file appears at expected path
  - 9.5.2 Second init: cache hit → no call to `loadUnigramOnly` (the new symbol introduced in Section 3 — spy on THAT name, not the deleted `loadDefaultDictionaries`) → lookups still correct
  - 9.5.3 Corrupted cache file: load fails silently → fresh build runs → file is overwritten on next session
  - 9.5.4 Stale sibling files: present before a successful cache LOAD → absent after that load (NOT pruned by a fresh-build session)
  - 9.5.5 `MOBILE_AUTOCORRECT_CACHE_DIR` env override is honored
  - 9.5.6 Cache write failure (simulated): readiness still reaches `ready`; lookups work normally
  - 9.5.7 Unresolvable symspell-ts package root (mocked `resolveSymspellPackageRoot` returning `null`): `computeCacheKey` returns `null`; engine builds fresh via upstream `loadDefaultDictionaries` fallback; readiness reaches `ready`; no cache file written
  - 9.5.8 Double `initialize()` on the same engine instance while in `building` state does not invoke the unigram loader twice

## 10. Documentation

- [x] 10.1 README updates:
  - 10.1.1 Document `minEditDistance` and `editDistanceStepEvery` in the `/typos config` knobs section, with the formula and a short example curve
  - 10.1.2 Update `maxEditDistance` documentation to mention range `[1, 4]`, with explicit warning that ED=4 is experimental and produces high false-positive rates; document the rejection rule (lowering `maxEditDistance` below the current `minEditDistance` is rejected)
  - 10.1.3 Add an "Index cache" subsection under "How it works" describing the cache file location, what invalidates it, the env override, and that it's safe to delete
  - 10.1.4 Update the "Known limitations" section: remove "Edit distance 1 misses some real typos by design" (now configurable), keep "Concurrent sessions writing the same learned dictionary file use last-write-wins" and similar, note that ED 4 may produce nonsensical corrections on novel long words
- [x] 10.2 NOTES.md: add a section summarizing the empirical measurements that led to the design (build-time table, cache load time, format chosen, why bigrams dropped) — useful for future maintainers
- [x] 10.3 CHANGELOG.md: add a section for this change describing user-visible deltas (new config keys, faster startup, expanded `maxEditDistance` range, cache file appearance)

## 11. End-to-end validation

- [x] 11.1 Manual smoke test on macOS: clean cache dir, `/typos on`, observe loading status → ready transition; restart session, observe near-instant ready transition (cache hit); change `maxEditDistance`, observe rebuild + new cache file appearing. Scenario documented in `tests/scenarios/manual/macos-smoke-test.md`; manual execution is the user's responsibility.
- [x] 11.2 Manual smoke test on Termux (slow hardware): same sequence; verify the toggle command returns immediately. Document what the cache-miss build phase actually feels like on the target device (this is the "narrowed non-blocking" claim from the proposal/design — the ground truth for whether chunking the build is needed as a follow-up). Scenario documented in `tests/scenarios/manual/termux-smoke-test.md` with fillable `Observed timings` section; manual execution is the user's responsibility.
- [x] 11.3 Run the full test suite (`npm test`) and verify no regressions in existing scenarios. Result: 209 passed (209), 0 failures.
- [x] 11.4 Commit the benchmark scripts used during exploration to `bench/` (build time across ED 1–4, cache load time, format size comparison, unigram vs full dict parity, resolver-correctness check). The current proposal/design rests on these numbers; make them reproducible so future regressions are detectable.

## 12. Cleanup

- [x] 12.1 Remove dead code paths if any (e.g., the old awaited `enable()` flow if a fallback was kept during transition). Audit complete: no dead code, stale TODOs, or unused exports found in `src/commands.ts`, `src/correction-engine.ts`, or `index.ts`. TypeScript clean (`npx tsc --noEmit`).
- [x] 12.2 Verify `openspec validate improve-autocorrect-quality-and-startup --strict` passes (no missing required artifacts, all requirements have scenarios, etc.). Output: `Change 'improve-autocorrect-quality-and-startup' is valid`.
