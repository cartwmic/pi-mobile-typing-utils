#!/usr/bin/env bash
# Scenario T16 — /typos dict add validation.
#
# Goal: Verify invalid add forms are rejected and a valid word is persisted.
# Regression class: dictionary commands must validate user input instead of storing junk tokens.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t16"
trap 'scn_pi_stop' EXIT

scn_pi_start

scn_submit_typos_dict "add foo bar"
scn_wait_for "Usage: /typos dict add <word>" 5 || scn_fail "T16: multi-word validation message missing"

scn_submit_typos_dict "add foo123"
scn_wait_for "Usage: /typos dict add <word>" 5 || scn_fail "T16: alphanumeric validation message missing"

scn_submit_typos_dict "add foo"
scn_wait_for 'Added "foo" to dictionary' 5 || scn_fail "T16: valid add confirmation missing"
sleep 1

echo "==== T16 results ===="
scn_assert_file_contains "$SCN_DICT_PATH" '"foo"[[:space:]]*:' "T16: valid add writes the word to the dictionary file"
echo "===================="
exit $SCN_FAILED
