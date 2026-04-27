#!/usr/bin/env bash
# Scenario T17 — /typos dict search case-insensitive.
#
# Goal: Verify substring search matches learned words regardless of query case.
# Regression class: dictionary search must be lowercase-normalized and filtered correctly.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t17"
trap 'scn_pi_stop' EXIT

cat <<'JSON' | scn_seed_dict_from_stdin
{
  "version": 1,
  "words": {
    "termux": { "added": "2026-04-26T00:00:00Z", "source": "manual", "rejections": 0 },
    "nginx": { "added": "2026-04-26T00:00:00Z", "source": "manual", "rejections": 0 },
    "kubectl": { "added": "2026-04-26T00:00:00Z", "source": "manual", "rejections": 0 }
  },
  "pendingRejections": {}
}
JSON

scn_pi_start

scn_submit_typos_dict "search TER"
scn_wait_for "termux" 5 || scn_fail "T17: uppercase query did not match termux"
scn_assert_pane_contains "termux" "T17: uppercase query finds termux"
scn_assert_pane_not_contains "nginx" "T17: uppercase query excludes non-matching nginx"
scn_assert_pane_not_contains "kubectl" "T17: uppercase query excludes non-matching kubectl"

scn_submit_typos_dict "search ngi"
scn_wait_for "nginx" 5 || scn_fail "T17: lowercase query did not match nginx"

echo "==== T17 results ===="
scn_assert_pane_contains "nginx" "T17: lowercase query finds nginx"
echo "===================="
exit $SCN_FAILED
