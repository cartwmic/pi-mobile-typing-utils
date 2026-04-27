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
- `maxEditDistance` (integer `1`–`3`, default `2`) — SymSpell lookup distance. Higher catches more typos but produces more false positives and grows memory cost. The change takes effect on the next correction; if autocorrect is currently running, the engine is hot-reloaded automatically.
- `minWordLength` (integer `2`–`8`, default `2`) — minimum word length eligible for correction. Higher = fewer false positives on short noisy sequences but you stop correcting things like `te` → `be`. Read live by the engine; takes effect on the next lookup with no rebuild.

## How it works

- **Three-layer dictionary lookup:** learned words first, bundled tech terms second, bundled SymSpell English last.
- **Token eligibility gate:** only tokens matching `^[A-Za-z]{3,}$` are considered for correction.
- **Case preservation:** `Teh` becomes `The`, `TEH` becomes `THE`, and `teh` becomes `the`.
- **Backspace-to-undo learning loop:** if you immediately backspace a correction, the original word is restored; repeated rejections teach the extension to keep that word in the future.

## Known limitations

- Concurrent sessions writing the same learned dictionary file use last-write-wins behavior.
- Typos of tech-dictionary words are not corrected in v1; the tech dictionary is a whitelist, not a correction source.
- Edit distance 1 misses some real typos by design.
- Rejection counts persist across sessions until the learning threshold is reached.
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
