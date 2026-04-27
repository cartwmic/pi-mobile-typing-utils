# Mobile Autocorrect Scenario Tests

This directory contains tmux-driven Pi TUI scenarios for the `mobile-autocorrect` extension. See [`SCENARIOS.md`](./SCENARIOS.md) for the full catalog and design rationale.

## Prerequisites

- `tmux` installed and configured with extended keys per Pi `docs/tmux.md`:
  - `set -g extended-keys on`
  - `set -g extended-keys-format csi-u`
- Pi installed locally
- `claude-bridge` installed and authenticated
- Default scenario model available: `claude-bridge/claude-haiku-4-5`
- Project built once with `npm run build` (the harness will rebuild automatically if `dist/` is stale)

## Run everything

```bash
npm run scenarios
```

## Run one scenario

```bash
bash tests/scenarios/scripts/run-scenario-t01.sh
```

## Output

Logs, pane captures, bridge logs, per-scenario run logs, and the batch summary are written under:

```text
.test-output/scenarios/
```

## Troubleshooting

- **Scenario timed out:** check the footer text Pi is rendering and adjust `SCN_IDLE_REGEX` in `scripts/scenario-lib.sh` if needed.
- **Autocomplete scenarios behave oddly:** confirm tmux extended keys are enabled and restart tmux.
- **Dictionary pollution concern:** each scenario uses an isolated `MOBILE_AUTOCORRECT_DICT_PATH`, so the real `~/.pi/agent/mobile-autocorrect-dictionary.json` should not be touched.
- **First enable is slow:** the first `/typos on` in a session lazily loads dictionaries and can take several seconds.
