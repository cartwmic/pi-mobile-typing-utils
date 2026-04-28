# macOS Manual Smoke Test

**Status:** Document complete — execution is the user's responsibility.

This scenario verifies the full adaptive-ED + lazy-init + index-cache end-to-end flow on macOS.

---

## Pre-conditions

1. Build the extension:
   ```bash
   npm run build
   ```
2. Clear any existing cache to guarantee a cold start:
   ```bash
   rm -rf ~/.pi/agent/cache/mobile-autocorrect/
   ```
3. Confirm config has `defaultMode: off` and `maxEditDistance: 2`:
   ```bash
   cat ~/.pi/agent/mobile-autocorrect-config.json
   # Expected: {"defaultMode":"off","maxEditDistance":2,...}
   # If the file doesn't exist yet, the first run will create it with defaults.
   ```

---

## Steps

### Step 1 — Cold start: loading indicator

1. Start a Pi session with the extension loaded (e.g. `pi -e ./dist/index.js`).
2. Run `/typos on`.
3. **Observe:** The persistent status indicator in the Pi footer shows `Autocorrect loading…`.
4. Wait a few seconds (typically 1–2 s on macOS for a cache-miss build at ED=2).
5. **Observe:** The indicator transitions to `✓ Autocorrect`.

**Expected:** Both states are visible. The command returns immediately (before the indicator transitions).

---

### Step 2 — Correction works

1. Type the word `teh` followed by a space (or punctuation).
2. **Observe:** The word is automatically corrected to `the`.

**Expected:** Correction fires after the trigger character.

---

### Step 3 — Disable and end session

1. Run `/typos off`.
2. **Observe:** The persistent `typos` indicator is removed from the footer.
3. End the Pi session (Ctrl-C or `/exit`).

---

### Step 4 — Second session: cache hit (fast start)

1. Start a fresh Pi session.
2. Run `/typos on`.
3. **Observe:** The indicator transitions from `Autocorrect loading…` to `✓ Autocorrect` within approximately 200–500 ms (the cache file `~/.pi/agent/cache/mobile-autocorrect/symspell-*.bin` is present and loaded).

**Expected:** Much faster than Step 1. The cache file should be visible:
```bash
ls -lh ~/.pi/agent/cache/mobile-autocorrect/
# Should show a symspell-<hex>.bin file of approximately 28–31 MB
```

---

### Step 5 — Config change: hot-reload

1. While autocorrect is enabled (`/typos on` is active), run:
   ```
   /typos config maxEditDistance 3
   ```
2. **Observe:** A `maxEditDistance set to 3` notification appears.
3. **Observe:** The persistent indicator transitions back through `Autocorrect loading…` → `✓ Autocorrect` (engine rebuilds in the background with ED=3).
4. After the rebuild completes, check the cache directory:
   ```bash
   ls -lh ~/.pi/agent/cache/mobile-autocorrect/
   ```
5. **Observe:** A new `symspell-{newKey}.bin` file exists. The old `symspell-{oldKey}.bin` file has been pruned.

**Expected:** Config change returns immediately, hot-reload happens in the background, and the cache directory contains exactly one `.bin` file (the new key).

---

## Pass / Fail Criteria

| Observation | Expected result |
|-------------|----------------|
| Step 1: command returns before indicator transitions | ✓ |
| Step 1: indicator shows loading → ready | ✓ |
| Step 2: `teh` → `the` | ✓ |
| Step 3: indicator clears on disable | ✓ |
| Step 4: cache-hit startup ≤ 500 ms | ✓ |
| Step 5: hot-reload on config change, old cache pruned | ✓ |

---

## Notes

- Cache file location: `~/.pi/agent/cache/mobile-autocorrect/symspell-{key}.bin`
- Override with: `MOBILE_AUTOCORRECT_CACHE_DIR=/path/to/dir pi -e ./dist/index.js`
- If any step fails, check console output for `[mobile-autocorrect]` log lines.
- Re-run with `rm -rf ~/.pi/agent/cache/mobile-autocorrect/` to reset to cold-start state.

---

## Phase 12 additions (context rerank, segmentation, telemetry)

This section covers the `improve-autocorrect-context-and-segmentation` change. Run
after the Phase 12 build has passed all 442 automated tests.

### Pre-conditions (Phase 12)

1. Build the extension:
   ```bash
   npm run build
   ```
2. Clear cache to guarantee a cold start:
   ```bash
   rm -rf ~/.pi/agent/cache/mobile-autocorrect/
   ```
3. Confirm `maxEditDistance: 2` and no `telemetry` override in config (delete the
   config file to reset to defaults if needed):
   ```bash
   rm -f ~/.pi/agent/mobile-autocorrect-config.json
   ```

---

### Phase 12 Step 1 — Cold-start build time with bigrams loaded

Bigrams are now loaded eagerly (schema v2 cache). Cold-start build time is slightly
higher than the previous unigram-only baseline.

1. Start Pi: `pi -e ./dist/index.js`.
2. Run `/typos on`.
3. Time how long until the footer transitions from `Autocorrect loading…` to `✓ Autocorrect`.

**Expected:** Typically 1.5–3 s on macOS for a cold build at ED=2 with bigrams included
(vs ~1–2 s for unigram-only). Cache-hit startup (second session) is expected to be
≤ 500 ms (soft target; the v2 cache serializes bigrams, so the `.bin` file is a few
MB larger than the v1 baseline of ~29.8 MB).

The resident-memory cost of loading bigrams is approximately +24 MB over the
previous unigram-only baseline.

---

### Phase 12 Step 2 — Word segmentation: accepted case

1. With `/typos on`, type `thequick` followed by a space.
2. **Observe:** The pane shows `the quick ` (two words, split by a space).
3. **Observe:** A status flash `Corrected: thequick → the quick (split)` appears briefly.

**Expected:** Split accepted. `probabilityLogSum` for `thequick` is expected to be
≥ -12.0 (the `segmentationLogProbFloor` default). See
`bench/segmentation-logprob-baselines.ts` for observed values.

---

### Phase 12 Step 3 — Word segmentation: rejected case (tech-prose concatenation)

1. Type `kubernetespod` followed by a space.
2. **Observe:** The pane shows `kubernetespod ` UNCHANGED (no split).

**Expected:** No correction. `kubernetes` is in the tech-dictionary, NOT in the
SymSpell unigram index; `wordSegmentation()` cannot construct the split. This is
the documented v1 known limitation.

---

### Phase 12 Step 4 — Context rerank: disambiguation

1. Type `i want te` followed by a space.
2. **Observe:** The pane shows `i want to ` (preferred) or `i want the ` (also acceptable).

**Expected:** The bigram `want → to` has higher frequency in the SymSpell corpus than
`want → ten` or `want → tea`, so `to` should win. Both `to` and `the` are acceptable
outcomes depending on corpus counts — the important thing is that a plausible
preposition/article is chosen rather than a low-frequency word.

> If neither `to` nor `the` appears, check that `enableContextRerank` is `true`
> (default) and that the engine reached `ready` (not `degraded`).

---

### Phase 12 Step 5 — Telemetry file presence check

1. In an isolated cache dir, type `teh` followed by a space (one correction):
   ```bash
   MOBILE_AUTOCORRECT_CACHE_DIR=/tmp/smoke-telem pi -e ./dist/index.js
   ```
2. Run `/typos on`, type `teh `, then exit Pi.
3. Check for the telemetry file:
   ```bash
   ls /tmp/smoke-telem/telemetry/
   # Expected: events-YYYY-MM-DD.ndjson
   ```
4. Inspect the file content:
   ```bash
   cat /tmp/smoke-telem/telemetry/events-*.ndjson
   ```

**Expected at `metrics` level (default):**
- At least one line with `"event":"correction.applied"`.
- The line does NOT contain `"token":"teh"` (content fields masked at `metrics`).
- The line does NOT contain `"suggestion":"the"` (content fields masked).
- The line DOES contain `"latencyMs"` and structural fields like `"kind"`, `"editDistance"`.

Example `metrics`-level event shape (fields will vary):
```json
{"event":"correction.applied","timestamp":"2026-04-28T12:00:00.000Z","kind":"lookup","editDistance":1,"latencyMs":0.4}
```

---

### Phase 12 Step 6 — /typos stats output

1. With telemetry enabled (`metrics`), fire several corrections:
   ```
   /typos on
   ```
   Type: `teh `, `hte `, `adn `, then wait a few seconds.
2. Run:
   ```
   /typos stats
   ```
3. **Observe:** A notification appears in the pane beginning with
   `Mobile autocorrect telemetry summary` and containing `corrections applied:`.

**Example summary block (values will vary):**
```
Mobile autocorrect telemetry summary (last 24h)
  corrections applied:  3
  corrections rejected: 0
  corrections skipped:  0
  p50 latency: 0.4 ms    p95 latency: 1.2 ms
```

---

### Phase 12 Pass / Fail Criteria

| Observation | Expected result |
|-------------|----------------|
| Cold-start with bigrams (§12 Step 1) | ≤ 3 s on macOS |
| Cache-hit startup (§12 Step 1, 2nd session) | ≤ 500 ms |
| `thequick ` → `the quick ` with `(split)` flash | ✓ |
| `kubernetespod ` → UNCHANGED | ✓ |
| `i want te ` → `i want to ` or `i want the ` | ✓ |
| `events-YYYY-MM-DD.ndjson` exists after correction | ✓ |
| `metrics`-level file omits `token`/`suggestion` fields | ✓ |
| `/typos stats` renders `corrections applied:` | ✓ |

---

## Notes (Phase 12)

- Telemetry directory: `<cacheDir>/telemetry/` (default `~/.pi/agent/cache/mobile-autocorrect/telemetry/`).
- Disable telemetry: `/typos config telemetry off`.
- Trigram side-table (`data/trigram-top500k.tsv`) is not committed until §16.2 is run.
  The rerank module falls back to bigram + unigram scoring when trigrams are absent.
- Run `bench/segmentation-logprob-baselines.ts` to see the observed `probabilityLogSum`
  values for the fixture set and verify the `-12.0` floor is correctly placed.
