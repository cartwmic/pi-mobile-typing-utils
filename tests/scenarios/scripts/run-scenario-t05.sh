#!/usr/bin/env bash
# Scenario T05 — Backspace immediately undoes correction.
#
# Goal: Verify the one-action undo window restores the original word.
# Regression class: accepted corrections must remain reversible without manual retyping.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t05"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_type_and_settle "teh "
scn_send_keys BSpace
sleep 0.3

echo "==== T05 results ===="
scn_assert_editor_contains "teh$|teh " "T05: undo restores the original token"
scn_assert_editor_not_contains "the$|the " "T05: corrected token is removed after undo"
echo "===================="
exit $SCN_FAILED
