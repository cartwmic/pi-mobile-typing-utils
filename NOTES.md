## symspell-ts contraction probe (task 3.0)
- lookup("dont", dist=1): [{"term":"done","distance":1,"count":102812628}]
- lookup("dont", dist=2): [{"term":"done","distance":1,"count":102812628}]
- lookup("wont", dist=1): [{"term":"wont","distance":0,"count":3978693}]
- lookup("wont", dist=2): [{"term":"wont","distance":0,"count":3978693}]
- lookup("its", dist=1): [{"term":"its","distance":0,"count":525627757}]
- lookup("its", dist=2): [{"term":"its","distance":0,"count":525627757}]
- lookup("cant", dist=1): [{"term":"cant","distance":0,"count":8363193}]
- lookup("cant", dist=2): [{"term":"cant","distance":0,"count":8363193}]

Known limitation: apostrophe handling is not reliable for mobile-style contraction input. The English SymSpell dictionary may treat apostrophe-free forms like `wont`, `its`, and `cant` as valid words, while `dont` prefers `done` instead of `don't`, and the engine deliberately skips tokens containing apostrophes (for example `don't`) because task 3.2 only allows `^[A-Za-z]{3,}$`. README task 8.8 should call out that apostrophe/contraction autocorrect is limited.

## API Verification Checkpoint (task 4.7)

### 1. Extension entrypoint async contract
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/loader.js:223-264`, `:275-278`
- **Verified contract:** Static-only verified. Pi loads the extension module, extracts the default export, and `await`s the factory (`await factory(api)`). `export default async function(pi)` and any Promise-returning extension factory are supported.
- **Action taken:** No change needed.

### 2. `ctx.ui.setEditorComponent()` state preservation
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1452-1505`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/components/editor.js:300-309`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/components/editor.d.ts:99-110`
- **Verified contract:** Static analysis is conclusive for text and cursor behavior. Pi captures only `this.editor.getText()` before a swap, then calls `newEditor.setText(currentText)` (or `defaultEditor.setText(currentText)` on restore). `Editor.setTextInternal()` resets the cursor to the last line / end of line. The public API exposes `getCursor()` but does **not** expose a cursor setter, so cursor position is **not** preserved and cannot be restored via verified public APIs. Behavior if the swap lands during an in-flight `handleInput()` call remains **needs live verification**.
- **Action taken:** Narrowed tasks 6.2/6.3, 8.1a, 8.3, and README task 8.8: treat editor swaps as **text-preserving but cursor-resetting**; do not rely on private editor internals for cursor restoration.

### 3. Bracketed paste
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/stdin-buffer.js:21-22`, `:233-245`, `:249-273`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/terminal.js:99-103`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/components/editor.js:442-465`
- **Verified contract:** Static-only verified inside Pi. When terminal input arrives as bracketed paste, Pi preserves it end-to-end and delivers a single `\x1b[200~...\x1b[201~` payload to `Editor.handleInput()`, which buffers until the end marker and then calls `handlePaste(pasteContent)`. Whether the Termux → SSH → Zellij path actually forwards bracketed paste markers to Pi is **needs live verification**.
- **Action taken:** No spec narrowing yet. Consequence documented: without bracketed paste, pasted `\n` falls back to normal Enter handling and may submit.

### 4. `CustomEditor` constructor signature and `handleInput(data)` contract
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/custom-editor.d.ts:6-19`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/components/editor.d.ts:67-98`, `:241-242`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/stdin-buffer.js:154-189`, `:275-279`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/terminal.js:79-103`
- **Verified contract:** Static-only verified. `CustomEditor` constructor signature is `(tui, theme, keybindings, options?)`. `handleInput(data)` receives a `string`. Non-escape printable input is normally delivered one character at a time; complete escape/control sequences are delivered as one string; bracketed paste is rewrapped as a single `\x1b[200~...\x1b[201~` string; any incomplete leftover buffered by `StdinBuffer` can flush as a multi-character raw string after timeout.
- **Action taken:** No change needed.

### 5. `ctx.ui.setStatus(key, value)`
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:66-67`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1081-1083`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/core/footer-data-provider.js:114-121`
- **Verified contract:** Static-only verified. API is `setStatus(key: string, text: string | undefined)`. Passing `undefined` deletes the keyed status entry and clears it from the footer.
- **Action taken:** No change needed.

### 6. `ctx.ui.setEditorComponent()` signature and restore behavior
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:112-145`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1452-1505`
- **Verified contract:** Static-only verified. Signature is factory-only: `setEditorComponent((tui, theme, keybindings) => EditorComponent)` or `undefined`. Passing `undefined` restores the default editor. There is no instance-taking overload. Same-stack / in-flight `handleInput()` swap behavior remains **needs live verification**.
- **Action taken:** Same task narrowing as item 2; probe added for live race observation.

### 7. `ctx.ui.notify()` shape, levels, and multiline suitability
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:62-63`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1510-1519`, `:2137-2152`, `:2539-2547`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/components/text.js:3-4`, `:37-86`
- **Verified contract:** Static-only verified. Signature is `notify(message: string, type?: "info" | "warning" | "error")`. Valid levels are `info`, `warning`, and `error`. `info` routes to `showStatus()`, `warning` to `showWarning()`, and `error` to `showError()`. All three render chat `Text` components, and `Text` explicitly supports multi-line text with wrapping, so `/typos dict`-style 50+ line output is suitable and non-blocking.
- **Action taken:** No change to task 7.1; `ctx.ui.notify()` remains the intended output mechanism.

### 8. `ctx.ui.confirm()` existence and async contract
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:57-59`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js:1336-1378`
- **Verified contract:** Static-only verified. `ctx.ui.confirm(title, message, opts?)` exists and returns `Promise<boolean>`.
- **Action taken:** No change needed.

### 9. `isShowingAutocomplete()` on `CustomEditor`
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/custom-editor.js:35-46`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/components/editor.d.ts:241-242`
- **Verified contract:** Static-only verified. `CustomEditor` inherits `Editor.isShowingAutocomplete()` and Pi's own `CustomEditor` implementation calls it directly when deciding whether Escape should interrupt or cancel autocomplete.
- **Action taken:** No change needed.

### 10. Command registration `getArgumentCompletions`
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:686-692`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/pi-codex-web-search/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js:256-262`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/autocomplete.js:223-239`
- **Verified contract:** Static-only verified. Registered commands may expose `getArgumentCompletions(argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>`. Pi passes the raw text after the first space in `/command ...`, not a token array, so nested completions must parse that raw argument string themselves.
- **Action taken:** No change needed.

### 11. Backspace key-code under Termux → SSH → Zellij
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/keys.js:520-534`, `:703-726`, `:1014-1017`
- **Verified contract:** Static-only verified inside Pi. On non-Windows sessions, Pi treats both raw DEL (`\x7f`) and raw BS (`\x08`) as plain `backspace`; `alt+backspace` may arrive as `\x1b\x7f` or `\x1b\b`. Which raw sequence the Termux → SSH → Zellij chain actually sends is **needs live verification**.
- **Action taken:** No spec narrowing yet; live probe added.

### 12. Undo semantics for programmatic backspace + insert
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/components/editor.js:802-810`, `:860-872`, `:1005-1034`, `:1583-1596`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/components/editor.d.ts:104-110`
- **Verified contract:** Static-only verified. Pi exposes atomic programmatic insert (`insertTextAtCursor`) but does **not** expose a public atomic delete+insert replacement API or undo-batching primitive. `handleBackspace()` pushes its own undo snapshot, and subsequent programmatic inserts push/coalesce independently. Therefore a correction implemented as programmatic backspace(s) + insert is **not guaranteed** to become one built-in undo unit.
- **Action taken:** Narrowed design, task 5.3, and the autocorrect-editor spec so only the immediate backspace-to-undo path is guaranteed; built-in undo parity for accepted corrections is best-effort.

### 13. `getCursor()` semantics
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/components/editor.d.ts:99-103`, `:168-178`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/components/editor.js:783-785`
- **Verified contract:** Static-only verified. `getCursor()` returns the logical editor coordinates `{ line, col }` backed by `state.cursorLine` / `state.cursorCol`, not display/wrapped-line indices.
- **Action taken:** No change needed.

### 14. `handleInput` delivery for paste with newlines
- **Source of truth:** `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/stdin-buffer.js:233-245`, `:249-279`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/terminal.js:99-103`; `/Users/cartwmic/.config/nvm/versions/node/v22.22.0/lib/node_modules/@marckrenn/pi-sub-core/node_modules/@mariozechner/pi-tui/dist/components/editor.js:442-465`, `:915-959`
- **Verified contract:** Static-only verified. With bracketed paste, Pi delivers one `\x1b[200~...\x1b[201~` payload to `handleInput()`, and `Editor.handlePaste()` then receives the full pasted text with embedded `\n` preserved and normalized. Without bracketed paste, `StdinBuffer` emits ordinary sequences/characters instead, so pasted newlines fall back to normal Enter handling. Whether the mobile terminal path provides bracketed paste is **needs live verification**.
- **Action taken:** No change yet; live probe added.

## Performance baseline
- TODO device model:
- TODO Termux version:
- TODO Android version:
- TODO cold-start procedure:
- TODO measured cold-init time:
- Target: ≤2s cold init on the reference Termux device.

## Adaptive ED + Cache (improve-autocorrect-quality-and-startup)

### Empirical measurements that drove the design

#### Build-time table (macOS, cold start, no cache)

| ED | Build time | Heap delta | Delete buckets | Notes |
|----|-----------|------------|----------------|-------|
| 1  | 511 ms    | +65 MB     | 316k           |       |
| 2  | 1 219 ms  | +100 MB    | 662k           |       |
| 3  | 2 204 ms  | +121 MB    | 750k           |       |
| 4  | 3 147 ms  | +137 MB    | 753k           | lookups 7× slower |

These numbers were measured during the design phase. Exact reproduction is available via `npx tsx bench/build-time.ts` (results vary by hardware; Termux/phone times are 3–10× higher).

#### Cache prototype measurements

| Scenario                      | Time    | Notes              |
|-------------------------------|---------|--------------------|
| Fresh ED=4 build              | 3 263 ms |                   |
| Cache load (read + parse)     | 189 ms  | ~17× speedup       |
| Cache file size               | 29.8 MB |                   |
| Fidelity                      | ✓       | All sample lookups match fresh build |

See `npx tsx bench/cache-load-time.ts` and `npx tsx bench/format-size.ts` for reproducible measurements.

#### Binary format rationale

| Format         | Approximate size | Notes                                   |
|----------------|------------------|-----------------------------------------|
| JSON           | ~86 MB           | Human-readable; too large               |
| JSON + gzip    | ~27 MB           | Requires decompression stream           |
| Binary (naive) | ~50 MB           | Without string-table deduplication      |
| Binary (v1)    | ~29.8 MB         | Deduplicated string table; chosen format |

The custom binary format with a deduplicated string table is the best balance of size and parse speed for the steady-state cache-hit path (~200 ms on macOS).

#### Why bigrams were dropped

`grep` of the codebase confirmed that only `lookup()` is called — `lookupCompound()` and `wordSegmentation()` (the only consumers of bigrams) are never invoked. Loading ~243k bigram entries costs ~24 MB resident memory and roughly 30% of fresh-build time with zero benefit for the `lookup()`-only pipeline. The unigram-only loader (`loadDictionary(text, 0, 1)`) skips bigrams entirely.

When the future "compound correction" capability lands, bigrams will return and the cache schema version will bump from v1 to v2 (existing caches auto-invalidate via the schema version in the cache key).
