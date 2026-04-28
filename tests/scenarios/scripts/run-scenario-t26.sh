#!/usr/bin/env bash
# Scenario T26 — Word segmentation, classic concatenation.
#
# Goal: Verify the segmentation engine splits a run-together compound into its
#       constituent words when typed in the editor.
# Regression class: unambiguous concatenations that exceed the minimum-length
#       gate and are absent from the learned dictionary must be split on Space.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t26"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_type_and_settle "thequick "

echo "==== T26 results ===="
scn_assert_editor_contains "the quick" "T26: segmented output visible in editor"
scn_assert_editor_not_contains "thequick" "T26: concatenated input not left orphaned in editor"
echo "===================="
exit $SCN_FAILED
