#!/usr/bin/env bash
# Scenario T11 — Bare /typos toggles.
#
# Goal: Verify the no-argument command flips autocorrect state in both directions.
# Regression class: the convenience toggle must stay aligned with explicit on/off behavior.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t11"
trap 'scn_pi_stop' EXIT

scn_pi_start

scn_send_no_enter "/typos"
scn_send_keys Enter
if scn_wait_for "Autocorrect ON" 15; then
  scn_pass "T11: bare /typos toggles from off to on"
else
  scn_fail "T11: bare toggle did not enable autocorrect"
fi

scn_send_no_enter "/typos"
scn_send_keys Enter
if scn_wait_for "Autocorrect OFF" 5; then
  scn_pass "T11: bare /typos toggles from on to off"
else
  scn_fail "T11: bare toggle did not disable autocorrect"
fi

echo "==== T11 results ===="
echo "===================="
exit $SCN_FAILED
