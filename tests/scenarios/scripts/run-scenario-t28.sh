#!/usr/bin/env bash
# Scenario T28 — Segmentation rejection for tokens below minimum length.
#
# Goal: Verify the segmentation engine skips tokens shorter than the configured
#       segmentationMinLength (default 6 chars). The 4-char token 'imho' must
#       pass through the editor unchanged — no split attempted.
# Regression class: the min-length gate must fire before dictionary lookup or
#       log-prob scoring; sub-threshold tokens must never be segmented.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t28"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_type_and_settle "imho "

echo "==== T28 results ===="
scn_assert_pane_contains "imho" "T28: short token not segmented (min-length gate)"
echo "===================="
exit $SCN_FAILED
