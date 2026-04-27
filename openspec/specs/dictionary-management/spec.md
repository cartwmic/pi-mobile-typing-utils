# Specification

## Purpose

The learned dictionary tracks words the user has explicitly chosen to keep (by rejecting auto-corrections) and exposes them for both the correction engine (to suppress future corrections) and the user (via `/typos dict` subcommands). It owns persistence to disk (JSON at `~/.pi/agent/mobile-autocorrect-dictionary.json`), atomic write semantics, FIFO eviction at the 10K cap, cross-session rejection-count accumulation, and the data-only side of dictionary-management commands (view, search, add, remove, clear). User-facing notifications about learning are emitted by the editor, not by this layer.

## Requirements

### Requirement: Learned dictionary persists to disk
The learned dictionary SHALL be stored as a JSON file at `~/.pi/agent/mobile-autocorrect-dictionary.json`. The file SHALL contain two top-level keys: `words` (learned entries) and `pendingRejections` (pre-threshold counts). Each learned entry SHALL conform to the schema: `{ added: string (ISO 8601), source: "learned" | "manual", rejections: number }`. The `pendingRejections` key SHALL be a map of `{ [word: string]: number }` tracking rejection counts for words that have not yet reached the learning threshold. The `rejections` field tracks how many times the user rejected a correction for this word before it was learned (0 for manually added words). The file SHALL be loaded on extension startup and written on every modification of persisted state (add, remove, threshold-learn, clear, FIFO eviction) using atomic writes (write to a temp file in the same directory, then rename). Pre-threshold rejection counter increments ARE persisted (they update the `pendingRejections` map and trigger a disk write) to ensure rejection progress survives across sessions. Concurrent access from multiple Pi sessions is a known limitation — last write wins.

#### Scenario: Dictionary loads on startup
- **WHEN** the extension starts and the dictionary file exists
- **THEN** the extension SHALL load all learned words from the file, including their rejection counts

#### Scenario: Dictionary file does not exist
- **WHEN** the extension starts and no dictionary file exists
- **THEN** the extension SHALL start with an empty learned dictionary and create the file on first write

#### Scenario: Dictionary persists across sessions
- **WHEN** the user learns a word in one Pi session and starts a new session
- **THEN** the learned word SHALL be available in the new session with its rejection count preserved

#### Scenario: Corrupt dictionary file
- **WHEN** the dictionary file exists but contains invalid JSON
- **THEN** the extension SHALL log a warning, start with an empty learned dictionary, and overwrite the file on next write

#### Scenario: Atomic write prevents corruption
- **WHEN** the dictionary is being saved and the process crashes mid-write
- **THEN** the previous valid dictionary file SHALL remain intact (temp-file-then-rename ensures atomicity)

### Requirement: Automatic learning from repeated rejection
When a correction is rejected (backspace-to-undo) for the same original word N times (default: 2), the word SHALL be automatically added to the learned dictionary. The rejection counter is keyed on the original word, independent of the suggested correction.

#### Scenario: First rejection increments counter
- **WHEN** the user rejects a correction for "termux" for the first time
- **THEN** the rejection count for "termux" SHALL be set to 1 and it SHALL NOT be added to the learned dictionary

#### Scenario: Reaching rejection threshold learns the word
- **WHEN** the user rejects a correction for "termux" for the second time (reaching the threshold of 2)
- **THEN** "termux" SHALL be automatically added to the learned dictionary with `source: "learned"`, and `recordRejection` SHALL return `{ learned: true, word: "termux" }` so the calling editor component can display the notification. (The notification itself is the editor's responsibility — see autocorrect-editor spec.)

#### Scenario: Pending rejections persist across sessions
- **WHEN** the user rejects a correction for "termux" once in session A and once in session B
- **THEN** "termux" SHALL be auto-learned (rejection count accumulated to 2 across sessions). Pending rejection counts are persisted in the dictionary JSON file under a `pendingRejections` key.

#### Scenario: Learned word is no longer corrected
- **WHEN** "termux" has been learned and the user types "termux" followed by space
- **THEN** the autocorrect engine SHALL NOT correct it

### Requirement: Learned dictionary has a maximum size
The learned dictionary SHALL NOT exceed 10,000 words. When the limit is reached, adding a new word SHALL remove the oldest word (by addition date). This is FIFO eviction, not LRU.

#### Scenario: Dictionary at capacity
- **WHEN** the learned dictionary contains 10,000 words and a new word is learned
- **THEN** the oldest word (by addition date) SHALL be removed and the new word SHALL be added

### Requirement: View learned dictionary via command
The `/typos dict` command (with no subcommand) SHALL display the learned dictionary contents as a formatted list via `ctx.ui.notify()` or similar non-blocking output, showing words with their addition dates and sources. When the dictionary contains more than 50 entries, the output SHALL be truncated to the 50 most recently added words with a note indicating the total count (e.g., "Showing 50 of 237 words — use `/typos dict search <term>` to filter").

#### Scenario: View dictionary
- **WHEN** the user runs `/typos dict`
- **THEN** the extension SHALL display a list of learned words (up to 50) with their addition dates and source (auto-learned or manually added)

#### Scenario: Large dictionary truncated
- **WHEN** the user runs `/typos dict` and the dictionary contains 237 words
- **THEN** the extension SHALL show the 50 most recently added words and a note "Showing 50 of 237 words — use `/typos dict search <term>` to filter"

#### Scenario: Empty dictionary
- **WHEN** the user runs `/typos dict` and no words have been learned
- **THEN** the extension SHALL show a message "No learned words yet. Words are learned automatically when you reject corrections."

### Requirement: Search learned dictionary
The `/typos dict search <term>` command SHALL filter the learned dictionary to words containing the search term (case-insensitive substring match). Results SHALL be capped at 50 entries; if more match, show a note with the total count.

#### Scenario: Search with matches
- **WHEN** the user runs `/typos dict search ngi`
- **THEN** the extension SHALL display matching learned words containing "ngi" (e.g., "nginx", "engineering"), up to 50 results

#### Scenario: Search with many matches
- **WHEN** the user runs `/typos dict search e` and 120 words match
- **THEN** the extension SHALL display the first 50 matches and a note "Showing 50 of 120 matches"

#### Scenario: Search with no matches
- **WHEN** the user runs `/typos dict search xyz` and no words match
- **THEN** the extension SHALL show "No words matching 'xyz'"

### Requirement: Learned dictionary uses lowercase-normalized keys
All dictionary operations (add, remove, has, search) SHALL normalize words to lowercase for storage and lookup. This ensures case-insensitive behavior: `Termux`, `TERMUX`, and `termux` all map to the same entry. The original casing is not preserved — all entries are stored lowercase.

#### Scenario: Case-insensitive add
- **WHEN** the user runs `/typos dict add Termux`
- **THEN** "termux" (lowercase) SHALL be stored in the dictionary

#### Scenario: Case-insensitive lookup
- **WHEN** "termux" is in the dictionary and the engine checks "Termux"
- **THEN** the lookup SHALL match (both normalized to lowercase)

#### Scenario: Case-insensitive remove
- **WHEN** the user runs `/typos dict remove TERMUX` and "termux" is in the dictionary
- **THEN** the entry SHALL be removed

### Requirement: Manually add words to learned dictionary
The `/typos dict add <word>` command SHALL add a word to the learned dictionary immediately, without requiring rejection cycles.

#### Scenario: Add a new word
- **WHEN** the user runs `/typos dict add graphql`
- **THEN** "graphql" SHALL be added to the learned dictionary with source "manual" and a confirmation SHALL be shown

#### Scenario: Add an already-learned word
- **WHEN** the user runs `/typos dict add nginx` and "nginx" is already in the dictionary
- **THEN** the extension SHALL show "Already in dictionary: nginx"

### Requirement: Remove words from learned dictionary
The `/typos dict remove <word>` command SHALL remove a word from the learned dictionary.

#### Scenario: Remove an existing word
- **WHEN** the user runs `/typos dict remove badword`
- **THEN** "badword" SHALL be removed from the learned dictionary and a confirmation SHALL be shown

#### Scenario: Remove a non-existent word
- **WHEN** the user runs `/typos dict remove nonexistent` and it is not in the dictionary
- **THEN** the extension SHALL show "Not in dictionary: nonexistent"

### Requirement: Clear entire learned dictionary
The `/typos dict clear` command SHALL remove all words from the learned dictionary after confirmation.

#### Scenario: Clear with confirmation
- **WHEN** the user runs `/typos dict clear`
- **THEN** the extension SHALL prompt for confirmation via `ctx.ui.confirm()` and, if confirmed, remove all learned words and show "Dictionary cleared (N words removed)"

#### Scenario: Clear cancelled
- **WHEN** the user runs `/typos dict clear` and declines the confirmation
- **THEN** the learned dictionary SHALL remain unchanged

### Requirement: Invalid dictionary subcommands show usage
The `/typos dict` command SHALL handle invalid subcommands and missing arguments gracefully.

#### Scenario: Unknown subcommand
- **WHEN** the user runs `/typos dict frobnicate`
- **THEN** the extension SHALL show a usage message listing valid subcommands

#### Scenario: Missing word argument
- **WHEN** the user runs `/typos dict add` with no word
- **THEN** the extension SHALL show "Usage: /typos dict add <word>"

### Requirement: Pending rejections are visible in dictionary listing

Words that have received at least one correction rejection but have not yet reached the auto-learn threshold (2 rejections) are tracked as "pending". The `/typos dict` command (bare, no subcommand) SHALL display these pending entries in a dedicated section below the graduated words so users can see which words are on the path to being learned. The `/typos dict search <term>` command searches only graduated entries, but SHALL append a note indicating how many pending entries also match the search term.

#### Scenario: Pending entries shown alongside graduated entries
- **WHEN** the user runs `/typos dict` and there are both graduated and pending entries
- **THEN** the output SHALL first list graduated words (in the standard format: `word  ISO-date  (source)`) followed by a blank line, then a `Pending (1 more rejection to learn):` header, followed by each pending word in the format `word  (N of 2 rejections)`, sorted by rejection count descending then alphabetically

#### Scenario: Search shows hint when matching pending entries exist
- **WHEN** the user runs `/typos dict search <term>` and there are graduated matches AND pending entries that contain the search term
- **THEN** the search results SHALL show only the graduated matches (existing behavior), with an additional note appended: `(Plus N pending matches — see /typos dict)` where N is the count of pending entries matching the term
