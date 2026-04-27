#!/usr/bin/env bash
# Scenario T10 — /typos on enables and /typos off disables.
#
# Goal: Verify explicit toggle commands gate editor behavior on and off.
# Regression class: session-level enablement must be reliable and reversible.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t10"
trap 'scn_pi_stop' EXIT

scn_pi_start

scn_type_and_settle "teh "
scn_assert_editor_contains "teh$|teh " "T10: autocorrect starts disabled by default"
scn_clear_editor

scn_enable_autocorrect 15
scn_type_and_settle "teh "
scn_assert_editor_contains "the$|the " "T10: autocorrected text appears after /typos on"
scn_clear_editor

scn_disable_autocorrect 5
scn_type_and_settle "teh "
scn_assert_editor_contains "teh$|teh " "T10: typo remains unchanged after /typos off"

echo "==== T10 results ===="
echo "===================="
exit $SCN_FAILED
