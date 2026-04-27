# Specification

## Purpose

The `/typos` command is the user-facing control surface for autocorrect. It supports `on`, `off`, bare-toggle, status reporting, idempotent re-issue, lazy engine initialization with status feedback, async-init serialization (final state wins), routes `dict` subcommands to dictionary management, routes `default` subcommands to the persisted default mode for new sessions, and routes `config` subcommands to a flat key/value tuning surface (`defaultMode`, `maxEditDistance`, `minWordLength`). Autocorrect state is per-session — each new Pi session starts in the configured default mode (which itself defaults to disabled if never set), regardless of the prior session's state.

## Requirements

### Requirement: Enable autocorrect with /typos on
The `/typos on` command SHALL enable autocorrect for the current session by replacing Pi's editor with the AutocorrectEditor via `ctx.ui.setEditorComponent()`. On first enable, the command SHALL lazily initialize the correction engine (loading dictionaries), showing a brief "Loading autocorrect..." status during initialization.

#### Scenario: Enable autocorrect (first time)
- **WHEN** the user runs `/typos on` for the first time in a session
- **THEN** the extension SHALL load dictionaries, show "Loading autocorrect..." via status key `"typos-loading"` during load, clear that status when done, then replace the editor with AutocorrectEditor and show "Autocorrect ON". The loading status key `"typos-loading"` is distinct from the persistent indicator key `"typos"` and the correction feedback key `"typos-correction"`.

#### Scenario: Enable autocorrect (subsequent)
- **WHEN** the user runs `/typos on` after having previously enabled and disabled autocorrect in the same session
- **THEN** the editor SHALL be replaced with AutocorrectEditor immediately (dictionaries already loaded) and show "Autocorrect ON"

#### Scenario: Already enabled
- **WHEN** the user runs `/typos on` and autocorrect is already enabled
- **THEN** the extension SHALL show "Autocorrect is already on"

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
Autocorrect state SHALL NOT persist across Pi sessions. Each new session SHALL start in the configured default mode (see "Default mode configuration"); when no default mode has been configured, sessions SHALL start with autocorrect disabled. The learned dictionary loads at extension init (for `/typos dict` availability); correction-engine dictionaries (English + tech) are not loaded until first enable.

#### Scenario: New session starts in the configured default mode
- **WHEN** the user starts a new Pi session
- **THEN** autocorrect SHALL be reconciled to the configured default mode; when no default mode has been configured, autocorrect SHALL be disabled; the learned dictionary SHALL be loaded (for `/typos dict` availability) but the correction-engine dictionaries (English + tech) SHALL NOT be loaded until first enable (or until the configured default mode is `on`, in which case they load as part of session-start reconciliation)

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

### Requirement: Toggle serialization during async initialization
Enable/disable operations SHALL be serialized via an in-flight promise. Concurrent toggle commands SHALL await the in-flight operation and then apply the requested state. The final requested state wins.

#### Scenario: Disable during initialization
- **WHEN** the user runs `/typos on` (triggering first-time dictionary load) and then immediately runs `/typos off` before loading completes
- **THEN** the extension SHALL await the load, then immediately disable autocorrect and show "Autocorrect OFF"

#### Scenario: Double enable during initialization
- **WHEN** the user runs `/typos on` while a previous `/typos on` is still loading
- **THEN** the extension SHALL await the existing load (not start a second one) and show "Autocorrect ON" once

### Requirement: Status indicator when autocorrect is active
When autocorrect is enabled, the extension SHALL show a persistent status indicator via `ctx.ui.setStatus()` that indicates autocorrect is active. The status key SHALL be "typos" to avoid collision with the correction-feedback status key "typos-correction".

#### Scenario: Status shown when enabled
- **WHEN** autocorrect is enabled via `/typos on` or `/typos`
- **THEN** a status indicator "✓ Autocorrect" SHALL appear in Pi's footer via `setStatus("typos", ...)`

#### Scenario: Status cleared when disabled
- **WHEN** autocorrect is disabled via `/typos off` or `/typos`
- **THEN** the status indicator SHALL be removed via `setStatus("typos", undefined)`

### Requirement: Route to dictionary subcommands
The `/typos` command SHALL route arguments starting with "dict" to the dictionary management subcommands (view, search, add, remove, clear). These subcommands SHALL work regardless of whether autocorrect is enabled or disabled.

#### Scenario: Dictionary command while disabled
- **WHEN** autocorrect is disabled and the user runs `/typos dict add kubernetes`
- **THEN** the word SHALL be added to the learned dictionary (dictionary management is always available)

### Requirement: Argument auto-completion for /typos command
The `/typos` command SHALL provide argument completions via `getArgumentCompletions`. First-level completions SHALL include `on`, `off`, `dict`, `default`, `config`. When the first argument is `dict`, second-level completions SHALL include `add`, `remove`, `search`, `clear`. When the first argument is `default`, second-level completions SHALL include `on`, `off`. When the first argument is `config`, second-level completions SHALL include `defaultMode`, `maxEditDistance`, `minWordLength`, and third-level completions SHALL include the valid values for the chosen key. Second-level and deeper completion items SHALL set their `value` to the full argument path (parent token included), because Pi's `applyCompletion` replaces the entire argument text with the chosen item's `value`.

#### Scenario: First-level completion
- **WHEN** the user types `/typos ` and triggers completion
- **THEN** the extension SHALL suggest `on`, `off`, `dict`, `default`, `config`

#### Scenario: Second-level dict completion
- **WHEN** the user types `/typos dict ` and triggers completion
- **THEN** the extension SHALL suggest `add`, `remove`, `search`, `clear`

#### Scenario: Second-level default completion
- **WHEN** the user types `/typos default ` and triggers completion
- **THEN** the extension SHALL suggest `on`, `off`

### Requirement: Tuning configuration via /typos config
The extension SHALL expose a flat `/typos config` key/value surface for runtime-tunable parameters, persisted to the same configuration file as `defaultMode`. The supported keys SHALL be `defaultMode`, `maxEditDistance`, and `minWordLength`. Each key SHALL be range-validated; out-of-range or non-integer values SHALL be rejected without modifying the persisted configuration. The `defaultMode` key SHALL be functionally equivalent to the dedicated `/typos default` subcommand. The `maxEditDistance` value SHALL be an integer in `[1, 3]` and SHALL be applied by rebuilding the SymSpell index (the value is baked into the index at initialization time); when autocorrect is currently enabled the rebuild SHALL happen automatically (disable, drop the cached engine, re-enable). The `minWordLength` value SHALL be an integer in `[2, 8]` and SHALL be applied live (read by the correction engine on each lookup, no rebuild required).

#### Scenario: List all configured values
- **WHEN** the user runs `/typos config`
- **THEN** the extension SHALL show a single info notification beginning with "Mobile autocorrect config:" and including one line per key with the current value and (for ranged keys) the allowed range

#### Scenario: Show a single configured value
- **WHEN** the user runs `/typos config maxEditDistance`
- **THEN** the extension SHALL show "maxEditDistance = <value> (range 1-3)"; analogous behavior applies to `minWordLength` (range 2-8) and `defaultMode` (no range)

#### Scenario: Reject unknown config keys
- **WHEN** the user runs `/typos config <key>` where `<key>` is not one of `defaultMode`, `maxEditDistance`, `minWordLength`
- **THEN** the extension SHALL show "Usage: /typos config [defaultMode|maxEditDistance|minWordLength] [<value>]" and SHALL NOT modify the configuration

#### Scenario: Configure defaultMode via /typos config
- **WHEN** the user runs `/typos config defaultMode on` and the previous configured value is `off`
- **THEN** the extension SHALL behave identically to `/typos default on`: persist the value and emit "Default mode for new sessions set to on"

#### Scenario: Configure maxEditDistance with engine rebuild
- **WHEN** the user runs `/typos config maxEditDistance <n>` where `<n>` is an integer in `[1, 3]` and differs from the current value
- **THEN** the configuration SHALL be persisted, the cached correction engine SHALL be dropped, and the next `/typos on` (or the immediate hot-reload if autocorrect is currently enabled) SHALL build a new SymSpell index with the new value; a notification SHALL show "maxEditDistance set to <n>"

#### Scenario: Hot-reload the engine when maxEditDistance changes while enabled
- **WHEN** the user runs `/typos config maxEditDistance <n>` while autocorrect is currently enabled
- **THEN** the extension SHALL disable autocorrect, drop the cached engine, and re-enable autocorrect (rebuilding the engine with the new value), so the change takes effect without requiring a manual `/typos off; /typos on`

#### Scenario: Reject out-of-range or non-integer maxEditDistance
- **WHEN** the user runs `/typos config maxEditDistance <v>` where `<v>` is not an integer in `[1, 3]`
- **THEN** the extension SHALL show "Usage: /typos config maxEditDistance <integer 1-3>" and SHALL NOT modify the configuration or rebuild the engine

#### Scenario: Configure minWordLength live
- **WHEN** the user runs `/typos config minWordLength <n>` where `<n>` is an integer in `[2, 8]` and differs from the current value
- **THEN** the configuration SHALL be persisted and the next correction lookup SHALL use the new value without rebuilding the engine; a notification SHALL show "minWordLength set to <n>"

#### Scenario: Reject out-of-range or non-integer minWordLength
- **WHEN** the user runs `/typos config minWordLength <v>` where `<v>` is not an integer in `[2, 8]`
- **THEN** the extension SHALL show "Usage: /typos config minWordLength <integer 2-8>" and SHALL NOT modify the configuration

#### Scenario: Out-of-range persisted values fall back to defaults
- **WHEN** the configuration file contains a value for `maxEditDistance` or `minWordLength` outside the valid range, or with a non-integer type
- **THEN** the extension SHALL load the affected key with the bootstrap default (`maxEditDistance = 2`, `minWordLength = 2`), preserving any other valid keys; the file SHALL NOT be auto-rewritten until the user explicitly sets a value

#### Scenario: Third-level value completion for /typos config
- **WHEN** the user types `/typos config maxEditDistance ` and triggers completion
- **THEN** the extension SHALL suggest `1`, `2`, `3`; analogous suggestions apply to `minWordLength` (`2` through `8`) and `defaultMode` (`on`, `off`)
