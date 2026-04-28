# Termux Manual Smoke Test

**Status:** Document complete — execution is the user's responsibility.

This scenario verifies the full adaptive-ED + lazy-init + index-cache end-to-end flow on Termux (Android). It follows the same steps as `macos-smoke-test.md` with Termux-specific notes and a fillable timings section.

---

## Pre-conditions

1. Build the extension on macOS / CI and transfer the compiled `dist/` and `data/` assets to `~/.pi/agent/extensions/mobile-autocorrect/` on your Android device, **OR** build directly on Termux:
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
   ```
   If missing, defaults apply (`maxEditDistance: 2`, `defaultMode: off`).

---

## Termux-specific notes

- The cache-miss build (Step 1) is significantly slower on mobile hardware — typically 3–10× the macOS time. At ED=2 this is approximately 3–10 s; at ED=4, expect 10–30 s.
- The cache-hit load (Step 4) is also slower on mobile: approximately 400–600 ms is the design estimate (not yet measured on all devices; fill in actual time below).
- **Time the cache-miss build** in Step 1 using a stopwatch and record it in the [Observed timings](#observed-timings-fill-in-after-running) section below.
- The Pi footer and status indicator may render differently depending on your terminal emulator (Termux + Zellij setup). Verify the `✓ Autocorrect` state appears in the footer area.

---

## Steps

### Step 1 — Cold start: loading indicator (TIME THIS)

1. Start a Pi session with the extension loaded.
2. Run `/typos on`.
3. **Start your stopwatch now.**
4. **Observe:** The persistent status indicator shows `Autocorrect loading…`.
5. Wait for the indicator to change.
6. **Stop your stopwatch when the indicator shows `✓ Autocorrect`.**
7. Record the elapsed time in [Observed timings](#observed-timings-fill-in-after-running).

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
3. End the Pi session.

---

### Step 4 — Second session: cache hit (TIME THIS)

1. Start a fresh Pi session.
2. Run `/typos on`.
3. **Start your stopwatch now.**
4. Wait for `✓ Autocorrect`.
5. **Stop your stopwatch.**
6. Record the elapsed time in [Observed timings](#observed-timings-fill-in-after-running).

**Expected:** Much faster than Step 1. Check the cache file:
```bash
ls -lh ~/.pi/agent/cache/mobile-autocorrect/
# Should show a symspell-<hex>.bin file
```

---

### Step 5 — Config change: hot-reload

1. While autocorrect is enabled, run:
   ```
   /typos config maxEditDistance 3
   ```
2. **Observe:** `maxEditDistance set to 3` notification appears.
3. **Observe:** Indicator transitions back through `Autocorrect loading…` → `✓ Autocorrect`.
4. Check cache directory:
   ```bash
   ls -lh ~/.pi/agent/cache/mobile-autocorrect/
   ```
5. **Observe:** New `symspell-{newKey}.bin` exists; old key is pruned.

---

## Observed timings (fill in after running)

| Scenario | Device / Android version | ED | Time (s) |
|----------|--------------------------|----|----------|
| Cold start (cache miss, Step 1) | | 2 | |
| Cache hit (Step 4) | | 2 | |
| Hot-reload (Step 5, loading → ready) | | 3 | |

**Device info (fill in):**
- Device model: _______________
- Android version: _______________
- Termux version: _______________
- Storage type (internal/SD): _______________

---

## Pass / Fail Criteria

| Observation | Expected result |
|-------------|----------------|
| Step 1: command returns before indicator transitions | ✓ |
| Step 1: indicator shows loading → ready | ✓ |
| Step 2: `teh` → `the` | ✓ |
| Step 3: indicator clears on disable | ✓ |
| Step 4: cache-hit startup noticeably faster than cache miss | ✓ |
| Step 5: hot-reload on config change, old cache pruned | ✓ |

---

## Notes

- Cache file location: `~/.pi/agent/cache/mobile-autocorrect/symspell-{key}.bin`
- Override with: `MOBILE_AUTOCORRECT_CACHE_DIR=/path/to/dir pi -e ./dist/index.js`
- If any step fails, check console output for `[mobile-autocorrect]` log lines.
- Reset with `rm -rf ~/.pi/agent/cache/mobile-autocorrect/` to return to cold-start state.
- The Termux cache-miss build blocks keystroke processing during the synchronous deletion-table build. This is expected behavior for cache-miss paths; the cache makes cache-hit the steady-state.

---

## Phase 12 additions (context rerank, segmentation, telemetry) — Termux

This section mirrors `macos-smoke-test.md §Phase 12` with Termux-specific timing
adjustments. Run after the Phase 12 build has passed all 442 automated tests.

### Termux-specific notes

- **Cold-start time is 2–3× the macOS time** for the same operation.
- **Cache-hit startup soft target on Termux:** ≤ 2 s (vs ≤ 500 ms on macOS).
- **Memory soft target on Termux:** rss delta ≤ 100 MB (vs ≤ 150 MB on macOS).
- **Default telemetry cache dir on Termux:** `/data/data/com.termux/files/home/.pi/agent/cache/mobile-autocorrect/` unless overridden by `MOBILE_AUTOCORRECT_CACHE_DIR`.

---

### Phase 12 Step 1 — Cold-start build time with bigrams loaded (TIME THIS)

Bigrams are now loaded eagerly (schema v2 cache). Cold-start build time on Termux
is higher than the previous unigram-only baseline.

1. Clear cache:
   ```bash
   rm -rf ~/.pi/agent/cache/mobile-autocorrect/
   ```
2. Start Pi: `pi -e ./dist/index.js`, run `/typos on`, start stopwatch.
3. Stop when footer shows `✓ Autocorrect`. Record time below.

**Expected Termux timing:** approximately 3–6 s for a cold build at ED=2 with bigrams
(2–3× the macOS ~1.5–3 s range). Cache-hit startup should be ≤ 2 s (Termux soft
target; the v2 `.bin` file is slightly larger than v1 due to bigram serialization).

The resident-memory cost of loading bigrams is approximately +24 MB over the previous
unigram-only baseline. Total rss delta is expected to be ≤ 100 MB on Termux.

---

### Phase 12 Step 2 — Word segmentation: accepted case

Same as macOS Step 2. Latency of the segmentation call is expected to be ~5–30×
higher on Termux than on macOS.

1. With `/typos on`, type `thequick` followed by a space.
2. **Observe:** Pane shows `the quick ` (split).
3. **Observe:** Status flash `Corrected: thequick → the quick (split)`.

**Expected:** Same outcome as macOS. Note that segmentation latency on Termux may
be noticeable for very long tokens at ED=1.

---

### Phase 12 Step 3 — Word segmentation: rejected case (tech-prose concatenation)

1. Type `kubernetespod` followed by a space.
2. **Observe:** Pane shows `kubernetespod ` UNCHANGED.

**Expected:** Same as macOS (v1 known limitation; `kubernetes` not in SymSpell unigram index).

---

### Phase 12 Step 4 — Context rerank: disambiguation

1. Type `i want te` followed by a space.
2. **Observe:** Pane shows `i want to ` or `i want the `.

**Expected:** Same outcome as macOS. The rerank operates on the same bundled corpus
regardless of platform.

---

### Phase 12 Step 5 — Telemetry file presence check

1. Start Pi with an isolated cache dir:
   ```bash
   MOBILE_AUTOCORRECT_CACHE_DIR=/data/data/com.termux/files/tmp/smoke-telem \
     pi -e ./dist/index.js
   ```
   (Adjust the path to a writable location on your device.)
2. Run `/typos on`, type `teh `, exit Pi.
3. Check for the telemetry file:
   ```bash
   ls /data/data/com.termux/files/tmp/smoke-telem/telemetry/
   # Expected: events-YYYY-MM-DD.ndjson
   ```
4. Inspect content:
   ```bash
   cat .../telemetry/events-*.ndjson
   ```

**Expected:** Same shape as macOS. At `metrics` level:
- `"event":"correction.applied"` line present.
- `token` and `suggestion` fields absent.
- `latencyMs` and structural fields present.

---

### Phase 12 Step 6 — /typos stats output

Same as macOS Step 6. The rendering path is platform-independent.

1. Fire a few corrections, run `/typos stats`.
2. **Observe:** Notification begins with `Mobile autocorrect telemetry summary`
   and contains `corrections applied:`.

---

### Phase 12 Observed timings (fill in after running)

| Scenario | Device / Android version | Time |
|----------|--------------------------|------|
| Cold start with bigrams (Phase 12 Step 1) | | |
| Cache-hit startup (Phase 12 Step 1, 2nd session) | | |
| `thequick ` → `the quick ` latency (perceived) | | |

---

### Phase 12 Pass / Fail Criteria (Termux)

| Observation | Expected result |
|-------------|----------------|
| Cold-start with bigrams | ≤ 6 s on Termux |
| Cache-hit startup | ≤ 2 s on Termux |
| `thequick ` → `the quick ` with `(split)` flash | ✓ |
| `kubernetespod ` → UNCHANGED | ✓ |
| `i want te ` → `i want to ` or `i want the ` | ✓ |
| Telemetry file written after correction | ✓ |
| `metrics`-level file omits `token`/`suggestion` | ✓ |
| `/typos stats` renders `corrections applied:` | ✓ |

---

## Notes (Phase 12)

- Termux telemetry default cache dir: `/data/data/com.termux/files/home/.pi/agent/cache/mobile-autocorrect/telemetry/`.
  Override with `MOBILE_AUTOCORRECT_CACHE_DIR`.
- Memory budget: rss delta ≤ 100 MB on Termux (vs ≤ 150 MB on macOS). Run
  `bench/memory-residency.ts` to measure the actual delta.
- Trigram side-table is deferred (§16.2). The bench falls back to bigram + unigram
  scoring when `data/trigram-top500k.tsv` is absent — no user-visible error.
- Disable telemetry: `/typos config telemetry off`.
