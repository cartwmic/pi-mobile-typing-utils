#!/usr/bin/env bash
# Scenario T04 — Identity correction suppressed.
#
# Goal: Verify exact dictionary matches do not loop through a fake replacement path.
# Regression class: exact English words must remain stable and not flash as corrections.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t04"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_type_and_settle "the "

echo "==== T04 results ===="
scn_assert_editor_contains "the$|the " "T04: exact English word remains unchanged"
scn_assert_pane_not_contains "✓ the → the" "T04: identity match does not emit correction feedback"
echo "===================="
exit $SCN_FAILED
