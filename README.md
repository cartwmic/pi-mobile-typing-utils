# pi-mobile-typing-utils

Mobile-friendly autocorrect utilities for Pi's terminal editor.

## Why

Typing into Pi from Termux over SSH on Android is great for mobility, but it removes the autocorrect help you normally get from a phone keyboard. That makes natural-language prompting noticeably noisier: typos leak into prompts, commit messages, filenames, and generated code. This extension adds a lightweight correction layer inside Pi itself so mobile sessions get Gboard-style word-by-word autocorrect without fighting terminal input.

## Installation

Install from npm:

```bash
pi install pi-mobile-typing-utils
```

For local development from this repo:

```bash
npm install
npm run build
pi -e ./dist/index.js
```

You can also run `npm run dev:install` for a rebuild plus local loading/copy instructions. The repo includes `.pi/extensions/` as a convenient local staging directory, but Pi auto-discovery on your dev machine still expects the compiled `dist/` and `data/` assets under `~/.pi/agent/extensions/mobile-autocorrect/`.

## Usage

Toggle autocorrect:

- `/typos`
- `/typos on`
- `/typos off`

Manage the learned dictionary:

- `/typos dict`
- `/typos dict search <term>`
- `/typos dict add <word>`
- `/typos dict remove <word>`
- `/typos dict clear`

Configure the default mode for new sessions:

- `/typos default` — show the current configured default (`on` or `off`).
- `/typos default on` — new sessions start with autocorrect enabled.
- `/typos default off` — new sessions start with autocorrect disabled (the bootstrap default; matches the original per-session behavior).

The value is persisted to `~/.pi/agent/mobile-autocorrect-config.json` (override with `MOBILE_AUTOCORRECT_CONFIG_PATH`). On every session start the extension reconciles the session to the configured mode in both directions, silently when state already matches.

Tune the correction engine:

- `/typos config` — list all configured values with their ranges.
- `/typos config <key>` — show one value (`defaultMode`, `maxEditDistance`, `minWordLength`).
- `/typos config <key> <value>` — set and persist.

Knobs:

- `defaultMode` (`on`/`off`, default `off`) — same value the dedicated `/typos default` command edits.
- `maxEditDistance` (integer `1`–`4`, default `2`) — SymSpell lookup distance (the upper cap of the adaptive ED curve). Higher catches more typos but produces more false positives and grows memory cost. If autocorrect is currently running, the engine is hot-reloaded automatically when you change this.

  > **Warning — ED=4 is experimental.** At edit distance 4, lookups are roughly 7× slower and the false-positive rate climbs sharply: at distance 4, almost any misspelled English word matches *something* in the 82k-word dictionary, often semantically unrelated (e.g., `kbuernetes → burners`). Use ED=4 only for testing long-word coverage and expect unexpected corrections.

  > **Rejection rule:** lowering `maxEditDistance` below the current `minEditDistance` is rejected with an actionable error. Raise `minEditDistance` first, or lower both together.

- `minEditDistance` (integer `0`–`maxEditDistance`, default `1`) — floor edit distance for the adaptive ED curve. Words too short to be ramped above this threshold are corrected at exactly this distance. `0` effectively disables correction for short words (exact-match only, which the identity-suppression rule removes, yielding no correction).
- `editDistanceStepEvery` (integer `1`–`8`, default `4`) — how many additional characters of word length are needed to ramp the effective edit distance up by one step.

  The adaptive curve formula is:
  ```
  ED(L) = clamp(minED + floor((L - minWordLength) / step), minED, maxED)
  ```
  Example with defaults (minED=1, step=4, minWL=2, maxED=2):
  | Word length | Effective ED |
  |-------------|-------------|
  | 2–5         | 1           |
  | 6+          | 2 (capped)  |

  With maxED=4 and the same minED=1, step=4, minWL=2:
  | Word length | Effective ED |
  |-------------|-------------|
  | 2–5         | 1           |
  | 6–9         | 2           |
  | 10–13       | 3           |
  | 14+         | 4 (capped)  |

- `minWordLength` (integer `2`–`8`, default `2`) — minimum word length eligible for correction. Higher = fewer false positives on short noisy sequences but you stop correcting things like `te` → `be`. Read live by the engine; takes effect on the next lookup with no rebuild.

## How it works

- **Three-layer dictionary lookup:** learned words first, bundled tech terms second, bundled SymSpell English last.
- **Token eligibility gate:** only tokens matching `^[A-Za-z]{3,}$` are considered for correction.
- **Case preservation:** `Teh` becomes `The`, `TEH` becomes `THE`, and `teh` becomes `the`.
- **Backspace-to-undo learning loop:** if you immediately backspace a correction, the original word is restored; repeated rejections teach the extension to keep that word in the future.
- **Lazy engine initialization:** `/typos on` returns immediately; a persistent status indicator shows `Autocorrect loading…` while the engine builds in the background, then transitions to `✓ Autocorrect` (or `Autocorrect unavailable` on failure). When `defaultMode: on`, the engine pre-warms at extension load to overlap initialization with extension startup.

### Index cache

After a successful first build, the extension writes a binary SymSpell index cache to disk so subsequent sessions load quickly instead of rebuilding from scratch.

- **Cache file location:** `~/.pi/agent/cache/mobile-autocorrect/symspell-{key}.bin`
- **Override location:** set `MOBILE_AUTOCORRECT_CACHE_DIR` to a different directory path.
- **Cache invalidation:** the key embeds `maxEditDistance`, `prefixLength`, `compactLevel`, `countThreshold`, the symspell-ts package version, and a schema version. Changing `maxEditDistance` (or upgrading symspell-ts) automatically invalidates the cache; stale sibling files are pruned on every successful load.
- **Safe to delete:** the cache is purely a performance optimization. Deleting `~/.pi/agent/cache/mobile-autocorrect/` causes the engine to rebuild on next session start and re-write the cache — functionality is unaffected.
- **Approximate size:** ~30 MB per `maxEditDistance` value (varies slightly; measured ~29.8 MB at ED=4).
- **POSIX-only atomic writes:** the cache write uses `rename()` for atomic replacement on POSIX systems. On Windows the cache is skipped (the engine builds from scratch every session, which still works correctly).

## Known limitations

- Concurrent sessions writing the same learned dictionary file use last-write-wins behavior.
- Typos of tech-dictionary words are not corrected in v1; the tech dictionary is a whitelist, not a correction source.
- Rejection counts persist across sessions until the learning threshold is reached.
- ED=4 may produce nonsensical corrections on novel long words (e.g., `kbuernetes → burners`).
- Two parallel sessions with different `maxEditDistance` values in the same cache directory will thrash each other's cache files; set `MOBILE_AUTOCORRECT_CACHE_DIR` to a different path per session to isolate them.
- Apostrophe and contraction handling is best-effort; see `NOTES.md` for the `dont`/`wont`/`its` findings from task 3.0.
- The last word before Enter/submit is **not** corrected; corrections only trigger on space or supported punctuation.
- Words immediately followed by `)`, `]`, `}`, `"`, or `'` are not corrected.
- Mixed-case input such as `tHe` falls back to lowercase on correction.
- Multi-line paste depends on bracketed paste mode; without it, `\n` may trigger submit behavior.
- In multi-correction pastes, only the last correction can be undone with immediate backspace.
- Buffered SSH input can make an immediate post-trigger backspace undo fire unexpectedly in rare cases.
- Atomic learned-dictionary saves assume a filesystem that supports atomic rename semantics; FAT-style filesystems are not guaranteed.
- Toggling autocorrect preserves draft text but resets the cursor to the end of the buffer because Pi does not expose a public cursor-restore API for editor swaps.

## Development

```bash
npm install
npm run build
npm run build:dict
npm test
pi -e ./dist/index.js
```

Useful development notes:

- Run `npm run dev:install` to rebuild and print local loading instructions.
- Run `npm run dev:reload-hint` for the `/reload` reminder.
- In a live Pi session, run `/reload` after rebuilding to hot-reload the extension.
- Use `docs/live-validation-checklist.md` for the manual live-validation pass.
