## ADDED Requirements

### Requirement: Telemetry emit ownership across engine, editor, and singleton
The extension SHALL split telemetry emission ownership between three surfaces based on which surface naturally holds each event's data:

- **Engine emits**: `engine.init` (success AND degraded paths — see specific scenario below), `lookup.latency`, `correction.applied`, `correction.skipped`, `segmentation.attempt`. The engine has the candidate count, score breakdown, edit distance, lookup latency, and segmentation result fields natively; emitting from the engine avoids threading these through the `CorrectionResult` type.
- **Editor emits**: `correction.rejected`. The editor owns the timing of the backspace-undo relative to the original `correction.applied` and so is the only surface that can compute `msUntilUndo`.
- **Trigram singleton emits**: `trigram.lazy_attached`. Emitted exactly once per process when the singleton's load promise resolves (success or failure). Engine instances do NOT emit `trigram.lazy_attached` from their per-engine `.then` callbacks; this avoids duplicate events on the first ready engine and zero events for orphan engines.

Both surfaces SHALL share a single `TelemetryWriter` instance constructed once in `index.ts` and passed through `CorrectionEngineOptions.telemetry?` and `AutocorrectEditorOptions.uiAdapter` (or a similar adapter slot). Either constructor argument MAY be omitted in tests, in which case telemetry is silently skipped.

#### Scenario: Engine emits correction.applied with score breakdown
- **WHEN** the engine returns a `kind: "lookup"` or `kind: "segmentation"` correction
- **THEN** the engine SHALL emit a `correction.applied` event with the `kind`, `candidateCount`, `winningEditDistance`, `latencyMs`, and `scores` fields populated from the rerank module's score breakdown; if level is `metrics`, content fields (`token`, `suggestion`, `original`, `candidates`) SHALL be omitted

#### Scenario: Editor emits correction.rejected with msUntilUndo
- **WHEN** the user backspaces within the undo window after a correction was applied
- **THEN** the editor SHALL emit a `correction.rejected` event with `msUntilUndo` measured against the editor's stored `lastCorrection` timestamp; the engine SHALL NOT attempt to emit this event (it has no visibility into editor timing)

### Requirement: Privacy-tiered local telemetry with three levels
The extension SHALL emit telemetry events to a local NDJSON log under the cache directory. The level SHALL be controlled by the persisted config key `telemetry: "off" | "metrics" | "debug"` with default `"metrics"`. The privacy semantics by level are:

| Level | Counters & latency | Token strings | Suggestion strings | Candidate list |
|---|---|---|---|---|
| `off` | — | — | — | — |
| `metrics` | yes | **no** | **no** | **no** |
| `debug` | yes | yes | yes | yes |

At `metrics` level the events SHALL contain only structural fields (event type, timestamps, token length, suggestion length, candidate count, latency milliseconds, kind discriminator, score components as numbers). Specifically, the fields named `token`, `suggestion`, `original`, `lineText`, `candidates[].term` SHALL be either omitted or set to `null` at `metrics` level. They SHALL be present and populated at `debug` level.

At `off` level no events SHALL be written; no telemetry directory SHALL be created on first run if `telemetry: "off"` is the active value at the time the engine first attempts to log an event.

#### Scenario: Default level is metrics
- **WHEN** the extension loads with no explicit `telemetry` value persisted
- **THEN** the bootstrap default `metrics` SHALL be used; the `Config` snapshot returned by `config.getTelemetry()` SHALL be `"metrics"`

#### Scenario: metrics level omits content fields
- **WHEN** `telemetry: "metrics"` and a `correction.applied` event fires for token `"teh"` with suggestion `"the"`
- **THEN** the NDJSON line SHALL contain numeric fields (e.g. `tokenLength: 3`, `suggestionLength: 3`, `latencyMs: 0.7`) and structural fields (`kind: "lookup"`); it SHALL NOT contain `token`, `suggestion`, or `original` keys with string values; if those keys are present they SHALL be `null`

#### Scenario: debug level includes content fields
- **WHEN** `telemetry: "debug"` and a `correction.applied` event fires for token `"teh"` with suggestion `"the"`
- **THEN** the NDJSON line SHALL contain `token: "teh"`, `suggestion: "the"`, and the candidate list (with each candidate's term and score breakdown)

#### Scenario: off level writes nothing
- **WHEN** `telemetry: "off"` and any correction or engine event would normally fire
- **THEN** no file SHALL be written; no telemetry directory SHALL be created; the engine and editor hot paths SHALL incur no I/O

### Requirement: NDJSON file rotation and retention
Telemetry SHALL be written to `~/.pi/agent/cache/mobile-autocorrect/telemetry/events-YYYY-MM-DD.ndjson`, where `YYYY-MM-DD` is the current local date when the event fires. The directory SHALL be overridable via the existing `MOBILE_AUTOCORRECT_CACHE_DIR` environment variable (the telemetry subdirectory SHALL be created under whatever cache root is in effect, mirroring the index-cache directory rules).

The extension SHALL prune log files older than 30 days. Pruning SHALL be **date-aware**: the writer caches the local date of its last successful prune (`lastPruneDate`); on each `emit()`, if the current local date differs from `lastPruneDate`, pruning re-runs and `lastPruneDate` is updated. This handles long-lived sessions that cross midnight. The pruning step SHALL list files in the telemetry directory matching `events-*.ndjson`, parse the date stamp from each filename, and `unlink()` any whose date is more than 30 days before the current local date. Pruning failures SHALL NOT propagate; non-`ENOENT` failures SHALL be logged at info level; `ENOENT` failures (a peer process has already deleted the file) SHALL be silently ignored.

#### Scenario: Daily-stamped filenames
- **WHEN** the first telemetry event of the local date `2026-05-15` fires
- **THEN** the event SHALL be appended to `events-2026-05-15.ndjson`; subsequent events on the same local date SHALL append to the same file

#### Scenario: Date rollover creates a new file
- **WHEN** the local date changes from `2026-05-15` to `2026-05-16` and the next event fires
- **THEN** the event SHALL be appended to `events-2026-05-16.ndjson`; the previous day's file SHALL remain on disk

#### Scenario: Files older than 30 days are pruned on first emit of a session
- **WHEN** the engine instance writes its first telemetry event of a session and the directory contains `events-2026-04-01.ndjson` while the current local date is `2026-05-03`
- **THEN** the engine SHALL delete `events-2026-04-01.ndjson` (32 days old); files within the 30-day window SHALL be retained; `lastPruneDate` SHALL be set to `2026-05-03`

#### Scenario: Long-lived session crossing midnight re-runs prune
- **WHEN** a writer instance has `lastPruneDate = 2026-05-02` and the next `emit()` fires after midnight (current local date is now `2026-05-03`)
- **THEN** the writer SHALL re-run the prune step, deleting any newly-stale files (those now > 30 days old), and update `lastPruneDate` to `2026-05-03`

#### Scenario: Prune failure does not break telemetry
- **WHEN** an `unlink()` of an old file fails (e.g., permission denied)
- **THEN** the engine SHALL log the failure at info level and continue; the in-flight event SHALL still be written

### Requirement: Telemetry writes are fire-and-forget on the editor hot path
Telemetry writes SHALL NEVER block the editor's `handleInput` path. Every telemetry write SHALL be issued via `fs.appendFile` (or equivalent async API) and SHALL NOT be `await`ed by any code path called from `AutocorrectEditor`, `CorrectionEngine.shouldCorrect`, or the rerank/segmentation modules. Write rejections SHALL be caught and swallowed (or logged at info level at most once per engine instance to avoid log spam from a persistent failure mode like a read-only filesystem). `ENOENT` errors from the prune step (a peer process has already deleted the file) SHALL be silently ignored and SHALL NOT count toward the once-per-instance log budget.

#### Scenario: A slow disk does not block typing
- **WHEN** the underlying filesystem's `appendFile` takes 500 ms to complete
- **THEN** the editor SHALL accept and render subsequent keystrokes without delay (the in-flight telemetry promise SHALL resolve later, with no observable user-side effect)

#### Scenario: A read-only filesystem does not break corrections
- **WHEN** the telemetry directory is on a read-only filesystem (every `appendFile` rejects with `EROFS`)
- **THEN** the engine SHALL continue to serve corrections normally; the telemetry rejections SHALL be swallowed and logged at info level at most once per session

### Requirement: Telemetry directory is created lazily before first non-off emit
The `TelemetryWriter` SHALL `mkdir` the telemetry directory (`<cacheDir>/telemetry/`) recursively (`{ recursive: true }`) before its first `appendFile` call at any non-`off` level. The `mkdir` SHALL happen at most once per writer instance (subsequent emits skip it). When the writer's level is `off`, the directory SHALL NOT be created. The `mkdir` SHALL be issued before the corresponding `appendFile` (e.g., as part of an internal initialization promise the first emit awaits internally), so that the first event reliably lands on disk rather than silently failing with `ENOENT`.

This addresses a class of failures where `fs.appendFile` does not implicitly create the parent directory; without explicit mkdirp, the first event silently rejects with `ENOENT` and no telemetry is ever written until something else creates the directory.

#### Scenario: Telemetry directory is created on first emit
- **WHEN** a `TelemetryWriter` is constructed against a cache directory that does not yet contain a `telemetry/` subdirectory, and the writer's level is `metrics` or `debug`
- **THEN** the first `emit()` call SHALL create the `telemetry/` subdirectory recursively before issuing the `appendFile`; subsequent emits SHALL skip the mkdir step

#### Scenario: Telemetry directory NOT created when level is off
- **WHEN** a `TelemetryWriter` is constructed and `getLevel()` returns `"off"` at the time of every `emit()` call
- **THEN** the `telemetry/` subdirectory SHALL NOT be created; no `mkdir` SHALL be issued

### Requirement: Telemetry events are serialized via an in-memory writer queue
Each `TelemetryWriter` instance SHALL serialize its `appendFile` calls through an internal in-memory promise chain so that two near-simultaneous `emit()` calls from the same process do not race their `appendFile` invocations and produce interleaved bytes mid-line. The serialization SHALL NOT change the caller-visible API contract (`emit()` remains synchronous-looking and fire-and-forget); the queue is internal. This protection is per-process; cross-process interleaving is not protected against beyond what POSIX `O_APPEND` semantics already provide for short single-line writes.

#### Scenario: Concurrent emits do not interleave
- **WHEN** two `emit()` calls fire from the same process within microseconds of each other
- **THEN** the resulting NDJSON file SHALL contain two well-formed JSON lines (one per event), in some order, with no interleaved bytes; the `TelemetryWriter`'s internal serialization chain SHALL prevent corruption

### Requirement: Telemetry event types
The extension SHALL emit at least the following event types, identified by the `event` field on each NDJSON line:

| Event | Fired when | Required fields (metrics + debug) | Debug-only fields (all marked `contentField: true`) |
|---|---|---|---|
| `engine.init` | Engine `initialize()` resolves OR rejects (degraded) | `event`, `timestamp`, `fromCache: bool`, `buildMs: number`, `unigramCount: int`, `bigramCount: int`, `outcome: "ready"\|"degraded"`, `cause: string\|null` | (none) |
| `trigram.lazy_attached` | Trigram singleton resolves (success or fail) — emitted ONLY by the singleton, never by per-engine code | `event`, `timestamp`, `loadMs: number`, `outcome: "ready"\|"failed"`, `trigramCount: int\|null` | (none) |
| `lookup.latency` | Every `shouldCorrect()` call (full, not sampled, at metrics+debug) | `event`, `timestamp`, `tokenLength: int`, `candidateCount: int`, `latencyMs: number`, `result: "corrected"\|"skipped"` | `token`, `suggestion`, `lineText`, `cursor` |
| `correction.applied` | A correction is applied (lookup or segmentation) | `event`, `timestamp`, `kind: "lookup"\|"segmentation"`, `tokenLength: int`, `suggestionLength: int`, `candidateCount: int`, `winningEditDistance: int\|null` (null for `kind: "segmentation"`), `latencyMs: number`, `scores: { unigram, bigram, trigram, edPenalty } \| null` (null for `kind: "segmentation"`), `scoresVsAlt: { lookupScore: number\|null, segmentationScore: number\|null } \| null` (populated only when both head-to-head paths produced a viable result; records the loser's score for v1.1 tuning analysis; null otherwise) | `token`, `suggestion`, `original`, `candidates: Array<{term, ed, scores}>`, `lineText`, `cursor` |
| `correction.rejected` | User backspace-undoes a correction | `event`, `timestamp`, `msUntilUndo: number`, `kind: "lookup"\|"segmentation"`, `tokenLength: int` | `token`, `suggestion` |
| `correction.skipped` | A token was eligible but not corrected (skip reason recorded) | `event`, `timestamp`, `tokenLength: int`, `reason: "in_dict"\|"not_eligible"\|"no_candidates"\|"low_confidence"\|"segmentation_rejected"\|"adaptive_ed_too_high"` | `token`, `lineText`, `cursor` |
| `segmentation.attempt` | Segmentation path is invoked, regardless of accept/reject | `event`, `timestamp`, `tokenLength: int`, `accepted: bool`, `segmentCount: int\|null`, `probabilityLogSum: number`, `latencyMs: number` | `token`, `suggestion` |

**Privacy contract:** Every field listed in the "Debug-only fields" column SHALL be masked at `metrics` level — either omitted from the JSON output entirely or set to `null`. The `lineText` and `cursor` fields are particularly sensitive (full prose / cursor coordinates) and SHALL never appear in `metrics`-mode events. The unit test in `src/telemetry.test.ts` SHALL assert this for every event class by emitting a debug-fixture event with all content fields populated, switching the level mock to `metrics`, re-emitting, and verifying NONE of `token`, `suggestion`, `original`, `lineText`, `cursor`, `candidates` appear in any line of the resulting NDJSON.

Event field names and value types SHALL be stable within v1; field additions are permitted in patch versions, removals require a version bump.

#### Scenario: engine.init event written on cache hit
- **WHEN** the engine successfully hydrates from the on-disk cache and reaches `ready`
- **THEN** an `engine.init` event SHALL be appended with `fromCache: true`, `buildMs` set to the hydration duration, and `outcome: "ready"`

#### Scenario: engine.init event written on degraded path
- **WHEN** `initialize()` rejects (cache load failed AND fresh build also failed) and the engine transitions to `degraded` state
- **THEN** an `engine.init` event SHALL be appended BEFORE the rejection propagates, with `fromCache: false`, `buildMs` set to the elapsed time before failure, `outcome: "degraded"`, and `cause: <error.message>`; the event SHALL be emitted from the catch branch of `initialize()` so it lands on disk even though the engine never reaches `ready`

#### Scenario: correction.applied event written on every correction
- **WHEN** the engine returns `{ corrected: true, kind: ..., suggestion: ... }` from `shouldCorrect()`
- **THEN** the **engine** SHALL emit a `correction.applied` event with the chosen `kind`, `winningEditDistance` (null for `kind: "segmentation"`), `scores` (null for `kind: "segmentation"`), `scoresVsAlt` (populated only at `debug` when both head-to-head paths produced a viable result), and the rest of the structural fields populated; at `metrics` level, content fields (`token`, `suggestion`, `original`, `candidates`, `lineText`, `cursor`) SHALL be omitted. The editor does NOT emit this event — see the "Telemetry emit ownership" requirement above.

#### Scenario: correction.rejected fires on backspace-undo
- **WHEN** the user backspaces within the undo window and a previous correction is reverted
- **THEN** a `correction.rejected` event SHALL be emitted with `msUntilUndo` measuring elapsed milliseconds since the correction's `correction.applied` timestamp; `kind` SHALL match the original correction's kind

### Requirement: /typos stats summary command
The `/typos` command SHALL accept a `stats` subcommand that prints a summary of telemetry data over a configurable time range. The supported syntax SHALL be:

- `/typos stats` — default range `24h`
- `/typos stats 24h` — last 24 hours
- `/typos stats 7d` — last 7 days
- `/typos stats all` — everything in the telemetry directory
- `/typos stats reset` — delete all `events-*.ndjson` files (after a confirmation prompt)

The summary SHALL aggregate from disk by streaming the NDJSON files in the date range, NOT from in-memory counters. The aggregation SHALL filter individual NDJSON events by the event's own `timestamp` field against `now - rangeMs`, NOT by file mtime. The file-list step is an I/O optimization (skip files whose date stamp is entirely outside the range) but the per-event timestamp filter SHALL be authoritative; this avoids a 24h-vs-48h discrepancy that would arise if the `24h` range loaded "today's" and "yesterday's" files without intra-file filtering. The summary SHALL include:

- Total `correction.applied` count, broken down by `kind`
- Acceptance rate: `1 − (correction.rejected / correction.applied)`, both counts must be from the same time range
- Lookup latency: count, p50, p95 (from `lookup.latency` events)
- Segmentation latency: count, p50, p95 (from `segmentation.attempt` events; only when at least one segmentation attempt is in the range)
- `engine.init` count, average `buildMs` for `fromCache: true` and `fromCache: false` separately
- Cache hit rate: `count(fromCache:true) / count(any)` from `engine.init` events
- Telemetry file count, total file size, oldest event date

The summary SHALL be presented as a single info-level notification with a multi-line message, similar to `/typos config` and `/typos dict` listings.

#### Scenario: Default stats range is 24h
- **WHEN** the user runs `/typos stats`
- **THEN** the extension SHALL aggregate events whose `timestamp` is within the last 24 hours of `Date.now()` (filtered per-event from the candidate file set spanning today and yesterday); events older than `now - 24h` from yesterday's file SHALL be excluded; the heading SHALL include the range `(last 24h)`

#### Scenario: Stats with custom range
- **WHEN** the user runs `/typos stats 7d`
- **THEN** the extension SHALL aggregate from the most recent 7 daily files and print the summary; the heading SHALL include `(last 7d)`

#### Scenario: Stats `all` aggregates the full retention window
- **WHEN** the user runs `/typos stats all`
- **THEN** the extension SHALL aggregate from every `events-*.ndjson` file in the telemetry directory; the heading SHALL include `(all retained data)` and the date range from oldest to newest

#### Scenario: Stats reset requires confirmation
- **WHEN** the user runs `/typos stats reset` for the first time in a session
- **THEN** the extension SHALL prompt with an info notification "Reset all autocorrect telemetry? Run `/typos stats reset` again within 30 seconds to confirm." and SHALL NOT delete any files yet; the second invocation within 30 seconds SHALL delete every `events-*.ndjson` file in the telemetry directory

#### Scenario: Stats with no data
- **WHEN** the user runs `/typos stats` and the telemetry directory is empty (or `telemetry` is `"off"` and never wrote anything)
- **THEN** the extension SHALL show "No autocorrect telemetry recorded" without erroring

#### Scenario: Stats reads historical data even when telemetry is currently off
- **WHEN** the user has previously written telemetry events at `metrics` or `debug` level, has since changed `telemetry` to `"off"`, and now runs `/typos stats`
- **THEN** the extension SHALL aggregate and display the previously-written historical data (because the events still exist on disk); the summary header SHALL include a note like "telemetry is currently off; showing historical data only" so the user is not surprised; to remove historical data the user must run `/typos stats reset`

#### Scenario: Stats argument auto-completion
- **WHEN** the user types `/typos stats ` and triggers completion
- **THEN** the extension SHALL suggest `24h`, `7d`, `all`, `reset`

### Requirement: Telemetry config knob behaves like other live-applied keys
The `/typos config telemetry <value>` command SHALL accept the values `off`, `metrics`, `debug` (case-sensitive). Setting the value SHALL be persisted immediately and SHALL apply live (no engine rebuild). When the value changes from `off` to `metrics` or `debug`, subsequent events SHALL begin appearing in the telemetry log; when the value changes to `off`, subsequent events SHALL be suppressed at the call site (the writer module checks the live value before writing).

#### Scenario: Live transition off → metrics
- **WHEN** the user runs `/typos config telemetry metrics` while autocorrect is active and the previous value was `off`
- **THEN** the next correction SHALL produce a `correction.applied` event in the telemetry log; no engine rebuild SHALL occur

#### Scenario: Live transition metrics → debug
- **WHEN** the user runs `/typos config telemetry debug` and the previous value was `metrics`
- **THEN** subsequent events SHALL include content fields (`token`, `suggestion`, etc.); previously-written events at `metrics` level SHALL be unchanged on disk

#### Scenario: Reject invalid telemetry values
- **WHEN** the user runs `/typos config telemetry <value>` where `<value>` is not in `{off, metrics, debug}`
- **THEN** the extension SHALL show "Usage: /typos config telemetry <off|metrics|debug>" and SHALL NOT modify the configuration
