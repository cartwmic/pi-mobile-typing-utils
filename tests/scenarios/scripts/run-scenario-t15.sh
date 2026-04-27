#!/usr/bin/env bash
# Scenario T15 — /typos dict empty and populated.
#
# Goal: Verify dictionary listing renders both the empty state and a later populated entry.
# Regression class: dictionary-management output must reflect current persisted state.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t15"
trap 'scn_pi_stop' EXIT

scn_pi_start

scn_submit_typos_dict
scn_wait_for "No words in dictionary yet|No learned words yet" 5 || scn_fail "T15: empty dictionary message missing"

scn_submit_typos_dict "add foo"
scn_wait_for 'Added "foo" to dictionary' 5 || scn_fail "T15: add confirmation missing"

scn_submit_typos_dict
scn_wait_for "foo" 5 || scn_fail "T15: populated dictionary output missing"

echo "==== T15 results ===="
scn_assert_pane_contains "foo" "T15: dictionary list shows the added word"
scn_assert_pane_contains "manual" "T15: dictionary list shows the entry source"
echo "===================="
exit $SCN_FAILED
