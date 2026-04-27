## ADDED Requirements

### Requirement: Token eligibility gate before correction
The editor SHALL only send tokens to the correction engine that match natural-language word patterns. Tokens SHALL be skipped (not corrected) if they contain: path separators (`/`, `\`), dots (file extensions like `.ts`, `.md`), underscores (`snake_case`), hyphens (`kebab-case`), leading dashes (flags like `--force`), digits mixed with letters (`v1beta1`, `s3`), or any non-alphabetic characters other than the trailing trigger character. This gate catches most but not all code-like tokens; pure-alphabetic identifiers in code contexts may still be corrected (known limitation documented in README).

#### Scenario: File path not corrected
- **WHEN** the user types `src/autocorect-editor.ts ` (space after a path-like token)
- **THEN** the editor SHALL NOT attempt to correct any part of the path

#### Scenario: Snake-case identifier not corrected
- **WHEN** the user types `my_var ` (space after an underscore-containing token)
- **THEN** the editor SHALL NOT attempt to correct it

#### Scenario: CLI flag not corrected
- **WHEN** the user types `--forc ` (space after a flag-like token)
- **THEN** the editor SHALL NOT attempt to correct it

#### Scenario: Version string not corrected
- **WHEN** the user types `v1beta1 ` (space after a mixed alphanumeric token)
- **THEN** the editor SHALL NOT attempt to correct it

#### Scenario: Plain word is eligible
- **WHEN** the user types `teh ` (space after a pure-alphabetic token of 3+ chars)
- **THEN** the editor SHALL pass "teh" to the correction engine

#### Scenario: Apostrophe-containing word not corrected
- **WHEN** the user types `don't ` (space after an apostrophe-containing token)
- **THEN** the editor SHALL NOT attempt to correct it (apostrophe is non-alphabetic)

#### Scenario: Non-ASCII word not corrected
- **WHEN** the user types `café ` (space after a token with non-ASCII characters)
- **THEN** the editor SHALL NOT attempt to correct it ("alphabetic" means `[A-Za-z]` only)

### Requirement: Word-by-word correction on space and punctuation
The editor SHALL trigger autocorrect on the eligible token immediately before the cursor when the user types a space or natural-language punctuation character (`. , ; : ! ?`). The trigger set is restricted to natural-language sentence terminators and the comma/semicolon/colon family; brackets, braces, parentheses, quotes, and programming-specific punctuation are excluded. (Rationale: `)` was removed because it rarely terminates natural-language words in chat-style prompts; `"` and `'` are excluded to avoid interaction with quoting.)

#### Scenario: Space triggers correction
- **WHEN** the user types "teh" followed by a space
- **THEN** the editor SHALL replace "teh" with "the" and insert the space after it, so the editor shows "the "

#### Scenario: Punctuation triggers correction
- **WHEN** the user types "modle." (period after typo)
- **THEN** the editor SHALL replace "modle" with "model" and insert the period, so the editor shows "model."

#### Scenario: No correction available
- **WHEN** the user types a word followed by space and the correction engine returns no suggestion
- **THEN** the editor SHALL insert the space without modifying the word

#### Scenario: Identity match is not a correction
- **WHEN** the user types "the " and the engine finds "the" as an exact match (distance 0)
- **THEN** the editor SHALL NOT report a correction event (no feedback, no rejection tracking)

### Requirement: Correction only triggers at word boundary after text
The editor SHALL only trigger correction when the character immediately before the cursor (before the trigger character) is a letter. If the cursor is at the start of a line, after whitespace, or after a non-letter character, no correction SHALL be attempted.

#### Scenario: Cursor in middle of text after moving
- **WHEN** the user positions the cursor between two existing words and types space
- **THEN** the editor SHALL NOT attempt to correct the preceding text (the word boundary context is ambiguous — both the character before the trigger and the character after the inserted trigger must be checked to confirm a true word-end boundary)

#### Scenario: Double space
- **WHEN** the user types space when the previous character is already a space
- **THEN** the editor SHALL NOT attempt correction (just insert the space)

### Requirement: Backspace within one character undoes correction
When the user's immediate next action after a correction is backspace, the editor SHALL undo the entire correction: restore the original word and remove the trailing space/punctuation that triggered the correction. If any other key is pressed first, the correction is committed.

#### Scenario: Immediate backspace after correction
- **WHEN** the editor corrects "teh " to "the " and the user immediately presses backspace
- **THEN** the editor SHALL restore the text to "teh" (original word, no trailing space) with the cursor after the restored word

#### Scenario: Typing after correction commits it
- **WHEN** the editor corrects "teh " to "the " and the user types any character other than backspace
- **THEN** the correction is committed and backspace SHALL behave normally (delete previous character)

#### Scenario: Cursor movement commits correction
- **WHEN** the editor corrects "teh " to "the " and the user moves the cursor (arrow keys, Home, End)
- **THEN** the correction is committed (cursor movement counts as "any other key")

#### Scenario: Tracking state cleared after undo
- **WHEN** the user backspaces to undo a correction (restoring "teh")
- **THEN** the correction tracking record SHALL be cleared. A subsequent backspace SHALL perform a normal character delete (removing the last character of "teh")

#### Scenario: Backspace in same buffered chunk as trigger
- **WHEN** a buffered SSH chunk contains both a trigger and a backspace (e.g., `"teh \x7F"`), causing correction then immediate undo in the same `handleInput` call
- **THEN** the undo SHALL still fire (the backspace is the "next action" after the correction within the byte-by-byte dispatch). This is accepted behavior — the user intended to delete a character, and the system interprets the backspace as undo since it immediately follows a correction. Documented in known limitations.

#### Scenario: Double-backspace after correction
- **WHEN** the editor corrects "teh " to "the " and the user presses backspace twice rapidly
- **THEN** the first backspace undoes the correction (restoring "teh"), and the second backspace deletes the last character (producing "te")

#### Scenario: Rejected word is not re-corrected on next space
- **WHEN** the user rejects a correction for "termux" (backspace to undo) and then types space after the restored "termux"
- **THEN** the editor SHALL NOT re-trigger the same correction for "termux" at this buffer position (keyed on `(lineIndex, wordStartOffset)`)

#### Scenario: Rejection suppression clears when cursor leaves the line
- **WHEN** the user rejects a correction on line 1 and moves the cursor to line 2
- **THEN** the suppression entry for the rejected word on line 1 SHALL be cleared

#### Scenario: Rejection suppression clears when word is edited
- **WHEN** the user rejects a correction for "termux" and then inserts text before the rejected word (shifting its position)
- **THEN** the suppression entry SHALL be cleared (the cached offset no longer points at the original word)

#### Scenario: Rejection suppression is re-validated at trigger time
- **WHEN** a trigger character is typed and the editor consults `recentlyRejected` for the token
- **THEN** the editor SHALL re-validate the entry at that moment: confirm `lineIndex === currentCursorLine` AND `getText().slice(offset, offset + original.length) === original`. If either check fails, the entry is dropped and correction proceeds normally.

#### Scenario: Rejection suppression clears when word is deleted
- **WHEN** the user rejects a correction and then deletes the rejected word entirely
- **THEN** the suppression entry SHALL be cleared

### Requirement: Correction feedback via status line
When a word is corrected, the editor SHALL display a status message via the injected UI adapter's `setStatus("typos-correction", "✓ teh → the")` for approximately 500ms, then clear it via `setStatus("typos-correction", undefined)`. (All status clearing uses `setStatus(key, undefined)` as the canonical API.) This avoids corrupting the editor's existing ANSI escape sequences in rendered output.

#### Scenario: Status line shows correction
- **WHEN** the editor corrects "teh" to "the"
- **THEN** a status message "✓ teh → the" SHALL appear in Pi's footer via `setStatus("typos-correction", ...)`

#### Scenario: Status clears after timeout
- **WHEN** 500ms has elapsed since the most recent correction
- **THEN** the status message SHALL be cleared via `setStatus("typos-correction", undefined)`. Each new correction cancels the previously scheduled clear timer before scheduling a new one.

### Requirement: No correction when autocomplete is showing
The editor SHALL NOT trigger autocorrect when Pi's autocomplete dropdown is visible.

#### Scenario: Space during autocomplete
- **WHEN** the user is browsing autocomplete suggestions (e.g., slash commands) and presses space
- **THEN** the editor SHALL NOT autocorrect the word before the cursor

### Requirement: Handles multi-character input (paste/buffer)
When `handleInput(data)` receives a multi-character payload, the editor SHALL classify and dispatch it:

1. **Escape sequences** (payload starts with an escape byte): pass the entire payload through to `super.handleInput(data)` untouched.
2. **Otherwise**: process byte-by-byte. Known control characters (backspace, Enter, Tab) dispatch to their normal handlers individually. Printable bytes accumulate and trigger correction at each trigger character position. This handles SSH-buffered chunks where printable text and control characters are interleaved. (See design Decision 7a for byte-level classification details.)

#### Scenario: Pasted text with spaces
- **WHEN** `handleInput` receives `"fix teh bug "` as a single chunk
- **THEN** the editor SHALL correct "teh" to "the" (trigger at the space after "teh") and leave "fix" and "bug" unmodified

#### Scenario: Pasted text with no triggers
- **WHEN** `handleInput` receives `"kubernetes"` as a single chunk (no trailing space)
- **THEN** the editor SHALL insert the text without triggering any correction

#### Scenario: Escape sequence passthrough
- **WHEN** `handleInput` receives a multi-byte escape sequence (e.g., arrow keys)
- **THEN** the editor SHALL pass the entire sequence through to `super.handleInput(data)` without character-by-character iteration or correction attempts

#### Scenario: Buffered input with interleaved control characters
- **WHEN** `handleInput` receives a chunk containing printable text interleaved with control characters (e.g., text + backspace from SSH buffering)
- **THEN** the editor SHALL process byte-by-byte: printable text accumulates and triggers correction at trigger characters; backspace dispatches to the backspace/undo handler; Enter/Tab delegate to their normal handlers

#### Scenario: Pasted multi-line text (known v1 limitation)
- **WHEN** `handleInput` receives text containing `\n` (e.g., `"fix teh\nbug "`)
- **THEN** the newline is delegated to `super.handleInput` which may treat it as Enter/submit (Pi's TUI convention). Multi-line paste safety depends on bracketed paste mode, which is not in scope for v1. If `\n` triggers submit, only text before the first `\n` is processed for corrections. This is a documented known limitation.

#### Scenario: Multiple corrections in single paste
- **WHEN** `handleInput` receives `"fix teh bug nad more "` triggering corrections for both "teh" and "nad"
- **THEN** both corrections SHALL be applied, and the status line SHALL show only the last correction ("✓ nad → and")

### Requirement: Extends CustomEditor preserving all standard behavior
The autocorrect editor SHALL extend Pi's `CustomEditor` class, delegating all unhandled keystrokes to `super.handleInput(data)`. All standard editor features (multi-line editing, undo, history, cursor movement, autocomplete, app keybindings) SHALL continue to work. Word replacement SHALL use cursor-position-aware editing operations rather than whole-buffer `setText()` replacement, preserving cursor state and keeping programmatic edits undoable; task 4.7 verified that built-in undo batching for an accepted correction is best-effort because Pi's public editor API does not expose an atomic delete+insert replacement primitive.

#### Scenario: Standard editing works
- **WHEN** the user uses arrow keys, Ctrl+C, Ctrl+D, undo, or any standard editor key
- **THEN** the editor SHALL behave identically to the default `CustomEditor`

#### Scenario: Multi-line editing
- **WHEN** the user types Shift+Enter for a new line
- **THEN** the editor SHALL insert a newline without triggering autocorrect

#### Scenario: Last word before submit is not corrected (known v1 limitation)
- **WHEN** the user types "fix teh" and presses Enter to submit without a trailing space or punctuation
- **THEN** "teh" is NOT corrected (Enter/submit is not a correction trigger in v1). This is a documented known limitation.

#### Scenario: Undo after correction
- **WHEN** the user accepts a correction (types past it) and then presses undo
- **THEN** IF the editor's undo system supports batching programmatic edits into a single undo unit (verified in task 4.7), the built-in undo SHALL restore the pre-correction state. IF undo batching is not available, this scenario is narrowed to: only immediate backspace-to-undo (within the 1-character window) is guaranteed; built-in undo behavior for programmatic edits is best-effort.

### Requirement: Correction tracks rejection for dictionary learning
When the user undoes a correction via backspace, the editor SHALL notify the dictionary management system of the rejection, passing the original word. The rejection counter is keyed on the original word regardless of what correction was suggested.

#### Scenario: Rejection signal sent on undo
- **WHEN** the user backspaces to undo a correction of "nginx" → "engine"
- **THEN** the editor SHALL report to the dictionary system that "nginx" was rejected as a correction target

#### Scenario: Rejection keyed on original word
- **WHEN** the user rejects corrections for "nginx" twice, even if the suggested corrections were different each time
- **THEN** both rejections SHALL count toward the same "nginx" rejection counter

### Requirement: Editor receives UI capabilities via injected adapter
The editor SHALL receive a UI adapter (providing `setStatus` and `notify` callbacks) via its constructor, rather than requiring direct access to `ctx.ui`. Status clearing uses `setStatus(key, undefined)`. This decouples the editor from the extension context and enables testing with mocked UI.

#### Scenario: Editor uses injected adapter for status
- **WHEN** the editor needs to show correction feedback
- **THEN** it SHALL call the injected `setStatus` callback, not reference `ctx.ui` directly
