#!/usr/bin/env bash
# Scenario T24 — Corrected text flows to the model.
#
# Goal: Verify the model receives the corrected editor text rather than the original typos.
# Regression class: a pre-submit visual correction must also survive the submission path end-to-end.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t24"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_type_and_settle "teh atuhorization modle "
scn_assert_editor_contains "the authorization model$|the authorization model " "T24: corrected draft is visible before submit"
scn_send "Please echo back exactly the next sentence I typed before this one, in quotes."

echo "==== T24 results ===="
scn_assert_response   "Please echo back exactly"   '"the authorization model"'   'teh|atuhorization|modle'   "T24 coherence: corrected text reached the model"
echo "===================="
exit $SCN_FAILED
