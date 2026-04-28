#!/usr/bin/env bash
# Scenario T29 — Segmentation respects the learned dictionary.
#
# Goal: Verify that two user rejections (Backspace after segmentation) cause the
#       engine to learn 'thequick' as a valid token, suppressing segmentation on
#       the third and subsequent occurrences.
# Regression class: the learned-dictionary gate must run before the segmentation
#       path; two rejections via the existing learning loop must be sufficient to
#       suppress re-segmentation.
#
# Implementation note: the engine suppresses re-correction at the same cursor
# position after an undo. The second rejection therefore uses a separator phrase
# (" ok ") to create a fresh word boundary — matching the T06 pattern.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t29"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15

# First occurrence: type 'thequick ', then reject the segmentation with Backspace.
scn_type_and_settle "thequick "
scn_send_keys BSpace
sleep 0.3

# Second occurrence at a new word boundary (suppresses same-position skip guard).
# This second rejection triggers the learning loop threshold.
scn_type_and_settle " ok thequick "
scn_send_keys BSpace
scn_wait_for "Learned: thequick" 5 || scn_fail "T29: learned-word notification missing after two rejections"
sleep 0.5

# Third occurrence: the learned-dict gate should now suppress segmentation.
scn_type_and_settle " thequick "

echo "==== T29 results ===="
scn_assert_pane_contains "thequick" "T29: token present in pane after learning (segmentation suppressed)"
scn_assert_file_contains "$SCN_DICT_PATH" '"thequick"[[:space:]]*:' "T29: learned word persisted to the dictionary file"
echo "===================="
exit $SCN_FAILED
