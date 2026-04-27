#!/usr/bin/env bash
# Scenario T07 — Learned word no longer corrected.
#
# Goal: Verify a pre-seeded learned dictionary entry is consulted live by the correction engine.
# Regression class: learned words must override normal typo correction without a reload.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t07"
trap 'scn_pi_stop' EXIT

cat <<'JSON' | scn_seed_dict_from_stdin
{
  "version": 1,
  "words": {
    "termux": {
      "added": "2026-04-26T00:00:00Z",
      "source": "manual",
      "rejections": 0
    }
  },
  "pendingRejections": {}
}
JSON

scn_pi_start
scn_enable_autocorrect 15
scn_type_and_settle "termux "

echo "==== T07 results ===="
scn_assert_editor_contains "termux$|termux " "T07: learned word remains unchanged"
scn_assert_editor_not_contains "terminal$|terminal " "T07: learned word is not corrected to another English word"
echo "===================="
exit $SCN_FAILED
