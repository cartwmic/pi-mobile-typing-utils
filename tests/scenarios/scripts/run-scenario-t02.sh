#!/usr/bin/env bash
# Scenario T02 — Tech-dict word preserved.
#
# Goal: Verify known technical vocabulary is treated as valid input.
# Regression class: English-nearest corrections must not mangle bundled tech terms.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t02"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_type_and_settle "nginx "

echo "==== T02 results ===="
scn_assert_editor_contains "nginx$|nginx " "T02: tech dictionary word stays unchanged"
scn_assert_editor_not_contains "engine$|engine " "T02: tech dictionary word is not corrected to an English neighbor"
echo "===================="
exit $SCN_FAILED
