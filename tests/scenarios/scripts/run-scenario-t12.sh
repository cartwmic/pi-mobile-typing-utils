#!/usr/bin/env bash
# Scenario T12 — Idempotency.
#
# Goal: Verify enabling an already-enabled session yields the explicit no-op message.
# Regression class: repeated setup commands must not reinitialize or silently change state.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t12"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_submit_typos_explicit_state on
scn_wait_for "Autocorrect is already on" 5 || scn_fail "T12: idempotency message missing"

echo "==== T12 results ===="
scn_assert_pane_contains "Autocorrect is already on" "T12: repeated /typos on reports existing state"
echo "===================="
exit $SCN_FAILED
