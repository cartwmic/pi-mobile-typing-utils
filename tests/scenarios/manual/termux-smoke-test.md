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
