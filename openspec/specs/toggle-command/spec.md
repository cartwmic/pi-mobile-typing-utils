# Specification

## Purpose

The `/typos` command is the user-facing control surface for autocorrect. It supports `on`, `off`, bare-toggle, status reporting, idempotent re-issue, lazy engine initialization with status feedback, async-init serialization (final state wins), routes `dict` subcommands to dictionary management, routes `default` subcommands to the persisted default mode for new sessions, and routes `config` subcommands to a flat key/value tuning surface (`defaultMode`, `maxEditDistance`, `minWordLength`). Autocorrect state is per-session — each new Pi session starts in the configured default mode (which itself defaults to disabled if never set), regardless of the prior session's state.
## Requirements
### Requirement: Enable autocorrect with /typos on
The `/typos on` command SHALL enable autocorrect for the current session by replacing Pi's editor with the AutocorrectEditor via `ctx.ui.setEditorComponent()`. On first enable, the command SHALL trigger lazy initialization of the correction engine — including loading dictionaries or hydrating from the on-disk index cache — but SHALL NOT block on initialization completing. The editor SHALL be installed immediately and accept keystrokes; the engine's existing graceful-degradation behavior (returning `{corrected: false}` while not ready) SHALL apply for the brief window before init completes. The persistent status indicator (`setStatus("typos", ...)`, see the "Status indicator when autocorrect is active" requirement) SHALL carry the live readiness story (`"Autocorrect loading…"` while building, `"✓ Autocorrect"` once ready, `"Autocorrect unavailable"` if degraded). The previously-used loading status key `"typos-loading"` SHALL NOT be set anymore — it is redundant with the persistent indicator and would render two simultaneous "loading" widgets to the user.

#### Scenario: Enable autocorrect (first time, engine still building)
- **WHEN** the user runs `/typos on` for the first time in a session and the engine has not yet reached `ready` state (no pre-warm hit)
- **THEN** the extension SHALL install the AutocorrectEditor immediately, kick off engine initialization in the background (or attach to an in-flight pre-warm promise if one exists — see "Engine pre-warms at extension load" requirement), update the persistent status `"typos"` to `"Autocorrect loading…"` until the engine reaches `ready` (or `degraded`), and emit `"Autocorrect ON (loading…)"` without waiting for initialization to complete. The user SHALL be able to type during initialization (subject to the cache-miss synchronous-build caveat documented in design.md); corrections SHALL begin firing once the engine reaches `ready` state.

#### Scenario: Enable autocorrect when engine is already ready (pre-warm hit)
- **WHEN** the user runs `/typos on` for the first time in a session and the engine has already reached `ready` state via pre-warm
- **THEN** the extension SHALL install the AutocorrectEditor immediately, set the persistent status `"typos"` to `"✓ Autocorrect"`, and emit `"Autocorrect ON"` (no "loading…" suffix)

#### Scenario: typos-loading status key is no longer set
- **WHEN** any toggle command runs (`/typos on`, `/typos off`, `/typos`, or any `/typos config` rebuild)
- **THEN** the extension SHALL NOT call `setStatus("typos-loading", ...)`; the persistent `"typos"` indicator SHALL be the sole source of truth for engine lifecycle visibility

#### Scenario: Enable autocorrect (subsequent)
- **WHEN** the user runs `/typos on` after having previously enabled and disabled autocorrect in the same session
- **THEN** the editor SHALL be replaced with AutocorrectEditor immediately (the engine instance is cached) and show "Autocorrect ON"; no re-initialization SHALL occur

#### Scenario: Already enabled
- **WHEN** the user runs `/typos on` and autocorrect is already enabled
- **THEN** the extension SHALL show "Autocorrect is already on"

#### Scenario: Engine initialization failure surfaces a degraded state
- **WHEN** background initialization fails (cache load failed AND fresh build also failed) after `/typos on`
- **THEN** the extension SHALL clear the loading status, emit a notification at error level naming the failure, and the engine's readiness state SHALL be `degraded`; the editor remains installed but corrections do not fire

#### Scenario: /typos on while degraded retries initialization
- **WHEN** the engine is in `degraded` state (a previous initialization failed) and the user runs `/typos on` (or the bare `/typos` toggle) while autocorrect is currently disabled
- **THEN** the extension SHALL discard the existing degraded engine instance, construct a fresh engine, and start initialization from scratch (cache load preferred, fresh build on miss); the readiness state SHALL transition `degraded → building → ready` (or back to `degraded` on repeated failure)

#### Scenario: /typos on while degraded and already enabled is treated as already-on
- **WHEN** the engine is in `degraded` state and the user runs `/typos on` while autocorrect is already enabled
- **THEN** the extension SHALL show "Autocorrect is already on" (existing behavior); the user must explicitly disable and re-enable to trigger a retry, OR change a config knob that triggers a rebuild

### Requirement: Disable autocorrect with /typos off
The `/typos off` command SHALL disable autocorrect for the current session by restoring Pi's default editor via `ctx.ui.setEditorComponent(undefined)`.

#### Scenario: Disable autocorrect
- **WHEN** the user runs `/typos off` and autocorrect is currently enabled
- **THEN** the editor SHALL be restored to the default and a notification SHALL show "Autocorrect OFF"

#### Scenario: Already disabled
- **WHEN** the user runs `/typos off` and autocorrect is already disabled
- **THEN** the extension SHALL show "Autocorrect is already off"

### Requirement: Toggle autocorrect with /typos
The `/typos` command with no arguments SHALL toggle autocorrect: enable if disabled, disable if enabled.

#### Scenario: Toggle from off to on
- **WHEN** the user runs `/typos` and autocorrect is disabled
- **THEN** autocorrect SHALL be enabled and a notification SHALL show "Autocorrect ON"

#### Scenario: Toggle from on to off
- **WHEN** the user runs `/typos` and autocorrect is enabled
- **THEN** autocorrect SHALL be disabled and a notification SHALL show "Autocorrect OFF"

### Requirement: Autocorrect state is per-session
Autocorrect state SHALL NOT persist across Pi sessions. Each new session SHALL start in the configured default mode (see "Default mode configuration"); when no default mode has been configured, sessions SHALL start with autocorrect disabled. The learned dictionary loads at extension init (for `/typos dict` availability); correction-engine dictionaries (English + tech) are not loaded until first enable, OR — when `defaultMode === "on"` — engine initialization SHALL be pre-warmed during extension load (before `session_start` fires) so that the engine is more likely to be `ready` by the time the user types their first word. Pre-warming SHALL itself be non-blocking and SHALL not delay extension load.

#### Scenario: New session starts in the configured default mode
- **WHEN** the user starts a new Pi session
- **THEN** autocorrect SHALL be reconciled to the configured default mode; when no default mode has been configured, autocorrect SHALL be disabled; the learned dictionary SHALL be loaded (for `/typos dict` availability) but the correction-engine dictionaries (English + tech) SHALL NOT be loaded until first enable (or until the configured default mode is `on`, in which case they begin loading as part of extension-load pre-warming)

#### Scenario: Engine pre-warms at extension load when defaultMode is on
- **WHEN** the extension factory function is invoked and `config.defaultMode === "on"`
- **THEN** the extension SHALL kick off engine initialization in the background (without awaiting it) before the `session_start` event fires; on Pi instances that fire `session_start` quickly after extension load, the engine may not yet be `ready` when the editor is installed, in which case the existing graceful-degradation behavior applies

#### Scenario: applyDefaultMode reuses the pre-warmed engine
- **WHEN** the extension has pre-warmed an engine at extension load time and `applyDefaultMode` (triggered by `session_start`) subsequently calls `enable()`
- **THEN** the toggle command SHALL reuse the pre-warmed engine instance (and its in-flight initialization promise, if still pending) rather than constructing a second engine; only one initialization SHALL be in flight at a time

#### Scenario: Pre-warm failure surfaces on first enable
- **WHEN** pre-warm initialization has failed (engine is in `degraded` state) before the first `enable()` call
- **THEN** the first `enable()` SHALL discard the degraded engine and start fresh initialization (matching the "`/typos on` while degraded retries initialization" scenario); no error notification SHALL be emitted from the pre-warm itself, because there is no UI context yet — the failure surfaces at the first `enable()` instead

#### Scenario: No pre-warm when defaultMode is off
- **WHEN** the extension factory function is invoked and `config.defaultMode === "off"`
- **THEN** the extension SHALL NOT pre-warm the engine; initialization SHALL only occur on the first `/typos on` (or `/typos`) toggle

### Requirement: Default mode configuration
The extension SHALL persist a `defaultMode` configuration value that controls the autocorrect state new sessions start in. The configuration SHALL be stored in a JSON file at `~/.pi/agent/mobile-autocorrect-config.json` by default, overridable via the `MOBILE_AUTOCORRECT_CONFIG_PATH` environment variable. The bootstrap value of `defaultMode` SHALL be `"off"`, preserving the long-standing per-session behavior for users who never configure it. The `/typos default` subcommand SHALL expose this configuration, and on every `session_start` event the extension SHALL reconcile session state to the configured value, in both directions (off→on and on→off), with already-in-state cases as silent no-ops.

#### Scenario: Inspect the current default mode
- **WHEN** the user runs `/typos default`
- **THEN** the extension SHALL show "Default mode for new sessions: <mode>" where `<mode>` is the current configured value (`on` or `off`)

#### Scenario: Configure default mode to on
- **WHEN** the user runs `/typos default on` and the previous configured value is `off`
- **THEN** the configuration SHALL be persisted to disk with `defaultMode: "on"` and a notification SHALL show "Default mode for new sessions set to on"

#### Scenario: Configure default mode to off
- **WHEN** the user runs `/typos default off` and the previous configured value is `on`
- **THEN** the configuration SHALL be persisted to disk with `defaultMode: "off"` and a notification SHALL show "Default mode for new sessions set to off"

#### Scenario: Re-issuing the current default mode is idempotent
- **WHEN** the user runs `/typos default off` and the configured value is already `off`
- **THEN** the configuration file SHALL NOT be rewritten and the notification SHALL show "Default mode is already off"; the same idempotent behavior applies to `/typos default on` when already `on`

#### Scenario: Reject invalid default mode arguments
- **WHEN** the user runs `/typos default <anything other than on or off>`
- **THEN** the extension SHALL show "Usage: /typos default [on|off]" and SHALL NOT modify the configuration

#### Scenario: Session-start reconciliation when default is on
- **WHEN** a session_start event fires (reason `startup`, `reload`, `new`, `resume`, or `fork`) and the configured default mode is `on` and autocorrect is currently disabled
- **THEN** the extension SHALL go through the same enable path as `/typos on`, including lazy engine initialization, the editor swap, the persistent status indicator, and the "Autocorrect ON" notification

#### Scenario: Session-start reconciliation when default is off
- **WHEN** a session_start event fires and the configured default mode is `off` and autocorrect is currently enabled (e.g. carried over from a prior session via session switch)
- **THEN** the extension SHALL go through the same disable path as `/typos off`, including the editor restore, the status-indicator clear, and the "Autocorrect OFF" notification

#### Scenario: Session-start reconciliation is silent when state already matches
- **WHEN** a session_start event fires and autocorrect is already in the configured default mode
- **THEN** the extension SHALL NOT emit any notification and SHALL NOT toggle the editor or status indicator

#### Scenario: Malformed config file is tolerated
- **WHEN** the configuration file exists but contains invalid JSON or an unknown `defaultMode` value
- **THEN** the extension SHALL load with the bootstrap default (`defaultMode: "off"`) and SHALL log a warning, without crashing extension initialization

### Requirement: Status indicator when autocorrect is active
When autocorrect is enabled, the extension SHALL show a persistent status indicator via `ctx.ui.setStatus()` whose value reflects the engine's readiness state. The status key SHALL be `"typos"` (distinct from the correction-feedback key `"typos-correction"`; the previously-used loading key `"typos-loading"` is no longer used — the `"typos"` indicator carries the loading state itself). The indicator SHALL take one of three forms based on the engine's readiness:

- `building`: "Autocorrect loading…"
- `ready`: "✓ Autocorrect"
- `degraded`: "Autocorrect unavailable"

When autocorrect is disabled, the indicator SHALL be cleared.

#### Scenario: Status shown when enabled and ready
- **WHEN** autocorrect is enabled and the engine has reached `ready` state
- **THEN** the status indicator SHALL show "✓ Autocorrect" via `setStatus("typos", ...)`

#### Scenario: Status shown when enabled and building
- **WHEN** autocorrect is enabled but the engine is still in `building` state (background initialization in progress)
- **THEN** the status indicator SHALL show "Autocorrect loading…" via `setStatus("typos", ...)`; once the engine reaches `ready`, the indicator SHALL update to "✓ Autocorrect"

#### Scenario: Status shown when enabled and degraded
- **WHEN** autocorrect is enabled but background initialization has failed and the engine is in `degraded` state
- **THEN** the status indicator SHALL show "Autocorrect unavailable" via `setStatus("typos", ...)`

#### Scenario: Status cleared when disabled
- **WHEN** autocorrect is disabled via `/typos off` or `/typos`
- **THEN** the status indicator SHALL be removed via `setStatus("typos", undefined)`

### Requirement: Route to dictionary subcommands
The `/typos` command SHALL route arguments starting with "dict" to the dictionary management subcommands (view, search, add, remove, clear). These subcommands SHALL work regardless of whether autocorrect is enabled or disabled.

#### Scenario: Dictionary command while disabled
- **WHEN** autocorrect is disabled and the user runs `/typos dict add kubernetes`
- **THEN** the word SHALL be added to the learned dictionary (dictionary management is always available)

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

### Requirement: Toggle serialization and orphan-promise generation guard
Enable/disable operations SHALL be serialized via the existing toggle-queue mechanism. The final requested state wins. Background engine initialization SHALL be tracked via an `initInFlight` promise, but `disable()` and `/typos config maxEditDistance` SHALL NOT await this promise (per the non-blocking scenarios below). Instead, those operations SHALL bump an orphan-generation token; every `.then`/`.catch` callback attached to `initInFlight` SHALL capture the generation at attachment time and early-return when the captured generation no longer matches the current `state.generation` OR when `state.enabled === false`. This prevents orphaned init's resolution from clobbering UI state the user has since changed. See design.md "Orphan-promise generation guard" for the full rule.

#### Scenario: Orphaned init callbacks make no UI side effects
- **WHEN** an `initialize()` call is attached to `state.initInFlight`, the user then runs `/typos off` (which bumps the generation), and the orphaned init subsequently resolves or rejects
- **THEN** the orphan's `.then`/`.catch` callbacks SHALL detect the generation mismatch and early-return; no `setStatus`, `notify`, or `state.engine` mutation SHALL occur on the orphaned engine's behalf

#### Scenario: Disable during initialization is non-blocking
- **WHEN** the user runs `/typos on` (triggering background initialization) and then immediately runs `/typos off` before initialization completes
- **THEN** the extension SHALL clear the editor and persistent status indicator immediately (within a few milliseconds, not waiting for initialization to complete) and show "Autocorrect OFF". The orphan-generation token SHALL be bumped so the in-flight initialization's `.then`/`.catch` callbacks no-op when they eventually fire (per the design.md "Orphan-promise generation guard" decision). The orphan engine's resolution SHALL NOT be retained in `state.engine`; the next `/typos on` constructs a fresh engine.

#### Scenario: Double enable during initialization
- **WHEN** the user runs `/typos on` while a previous `/typos on` is still loading in the background
- **THEN** the extension SHALL recognize the duplicate intent and SHALL NOT start a second initialization. It SHALL emit `"Autocorrect is already on"` (existing already-enabled behavior) without re-installing the editor. The original in-flight init's `.then`/`.catch` continues to drive the persistent `"typos"` indicator's transition; no second "Autocorrect ON" notification SHALL be emitted (the original toggle's notification stands).

#### Scenario: maxEditDistance change during initialization is non-blocking
- **WHEN** the user runs `/typos config maxEditDistance <n>` while a previous `enable()`'s background initialization is still running
- **THEN** the extension SHALL persist the new value, abandon the in-flight engine (mark its result as orphaned — it MAY complete in the background, but its state SHALL NOT be used after orphaning), and start a fresh initialization with the new value via the normal lazy-fire path. The user-visible state SHALL transition immediately to "loading with new ED" without waiting for the abandoned init to finish.

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

