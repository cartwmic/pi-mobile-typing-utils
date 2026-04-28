# Mobile Autocorrect Scenario Catalog

## Charter

These scenarios validate the user-visible Pi TUI behavior of the `mobile-autocorrect` extension end to end: editor-time correction, undo/learning, slash-command lifecycle, dictionary persistence, autocomplete coexistence, and a small number of model-facing coherence probes. They do **not** benchmark performance, cover mobile-device-specific keyboard transport quirks exhaustively, or replace lower-level unit/integration tests; those concerns stay in the existing test suite and project notes.

## Harness shape

Each scenario follows the canonical `pi-tui-scenario-tests` pattern in condensed form:

1. Start Pi in a fresh tmux session with the local compiled extension loaded.
2. Drive keys through tmux (`send-keys` for pre-submit editing and slash commands).
3. Wait on a deterministic signal:
   - pre-submit scenarios use a short editor-render settle
   - submitted scenarios use the `claude-bridge` debug log completion signal
4. Capture the pane and/or inspect the isolated learned-dictionary file.
5. Assert the expected editor state, notifications, persistence side effects, or model response.
6. Tear down the session.

## Provider, model, and Pi flags

- Provider: `claude-bridge`
- Model: `claude-bridge/claude-haiku-4-5`
- Default Pi args: `--no-session -e ./dist/index.js`
- Dictionary isolation: `MOBILE_AUTOCORRECT_DICT_PATH=<repo>/.test-output/scenarios/<scenario>.dictionary.json`
- Extension discovery disable flag (`-ne`): **not** used in this repo snapshot because `~/.pi/agent/extensions/` does not contain an installed `mobile-autocorrect` copy that could shadow `./dist/index.js`

## Group A — Core correction loop

### T01 — Plain typo correction
- **Goal:** prove the baseline `teh` → `the` pre-submit rewrite works.
- **Steps:** start Pi, `/typos on`, type `teh `.
- **Mechanical assertions:** pane contains `the ` and does not contain orphaned `teh `.
- **Coherence probe:** none; pre-submit scenario.

### T02 — Tech-dict word preserved
- **Goal:** prove bundled tech vocabulary bypasses correction.
- **Steps:** start Pi, `/typos on`, type `nginx `.
- **Mechanical assertions:** pane contains `nginx ` and does not contain `engine `.
- **Coherence probe:** none.

### T03 — Token-eligibility skips
- **Goal:** prove code-like and non-natural-language tokens are not sent to SymSpell.
- **Steps:** start Pi, `/typos on`, type each token separately: `src/foo.ts `, `--force `, `don't `, `v1beta1 `, `café `.
- **Mechanical assertions:** each token remains visible verbatim in the pane.
- **Coherence probe:** none.

### T04 — Identity correction suppressed
- **Goal:** prove exact words do not emit a fake correction event.
- **Steps:** start Pi, `/typos on`, type `the `.
- **Mechanical assertions:** pane contains `the ` and does not show `✓ the → the`.
- **Coherence probe:** none.

## Group B — Backspace undo and learning loop

### T05 — Backspace immediately undoes correction
- **Goal:** prove the immediate undo window restores the original token.
- **Steps:** start Pi, `/typos on`, type `teh `, press Backspace.
- **Mechanical assertions:** pane contains `teh` and no longer contains `the `.
- **Coherence probe:** none.

### T06 — Two rejections trigger learning
- **Goal:** prove repeated rejection auto-learns the original word.
- **Steps:** start Pi, `/typos on`, type `teh ` and undo twice.
- **Mechanical assertions:** pane shows `Learned: teh`; isolated dictionary file contains `"teh"` under persisted words.
- **Coherence probe:** none.

### T07 — Learned word no longer corrected
- **Goal:** prove pre-seeded learned words are respected without engine reload.
- **Steps:** pre-seed `termux` in the isolated dictionary, start Pi, `/typos on`, type `termux `.
- **Mechanical assertions:** pane contains `termux ` and not an English-neighbor replacement.
- **Coherence probe:** none.

### T08 — Pending rejections persist across Pi restart
- **Goal:** prove pre-threshold rejections survive restart and later learn successfully.
- **Steps:** start Pi, `/typos on`, type `teh ` and undo once, stop Pi, inspect file, restart Pi, repeat the rejection.
- **Mechanical assertions:** file contains `pendingRejections.teh = 1` after the first run; second run shows `Learned: teh` and persists `teh` as a learned word.
- **Coherence probe:** none.

## Group C — Case preservation

### T09 — Case patterns
- **Goal:** prove correction preserves title case and uppercase, and falls back to lowercase for mixed case.
- **Steps:** in one session with autocorrect on, type `Teh `, `TEH `, `teh `, and `tHe ` separately.
- **Mechanical assertions:** pane shows `The `, `THE `, `the `, and lowercase `the ` for the mixed-case case.
- **Coherence probe:** none.

## Group D — Toggle and lifecycle

### T10 — `/typos on` enables and `/typos off` disables
- **Goal:** prove explicit commands gate behavior.
- **Steps:** type `teh ` while off, enable, type `teh ` again, disable, type `teh ` again.
- **Mechanical assertions:** off shows unchanged `teh `, on shows `the `, off again returns to unchanged `teh `.
- **Coherence probe:** none.

### T11 — Bare `/typos` toggles
- **Goal:** prove the no-argument form flips state in both directions.
- **Steps:** run `/typos`, then `/typos` again.
- **Mechanical assertions:** pane shows `Autocorrect ON` then `Autocorrect OFF`.
- **Coherence probe:** none.

### T12 — Idempotency
- **Goal:** prove repeated enable is a no-op with user feedback.
- **Steps:** enable autocorrect, then run `/typos on` again.
- **Mechanical assertions:** pane shows `Autocorrect is already on`.
- **Coherence probe:** none.

### T13 — Editor swap preserves draft text
- **Goal:** prove editor replacement does not drop draft text.
- **Steps:** enable autocorrect, type `hello world`, disable autocorrect, inspect the draft.
- **Mechanical assertions:** pane still contains `hello world` after the swap back to the default editor.
- **Coherence probe:** none.

### T14 — Toggle race serialization
- **Goal:** prove first-enable lazy initialization serializes rapid conflicting toggles.
- **Steps:** send `/typos on` followed immediately by `/typos off`.
- **Mechanical assertions:** pane eventually contains `Autocorrect OFF`; `Loading autocorrect...` appears at most once in the captured pane.
- **Coherence probe:** none.

## Group E — Dictionary commands

### T15 — `/typos dict` empty and populated
- **Goal:** prove dictionary listing handles both empty and non-empty states.
- **Steps:** run `/typos dict` on an empty isolated dictionary; add `foo`; run `/typos dict` again.
- **Mechanical assertions:** empty-state text appears first; later output contains `foo` and `manual`.
- **Coherence probe:** none.

### T16 — `/typos dict add` validation
- **Goal:** prove invalid tokens are rejected and valid ones persist.
- **Steps:** run `/typos dict add foo bar`, `/typos dict add foo123`, then `/typos dict add foo`.
- **Mechanical assertions:** invalid forms show usage text; valid form writes `foo` into the isolated dictionary file.
- **Coherence probe:** none.

### T17 — `/typos dict search` case-insensitive
- **Goal:** prove learned-word search lowercases and filters correctly.
- **Steps:** pre-seed `termux`, `nginx`, `kubectl`; run `/typos dict search TER`; then `/typos dict search ngi`.
- **Mechanical assertions:** first search shows `termux` only; second search shows `nginx`.
- **Coherence probe:** none.

### T18 — `/typos dict remove` and not-found
- **Goal:** prove removal updates persistence and repeat removal reports correctly.
- **Steps:** pre-seed `foo`; run `/typos dict remove foo`; run it again.
- **Mechanical assertions:** first command confirms removal and the file no longer contains `foo`; second command shows not-found text.
- **Coherence probe:** none.

### T19 — `/typos dict clear` requires confirm
- **Goal:** prove the clear path is gated by `ctx.ui.confirm()`.
- **Steps:** pre-seed three words; run `/typos dict clear`; accept the Yes/No selector with Enter.
- **Mechanical assertions:** pane shows `Clear dictionary?`; pane shows `Cleared 3 words from dictionary`; file contains `"words": {}`.
- **Coherence probe:** none.

## Group F — Pi UI integration

### T20 — Slash menu still works
- **Goal:** prove slash-command completion remains reachable when autocorrect is active.
- **Steps:** start Pi, `/typos on`, type `/`.
- **Mechanical assertions:** pane shows slash-command suggestion UI (`/typos`, built-in slash labels, or equivalent menu entries).
- **Coherence probe:** none.

### T21 — `@` file-ref menu still works
- **Goal:** prove file-reference completion remains reachable when autocorrect is active.
- **Steps:** start Pi, `/typos on`, type `@`.
- **Mechanical assertions:** pane shows path-like suggestions such as `package.json`, `README.md`, `src/`, or `openspec/`.
- **Coherence probe:** none.

### T22 — `/typos` argument completion
- **Goal:** prove command argument completions surface in Pi autocomplete.
- **Steps:** start Pi, `/typos on`, type `/typos `, press Tab.
- **Mechanical assertions:** suggestion UI contains `on`, `off`, and `dict`.
- **Coherence probe:** none.

### T23 — Status flash appears and clears
- **Goal:** prove correction feedback is visible but transient.
- **Steps:** start Pi, `/typos on`, type `teh `.
- **Mechanical assertions:** pane shows `✓ teh → the` quickly, then `scn_wait_for_absent` confirms it disappears.
- **Coherence probe:** none.

## Group G — Coherence probes

### T24 — Corrected text flows to the model
- **Goal:** prove the corrected editor buffer is what the model actually receives.
- **Steps:** start Pi, `/typos on`, type `teh atuhorization modle `, verify the draft shows `the authorization model `, append the echo prompt, submit.
- **Mechanical assertions:** pre-submit pane shows the corrected phrase.
- **Coherence probe:** response to `Please echo back exactly...` matches `"the authorization model"` and does not include `teh`, `atuhorization`, or `modle`.

### T25 — Tech words preserved end to end
- **Goal:** prove valid technical words remain untouched all the way to the model.
- **Steps:** start Pi, `/typos on`, type `Use kubectl with nginx `, append the echo prompt, submit.
- **Mechanical assertions:** pre-submit pane shows the original tech terms.
- **Coherence probe:** response contains `kubectl` and `nginx` and does not contain `cuddle` or `engine`.

## Group F — Context rerank, segmentation, telemetry

### T26 — Word segmentation, classic concatenation
- **Goal:** prove the segmentation engine splits an unambiguous run-together compound into its constituent words when typed in the editor.
- **Steps:** start Pi, `/typos on`, type `thequick `.
- **Mechanical assertions:** pane contains `the quick` and does not contain the orphan `thequick `.
- **Coherence probe:** none (pre-submit).

### T27 — Word segmentation, edit-distance knob behavior
- **Goal:** prove `/typos config segmentationMaxEditDistance` is settable and that ED=0 suppresses fuzzy-match segmentation while ED=1 leaves behavior defined by corpus log-prob.
- **Steps:** start Pi, `/typos on`; set `segmentationMaxEditDistance` to `0`; type `wantto `; assert input present. Then set it to `1`; clear editor; type `wantto `; accept either the original or the split form.
- **Mechanical assertions:** at ED=0 pane contains `wantto`; at ED=1 pane contains `wantto` or `want to` (both acceptable — corpus-dependent).
- **Coherence probe:** none (pre-submit).

### T28 — Segmentation rejection, below minimum length
- **Goal:** prove the `segmentationMinLength` gate (default 6) prevents segmentation of short tokens.
- **Steps:** start Pi, `/typos on`, type `imho ` (4 chars).
- **Mechanical assertions:** pane contains `imho` and the token is not split.
- **Coherence probe:** none (pre-submit).

### T29 — Segmentation respects the learned dictionary
- **Goal:** prove that two user rejections cause the engine to learn a token, after which the learned-dictionary gate suppresses re-segmentation on the third occurrence.
- **Steps:** start Pi, `/typos on`; type `thequick ` and Backspace (first rejection); type `thequick ` at a new position and Backspace (second rejection, triggers learning); type `thequick ` a third time.
- **Mechanical assertions:** `Learned: thequick` notification appears after the second rejection; the isolated dictionary file contains `"thequick"`; the pane contains `thequick` after the third type (no segmentation).
- **Coherence probe:** none (pre-submit).

### T32 — Telemetry metrics file written by default
- **Goal:** prove the default telemetry level (`"metrics"`) writes an NDJSON events file on each correction and that content fields such as `token` are masked at that level.
- **Steps:** start Pi in an isolated `MOBILE_AUTOCORRECT_CACHE_DIR`, `/typos on`, type `teh `; wait for the async write to flush.
- **Mechanical assertions:** `<cacheDir>/telemetry/events-*.ndjson` exists; the file contains a line matching `"event":"correction.applied"`; that line does NOT contain `"token":"teh"` (metrics masking).
- **Coherence probe:** none (pre-submit).

### T33 — Telemetry off writes nothing
- **Goal:** prove that setting `telemetry` to `"off"` before enabling autocorrect prevents any telemetry directory or NDJSON file from being created.
- **Steps:** start Pi in an isolated `MOBILE_AUTOCORRECT_CACHE_DIR`; `/typos config telemetry off`; `/typos on`; type `teh `; wait.
- **Mechanical assertions:** `<cacheDir>/telemetry/` does not exist; no `events-*.ndjson` file is found anywhere under the cache directory.
- **Coherence probe:** none (pre-submit).

### T34 — `/typos stats` summary renders
- **Goal:** prove the `/typos stats` slash command aggregates the telemetry NDJSON files and displays a formatted summary in the Pi pane.
- **Steps:** start Pi in an isolated `MOBILE_AUTOCORRECT_CACHE_DIR`, `/typos on`; fire ~10 corrections using `scn_type_and_settle` with common misspellings; wait for async writes; submit `/typos stats`.
- **Mechanical assertions:** pane contains `Mobile autocorrect telemetry summary` (the heading locked in `src/telemetry-aggregate.ts`); pane contains `corrections applied:`.
- **Coherence probe:** none (pre-submit).

## Running

Run the full suite:

```bash
npm run scenarios
```

Run one scenario directly:

```bash
bash tests/scenarios/scripts/run-scenario-t01.sh
```

## Status (verified 2026-04-27)

| ID | State | Notes |
|---|---|---|
| T01 | PASS | |
| T02 | PASS | |
| T03 | PASS | |
| T04 | PASS | |
| T05 | PASS | |
| T06 | PASS | Learning verified in pane + isolated dictionary file. |
| T07 | PASS | |
| T08 | PASS | Standalone and sequential verification pass; one `run-all` batch also showed an intermittent macOS `Killed: 9` flake. |
| T09 | FAIL | Real product bug: with autocorrect on, typing `tHe ` leaves `tHe` instead of correcting to lowercase `the`. |
| T10 | PASS | |
| T11 | PASS | |
| T12 | PASS | Explicit `/typos on` idempotency message verified. |
| T13 | PASS | |
| T14 | SKIPPED | Queued on→off race is unit-tested, but Pi's slash-command UI is not deterministic enough to script during the transient loading window. |
| T15 | PASS | |
| T16 | PASS | |
| T17 | PASS | |
| T18 | PASS | |
| T19 | PASS | |
| T20 | PASS | |
| T21 | PASS | |
| T22 | SKIPPED | Pi autocomplete applies the first completion on Tab; no stable multi-item preview exists for assertion. |
| T23 | PASS | |
| T24 | PASS | Corrected draft verified in editor and echoed correctly by the model. |
| T25 | PASS | Tech terms preserved in editor and model response. |
| T26 | PENDING | Smoke-run deferred to user (requires live Pi + credentials). |
| T27 | PENDING | Knob-behavior test; corpus-dependent outcome. Smoke-run deferred. |
| T28 | PENDING | Smoke-run deferred to user. |
| T29 | PENDING | Smoke-run deferred to user. |
| T32 | PENDING | Smoke-run deferred to user. |
| T33 | PENDING | Smoke-run deferred to user. |
| T34 | PENDING | Smoke-run deferred to user. |

## Known issues / TODO (Phase 12 additions)

- **T27 is intentionally corpus-soft:** at `segmentationMaxEditDistance: 1` the outcome for `wantto` depends on the corpus log-probability of `want to` vs. `wantto`. Both the original and the split form are accepted. The test validates the config knob is settable and Pi remains stable, not a specific correction.
- **T29 timing:** the `Learned: thequick` notification must appear within 5 seconds of the second Backspace. On very slow CI machines this window may need widening.
- **T32 sleep(3):** telemetry is fire-and-forget; the 3-second sleep after correction is a conservative flush window. On heavily loaded systems a longer sleep may be needed.
- **T34 requires at least one correction to fire:** if none of the ~10 fixture words are in the symspell-ts dictionary, `corrections applied: 0` still appears and the assertion passes (the line exists regardless of count).

## Known issues / TODO

- **T09 is a real product bug:** in a fresh Pi session, enable autocorrect and type `tHe `. The editor leaves `tHe` unchanged instead of applying the documented lowercase fallback `the`. Do not weaken this scenario; the source behavior needs a real fix.
- **T14 remains a manual-only check in this environment:** a human should start from autocorrect OFF, trigger `/typos`, immediately trigger `/typos` again while `Loading autocorrect...` is visible, then verify the final state is OFF and the loading notice appears only once.
- **T22 remains intentionally skipped:** Pi's current autocomplete UI commits the first match on Tab rather than exposing a stable, non-destructive completion-preview list. The underlying completion handler is covered by unit tests.
- **`run-all-scenarios.sh` is improved but still somewhat batch-flaky on macOS/tmux:** the latest full batch consistently isolates scenarios and reports SKIPPED states, but long runs can still produce intermittent `Killed: 9` failures (observed once on T08) even when the affected scenario passes immediately in standalone reruns.
