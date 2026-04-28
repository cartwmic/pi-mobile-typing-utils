# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/) and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `/typos default [on|off]` subcommand and persistent extension configuration (`~/.pi/agent/mobile-autocorrect-config.json`, override with `MOBILE_AUTOCORRECT_CONFIG_PATH`) to control the autocorrect mode new sessions start in. The bootstrap value is `off`, preserving prior per-session behavior; setting it to `on` reconciles every `session_start` event to enabled. Reconciliation is bidirectional and silent when state already matches.
- `/typos config [defaultMode|maxEditDistance|minWordLength|minEditDistance|editDistanceStepEvery] [<value>]` flat key/value tuning surface, persisted to the same config file. `maxEditDistance` (integer `1`–`4`, default `2`) is baked into the SymSpell index at engine build time — changing it drops the cached engine and, when autocorrect is currently enabled, hot-reloads it. `minWordLength` (integer `2`–`8`, default `2`) is read live by the correction engine on every lookup, no rebuild required. All values are range-validated; out-of-range or non-integer inputs are rejected without modifying the persisted config. Out-of-range *persisted* values fall back to the bootstrap default for that key on load.
- Two new `/typos config` knobs: `minEditDistance` (integer `0`–`maxEditDistance`, default `1`) and `editDistanceStepEvery` (integer `1`–`8`, default `4`). Together with `maxEditDistance`, these drive an adaptive per-word-length edit distance curve `ED(L) = clamp(minED + floor((L - minWordLength) / step), minED, maxED)` that is tighter on short words (reducing false positives) and more permissive on long words (catching more typos). Both knobs are read live by the engine — no rebuild required when changed.
- Expanded `maxEditDistance` range from `[1, 3]` to `[1, 4]`. Default unchanged at `2`. ED=4 is experimental: lookups are ~7× slower and false positives climb sharply; see README for details.
- Faster startup via lazy/non-blocking engine initialization. `/typos on` returns immediately; a persistent status indicator shows `Autocorrect loading…` while the engine initializes in the background, then transitions to `✓ Autocorrect` (or `Autocorrect unavailable` on failure). When `defaultMode: on`, the engine pre-warms at extension load to overlap initialization with extension startup, reducing perceived cold-start time.
- Persistent on-disk SymSpell index cache at `~/.pi/agent/cache/mobile-autocorrect/symspell-{key}.bin` (override via `MOBILE_AUTOCORRECT_CACHE_DIR`). A cache hit (~200 ms on macOS) replaces the multi-second fresh build. Stale sibling cache files are pruned on every successful load. Cache load failures fall through to a fresh build transparently.
- Bigram dictionary no longer loaded — the extension only calls `lookup()`, not `lookupCompound()` or `wordSegmentation()`, which are the only bigram consumers. Dropping bigrams saves ~24 MB of resident memory and approximately 30% of build time on a fresh build.

## [0.1.0] - 2026-04-26

### Added

- Real-time mobile-friendly autocorrect for Pi's editor with word-by-word correction on space and punctuation triggers.
- A layered dictionary system combining a learned dictionary, a bundled tech-term whitelist, and SymSpell English suggestions.
- Learned-dictionary persistence with manual `/typos dict` management commands.
- `/typos`, `/typos on`, and `/typos off` commands for per-session enable/disable control.
- Gboard-style immediate backspace undo for the most recent correction, including rejection-based auto-learning.
- Automated integration coverage for autocomplete non-interference, toggle lifecycle behavior, token eligibility, and case preservation.

### Notes

- Tag with `git tag v0.1.0 && git push --tags` once integration tests pass on the user's mobile setup.
