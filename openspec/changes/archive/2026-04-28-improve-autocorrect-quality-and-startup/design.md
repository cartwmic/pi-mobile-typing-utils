## Context

The mobile-autocorrect extension wraps Pi's editor with a SymSpell-driven word-by-word correction layer. Today the engine has two design choices that interact badly with mobile usage:

- **Edit distance is uniform across word lengths.** The engine builds a SymSpell index at the configured `maxEditDistance` (default 2) and queries it at the same distance for every word. Empirically, ED=2 on 2- and 3-letter inputs reaches into a dense neighborhood of high-frequency function words, producing constant false positives (`te → the`, `ot → of`, `ho → to`, `aw → a`). At the same time, ED=2 misses real long-word typos that need ED=3 (`kbuernetes`, `entreprenur` with multiple errors).
- **Engine init is awaited synchronously.** `enable()` blocks on `engine.initialize()`, which calls `loadDefaultDictionaries()` and rebuilds the SymSpell deletion index from scratch. Measured cold-start build is 1.2 s (ED=2) → 2.2 s (ED=3) → 3.1 s (ED=4) on a fast laptop; Termux/phone hardware extrapolates 3–10 s. Because `applyDefaultMode` runs on every `session_start`, every new session with `defaultMode: on` blocks the user from typing for that long.

Empirical measurements done during exploration:

```
ED=1   build  511ms   heap +65 MB    316k delete buckets
ED=2   build 1219ms   heap +100 MB   662k buckets
ED=3   build 2204ms   heap +121 MB   750k buckets
ED=4   build 3147ms   heap +137 MB   753k buckets   (lookups 7× slower)
```

Cache prototype (binary format, deduplicated string table, no bigrams):

```
Fresh ED=4 build:        3,263 ms
Cache load (read+parse):   189 ms     (~17× speedup)
Cache file size:          29.8 MB
Fidelity:                 ✓ all sample lookups match fresh build
```

The bigram dictionary symspell-ts loads (~243k entries) is consulted only by `lookupCompound()` and `wordSegmentation()`. `grep` of the codebase confirms neither is called — bigrams are dead weight today.

Pi's `ExtensionAPI` does not expose any `cacheDir` helper. Convention from inspecting Pi internals and other installed extensions:

- User-owned config / state lives at `~/.pi/agent/<name>-*.json` (flat).
- Per-extension working dirs live at `~/.pi/agent/extensions/<name>/`.
- Regeneratable / derived data lives at `~/.pi/agent/cache/<scope>/` (Pi itself uses `~/.pi/agent/cache/sub-core/`).

## Goals / Non-Goals

**Goals:**

- Match correction aggressiveness to word length: tighter at the short end, more permissive at the long end, with the user able to tune both the floor and the ramp.
- Allow users to opt up to ED=4 for testing long-word coverage, while keeping the default ceiling at 2 for safety.
- Eliminate user-visible startup blocking. Steady-state session start should not require the user to wait for the index — even on slow Termux hardware.
- Keep the existing `/typos` command surface backward compatible. Defaults preserved. No migration of config or learned dictionary.
- Make engine state observable. Users on slow hardware should be able to see whether autocorrect is loading, ready, or in a failed state.

**Non-Goals:**

- **Phrase-level / context-aware correction.** Bigrams enable `lookupCompound` (word splitting like `alot → a lot`) and could enable real-word disambiguation (`their/there`). Both require a different correction trigger and editor plumbing. Out of scope; tracked as future work.
- **Tech-dictionary expansion.** ED=3 and ED=4 amplify the existing risk of the engine corrupting unfamiliar tooling names (`vitest → vilest`, `termux → terms`). Auditing and expanding the bundled tech dictionary is its own change.
- **The "last word before Enter" hole.** Today the engine never corrects the final word before submit. Adaptive ED makes that hole more visible (long final words are exactly where the user wants the new coverage), but fixing it requires editor-trigger changes outside this proposal's scope.
- **Replacing symspell-ts.** We continue to use the upstream library. The cache reaches into nominally-private fields, accepted as a known trade-off (see Risks).
- **Sharing the cache across machines / extensions.** Per-machine, per-version, per-extension. No remote sync.

## Decisions

### Decision: Adaptive ED via formula, not lookup table

Use `ED(L) = clamp(minED + floor((L - minWordLength) / step), minED, maxED)` evaluated per-call in `shouldCorrect`. Two new knobs: `minEditDistance` (default `1`, range `[0, maxEditDistance]`) and `editDistanceStepEvery` (default `4`, range `[1, 8]`). The existing `maxEditDistance` becomes the upper cap.

**Why a formula:**
- Two scalar knobs are simpler to validate, persist, and explain than a tier list or per-length map.
- Composes naturally with the existing `/typos config` UX: each knob is a single integer with a documented range.
- Predictable behavior — users can compute the curve in their head from three numbers.

**Why not a tier-list string** (e.g. `"3:1,6:2,9:3"`): more expressive but adds a parser, a richer validator, and a less-obvious display in `/typos config`. The compactness wins are not worth the complexity for the realistic shapes we expect.

**Why not constant defaults that bump the ceiling:** changing the defaults silently is risky. Today's behavior at ED=2 is well-understood; opt-in upgrades to 3 or 4 keep responsibility with the user.

**Per-call cost:** the formula evaluates in nanoseconds. The existing eligibility regex is cached; we'd add a tiny per-call arithmetic step before `lookup()`. Lookup itself is unchanged because SymSpell's index ceiling allows passing a smaller per-call distance — verified by benchmark (`accomodatte` returns `—` at d≤1 and `accommodate` at d≤2 against the same ED=3 index).

### Decision: `maxEditDistance` ceiling raised to 4, default unchanged at 2

Range expands from `[1, 3]` to `[1, 4]`. Default stays at `2`. ED=4 is documented as experimental: lookups are ~7× slower, and the false-positive rate climbs sharply because at distance 4 nearly every misspelled English word matches *something* in the 82k-word dictionary, often semantically unrelated (`kbuernetes → burners`).

The user explicitly asked for the ceiling so they can test. It's gated by the existing `prefixLength=7 > maxED` constraint (4 fits, 7+ doesn't).

### Decision: Drop bigrams entirely (with documented best-effort fallback)

`grep -rn "lookupCompound\|wordSegmentation\|bigram"` of the extension code returns nothing. Loading bigrams costs build time and ~24 MB of resident memory for zero benefit in the current `lookup()`-only pipeline. The unigram-only loader (which calls `symspell.loadDictionary(text, 0, 1)` against the bundled English unigram file resolved via the package-root walk) skips bigrams entirely and is the **default** initialization path.

**Resolver-failure fallback (best-effort):** in the unusual case where `resolveSymspellPackageRoot()` returns `null` (e.g., highly atypical module-resolution layout the test suite did not anticipate), the engine falls back to upstream `loadDefaultDictionaries(symSpell)`, which loads bigrams as a side effect. This is acceptable because (a) it preserves the engine's correctness contract — lookups still return the right results — at the cost of the optimization's memory savings, and (b) it preserves the user's autocorrect functionality rather than failing degraded over a packaging edge case. The bigram-no-load invariant in the engine spec applies to the unigram-only path; the fallback path has its own scenario explicitly permitting bigrams. Both spec scenarios are testable.

When the future "compound correction" change happens, bigrams come back and the cache schema bumps from v1 to v2 (existing v1 caches invalidate naturally via the schema-version part of the cache key).

### Decision: Orphan-promise generation guard for non-blocking lifecycle

The non-blocking `disable()` and the non-blocking `maxEditDistance` rebuild both leave a previously-in-flight `initialize()` promise running in the background after the toggle command has moved on. Without an ownership rule, those orphan promises' `.then`/`.catch` handlers can:

- Clear a status indicator the user already cleared by disabling.
- Surface a `degraded` notification for an engine the user no longer wants enabled.
- Resolve into `state.engine` after the user has changed `maxEditDistance`, so subsequent corrections fire against the wrong index.

**The rule:** every promise attached to an in-flight `initialize()` carries a generation token (a monotonically-increasing integer captured at the moment the promise was created). The toggle-command state holds the current `state.generation`. Every `.then`/`.catch` callback's first action SHALL be:

```
if (capturedGeneration !== state.generation) return;  // orphaned; do nothing
if (!state.enabled) return;                            // user disabled; do nothing
// otherwise, safe to update state.engine, status, etc.
```

The generation increments on **every code path that replaces or tears down `state.engine`**, including:

- `disable()` (the disabled user's prior init becomes orphaned)
- `/typos config maxEditDistance` (a config-change rebuild orphans the prior init)
- The degraded-recovery teardown when `/typos on` runs while the engine is in `degraded` state and currently disabled (so a stale degraded init's late callbacks cannot clobber the new build's UI updates)
- Any other engine teardown path added in the future

The rule is best maintained as an inversion: **every assignment site that replaces or clears `state.engine` MUST bump `state.generation` as its first step.** Pre-warm and the first `enable()` share generation 0; subsequent teardowns increment.

**The rule:** orphans are always discarded. The orphan's `.then`/`.catch` callbacks SHALL be guarded by the generation token (per the rule above) and SHALL NOT mutate `state.engine`, status, or notifications when the generation no longer matches. The next `enable()` after `disable()` constructs and initializes a fresh engine.

Decided after round-2 review: a strict reuse rule (orphan resolution donates its result back to `state.engine` under N conjunctive conditions) was considered and rejected. Reuse would save the cost of a second build on the rare `off; on` no-config-change flow at the cost of nontrivial code surface (engine identity, config snapshot comparison, generation matching) plus harder-to-test races. "Always discard" is one branch instead of four, and the cost is a rebuild the user can already see is happening (the loading status indicator is already visible).

### Decision: Lazy fire-and-forget `initialize()` — control returns immediately, but the build phase itself is event-loop-blocking on cache miss

`enable()` will:

1. Create `state.engine` and assign `state.initInFlight = engine.initialize().then(...).catch(...)`.
2. Set the editor component immediately (the editor's `shouldCorrect()` already returns `{corrected: false}` while `!ready`).
3. Show a loading status until the in-flight promise resolves.

**What "non-blocking" means here — honest framing:**

- **Cache hit (the steady-state path after the first session):** load is ~200 ms on macOS / ~400–600 ms estimated on Termux, and although that load is technically synchronous (binary parse + Map insertions), it's short enough that the user effectively does not perceive a freeze. The initial keystrokes that arrive in this window are queued by Pi's input handling and processed when the build returns; corrections begin firing once the engine is `ready`.
- **Cache miss (first run, library upgrade, or after a `maxEditDistance` change):** the SymSpell deletion-table build is 1–3 s on macOS / 3–10 s on Termux and runs synchronously in a single tick of the event loop (it iterates ~82k unigram entries, each calling `createDictionaryEntry` which mutates two Maps and computes hashes). During that tick, **keystroke processing is blocked** — "non-blocking" here only means the toggle command returns control to the caller immediately, not that the event loop stays responsive. Pre-warm at extension load mitigates this for `defaultMode === "on"` users by overlapping the build with extension startup so it's usually finished before the user types. For `defaultMode === "off"` users, the freeze on first `/typos on` after a config change is real and visible.

A chunked build (split `createDictionaryEntry` calls into batches with `setImmediate` yields between them) would make the cache-miss case truly event-loop-non-blocking at the cost of additional complexity and ~10–20% wall-clock overhead. Considered and deferred — with the cache subsystem in place, cache-hit is the steady state, so the cache-miss freeze is rare. If real-world usage shows the cache-miss freeze is painful, chunking is the natural follow-up.

Race safety (revised after round-2 review):

- `disable()` while init is in-flight: clear editor and status indicator immediately (within a few ms), do NOT await the in-flight build. Bump `state.generation` so the orphaned init's `.then`/`.catch` callbacks no-op (per the "Orphan-promise generation guard" decision above). The orphaned engine MAY complete in the background but its result is NOT retained — the next `/typos on` constructs and initializes a fresh engine. Awaiting was rejected because on Termux cold start it would mean `/typos off` blocks for 8+ seconds, defeating the purpose of the change.
- `/typos config maxEditDistance N` while init is in-flight: persist the new value, abandon the in-flight engine (orphan its result), start a fresh init via the normal lazy-fire path. The user-visible "loading" state transitions immediately; the abandoned init may complete in the background but its results are discarded.
- Concurrent `/typos on` while init is in-flight: dedupe via `state.initInFlight` (don't start a second build). The engine's `initialize()` is also internally idempotent under in-flight calls (returns the existing promise) as a defense-in-depth check.

`initialize()` errors are surfaced via `.catch()` → `notify(... "error")` and an "engine degraded" state that the persistent status indicator and the next `/typos on` enable-time notification report.

### Decision: Pre-warm at extension load when `defaultMode === "on"`

In `index.ts`, after `config.load()` resolves and before `pi.on("session_start", ...)` fires, kick off `engine.initialize()` (still non-blocking). For users who run with `defaultMode: on` (the painful case), the build starts as early as Pi will allow — usually before `session_start`. Combined with the cache, the typical second-and-later session has the engine ready before the user can type.

If `defaultMode === "off"`, no pre-warm. The engine builds (or loads from cache) on first `/typos on`.

### Decision: Disk cache as a separate capability

The cache is logically distinct from the engine: it has its own correctness story (key derivation, atomic write, sibling pruning, fall-through), its own format, its own version. Modeling it as a separate capability (`index-cache`) keeps the engine spec focused on lookup semantics and lets the cache evolve (e.g., schema v2 with bigrams) without touching engine requirements.

The engine consumes the cache via in-line logic inside `CorrectionEngine.initialize()` (no separate `fromCache` static factory — keeps the engine's public surface minimal); the cache subsystem itself lives in its own module (`src/index-cache.ts`).

### Decision: Custom binary cache format with deduplicated string table

Format chosen against three alternatives in benchmark:

```
JSON:               86 MB   1500 ms load
JSON + gzip:        27 MB   2400 ms load    (gunzip is the bottleneck)
Binary (naive):    ~50 MB   ~250 ms load
Binary + dedup:     30 MB    189 ms load    ← chosen
```

Layout:
1. Header: magic `"SYMC"` (4 bytes), schema version (u32), `maxEditDistance` (u32), `maxDictionaryWordLength` (u32).
2. String table: count (u32), then for each entry: length-prefixed UTF-8 (u8 length + bytes). All unique words across `words` and the value-lists of `deletes`.
3. Words: count (u32), then for each: string-table index (u32) + frequency (f64).
4. Delete buckets: count (u32), then for each: hash (i32) + bucket length (u16, **not** u8 — measured max bucket size 5430) + per-entry string-table index (u32).

No bigrams (see decision above). No `belowThresholdWords` (default `countThreshold=1` leaves it empty after `loadDefaultDictionaries`).

### Decision: Cache key embeds all inputs that can affect correctness

Key components hashed into the filename:

- `maxEditDistance` — index is built at this distance; fundamental.
- `prefixLength` — affects which deletion variants are generated.
- `compactLevel` — feeds `compactMask`, which is used by `getStringHash`. Hash mismatch silently corrupts lookups, so this matters.
- `countThreshold` — affects whether words land in `words` or `belowThresholdWords` and what the loader stores. The schema-v1 cache format only serializes `words`; if `countThreshold > 1` ever ships, the format invariant breaks and the cache must invalidate.
- `symspell-ts version` (resolved via `createRequire(import.meta.url).resolve("symspell-ts")` then walking up directories from the resolved entrypoint to find the `package.json` whose `name === "symspell-ts"` — NOT via `resolve("symspell-ts/package.json")`, which fails under the upstream `exports` map with `ERR_PACKAGE_PATH_NOT_EXPORTED`) — guards against internal restructuring of the fields we serialize.
- Cache schema version (incremented when format changes).

We do **not** hash the loaded dictionary content. The dictionary is bundled with symspell-ts and changes only when the library version changes — already covered by the version part of the key.

### Decision: Cache lives at `~/.pi/agent/cache/mobile-autocorrect/`

Matches Pi's own convention (`~/.pi/agent/cache/sub-core/`). Override via `MOBILE_AUTOCORRECT_CACHE_DIR` env var, mirroring the existing `MOBILE_AUTOCORRECT_DICT_PATH` and `MOBILE_AUTOCORRECT_CONFIG_PATH` patterns.

User-owned files (`mobile-autocorrect-config.json`, `mobile-autocorrect-dictionary.json`) stay at `~/.pi/agent/`. No migration; clean separation of "user data" from "regeneratable data".

### Decision: Atomic write with unique per-writer temp file, prune-stale-on-load eviction

- Write: build the file at a unique per-writer temp filename `symspell-{key}.bin.{pid}-{random}.tmp` (≥8 hex chars of randomness), then `rename()` to `symspell-{key}.bin`. The unique suffix prevents two concurrent writers from interleaving bytes into a shared temp path; `rename()` is the only atomic step. Cache durability across power loss is explicitly not required (the cache is regeneratable), so no `fsync` before rename. POSIX-only; Windows MAY skip the cache subsystem entirely.
- Eviction: only after a successful cache **load**, list sibling files in the cache dir and `unlink()` files matching `symspell-*.bin` (no additional suffixes — do NOT touch `*.tmp` files or unrelated files) whose name doesn't match the current key. Pruning intentionally does NOT fire after a fresh build, because that would let a fresh-build session evict a peer session's cache it never read (multi-session config thrash; documented as accepted in Risks).

Prune failures (permission errors, missing file) are logged but ignored — eviction is best-effort.

### Decision: Corruption falls through to fresh build, no panic

Any failure path during cache load (missing file, bad magic, version mismatch, parse error, too-short buffer, etc.) catches the exception, logs at `info` (not `error`), and continues to a fresh build. The fresh build then writes a new cache file, overwriting the bad one. The user sees autocorrect work normally; the only visible signal is a slightly slower first session after a corruption event.

### Decision: Engine readiness surfaced via the persistent status indicator (and the enable-time notify)

The persistent status indicator (`setStatus("typos", ...)`) gains additional values alongside the existing "✓ Autocorrect" / cleared. The enable-time notification reflects readiness at the moment of the toggle: `"Autocorrect ON"` when the engine is already `ready` (subsequent enable in a session, or pre-warm hit); `"Autocorrect ON (loading…)"` when the engine is still `building`. The notification fires once at toggle time — the live readiness story is told by the persistent indicator.

```
readiness state       persistent indicator value
─────                 ──────────────────────────
building              "Autocorrect loading…"
ready                 "✓ Autocorrect"
degraded              "Autocorrect unavailable"
disabled              (cleared)
```

The "degraded" state matters because today, an `initialize()` error notifies once and is forgotten — but `state.enabled` stays true. Users can be confused why autocorrect says "on" while nothing corrects. The new persistent indicator value makes the failed state continuously visible without spamming notifications.

Proposal-level claim that "the bare `/typos` command reports loading/ready/degraded states" is narrowed to: the persistent indicator carries the live story; the bare-toggle notification carries a one-shot snapshot at toggle time.

## Risks / Trade-offs

**[Reaching into private SymSpell fields]** → A symspell-ts upgrade could rename or restructure `words` / `deletes` / `maxDictionaryWordLength`. **Mitigation:** the symspell-ts version is part of the cache key, so an upgrade auto-invalidates every existing cache. Add a CI test that builds a fresh engine, serializes, deserializes, and asserts identical lookup results across a fixed corpus of words. If symspell-ts's internals shift, this test breaks loudly during library bump and we either adapt the serializer or fall back to no-cache for the new version.

**[Hash mismatch corrupts lookups silently]** → `getStringHash` depends on `compactMask`, which depends on `compactLevel`. If we ever pass a different compactLevel at load vs. the one used at build, lookups silently return wrong results (no error, just bad output). **Mitigation:** include `compactLevel` in the cache key. Always construct the runtime SymSpell with the same compactLevel that was used to build the cache (we currently use the default; lock it explicitly in code with a comment).

**[Lazy init means first ~2s of typing has no autocorrect]** → On first session ever (cache miss + cold start) the user can type but won't see corrections for a couple of seconds. **Mitigation:** the loading status indicator tells them what's happening; corrections kick in once the engine is ready; subsequent sessions hit the cache and the window shrinks to ~200ms (effectively invisible). Acceptable trade-off for unblocking the editor.

**[Concurrent sessions race on cache write]** → Two sessions both miss → both build → both write to the same path. **Mitigation:** atomic-rename means at worst one session's write is overwritten by another's identical bytes. No data integrity issue. The eviction step (prune siblings on hit) is also race-tolerant — at worst we re-create a file we just deleted, harmless.

**[ED=4 false positives]** → At distance 4, almost any misspelled long word matches *something* in the 82k-word dictionary, frequently a semantically unrelated word with high frequency. Example: `kbuernetes → burners`. **Mitigation:** keep the default at 2, document ED=4 as experimental in `/typos config maxEditDistance` help text and in the README. The existing tech-dictionary whitelist suppresses corrections for known dev terms (when those terms are in the whitelist). Audit / expansion of that whitelist is a follow-up change.

**[Multi-session config thrash on shared cache directory]** → Two concurrent sessions in the same `MOBILE_AUTOCORRECT_CACHE_DIR` running with different `maxEditDistance` (or other keyed inputs) will each, on every successful cache load, prune the other's cache file (because prune-on-hit removes siblings whose key doesn't match the loader's key). Each subsequent session start in the other config sees a missing cache, rebuilds, writes, prunes — both sessions thrash forever. **Mitigation:** documented and accepted. The use case (parallel sessions with different ED experiments) is rare; users running parallel experiments can override `MOBILE_AUTOCORRECT_CACHE_DIR` per session to isolate caches. A future refinement could be "skip prune if any sibling is younger than N seconds," but it adds clock-dependent behavior and is not worth the complexity in v1.

**[Crashed `*.tmp` writers leak forever]** → The atomic-write spec writes to `{path}.{pid}-{random}.tmp` and renames; the prune step explicitly excludes `*.tmp` files. A process killed between write and rename leaves a ~30 MB orphan file forever. **Mitigation:** acceptable in v1. Over months on a Termux device this could accumulate; can be addressed by extending the prune step to delete `*.tmp` files older than N hours in a follow-up if it becomes a real problem.

**[Cache load reads the entire ~30 MB file into a Buffer]** → On low-memory Termux devices, peak memory during cache load (30 MB read buffer + 100 MB+ in-progress index reconstruction) is non-trivial. **Mitigation:** acceptable in v1; lazy fire-and-forget means the load doesn't compete with foreground work. A streaming/incremental parser would reduce peak memory and is a natural follow-up if it becomes a problem.

**[Windows `rename()` semantics]** → POSIX `rename()` is atomic over an existing target; Win32 `rename()` throws `EEXIST` and breaks atomic write on first overwrite. **Mitigation:** the cache subsystem is supported on POSIX-compatible platforms (Linux, macOS, Termux) only. On Windows the implementation MAY skip the cache subsystem entirely (every load returns null, every write is a no-op); the engine still works via fresh build. Termux is the priority target and is POSIX.

**[Pre-warm wastes work for users who never enable autocorrect]** → If `defaultMode === "on"` we pre-warm; if `"off"` we don't. **Mitigation:** the gate covers the common case correctly. Users with `defaultMode: off` who later run `/typos on` get the same lazy-fire path with cache-load-or-build, still non-blocking — just delayed until first toggle.

**[Cache dir grows if user toggles maxEditDistance frequently]** → Each (key) variant produces a ~30MB file. **Mitigation:** prune-on-hit removes siblings with non-matching keys, so steady state is one cache file per active configuration. A user oscillating between configs in a single session pays a temporary 2× disk cost; harmless on any modern device.

**[Cache directory creation racing on fresh install]** → Multiple sessions could simultaneously try `mkdir -p` the cache dir. **Mitigation:** use `mkdir -p` semantics (idempotent, no-op if exists) — `fs.mkdir(path, { recursive: true })`.

**[Load failure during `applyDefaultMode` could leave session in inconsistent state]** → If the cache load throws and the fresh-build fallback also throws (e.g., dictionary file missing), `state.enabled` is `true` but `state.engine` may be undefined. **Mitigation:** the engine constructor itself can't fail; the `initialize()` call can. We surface "degraded" state in `/typos` rather than silently failing, and `shouldCorrect()` already handles `!ready` → no-op gracefully.

**[Bigram drop reduces capability ceiling]** → If we later want compound correction (`alot → a lot`), we need bigrams back. **Mitigation:** schema v1 explicitly excludes bigrams; future schema v2 would re-include them. The format already has a version byte. No commitment is made today that bigrams are gone forever — only that they're not in v1.

## Migration Plan

**Deploy:**
- Single npm release. Existing installs upgrade in place.
- First session after upgrade: cache miss → fresh build (lazy/non-blocking) → cache write. User sees autocorrect become available a few seconds in (same as today's blocking behavior, but the editor isn't frozen).
- All subsequent sessions: cache hit → ~200ms load → autocorrect available almost immediately.

**Config compatibility:**
- New keys (`minEditDistance`, `editDistanceStepEvery`) are absent from existing config files. The config loader falls back to defaults when keys are missing.
- Existing `maxEditDistance` value is preserved. Range widens; old persisted values (1, 2, 3) all remain valid.
- No file moves, no rewrites of existing configs.

**Rollback:**
- Downgrade the extension: cache files at the new path are ignored by the older extension (which doesn't know about them). Slight disk waste until manually cleaned. No corruption risk.
- If we need to disable just the cache (e.g., during a hotfix while keeping adaptive ED): a single env var `MOBILE_AUTOCORRECT_NO_CACHE=1` could short-circuit cache load and write — worth shipping as a safety hatch. (Not strictly required; can be added in a follow-up if needed.)

## Open Questions

Resolved during round-1 review and codified in specs:

- **`degraded` state self-healing on next `/typos on`:** Codified — toggle-command spec scenario "running `/typos on` while degraded discards the engine and starts fresh initialization."
- **min/max ED interaction policy:** Lowering `maxEditDistance` below the persisted `minEditDistance` is REJECTED with an actionable error rather than auto-clamping `minEditDistance`. Rejection is least surprising because it keeps the user's intent explicit (which knob did they want to move?) and avoids silently mutating a value they previously set.
- **Enable-time notification text variants:** `"Autocorrect ON"` when `ready`, `"Autocorrect ON (loading…)"` when `building` — codified in the toggle-command spec "Enable autocorrect (first time)" scenario.
- **`symspell-ts` version + bundled-data path resolution:** Resolve via `createRequire(import.meta.url).resolve("symspell-ts")` (the bare entrypoint) then walk up to the `package.json` matching `name === "symspell-ts"`. Do NOT use `resolve("symspell-ts/package.json")` (blocked by upstream `exports` map) or any hardcoded `node_modules/...` string. If resolution fails, skip the cache subsystem (engine reaches `ready` via fresh build); the unigram-only loader's resolver-failure fallback is documented separately in the bigram-loading decision below.
- **Atomic-write temp filename:** Unique per writer (`{path}.{pid}-{random}.tmp`) to keep concurrent writers from interleaving into a shared `.tmp`.
- **Cache write failure does not block readiness:** Engine reaches `ready` after a successful build even if the subsequent cache write throws. Codified as a spec scenario.

Deferred (closed for this change):

- **`MOBILE_AUTOCORRECT_NO_CACHE` env var safety hatch:** Not shipped here. Existing fall-through-on-corruption already handles common failure modes; can be added as a small follow-up if the cache subsystem misbehaves in the wild.
- **Pre-built cache in the npm package:** Not shipped. Adds ~30MB per `maxEditDistance` value; lazy-fire makes first-run cost non-blocking already.
- **Hashing the serializer source into the cache key:** Not shipped. Round-trip CI fidelity test catches the same risk loudly during PR review when `index-cache.ts` changes; baking the hash adds build-time complexity for marginal gain.

Still open for implementation:

- **Pi extension factory ordering:** does `factory()` run to completion before the first `session_start`? If yes, pre-warm timing is ideal. If no, `applyDefaultMode` SHALL reuse the pre-warmed engine and attach to (NOT block on) the in-flight pre-warm init promise via the same `initInFlight` reuse path that `enable()` uses for double-enable dedupe (covered by the pre-warm-handoff scenario in the toggle-command spec). Either way, no command is forced to await initialization. Verify during implementation; the spec wording supports either ordering.
- **Eviction during failed rebuilds:** prune-on-hit only fires on a *successful* load. If a user changes `maxEditDistance` and the new build fails, the old cache for the old value is not pruned. This is intentional (no successful new state to prune toward) and acceptable; documenting it here for clarity.
