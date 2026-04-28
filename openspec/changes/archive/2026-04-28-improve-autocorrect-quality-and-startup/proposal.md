# Proposal

## Why

Two related pain points block daily mobile use today:

1. **The current uniform `maxEditDistance: 2` across all word lengths is the wrong shape.** Empirically it produces a steady stream of false positives on 2- and 3-letter inputs (e.g. `te → the`, `ot → of`, `ho → to`) — every short string is within distance 2 of a hyper-frequent function word — while still missing a tail of long-word typos that need ED 3 or 4 (`accomodatte`, `kubrnetes`, `kbuernetes`).
2. **Every `/typos on` (and every `session_start` when `defaultMode: on`) blocks for multiple seconds while the SymSpell index is rebuilt from scratch.** Measured cold-start build is ~1.2 s at ED=2 on a fast laptop and extrapolates to 3–10 s on Termux/phone hardware. The user can't type until it finishes.

Both problems compound: raising the ceiling to catch long-word typos makes the build slower, and tightening the curve at the short end is wasted if startup feels broken.

## What Changes

- **Adaptive edit-distance curve.** Replace the single fixed `maxEditDistance` per-lookup behavior with a per-word-length policy: `ED(L) = clamp(minED + floor((L - minWordLength) / step), minED, maxED)`. Two new tunable knobs — `minEditDistance` (default `1`) and `editDistanceStepEvery` (default `4`) — describe the ramp; the existing `maxEditDistance` becomes the upper cap.
- **Raise `maxEditDistance` ceiling from 3 to 4.** The current range is `[1, 3]`. New range is `[1, 4]`. The default stays at `2` — `4` is opt-in for users who want to test long-word coverage and accept the higher false-positive rate it brings. `prefixLength=7 > maxED=4` constraint still holds.
- **Drop bigram loading.** symspell-ts loads ~243k bigram entries to support `lookupCompound()` and `wordSegmentation()`. The extension only calls `lookup()`, which never consults bigrams. Skipping the bigram load shrinks the in-memory index, speeds up fresh builds, and shrinks the cache file.
- **Lazy engine initialization.** `enable()` no longer awaits `engine.initialize()`. Control returns to the toggle command immediately, so `/typos on`, `/typos off`, and `/typos config maxEditDistance` all behave responsively from the user's perspective. **Caveat:** the underlying SymSpell deletion-table build is CPU-bound and runs synchronously on a single event-loop tick, so on cache miss (first run, library upgrade, or after a `maxEditDistance` change) the editor will still be unable to process keystrokes during the build phase — 1–3 s on macOS, 3–10 s on Termux. The cache subsystem makes cache HIT the steady-state path, where the load is short enough (~200 ms macOS / ~400–600 ms estimated Termux) to be effectively imperceptible. Pre-warm at extension load further hides the cache-miss build for `defaultMode === "on"` users by overlapping it with extension startup. Chunking the build with `setImmediate` yields would make the cache-miss path truly event-loop-non-blocking and is the natural follow-up if the residual cache-miss freeze proves painful in practice.
- **Pre-warm at extension load when `defaultMode === "on"`.** Kick off engine init during the extension's bootstrap (before `session_start`) so the build is usually finished by the time the user types their first word.
- **Disk-cached SymSpell index.** New `index-cache` capability: the built index is serialized to a binary file under `~/.pi/agent/cache/mobile-autocorrect/symspell-{key}.bin` after a successful fresh build. Subsequent sessions load the cache (~200 ms on a laptop, est. 400–600 ms on Termux) instead of rebuilding (~1–10 s). Cache key embeds `(maxEditDistance, prefixLength, compactLevel, symspell-ts version, schema version)` so any change to inputs invalidates the cache. Stale sibling caches are pruned on every successful load. Corrupted cache reads fall through to a fresh build.
- **New `/typos config` knobs** (`minEditDistance`, `editDistanceStepEvery`) with the same range-validated, persisted, auto-completable UX as the existing keys.
- **Engine-state surface via the persistent status indicator.** The persistent status indicator (`setStatus("typos", ...)`) reports loading / ready / degraded states alongside on/off, so users can see what's happening during cold starts and diagnose cache or build failures. The bare `/typos` toggle's notification text also reflects readiness when transitioning into the enabled state.

## Capabilities

### New Capabilities
- `index-cache`: persistent on-disk cache for the SymSpell deletion index, keyed by inputs that affect the index, with atomic writes, sibling pruning, and graceful fall-through to fresh build on corruption or version drift.

### Modified Capabilities
- `autocorrect-engine`: adaptive per-word-length edit distance curve at lookup time; `maxEditDistance` ceiling raised to `4`; bigrams no longer loaded; engine instances may be hydrated from the index cache instead of built from scratch (with identical lookup behavior either way).
- `toggle-command`: enable/disable no longer block on initialization; engine init runs in the background with explicit loading/ready/degraded states surfaced in the `/typos` status output and persistent status indicator; engine pre-warms at extension load when `defaultMode: on`; new `minEditDistance` and `editDistanceStepEvery` keys exposed via `/typos config` (range-validated, persisted, completed); `maxEditDistance` range expanded to `[1, 4]`.

## Impact

- **Code:**
  - `src/correction-engine.ts`: adaptive ED computation in `shouldCorrect`; constructor accepts the curve knobs; bigrams skipped during initialization; new `hydrateFromCache` / `serializeToCache` (or equivalent) factory paths.
  - `src/commands.ts`: `enable()` / `applyDefaultMode()` no longer await init; new in-flight init promise tracked alongside `toggleInFlight` for race safety with `disable()` and rebuild; new config handlers for `minEditDistance`, `editDistanceStepEvery`; `maxEditDistance` validator widened to `[1, 4]`; `/typos` status surface extended for loading/ready/degraded.
  - `src/config.ts`: new persisted keys with ranges; range constants exported for command-layer validation.
  - **New** `src/index-cache.ts`: binary serializer/deserializer, key derivation, atomic write, sibling prune, fall-through.
  - `index.ts`: pre-warm engine when `config.defaultMode === "on"` at extension bootstrap.
- **APIs:** No external API changes. New optional constructor arguments on `CorrectionEngine` are additive. `ExtensionAPI` unchanged.
- **Dependencies:** No new runtime dependencies. The cache reaches into nominally-private fields (`words`, `deletes`, `maxDictionaryWordLength`) of `SymSpell`; the symspell-ts version is part of the cache key so an upgrade auto-invalidates. A round-trip fidelity test runs on every CI build to detect any internal restructuring early.
- **Filesystem:**
  - **New:** `~/.pi/agent/cache/mobile-autocorrect/symspell-*.bin` (overridable via `MOBILE_AUTOCORRECT_CACHE_DIR`). Roughly 30 MB per `maxEditDistance` value at the upper end of the range.
  - **Unchanged:** `~/.pi/agent/mobile-autocorrect-config.json`, `~/.pi/agent/mobile-autocorrect-dictionary.json`. No migration.
- **User-visible defaults:** All defaults preserved (`maxEditDistance: 2`, `minWordLength: 2`, `defaultMode: "off"`). New defaults: `minEditDistance: 1`, `editDistanceStepEvery: 4`. With `maxEditDistance: 2` and the default curve, most lengths map to ED=1 or ED=2, slightly more conservative than today on short words and identical on longer ones; users opt in to ED=3 or ED=4 explicitly.
- **Performance budget:**
  - Cold-start blocking: reduced from "multi-second await" to "non-blocking" (lazy fire). Steady-state startup: ~200 ms cache load measured on macOS; Termux numbers (estimated 400–600 ms) are not yet measured and are documented as estimates, not commitments. The lazy-fire path makes the editor non-blocking regardless of cache-load wall time.
  - Memory: bigram drop saves a chunk; index size unchanged.
  - Per-lookup time: unchanged at ED ≤ 3; ~7× slower at ED=4 (still sub-millisecond).
- **No breaking changes** to user config, learned dictionary, command shape, or extension entry point. Existing installs upgrade in place; first session after upgrade does a fresh build (lazy) and writes the cache; subsequent sessions are fast.
