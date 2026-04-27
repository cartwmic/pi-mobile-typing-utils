#!/usr/bin/env bash
# Scenario T01 — Plain typo correction.
#
# Goal: Verify the core pre-submit correction loop rewrites a common typo in the editor.
# Regression class: eligible natural-language tokens stop leaking misspellings into the submitted draft.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t01"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_type_and_settle "teh "

echo "==== T01 results ===="
scn_assert_editor_contains "the$|the " "T01: corrected typo is visible in the editor"
scn_assert_editor_not_contains "teh$|teh " "T01: original typo is not orphaned in the editor"
echo "===================="
exit $SCN_FAILED
