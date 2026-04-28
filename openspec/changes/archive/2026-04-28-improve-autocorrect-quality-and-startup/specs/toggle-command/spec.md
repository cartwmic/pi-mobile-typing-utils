## RENAMED Requirements

- FROM: `### Requirement: Toggle serialization during async initialization`
- TO: `### Requirement: Toggle serialization and orphan-promise generation guard`

## MODIFIED Requirements

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

### Requirement: Tuning configuration via /typos config
The extension SHALL expose a flat `/typos config` key/value surface for runtime-tunable parameters, persisted to the same configuration file as `defaultMode`. The supported keys SHALL be `defaultMode`, `maxEditDistance`, `minWordLength`, `minEditDistance`, and `editDistanceStepEvery`. Each key SHALL be range-validated; out-of-range or non-integer values SHALL be rejected without modifying the persisted configuration. The `defaultMode` key SHALL be functionally equivalent to the dedicated `/typos default` subcommand. The `maxEditDistance` value SHALL be an integer in `[1, 4]` and SHALL be applied by rebuilding the SymSpell index (the value is baked into the index at initialization time); when autocorrect is currently enabled the rebuild SHALL happen automatically via the existing teardown-and-rebuild flow, but the rebuild itself SHALL be non-blocking (lazy fire-and-forget). The `minWordLength` value SHALL be an integer in `[2, 8]` and SHALL be applied live (read by the correction engine on each lookup, no rebuild required). The `minEditDistance` value SHALL be an integer in `[0, maxEditDistance]` and SHALL be applied live (read on each lookup, no rebuild required). The `editDistanceStepEvery` value SHALL be an integer in `[1, 8]` and SHALL be applied live (read on each lookup, no rebuild required).

#### Scenario: List all configured values
- **WHEN** the user runs `/typos config`
- **THEN** the extension SHALL show a single info notification beginning with "Mobile autocorrect config:" and including one line per key with the current value and (for ranged keys) the allowed range; the listing SHALL include `defaultMode`, `maxEditDistance`, `minWordLength`, `minEditDistance`, and `editDistanceStepEvery`

#### Scenario: Show a single configured value
- **WHEN** the user runs `/typos config maxEditDistance`
- **THEN** the extension SHALL show "maxEditDistance = <value> (range 1-4)"; analogous behavior applies to `minWordLength` (range 2-8), `minEditDistance` (range 0-maxEditDistance, with the upper bound shown as the current `maxEditDistance` value), `editDistanceStepEvery` (range 1-8), and `defaultMode` (no range)

#### Scenario: Reject unknown config keys
- **WHEN** the user runs `/typos config <key>` where `<key>` is not one of the supported keys
- **THEN** the extension SHALL show "Usage: /typos config [defaultMode|maxEditDistance|minWordLength|minEditDistance|editDistanceStepEvery] [<value>]" and SHALL NOT modify the configuration

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
- **THEN** the extension SHALL bump the orphan-generation token (orphaning any in-flight init's UI callbacks per the design.md "Orphan-promise generation guard" decision), drop the cached engine, and re-invoke the lazy enable path internally to construct and start a fresh engine. The new initialization SHALL run in the background; control returns to the toggle command immediately without waiting for the abandoned in-flight init to complete. The user SHALL see the persistent `"typos"` status indicator transition to `"Autocorrect loading…"` until the new engine reaches `ready`. The hot-reload SHALL emit a single `"maxEditDistance set to <n>"` notification (the existing config-change notification) — it SHALL NOT emit `"Autocorrect OFF"` or `"Autocorrect ON (loading…)"` notifications, because the user did not toggle autocorrect, only reconfigured it. This scenario is the same flow as "maxEditDistance change during initialization is non-blocking" above — the orphan-generation guard makes both a single coherent rule rather than two competing flows.

#### Scenario: maxEditDistance change while disabled does not enable autocorrect
- **WHEN** the user runs `/typos config maxEditDistance <n>` while autocorrect is currently DISABLED (`state.enabled === false`)
- **THEN** the extension SHALL persist the new value, bump the orphan-generation token (defensively orphans any lingering pre-warm or prior-rebuild in-flight init), drop any cached engine, and emit `"maxEditDistance set to <n>"`. It SHALL NOT install the editor, set the persistent `"typos"` indicator, or kick off engine initialization. The new value takes effect on the next `/typos on`.

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

#### Scenario: Out-of-range persisted values fall back to defaults
- **WHEN** the configuration file contains a value for `maxEditDistance`, `minWordLength`, `minEditDistance`, or `editDistanceStepEvery` outside the valid range, or with a non-integer type
- **THEN** the extension SHALL load the affected key with the bootstrap default (`maxEditDistance = 2`, `minWordLength = 2`, `minEditDistance = 1`, `editDistanceStepEvery = 4`), preserving any other valid keys; the file SHALL NOT be auto-rewritten until the user explicitly sets a value

#### Scenario: Third-level value completion for /typos config
- **WHEN** the user types `/typos config maxEditDistance ` and triggers completion
- **THEN** the extension SHALL suggest values in `[currentMinEditDistance, 4]` (so suggestions never include values that would be rejected by the min/max invariant); analogous suggestions apply to `minWordLength` (`2` through `8`), `minEditDistance` (`0` through current `maxEditDistance`), `editDistanceStepEvery` (`1` through `8`), and `defaultMode` (`on`, `off`)

### Requirement: Argument auto-completion for /typos command
The `/typos` command SHALL provide argument completions via `getArgumentCompletions`. First-level completions SHALL include `on`, `off`, `dict`, `default`, `config`. When the first argument is `dict`, second-level completions SHALL include `add`, `remove`, `search`, `clear`. When the first argument is `default`, second-level completions SHALL include `on`, `off`. When the first argument is `config`, second-level completions SHALL include `defaultMode`, `maxEditDistance`, `minWordLength`, `minEditDistance`, `editDistanceStepEvery`, and third-level completions SHALL include the valid values for the chosen key. Second-level and deeper completion items SHALL set their `value` to the full argument path (parent token included), because Pi's `applyCompletion` replaces the entire argument text with the chosen item's `value`.

#### Scenario: First-level completion
- **WHEN** the user types `/typos ` and triggers completion
- **THEN** the extension SHALL suggest `on`, `off`, `dict`, `default`, `config`

#### Scenario: Second-level dict completion
- **WHEN** the user types `/typos dict ` and triggers completion
- **THEN** the extension SHALL suggest `add`, `remove`, `search`, `clear`

#### Scenario: Second-level default completion
- **WHEN** the user types `/typos default ` and triggers completion
- **THEN** the extension SHALL suggest `on`, `off`

#### Scenario: Second-level config completion
- **WHEN** the user types `/typos config ` and triggers completion
- **THEN** the extension SHALL suggest `defaultMode`, `maxEditDistance`, `minWordLength`, `minEditDistance`, `editDistanceStepEvery`
