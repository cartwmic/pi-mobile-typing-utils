#!/usr/bin/env bash
# Scenario T19 — /typos dict clear requires confirm.
#
# Goal: Verify the destructive clear path prompts for confirmation and empties the dictionary on Yes.
# Regression class: destructive dictionary commands must be gated by the confirm UI.
#
# Note: Pi renders ctx.ui.confirm() as a Yes/No selector with Yes preselected; Enter confirms.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t19"
trap 'scn_pi_stop' EXIT

cat <<'JSON' | scn_seed_dict_from_stdin
{
  "version": 1,
  "words": {
    "alpha": { "added": "2026-04-26T00:00:00Z", "source": "manual", "rejections": 0 },
    "bravo": { "added": "2026-04-26T00:00:00Z", "source": "manual", "rejections": 0 },
    "charlie": { "added": "2026-04-26T00:00:00Z", "source": "manual", "rejections": 0 }
  },
  "pendingRejections": {}
}
JSON

scn_pi_start

scn_submit_typos_dict "clear"
scn_wait_for "Clear dictionary\?" 5 || scn_fail "T19: clear confirmation prompt missing"
scn_send_keys Enter
scn_wait_for "Cleared 3 words from dictionary" 5 || scn_fail "T19: clear confirmation result missing"
sleep 1

echo "==== T19 results ===="
scn_assert_file_contains "$SCN_DICT_PATH" '"words"[[:space:]]*:[[:space:]]*\{\}' "T19: dictionary words map is cleared after confirmation"
echo "===================="
exit $SCN_FAILED
