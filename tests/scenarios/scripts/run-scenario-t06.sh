#!/usr/bin/env bash
# Scenario T06 — Two rejections trigger learning.
#
# Goal: Verify repeated undo of the same correction learns the original token.
# Regression class: rejection tracking must persist to the learned dictionary after the configured threshold.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t06"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15

scn_type_and_settle "teh "
scn_send_keys BSpace
sleep 0.3
# Re-typing the same word at the same cursor position is intentionally suppressed
# after an undo. Type a separator + second typo so the next correction occurs at a
# new word boundary, then undo that second correction.
scn_type_and_settle " ok teh "
scn_send_keys BSpace
scn_wait_for "Learned: teh" 5 || scn_fail "T06: learned-word notification missing"
sleep 1

echo "==== T06 results ===="
scn_assert_file_contains "$SCN_DICT_PATH" '"teh"[[:space:]]*:' "T06: learned word was persisted to the dictionary file"
echo "===================="
exit $SCN_FAILED
