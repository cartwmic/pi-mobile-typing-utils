#!/usr/bin/env bash
# Scenario T14 — Toggle race serialization.
#
# Goal: Verify a rapid on-then-off sequence settles in the final requested state.
# Regression class: first-enable lazy initialization must serialize correctly instead of racing.
#
# STATUS: SKIPPED — the queued-toggle behavior is covered by src/commands.test.ts,
# but Pi's slash-command UI does not expose a deterministic tmux-sendable path for
# issuing the second toggle while the first enable is still in its transient
# "Loading autocorrect..." window. Manual verification should: start from OFF,
# trigger /typos, immediately trigger /typos again while the loading notice is
# visible, then confirm the final state is OFF and the loading notice appears once.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t14"
trap 'scn_pi_stop' EXIT

scn_pi_start

echo "==== T14 results ===="
echo "  SKIPPED: queued on→off race is unit-tested; reliable Pi UI automation is not available in this environment"
echo "===================="
exit 0
