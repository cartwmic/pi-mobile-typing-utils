## ADDED Requirements

### Requirement: /typos stats subcommand
The `/typos` command SHALL accept a `stats` subcommand that prints a summary of recent telemetry data. The supported syntax SHALL be:

- `/typos stats` — default range `24h`
- `/typos stats 24h` — last 24 hours
- `/typos stats 7d` — last 7 days
- `/typos stats all` — every retained `events-*.ndjson` file
- `/typos stats reset` — delete all telemetry NDJSON files (after a single-step confirmation)

The summary's content and confirmation behavior are detailed in the `telemetry` capability spec ("/typos stats summary command"). The toggle-command spec restates the dispatch contract here so the `/typos` command's argument shape is complete.

#### Scenario: Stats with default range
- **WHEN** the user runs `/typos stats`
- **THEN** the extension SHALL aggregate the last 24h of telemetry data and print a summary notification (per the `telemetry` spec)

#### Scenario: Stats reset confirmation flow
- **WHEN** the user runs `/typos stats reset` for the first time in a session
- **THEN** the extension SHALL prompt for confirmation, store `pendingResetAt = Date.now()` in the per-process command state, and SHALL NOT delete any files; a second `/typos stats reset` invocation SHALL check `Date.now() - pendingResetAt`; if `<= 30000` ms, the extension SHALL delete every `events-*.ndjson` file in the telemetry directory; if `> 30000` ms, the second invocation SHALL be treated as a fresh first-invocation (re-prompt and reset `pendingResetAt`) rather than executing a stale confirmation. The `pendingResetAt` field SHALL not be persisted across processes; a Pi session restart resets the confirmation window.

## MODIFIED Requirements

### Requirement: Argument auto-completion for /typos command
The `/typos` command SHALL provide argument auto-completion to surface available subcommands and value sets without requiring users to memorize them. Auto-completion SHALL operate at three levels: first-level subcommand suggestions when the cursor is positioned after `/typos `, second-level option suggestions for subcommands that have a fixed argument set (`dict`, `default`, `config`, `stats`), and third-level value suggestions for `config <key>` invocations whose values are bounded.

#### Scenario: First-level completion
- **WHEN** the user types `/typos ` and triggers completion
- **THEN** the extension SHALL suggest `on`, `off`, `dict`, `default`, `config`, `stats`

#### Scenario: Second-level dict completion
- **WHEN** the user types `/typos dict ` and triggers completion
- **THEN** the extension SHALL suggest `add`, `remove`, `search`, `clear`

#### Scenario: Second-level default completion
- **WHEN** the user types `/typos default ` and triggers completion
- **THEN** the extension SHALL suggest `on`, `off`

#### Scenario: Second-level config completion
- **WHEN** the user types `/typos config ` and triggers completion
- **THEN** the extension SHALL suggest `defaultMode`, `maxEditDistance`, `minWordLength`, `minEditDistance`, `editDistanceStepEvery`, `enableSegmentation`, `segmentationMinLength`, `segmentationMaxEditDistance`, `segmentationLogProbFloor`, `segmentationVsLookupBias`, `enableContextRerank`, `rerankBigramWeight`, `rerankTrigramWeight`, `rerankEditDistancePenalty`, `telemetry`

#### Scenario: Second-level stats completion
- **WHEN** the user types `/typos stats ` and triggers completion
- **THEN** the extension SHALL suggest `24h`, `7d`, `all`, `reset`

### Requirement: Tuning configuration via /typos config
The extension SHALL expose a flat `/typos config` key/value surface for runtime-tunable parameters, persisted to the same configuration file as `defaultMode`. The supported keys SHALL be: `defaultMode`, `maxEditDistance`, `minWordLength`, `minEditDistance`, `editDistanceStepEvery`, `enableSegmentation`, `segmentationMinLength`, `segmentationMaxEditDistance`, `segmentationLogProbFloor`, `segmentationVsLookupBias`, `enableContextRerank`, `rerankBigramWeight`, `rerankTrigramWeight`, `rerankEditDistancePenalty`, and `telemetry`. Each key SHALL be range- or enum-validated; out-of-range, non-integer, or non-matching-enum values SHALL be rejected without modifying the persisted configuration.

The keys SHALL be classified as either **rebuild-required** (changing the value invalidates the engine instance and triggers a non-blocking rebuild) or **live-applied** (changing the value takes effect on the next correction lookup without a rebuild):

| Key | Type / Range | Default | Rebuild |
|---|---|---|---|
| `defaultMode` | enum `on`/`off` | `off` | n/a (config only) |
| `maxEditDistance` | int `[1, 4]` | `2` | yes |
| `minWordLength` | int `[2, 8]` | `2` | no |
| `minEditDistance` | int `[0, maxEditDistance]` | `1` | no |
| `editDistanceStepEvery` | int `[1, 8]` | `4` | no |
| `enableSegmentation` | bool | `true` | no |
| `segmentationMinLength` | int `[4, 12]` | `6` | no |
| `segmentationMaxEditDistance` | int `[0, 2]` | `1` | no |
| `segmentationLogProbFloor` | number `[-30, 0]` | `-12.0` | no |
| `segmentationVsLookupBias` | number `[-10, 10]` | `0.0` | no |
| `enableContextRerank` | bool | `true` | no |
| `rerankBigramWeight` | number `[0, 1]` | `0.5` | no |
| `rerankTrigramWeight` | number `[0, 1]` | `0.3` | no |
| `rerankEditDistancePenalty` | number `[0, 5]` | `1.0` | no |
| `telemetry` | enum `off`/`metrics`/`debug` | `metrics` | no |

The `defaultMode` key SHALL remain functionally equivalent to the dedicated `/typos default` subcommand. The existing rebuild rules for `maxEditDistance` (orphan-generation guard, non-blocking lazy-fire) SHALL continue to apply unchanged.

#### Scenario: List all configured values
- **WHEN** the user runs `/typos config`
- **THEN** the extension SHALL show a single info notification beginning with "Mobile autocorrect config:" and including one line per key with the current value and (for ranged keys) the allowed range; the listing SHALL include every key in the table above

#### Scenario: Show a single configured value
- **WHEN** the user runs `/typos config <key>` where `<key>` is a supported key
- **THEN** the extension SHALL show "<key> = <value> (range <range>)" for ranged keys, "<key> = <value>" for enum/boolean keys; for `minEditDistance` the upper bound SHALL be the current `maxEditDistance` value

#### Scenario: Reject unknown config keys
- **WHEN** the user runs `/typos config <key>` where `<key>` is not one of the supported keys
- **THEN** the extension SHALL show "Usage: /typos config [<key1>|<key2>|…] [<value>]" listing all supported keys and SHALL NOT modify the configuration

#### Scenario: Configure defaultMode via /typos config
- **WHEN** the user runs `/typos config defaultMode on` and the previous configured value is `off`
- **THEN** the extension SHALL behave identically to `/typos default on`: persist the value and emit "Default mode for new sessions set to on"

#### Scenario: Configure maxEditDistance with non-blocking engine rebuild
- **WHEN** the user runs `/typos config maxEditDistance <n>` where `<n>` is an integer in `[1, 4]`, differs from the current value, AND is greater than or equal to the current `minEditDistance`
- **THEN** the configuration SHALL be persisted, the cached correction engine SHALL be dropped, and a new engine SHALL be constructed and initialized in the background (non-blocking) so the change takes effect once the new engine reaches `ready` state; a notification SHALL show "maxEditDistance set to <n>"

#### Scenario: Reject maxEditDistance change that would violate minEditDistance invariant
- **WHEN** the user runs `/typos config maxEditDistance <n>` where `<n>` is a valid integer in `[1, 4]` but is LESS than the currently persisted `minEditDistance`
- **THEN** the extension SHALL reject the change with an actionable error: "Cannot set maxEditDistance to <n>: minEditDistance is currently <m> and must be ≤ maxEditDistance. Lower minEditDistance first via `/typos config minEditDistance <≤n>`." The configuration SHALL NOT be modified and the engine SHALL NOT be rebuilt.

#### Scenario: Persisted minEditDistance > persisted maxEditDistance preserves user's maxEditDistance
- **WHEN** the configuration file contains a value for `minEditDistance` that exceeds the persisted `maxEditDistance` (e.g., due to manual editing or a corrupted write)
- **THEN** the persisted `maxEditDistance` SHALL be preserved (it is itself a valid value the user may have set deliberately); `minEditDistance` SHALL be replaced by `min(bootstrap_default_minEditDistance, persisted_maxEditDistance)` so that the runtime invariant `minEditDistance ≤ maxEditDistance` always holds; other valid keys SHALL be preserved; the file SHALL NOT be auto-rewritten until the user explicitly sets a value

#### Scenario: Hot-reload the engine when maxEditDistance changes while enabled
- **WHEN** the user runs `/typos config maxEditDistance <n>` while autocorrect is currently enabled
- **THEN** the extension SHALL bump the orphan-generation token (orphaning any in-flight init's UI callbacks per the design.md "Orphan-promise generation guard" decision), drop the cached engine, and re-invoke the lazy enable path internally to construct and start a fresh engine. The new initialization SHALL run in the background; control returns to the toggle command immediately without waiting for the abandoned in-flight init to complete. The user SHALL see the persistent `"typos"` status indicator transition to `"Autocorrect loading…"` until the new engine reaches `ready`. The hot-reload SHALL emit a single `"maxEditDistance set to <n>"` notification.

#### Scenario: maxEditDistance change while disabled does not enable autocorrect
- **WHEN** the user runs `/typos config maxEditDistance <n>` while autocorrect is currently DISABLED (`state.enabled === false`)
- **THEN** the extension SHALL persist the new value, bump the orphan-generation token (defensively orphans any lingering pre-warm or prior-rebuild in-flight init), drop any cached engine, and emit `"maxEditDistance set to <n>"`. It SHALL NOT install the editor, set the persistent `"typos"` indicator, or kick off engine initialization.

#### Scenario: Reject out-of-range or non-integer maxEditDistance
- **WHEN** the user runs `/typos config maxEditDistance <v>` where `<v>` is not an integer in `[1, 4]`
- **THEN** the extension SHALL show "Usage: /typos config maxEditDistance <integer 1-4>" and SHALL NOT modify the configuration or rebuild the engine

#### Scenario: Configure minWordLength live
- **WHEN** the user runs `/typos config minWordLength <n>` where `<n>` is an integer in `[2, 8]` and differs from the current value
- **THEN** the configuration SHALL be persisted and the next correction lookup SHALL use the new value without rebuilding the engine; a notification SHALL show "minWordLength set to <n>"

#### Scenario: Reject out-of-range or non-integer minWordLength
- **WHEN** the user runs `/typos config minWordLength <v>` where `<v>` is not an integer in `[2, 8]`
- **THEN** the extension SHALL show "Usage: /typos config minWordLength <integer 2-8>" and SHALL NOT modify the configuration

#### Scenario: Configure minEditDistance live
- **WHEN** the user runs `/typos config minEditDistance <n>` where `<n>` is an integer in `[0, maxEditDistance]` and differs from the current value
- **THEN** the configuration SHALL be persisted and the next correction lookup SHALL use the new value without rebuilding the engine; a notification SHALL show "minEditDistance set to <n>"

#### Scenario: Reject minEditDistance greater than maxEditDistance
- **WHEN** the user runs `/typos config minEditDistance <v>` where `<v>` is greater than the current `maxEditDistance`
- **THEN** the extension SHALL show "Usage: /typos config minEditDistance <integer 0-<current maxEditDistance>>" and SHALL NOT modify the configuration

#### Scenario: Reject out-of-range or non-integer minEditDistance
- **WHEN** the user runs `/typos config minEditDistance <v>` where `<v>` is not an integer in `[0, maxEditDistance]`
- **THEN** the extension SHALL show "Usage: /typos config minEditDistance <integer 0-<current maxEditDistance>>" and SHALL NOT modify the configuration

#### Scenario: Configure editDistanceStepEvery live
- **WHEN** the user runs `/typos config editDistanceStepEvery <n>` where `<n>` is an integer in `[1, 8]` and differs from the current value
- **THEN** the configuration SHALL be persisted and the next correction lookup SHALL use the new value without rebuilding the engine; a notification SHALL show "editDistanceStepEvery set to <n>"

#### Scenario: Reject out-of-range or non-integer editDistanceStepEvery
- **WHEN** the user runs `/typos config editDistanceStepEvery <v>` where `<v>` is not an integer in `[1, 8]`
- **THEN** the extension SHALL show "Usage: /typos config editDistanceStepEvery <integer 1-8>" and SHALL NOT modify the configuration

#### Scenario: Configure enableSegmentation live
- **WHEN** the user runs `/typos config enableSegmentation <bool>` where `<bool>` is `true` or `false` and differs from the current value
- **THEN** the configuration SHALL be persisted and subsequent corrections SHALL respect the new value without rebuilding the engine; a notification SHALL show "enableSegmentation set to <bool>"

#### Scenario: Reject non-boolean enableSegmentation
- **WHEN** the user runs `/typos config enableSegmentation <v>` where `<v>` is not exactly `true` or `false` (case-sensitive)
- **THEN** the extension SHALL show "Usage: /typos config enableSegmentation <true|false>" and SHALL NOT modify the configuration

#### Scenario: Configure segmentationMinLength live
- **WHEN** the user runs `/typos config segmentationMinLength <n>` where `<n>` is an integer in `[4, 12]` and differs from the current value
- **THEN** the configuration SHALL be persisted and the next correction lookup SHALL use the new value without rebuilding the engine; a notification SHALL show "segmentationMinLength set to <n>"

#### Scenario: Reject out-of-range or non-integer segmentationMinLength
- **WHEN** the user runs `/typos config segmentationMinLength <v>` where `<v>` is not an integer in `[4, 12]`
- **THEN** the extension SHALL show "Usage: /typos config segmentationMinLength <integer 4-12>" and SHALL NOT modify the configuration

#### Scenario: Configure segmentationMaxEditDistance live
- **WHEN** the user runs `/typos config segmentationMaxEditDistance <n>` where `<n>` is an integer in `[0, 2]` and differs from the current value
- **THEN** the configuration SHALL be persisted and the next correction lookup SHALL use the new value without rebuilding the engine; a notification SHALL show "segmentationMaxEditDistance set to <n>"

#### Scenario: Reject out-of-range or non-integer segmentationMaxEditDistance
- **WHEN** the user runs `/typos config segmentationMaxEditDistance <v>` where `<v>` is not an integer in `[0, 2]`
- **THEN** the extension SHALL show "Usage: /typos config segmentationMaxEditDistance <integer 0-2>" and SHALL NOT modify the configuration

#### Scenario: Configure segmentationLogProbFloor live
- **WHEN** the user runs `/typos config segmentationLogProbFloor <v>` where `<v>` is a number in `[-30, 0]` and differs from the current value
- **THEN** the configuration SHALL be persisted and the next correction lookup SHALL use the new value without rebuilding the engine; a notification SHALL show "segmentationLogProbFloor set to <v>"

#### Scenario: Reject out-of-range or non-number segmentationLogProbFloor
- **WHEN** the user runs `/typos config segmentationLogProbFloor <v>` where `<v>` is not a finite number in `[-30, 0]`
- **THEN** the extension SHALL show "Usage: /typos config segmentationLogProbFloor <number -30 to 0>" and SHALL NOT modify the configuration

#### Scenario: Configure segmentationVsLookupBias live
- **WHEN** the user runs `/typos config segmentationVsLookupBias <v>` where `<v>` is a number in `[-10, 10]` and differs from the current value
- **THEN** the configuration SHALL be persisted and the next correction lookup SHALL use the new value without rebuilding the engine; the next `shouldCorrect` call's head-to-head comparison between lookup and segmentation paths uses the new bias; a notification SHALL show "segmentationVsLookupBias set to <v>"

#### Scenario: Reject out-of-range or non-number segmentationVsLookupBias
- **WHEN** the user runs `/typos config segmentationVsLookupBias <v>` where `<v>` is not a finite number in `[-10, 10]`
- **THEN** the extension SHALL show "Usage: /typos config segmentationVsLookupBias <number -10 to 10>" and SHALL NOT modify the configuration

#### Scenario: Configure enableContextRerank live
- **WHEN** the user runs `/typos config enableContextRerank <bool>` where `<bool>` is `true` or `false` and differs from the current value
- **THEN** the configuration SHALL be persisted and subsequent corrections SHALL respect the new value without rebuilding the engine; a notification SHALL show "enableContextRerank set to <bool>"

#### Scenario: Reject non-boolean enableContextRerank
- **WHEN** the user runs `/typos config enableContextRerank <v>` where `<v>` is not exactly `true` or `false`
- **THEN** the extension SHALL show "Usage: /typos config enableContextRerank <true|false>" and SHALL NOT modify the configuration

#### Scenario: Configure rerank weight knobs live
- **WHEN** the user runs `/typos config <key> <v>` where `<key>` is `rerankBigramWeight`, `rerankTrigramWeight`, or `rerankEditDistancePenalty`, and `<v>` is a finite number in the key's documented range, differing from the current value
- **THEN** the configuration SHALL be persisted and the next correction lookup SHALL use the new value without rebuilding the engine; a notification SHALL show "<key> set to <v>"

#### Scenario: Reject out-of-range rerank weights
- **WHEN** the user runs `/typos config <weightKey> <v>` where `<v>` is not a finite number in `[0, 1]` for `rerankBigramWeight`/`rerankTrigramWeight`, or not in `[0, 5]` for `rerankEditDistancePenalty`
- **THEN** the extension SHALL show a usage message naming the documented range for the key and SHALL NOT modify the configuration

#### Scenario: Configure telemetry live
- **WHEN** the user runs `/typos config telemetry <value>` where `<value>` is `off`, `metrics`, or `debug`
- **THEN** the configuration SHALL be persisted and subsequent telemetry events SHALL respect the new level without rebuilding the engine; a notification SHALL show "telemetry set to <value>"

#### Scenario: Reject invalid telemetry values
- **WHEN** the user runs `/typos config telemetry <v>` where `<v>` is not in `{off, metrics, debug}` (case-sensitive)
- **THEN** the extension SHALL show "Usage: /typos config telemetry <off|metrics|debug>" and SHALL NOT modify the configuration

#### Scenario: Out-of-range persisted values fall back to defaults
- **WHEN** the configuration file contains a value for any ranged or enum-typed key that is outside the valid range or not a member of the enum
- **THEN** the extension SHALL load the affected key with its bootstrap default; the file SHALL NOT be auto-rewritten until the user explicitly sets a value; other valid keys SHALL be preserved

#### Scenario: Third-level value completion for /typos config
- **WHEN** the user types `/typos config <key> ` and triggers completion for a key with a bounded value set
- **THEN** the extension SHALL suggest values: integer enumerations for ranged-int keys (e.g. `[currentMinEditDistance, 4]` for `maxEditDistance`), `true`/`false` for boolean keys, `off`/`metrics`/`debug` for `telemetry`, and `on`/`off` for `defaultMode`; for number-valued keys (`segmentationLogProbFloor`, `segmentationVsLookupBias`, `rerankBigramWeight`, `rerankTrigramWeight`, `rerankEditDistancePenalty`) no value suggestions are required (free-form numeric input)
