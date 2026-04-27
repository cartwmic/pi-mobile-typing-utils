#!/usr/bin/env bash
# Scenario T25 — Tech words preserved end-to-end.
#
# Goal: Verify valid technical vocabulary survives both the editor and model submission path unchanged.
# Regression class: whitelisted tech terms must not be silently normalized to English neighbors upstream of the model.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t25"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_type_and_settle "Use kubectl with nginx "
scn_assert_editor_contains "Use kubectl with nginx$|Use kubectl with nginx " "T25: tech-word draft is visible before submit"
scn_send "Please echo back the previous sentence verbatim."

echo "==== T25 results ===="
scn_assert_response   "Please echo back the previous sentence verbatim"   'kubectl.*nginx'   'cuddle|engine'   "T25 coherence: tech terms preserved through model"
echo "===================="
exit $SCN_FAILED
