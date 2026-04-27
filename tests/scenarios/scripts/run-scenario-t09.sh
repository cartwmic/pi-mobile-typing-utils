#!/usr/bin/env bash
# Scenario T09 — Case patterns.
#
# Goal: Verify correction preserves the supported case patterns and falls back cleanly for mixed case.
# Regression class: corrected output must retain user intent for capitalization-sensitive prompts.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t09"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15

scn_type_and_settle "Teh "
scn_assert_editor_contains "The$|The " "T09: title-case typo becomes title-case correction"
scn_clear_editor

scn_type_and_settle "TEH "
scn_assert_editor_contains "THE$|THE " "T09: uppercase typo becomes uppercase correction"
scn_clear_editor

scn_type_and_settle "teh "
scn_assert_editor_contains "the$|the " "T09: lowercase typo becomes lowercase correction"
scn_clear_editor

scn_type_and_settle "tHe "
scn_assert_editor_contains "the$|the " "T09: mixed-case typo falls back to lowercase correction"

echo "==== T09 results ===="
echo "===================="
exit $SCN_FAILED
