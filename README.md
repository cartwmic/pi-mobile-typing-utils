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
- `enableSegmentation` (`true`/`false`, default `true`) — enable the word-segmentation correction path. When `true`, tokens above `segmentationMinLength` that are not in any dictionary are tested with `SymSpell.wordSegmentation()`.
- `segmentationMinLength` (integer `4`–`12`, default `6`) — minimum token length to attempt segmentation. Shorter tokens (e.g. `imho`) are skipped to avoid false splits.
- `segmentationMaxEditDistance` (integer `0`–`2`, default `1`) — maximum per-segment edit distance passed to `wordSegmentation()`. `0` = exact splits only; `1` = allows one typo per segment.
- `segmentationLogProbFloor` (number `-30`–`0`, default `-12.0`) — minimum `Math.log10` probability sum for a segmentation to be accepted. Results below the floor are discarded. Tune up (toward `0`) to reject marginal splits; tune down to accept more.
- `segmentationVsLookupBias` (number `-10`–`10`, default `0.0`) — score bias added to the segmentation score before head-to-head comparison against the lookup-rerank score. Positive values favour splits; negative values favour single-word corrections.
- `enableContextRerank` (`true`/`false`, default `true`) — enable the n-gram rerank pass. When `true`, the engine uses the previous word(s) from the line to break ties among SymSpell candidates.
- `rerankBigramWeight` (number `0`–`1`, default `0.5`) — weight applied to the bigram log-probability tier in the rerank score. Higher = more influence from the previous word.
- `rerankTrigramWeight` (number `0`–`1`, default `0.3`) — weight applied to the trigram log-probability tier. Higher = more influence from the two previous words. Effective only after the trigram side-table lazy-attaches.
- `rerankEditDistancePenalty` (number `0`–`5`, default `1.0`) — penalty subtracted per edit-distance unit in the rerank score. Increase to bias strongly toward the least-distant candidate; decrease to let n-gram evidence override edit distance more freely.
- `telemetry` (`off`/`metrics`/`debug`, default `metrics`) — privacy level for local telemetry logging. See [How it works → Telemetry](#telemetry) for details.

View and manage telemetry summaries:

- `/typos stats` — show a correction summary for the last 24 hours.
- `/typos stats 24h` — last 24 hours.
- `/typos stats 7d` — last 7 days.
- `/typos stats all` — all retained telemetry (up to 30 days).
- `/typos stats reset` — delete local telemetry files. Requires a second confirmation within 30 seconds.

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
- **Cache invalidation:** the key embeds `maxEditDistance`, `prefixLength`, `compactLevel`, `countThreshold`, the symspell-ts package version, a schema version, and (as of v2) `bigramsPresent` plus the SHA-256 hash of the bigram dictionary file. Changing `maxEditDistance` (or upgrading symspell-ts) automatically invalidates the cache; stale sibling files are pruned on every successful load.
- **Bigrams are now serialized into the cache.** The v2 cache format includes the full bigram map and `bigramCountMin` so rehydrated engines are byte-identical to freshly-built ones. This increases the cache file size by a few MB but avoids re-parsing the bigram dictionary on cache-hit starts.
- **Safe to delete:** the cache is purely a performance optimization. Deleting `~/.pi/agent/cache/mobile-autocorrect/` causes the engine to rebuild on next session start and re-write the cache — functionality is unaffected.
- **Approximate size:** ~30–35 MB per `maxEditDistance` value (bigrams add a few MB over the v1 baseline).
- **POSIX-only atomic writes:** the cache write uses `rename()` for atomic replacement on POSIX systems. On Windows the cache is skipped (the engine builds from scratch every session, which still works correctly).

### Context rerank

When `enableContextRerank: true` (the default), the engine calls `Verbosity.All` to collect every SymSpell candidate within the adaptive edit-distance bound, then scores them with a weighted stupid-backoff n-gram model:

```
Score(c) = rerankBigramWeight × log P(c | prev)
         + rerankTrigramWeight × log P(c | prevPrev, prev)
         - rerankEditDistancePenalty × editDistance(token, c)
         + log P(c)   ← unigram prior
```

Smoothing follows the **stupid-backoff** scheme (Brants et al., α = 0.4): the trigram tier backs off to bigram if no trigram count is available; bigram backs off to unigram.

- **Bigram tier** reads from the SymSpell-bundled corpus (~243k bigrams, loaded eagerly at startup).
- **Trigram tier** reads from a separate Google Books corpus (`data/trigram-top500k.tsv`). It lazy-attaches in the background after the engine reaches `ready`; corrections during the attach window use bigram + unigram scoring without any user-visible loading state.
- **Cross-corpus magnitudes are not comparable.** Absolute log-probability values from the bigram corpus are not on the same scale as those from the trigram corpus. The user-tunable weights (`rerankBigramWeight`, `rerankTrigramWeight`) absorb this cross-corpus mismatch — they act as relative scaling factors, not raw coefficients. For full design rationale see Decision 1 and Decision 4 in `openspec/changes/improve-autocorrect-context-and-segmentation/design.md`.
- **Scope note:** rerank operates within the per-call edit distance from the adaptive ED curve. For short tokens (length 2–5, default ED=1) the engine only sees ED-1 neighbors. Insertion corrections like `te → the` (which requires ED=2) are NOT in the v1 candidate set regardless of context.

### Word segmentation

When `enableSegmentation: true` (the default), the engine tests tokens above `segmentationMinLength` (default 6) against `SymSpell.wordSegmentation()`. A segmentation result is accepted when:

1. `probabilityLogSum >= segmentationLogProbFloor` (default `-12.0`).
2. All segments are alphabetic and above `minWordLength`.
3. At least two segments were produced.

When both a lookup-rerank correction and a segmentation correction are available, the engine picks the higher-scoring result using `segmentationVsLookupBias` as a tie-breaking offset.

**Important v1 limitation:** segmentation operates against the SymSpell **unigram** dictionary only. Tech-dictionary words (e.g. `kubernetes`, `docker`) are layered on top of SymSpell but are NOT fed into SymSpell’s internal unigram index. As a result, tech-prose concatenations like `kubernetespod` or `dockerimage` are not split. Workaround: insert the space manually. See [Known limitations](#known-limitations).

### Telemetry

The extension emits structured telemetry events to a local NDJSON log so correction thresholds and n-gram weights can be tuned from real data.

- **File location:** `<cacheDir>/telemetry/events-YYYY-MM-DD.ndjson` (daily rotation).
  Override the directory via `MOBILE_AUTOCORRECT_CACHE_DIR`; default is `~/.pi/agent/cache/mobile-autocorrect/`.
- **Retention:** 30 days. Files older than 30 days are deleted on the next telemetry write.
- **Privacy levels** (set with `/typos config telemetry <level>`):
  - `off` — no events are written; no telemetry directory is created.
  - `metrics` (default) — counters, latency, and structural fields only. Token strings, suggestion strings, candidate lists, and line text are omitted.
  - `debug` — full event content, including token, suggestion, candidate list, line text, and cursor position.
- **Disable permanently:** `/typos config telemetry off`

> **Warning — `debug` mode:** `debug` mode logs full line text, cursor positions, and candidate strings. This includes any prose, file paths, prompts, or pasted secrets the user typed. Do NOT enable `debug` on shared machines or sessions where sensitive content is typed. Use `metrics` (default) for counters-only logging.

Emission is fire-and-forget: writes never block the editor hot path. Write failures are swallowed silently (at most one log message per session for non-transient failures).

## Known limitations

- **Trigram corpus register mismatch:** the trigram side-table is sourced from English Google Books n-grams (year ≥ 1990). Register may diverge from technical or conversational terminal use; this is a known v2 candidate for swapping to a Stack Exchange / Wikipedia source.
- **Tech-prose word-segmentation:** concatenations of tech-dict words (e.g., `kubernetespod`, `dockerimage`) are NOT split because `wordSegmentation()` consumes only the SymSpell unigram dictionary. Workaround: insert the missing space manually. A v2 candidate is to feed tech-dict words into the SymSpell unigram index.
- **Adaptive-ED bound:** the rerank module operates within the per-call edit distance set by the adaptive ED curve. With v1’s defaults (`minEditDistance=1`, `editDistanceStepEvery=4`), short tokens (length 2–5) cannot be corrected to ED=2 candidates regardless of context. Disambiguation among ED-1 candidates IS supported. Widening short-token ED is a v1.1 tuning candidate.
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

## Data attributions

See [`data/LICENSES.md`](data/LICENSES.md) for the full attribution text.

The trigram side-table (`data/trigram-top500k.tsv`) is derived from the Google Books English n-gram corpus (year ≥ 1990), licensed under CC-BY-SA 3.0.
