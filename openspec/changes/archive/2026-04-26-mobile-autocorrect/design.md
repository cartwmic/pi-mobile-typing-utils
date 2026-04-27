## Context

Pi is a terminal-based coding agent. Users interact by typing natural language prompts into an Editor component within Pi's TUI. When working remotely via Termux (Android) → SSH → Zellij, Gboard's autocorrect is disabled because autocorrect fights with terminal input. This leaves users typing natural language without any correction assistance, producing typos that leak into Pi's code generation, commit messages, and file names.

Pi's extension system provides `CustomEditor` (extends the base `Editor` class), which can intercept every keystroke via `handleInput(data)`, read/write editor content, and render custom output. Extensions register via `setEditorComponent()` and can be toggled at runtime. The `input` event system handles message transformation post-submit, and the autocomplete system triggers only on `/`, `@`, and Tab — no overlap with space-triggered autocorrect.

## Goals / Non-Goals

**Goals:**
- Real-time, word-by-word autocorrect that feels like Gboard (correction on space, backspace to undo)
- Zero interference with Pi's existing autocomplete (slash commands, file references, tab completion)
- Accurate correction of common mobile typos while never mangling technical terms, paths, identifiers, or flags
- A learning dictionary that adapts to the user's vocabulary through natural use (rejection signals)
- Per-session toggle so desktop users aren't affected
- Packaged as a standard Pi extension installable via `pi install`

**Non-Goals:**
- Swipe typing or gesture input (terminal limitation, not solvable at this layer)
- Grammar correction or sentence-level rewriting (too complex, too slow, and LLMs already handle this)
- Auto-capitalization (terminal conventions don't expect it)
- Multi-language support in v1 (English only; architecture should allow it later)
- Replacing the entire editor experience (we extend `CustomEditor`, not rewrite it)
- Correcting tech-term typos from the tech dictionary (the tech dictionary is a whitelist to prevent false corrections of valid terms, not a correction source — see Decision 3 for rationale)

## Decisions

### 1. CustomEditor extension vs. Input event transform

**Decision**: Extend `CustomEditor` to intercept keystrokes in real-time.

**Alternative considered**: Use `pi.on("input", ...)` to transform the complete message before sending.

**Rationale**: The `input` event fires after the user hits Enter — the user would see their typos the entire time they're typing and only see corrections after submit. This violates the core UX requirement of seeing corrections as you type, like Gboard. `CustomEditor.handleInput()` gives us per-keystroke control.

### 2. symspell-ts as the correction engine (Damerau-Levenshtein verified)

**Decision**: Use `symspell-ts` with edit distance 1 and `Verbosity.Top` (single best match). The library uses Damerau-Levenshtein distance, where transpositions count as 1 edit — verified by testing that `lookup("teh", Verbosity.Top, 1)` returns "the".

**Alternatives considered**:
- `mnemonist` SymSpell: No frequency weighting, so "teh" → "tech" instead of "the". Disqualified.
- Hunspell: Heavier, morphology-focused, slower for real-time single-word lookup.
- LLM call per word: 300-800ms latency per word is unusable for real-time correction.
- Custom implementation: SymSpell algorithm is well-documented but `symspell-ts` already implements it correctly with bundled dictionaries.

**Rationale**: Edit distance 1 catches the vast majority of mobile typos (transpositions, adjacent-key misses, dropped characters) while avoiding over-correction. At 0.006ms per lookup, it's imperceptible. Edit distance 2 aggressively mis-corrects tech terms (nginx → engine, zellij → ellis).

**Critical assumption**: The edit-distance-1 thesis depends on Damerau-Levenshtein (transpositions = 1 edit). This MUST be verified in a task before building on it (task 3.0).

### 3. Three-layer dictionary with cspell-dicts for the tech layer

**Decision**: Layered dictionary — Learned (user) → Tech (bundled) → English (symspell-ts bundled). Correction only happens if NO layer claims the word.

**Tech dictionary source**: Aggregate word lists from `@cspell/dict-software-terms`, `@cspell/dict-typescript`, `@cspell/dict-node`, `@cspell/dict-python`, `@cspell/dict-k8s` into a single pre-compiled text file at build time (~23K words). cspell-dicts devDependencies SHALL be pinned to exact versions for reproducible builds.

**Tech dict as whitelist only (not correction source)**: The tech dictionary prevents false corrections of valid tech terms but does NOT provide corrections for misspelled tech terms. This means `kubernetse` (typo of kubernetes) goes uncorrected. This is a deliberate trade-off: making the tech dict a correction source risks confusing similar tech terms (e.g., suggesting "nginx" for "nginz" when the user meant something else). The learning dictionary handles frequently-used tech terms over time.

**Lookup order rationale**: Learned first because the user's explicit choices should always win. Tech second because it's the most common source of false corrections. English last as the correction source.

**Live lookup**: The engine SHALL query the learned dictionary via a callable (`isLearned: (word: string) => boolean`), not a `Set<string>` snapshot. This ensures words added mid-session (via auto-learning or `/typos dict add`) take effect immediately without engine re-initialization.

### 4. Learning from rejection only

**Decision**: Words are added to the learned dictionary only when the user rejects a correction by backspacing. After N rejections of the same original word (default: 2), the original word is permanently learned. The rejection counter is keyed on the original word, independent of what correction was suggested.

**Rejection counter persistence**: Rejection counts are persisted in the dictionary JSON file under a `pendingRejections` key (`{ [word: string]: number }`), alongside the `words` map. When a user rejects a correction, the count increments and is saved. When the threshold is reached, the word moves from `pendingRejections` to `words` (learned). This ensures rejection progress accumulates across sessions — critical for mobile use where sessions are short (SSH drops, Termux backgrounding, phone switching). Without persistence, a user might reject the same word once per session across many sessions and never reach the threshold.

**Persistence**: `~/.pi/agent/mobile-autocorrect-dictionary.json` — JSON with word entries (`{ added: string, source: "learned" | "manual", rejections: number }`), written atomically via temp-file-then-rename to prevent corruption on crash. Concurrent access from multiple Pi sessions is a known limitation (last write wins).

**Learned dictionary lifecycle**: The `LearnedDictionary` class SHALL be instantiated once at extension load time, with `load()` called during extension initialization. This ensures `/typos dict` commands work immediately, even before autocorrect is first enabled. Dictionary state (words, pending rejections) persists across toggle cycles within a session. The `CorrectionEngine` (and its heavy English + tech dictionaries) initializes lazily on first `/typos on`. This split lifecycle means: zero cost for the correction engine when unused, but the lightweight learned dictionary (~800KB at 10K cap) is always loaded.

**Toggle serialization**: Enable/disable operations are serialized via an in-flight promise. If the user runs `/typos off` while lazy initialization from `/typos on` is still in progress, the disable awaits the load then immediately disables. A second `/typos on` during an in-flight first-enable awaits the existing load. Final requested state wins.

**Keystrokes during lazy load**: While the correction engine is initializing on first `/typos on`, the user types into the default editor (the editor swap has not happened yet). Keystrokes are NOT buffered or corrected during the load window. The editor swap occurs only after initialization completes. This means the first few words of the first prompt after enabling may be uncorrected — acceptable since the load is ~1.2s.

**Initialization failure**: If correction-engine initialization fails (missing dictionary, read error, SymSpell init failure), the extension SHALL clear the "typos-loading" status, leave autocorrect disabled, and show an error notification (e.g., `ctx.ui.notify("Autocorrect failed to initialize: <reason>", "error")`). The user can retry with `/typos on`.

### 5. Correction feedback via status line (not render injection)

**Decision**: Corrected words are signaled via `ctx.ui.setStatus()` showing a brief "✓ teh → the" message for ~500ms, rather than injecting ANSI color codes into `super.render()` output.

**Alternative considered**: Post-process `super.render()` output to wrap corrected word positions in ANSI color codes for an inline color flash.

**Rationale**: Pi's editor `render()` already emits ANSI escape sequences for cursor placement, theme styling, and autocomplete previews. Naive string slicing to inject additional ANSI codes would corrupt existing escape sequences (visual glitch) or land at wrong positions (off-by-N from invisible escape bytes). The status-line approach is reliable, visible on mobile, and avoids fragile render-layer coupling.

### 6. Backspace-to-undo within a 1-character window

**Decision**: If the user's very next action after a correction is backspace, undo the entire correction (restore original word and remove trailing space/punctuation). If they type any other character first, the correction is committed.

**Re-correction suppression**: After a rejection, the original word is added to a `recentlyRejected` map keyed on `(lineIndex, wordStartOffset)`. If the user types space immediately after the restored word, the same correction is NOT re-triggered. This prevents a frustrating reject-respace-reject cycle. The suppression entry is cleared when: (a) the cursor leaves the line, (b) the cached offset no longer points at the original word string (due to edits shifting positions), or (c) the word is deleted entirely.

**Rationale**: Matches Gboard behavior. A 1-character grace window is simple and intuitive.

### 7. Token eligibility gate before correction

**Decision**: Before sending a word to SymSpell, the editor checks whether the token looks like natural language: pure ASCII alphabetic characters (`[A-Za-z]` only), 3+ chars. Tokens containing paths (`/`, `\`), dots (`.ts`), underscores (`snake_case`), hyphens (`kebab-case`), leading dashes (`--force`), mixed alphanumeric patterns (`v1beta1`), apostrophes (`don't`), or non-ASCII characters (`café`) are skipped entirely.

**Rationale**: In a coding-agent context, many "words" are paths, identifiers, flags, and version strings. Sending these to SymSpell would produce nonsensical corrections. The eligibility gate is a cheap regex check that runs before the dictionary lookup. Excluding non-ASCII and apostrophes is appropriate because the symspell-ts English dictionary is ASCII-only.

### 7a. Multi-character input handling (paste/SSH buffer)

**Decision**: When `handleInput(data)` receives a multi-character payload (from clipboard paste, SSH buffering over Termux, or IME flush), the editor processes it byte-by-byte with the following dispatch rules:

1. **Escape sequences** (payload starts with `\x1b`): pass the entire payload through to `super.handleInput(data)` untouched. These are arrow keys, function keys, and other terminal controls. Note: task 4.7 must verify whether ESC-prefixed chunks can include trailing printable text (e.g., Alt+letter = `\x1b` + letter; mouse reports followed by typed chars). If they can, this rule is too coarse and a minimal ANSI sequence-length parser is needed to consume only the escape sequence and continue processing the remainder. Until verified, the "pass through entire ESC-prefixed payload" rule is the default.
2. **Known single-byte control characters** (backspace `0x7F`/`0x08`, Enter `0x0D`/`0x0A`, Tab `0x09`): dispatch each to its normal handler (backspace triggers undo-check, Enter/Tab delegated to super). These may appear interleaved with printable text in a buffered SSH chunk.
3. **Printable text** (everything else): accumulate into a buffer and trigger correction at each trigger character position.

**Rationale**: Terminal input over SSH frequently arrives in chunks, not character-by-character. Critically, multi-character payloads are NOT always paste — escape sequences for arrow keys, function keys, and other terminal controls are also multi-byte. But also, Termux/SSH commonly coalesces input where printable text and control characters appear in the same chunk (e.g., `"the \x7F"` = text + backspace). The previous rule of "pass through anything containing non-printable bytes" was too aggressive — it would skip corrections in pasted multi-line text and disable backspace-undo when buffered with text. The byte-by-byte dispatch with known-escape-prefix detection handles all cases correctly.

**Multiple corrections in one payload**: When a single paste triggers multiple corrections, only the last correction is shown in the status line. Each new correction cancels the previously scheduled clear timer before scheduling a new one. This prevents timer races on the `typos-correction` status key.

**Multi-line paste (v1 limitation)**: Pi's TUI treats `\n` as Enter/submit, not as newline insertion (Shift+Enter is used for multi-line input). Without bracketed paste mode detection, a pasted `\n` in `handleInput` will trigger submit behavior, meaning only text before the first `\n` is processed for corrections. Multi-line paste support depends on bracketed paste (`\x1b[200~..\x1b[201~`), which is not in scope for v1.

### 8. Guard against autocomplete conflicts

**Decision**: Skip autocorrect when `isShowingAutocomplete()` returns true on the editor.

**Rationale**: Pi's autocomplete triggers on `/`, `@`, and Tab — our autocorrect triggers on space/punctuation. There's no direct overlap, but if autocomplete is visible (e.g., user is browsing `/` command completions and hits space), we should not also autocorrect.

### 9. Split dictionary initialization: eager learned dict, lazy correction engine

**Decision**: The learned dictionary (~800KB at 10K cap) loads eagerly at extension init. The correction-engine dictionaries (English ~82K words + tech ~23K words) load lazily on first `/typos on`.

**Alternative considered**: Fully eager load on `session_start` with loading status; fully lazy load of everything on first enable.

**Rationale**: The learned dictionary must be available for `/typos dict` commands even when autocorrect is off. Its size (~800KB) is negligible. The correction engine's heavy dictionaries (~1.2s, ~6MB RAM) should only load when actually needed. This split preserves the near-zero startup cost for desktop sessions while ensuring dictionary management is always functional. A brief "Loading autocorrect..." status shows during the first correction-engine enable.

### 10. Word replacement via cursor-aware operations

**Decision**: Word replacement SHALL use cursor-position-aware editing operations (backspace to delete the word, then insert the correction) rather than whole-buffer `setText()` replacement.

**Alternative considered**: Read `getText()`, do string replacement, call `setText()`.

**Rationale**: Whole-buffer `setText()` destroys the editor's undo stack and may misplace the cursor. Using the editor's own backspace/insert operations avoids that whole-buffer reset and preserves cursor state within the active editor. However, task 4.7 verified that Pi's public editor API does **not** expose an atomic delete+insert batching primitive, so built-in undo parity for accepted corrections is best-effort; only the immediate backspace-to-undo path is guaranteed.

## Risks / Trade-offs

- **[Risk] symspell-ts uses plain Levenshtein instead of Damerau-Levenshtein** → Mitigation: Task 3.0 verifies this before any engine code is written. If verification fails, evaluate alternatives or raise max edit distance with tighter guards.

- **[Risk] 6.3MB package size due to bundled dictionaries** → Mitigation: One-time download via `pi install`. Acceptable for a utility extension.

- **[Risk] Over-correction of valid short words** → Mitigation: Don't correct words shorter than 3 characters. Token eligibility gate skips non-natural-language tokens.

- **[Risk] Tech-term typos go uncorrected** → Mitigation: The learning dictionary can learn specific tech terms the user frequently types (after 2 rejections or manual `/typos dict add`). However, this only helps AFTER the user has taught the system — novel tech-term typos will always go uncorrected in v1. For rarely-used terms, the LLM can still interpret typos from context. This is an acceptable trade-off for avoiding false corrections between similar tech terms.

- **[Risk] Learning dictionary could grow unbounded** → Mitigation: Cap at 10,000 words with FIFO eviction. `/typos dict clear` and `/typos dict remove` for manual cleanup.

- **[Risk] Concurrent sessions race on dictionary file** → Known limitation: last write wins. Acceptable for the expected single-user-on-phone use case. Document in README.

- **[Risk] Editor cursor-aware operations may not behave identically to manual typing** → Mitigation: Automated tests for word replacement, undo after correction, mid-line correction, and multi-line text.

- **[Trade-off] Edit distance 1 misses some real typos** → Some mobile typos involve 2+ edits. We accept this for safety. The LLM can still interpret them.
