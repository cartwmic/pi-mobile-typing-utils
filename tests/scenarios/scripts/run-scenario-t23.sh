#!/usr/bin/env bash
# Scenario T23 — Status flash appears and clears.
#
# Goal: Verify correction feedback is shown briefly and then removed.
# Regression class: status-line feedback must be visible without becoming sticky noise.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t23"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_type_and_settle "teh "
scn_wait_for "✓ teh → the" 2 || scn_fail "T23: correction status flash never appeared"
scn_wait_for_absent "✓ teh → the" 3 || scn_fail "T23: correction status flash never cleared"

echo "==== T23 results ===="
echo "===================="
exit $SCN_FAILED
