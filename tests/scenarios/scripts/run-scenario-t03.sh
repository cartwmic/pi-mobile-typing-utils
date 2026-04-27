#!/usr/bin/env bash
# Scenario T03 — Token-eligibility skips.
#
# Goal: Verify code-like, path-like, flagged, mixed-alnum, apostrophe, and non-ASCII tokens are skipped.
# Regression class: autocorrect must gate corrections before they reach SymSpell.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t03"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15

check_token() {
  local token="$1"
  local pattern="$2"
  local descr="$3"
  scn_clear_editor
  scn_type_and_settle "$token"
  scn_assert_editor_contains "$pattern" "$descr"
}

check_token "src/foo.ts " "src/foo\\.ts$|src/foo\\.ts " "T03: file path token is preserved"
check_token "--force " "--force$|--force " "T03: CLI flag token is preserved"
check_token "don't " "don't$|don't " "T03: apostrophe token is preserved"
check_token "v1beta1 " "v1beta1$|v1beta1 " "T03: mixed alphanumeric token is preserved"
check_token "café " "café$|café " "T03: non-ASCII token is preserved"

echo "==== T03 results ===="
echo "===================="
exit $SCN_FAILED
