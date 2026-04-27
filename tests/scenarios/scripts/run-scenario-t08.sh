#!/usr/bin/env bash
# Scenario T08 — Pending rejections persist across Pi restart.
#
# Goal: Verify pre-threshold rejection counts survive process restarts and complete learning later.
# Regression class: short mobile sessions must accumulate rejection progress across launches.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t08"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_type_and_settle "teh "
scn_send_keys BSpace
sleep 1
scn_pi_restart

SCN_FAILED=0

echo "==== T08 results ===="
scn_assert_file_contains "$SCN_DICT_PATH" '"teh"[[:space:]]*:[[:space:]]*1' "T08: first rejection count is persisted before restart"

scn_enable_autocorrect 15
scn_type_and_settle "teh "
scn_send_keys BSpace
scn_wait_for "Learned: teh" 5 || scn_fail "T08: learned-word notification missing after restart"
sleep 1
scn_assert_file_contains "$SCN_DICT_PATH" '"teh"[[:space:]]*:' "T08: learned word exists after second rejection in new session"
echo "===================="
exit $SCN_FAILED
