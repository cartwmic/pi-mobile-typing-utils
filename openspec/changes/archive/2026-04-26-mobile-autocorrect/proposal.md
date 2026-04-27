## Why

Typing prompts to Pi via Termux → SSH → Zellij on an Android phone produces frequent typos because Termux disables Gboard's autocorrect and swipe typing (they cause duplicate characters and gibberish in terminal contexts). This is the right default for terminal input, but Pi's input is natural language — it benefits from autocorrect. Typos leak into Pi's outputs: wrong variable names, mangled commit messages, confused code generation. A correction layer inside Pi itself solves this without fighting the terminal's input model.

## What Changes

- New Pi extension (`pi-mobile-typing-utils`) providing real-time, word-by-word autocorrect in the Pi input editor
- Custom editor component (`AutocorrectEditor`) extending Pi's `CustomEditor` that intercepts keystrokes, corrects words on space/punctuation, and supports backspace-to-undo
- Correction engine using `symspell-ts` (SymSpell algorithm, edit distance 1, frequency-ranked) with a layered dictionary: bundled English (82K words), bundled tech/dev terms (~23K words from cspell-dicts), and a user-learned dictionary
- Learning dictionary that grows from rejected corrections — when the user backspaces to undo an autocorrection, the original word is tracked; after repeated rejections, it's added to the learned dictionary automatically
- Status-line feedback showing corrections briefly (e.g. "✓ teh → the" in Pi's footer for ~500ms)
- `/typos` command for toggling autocorrect on/off (per-session) and managing the learned dictionary (view, search, add, remove words)
- Extension packaged as an npm `pi-package` installable via `pi install`

## Capabilities

### New Capabilities
- `autocorrect-engine`: SymSpell-based correction engine with layered dictionary lookup (learned → tech → English), edit distance 1, frequency-ranked suggestions
- `autocorrect-editor`: Custom Pi editor component that intercepts keystrokes, triggers word-by-word correction on space/punctuation, supports backspace-to-undo, and shows correction feedback via the status line
- `dictionary-management`: Learned dictionary persistence, automatic learning from correction rejections, and `/typos dict` commands for viewing, searching, adding, and removing words
- `toggle-command`: `/typos` command for per-session toggle of autocorrect (on/off), with explicit `/typos on` and `/typos off` variants, plus `/typos dict` subcommands for dictionary management

### Modified Capabilities

_None — this is a new extension with no existing specs._

## Impact

- **New npm package**: `pi-mobile-typing-utils` with `pi-package` keyword and `pi.extensions` field
- **Dependencies**: `symspell-ts` (SymSpell algorithm + bundled English dictionary), `@mariozechner/pi-coding-agent` (peer dep for extension API types)
- **Bundled data**: Pre-compiled tech dictionary (~23K words aggregated from `@cspell/dict-software-terms`, `@cspell/dict-typescript`, `@cspell/dict-node`, `@cspell/dict-python`, `@cspell/dict-k8s` at build time)
- **User data**: Learned dictionary stored at `~/.pi/agent/mobile-autocorrect-dictionary.json`
- **Pi editor**: When enabled, replaces the default editor component via `ctx.ui.setEditorComponent()` — restored to default on `/typos off`
- **No breaking changes**: Extension is opt-in, toggle-gated, and has no effect when disabled
