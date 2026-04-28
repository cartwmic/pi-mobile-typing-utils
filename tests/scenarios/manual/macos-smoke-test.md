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
