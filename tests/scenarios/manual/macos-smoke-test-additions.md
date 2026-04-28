# Manual smoke-test guide — Phase 12 additions (T26–T29, T32–T34)

Run each scenario from the repo root with:

```bash
bash tests/scenarios/scripts/run-scenario-t<N>.sh
```

Or run all new scenarios together:

```bash
SCENARIO_FILTER='t2[6-9]|t3[2-4]' npm run scenarios
```

---

## T26 — Word segmentation, classic concatenation

**Script:** `run-scenario-t26.sh`

**How to reproduce manually:**
1. Start Pi with the extension: `pi --no-session -e ./dist/index.js`
2. Run `/typos on` and wait for `Autocorrect ON`.
3. Type `thequick ` (no Enter).

**Expected pane substring:** `the quick` (the token split at the word boundary).

**Must NOT appear:** `thequick ` (the unsegmented concatenation).

**Known caveats:** None. The `thequick` fixture is unambiguous: `the + quick`
are both high-frequency unigrams and the compound has no single-word entry.

---

## T27 — Word segmentation, edit-distance knob behavior

**Script:** `run-scenario-t27.sh`

**How to reproduce manually:**
1. Start Pi, `/typos on`.
2. Run `/typos config segmentationMaxEditDistance 0 ` (trailing space + double Enter).
3. Type `wantto ` (no Enter). Observe the pane — expect `wantto` unchanged.
4. Run `/typos config segmentationMaxEditDistance 1 ` (trailing space + double Enter).
5. Clear the editor (Home + Delete × n), then type `wantto ` again.

**Expected pane substring (ED=0):** `wantto` (no split — ED=0 disables fuzzy matching).

**Expected pane substring (ED=1):** `wantto` OR `want to` (both acceptable — corpus-dependent).

**Known caveats:** At ED=1 the outcome depends on corpus log-probability. If
`wantto` has insufficient log-prob delta vs. `want to`, the segmentation floor
may reject the split and leave the token unchanged. This is correct behavior.
The test passes regardless of which form appears.

---

## T28 — Segmentation rejection, below minimum length

**Script:** `run-scenario-t28.sh`

**How to reproduce manually:**
1. Start Pi, `/typos on`.
2. Type `imho ` (no Enter).

**Expected pane substring:** `imho` (4-char token, below the 6-char default
`segmentationMinLength` gate — must not be split).

**Must NOT appear:** `im ho` or any segmented form.

**Known caveats:** None. `imho` (4 chars < 6) is safely below the gate.

---

## T29 — Segmentation respects the learned dictionary

**Script:** `run-scenario-t29.sh`

**How to reproduce manually:**
1. Start Pi, `/typos on`.
2. Type `thequick ` (no Enter) — it will be segmented to `the quick `.
3. Press Backspace once — rejection #1. Editor shows `thequick`.
4. Type ` ok thequick ` — engine corrects again.
5. Press Backspace once — rejection #2. `Learned: thequick` notification appears.
6. Type ` thequick ` — this third occurrence should remain `thequick`.

**Expected pane substring:** `thequick` (unsegmented after learning).

**Expected file state:** the isolated dictionary JSON file (path printed in
script output as `$SCN_DICT_PATH`) contains `"thequick":` under `words`.

**Known caveats:** The `Learned:` notification must appear within 5 seconds of
the second Backspace. If the engine is slow to initialize, widen the
`scn_wait_for` timeout in the script.

---

## T32 — Telemetry metrics file written by default

**Script:** `run-scenario-t32.sh`

**How to reproduce manually:**
1. Start Pi, `/typos on`.
2. Type `teh ` (no Enter).
3. Wait 3 seconds.
4. List `$SCN_CACHE_DIR/telemetry/` (printed in script output).

**Expected file state:**
- Directory `<cacheDir>/telemetry/` exists.
- At least one file matching `events-YYYY-MM-DD.ndjson` is present.
- The file contains at least one line with `"event":"correction.applied"`.
- That line does **not** contain `"token":"teh"` (metrics-level masking of
  content fields).

**Known caveats:** Telemetry is written asynchronously (fire-and-forget). The
3-second sleep is conservative. On very slow machines increase it. If
`MOBILE_AUTOCORRECT_CACHE_DIR` is unset or empty, Pi falls back to a platform
default cache directory — the script isolates via `SCN_CACHE_DIR` to avoid this.

---

## T33 — Telemetry off writes nothing

**Script:** `run-scenario-t33.sh`

**How to reproduce manually:**
1. Start Pi.
2. Run `/typos config telemetry off ` (trailing space + double Enter).
3. Run `/typos on`.
4. Type `teh ` (no Enter).
5. Wait 3 seconds.
6. Check that `<cacheDir>/telemetry/` does not exist.

**Expected file state:**
- `<cacheDir>/telemetry/` does **not** exist.
- No `events-*.ndjson` file exists anywhere under `<cacheDir>`.

**Known caveats:** The telemetry config must be set **before** `/typos on` so
the `TelemetryWriter` instance is constructed with `getLevel()` returning
`"off"`. Setting it after the engine is already running still takes effect on
the next emit (live-level contract), but the directory-creation test is most
reliable when `"off"` is set first.

---

## T34 — `/typos stats` summary renders

**Script:** `run-scenario-t34.sh`

**How to reproduce manually:**
1. Start Pi, `/typos on`.
2. Type each of the following (no Enter between): `teh `, `recieve `,
   `seperate `, `definately `, `existance `, `occurence `, `peice `,
   `untill `, `acommodate `, `succesful `.
3. Wait 3 seconds.
4. Run `/typos stats ` (trailing space + double Enter).

**Expected pane substrings:**
- `Mobile autocorrect telemetry summary` (the stats heading; exact text locked
  in `src/telemetry-aggregate.ts` line 261).
- `corrections applied:` (always present regardless of count — even zero).

**Known caveats:**
- If no fixture words produce corrections (corpus-dependent), the summary still
  renders with `corrections applied: 0`. The assertion passes either way.
- The stats heading is followed by the range label, e.g.,
  `Mobile autocorrect telemetry summary (last 24h):`. The assertion matches the
  prefix only and is therefore range-agnostic.
- The `/typos stats` output appears via `ctx.ui.notify` (info level) and flows
  into the pane as a notification block, not into the bridge debug log.
