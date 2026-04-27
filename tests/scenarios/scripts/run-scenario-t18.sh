#!/usr/bin/env bash
# Scenario T18 — /typos dict remove and not-found.
#
# Goal: Verify removing an existing word updates persistence and repeat removal reports not found.
# Regression class: dictionary mutation commands must keep on-disk state in sync with notifications.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t18"
trap 'scn_pi_stop' EXIT

cat <<'JSON' | scn_seed_dict_from_stdin
{
  "version": 1,
  "words": {
    "foo": { "added": "2026-04-26T00:00:00Z", "source": "manual", "rejections": 0 }
  },
  "pendingRejections": {}
}
JSON

scn_pi_start

scn_submit_typos_dict "remove foo"
scn_wait_for 'Removed "foo"' 5 || scn_fail "T18: remove confirmation missing"
sleep 1

scn_submit_typos_dict "remove foo"
scn_wait_for '"foo" not found in dictionary' 5 || scn_fail "T18: not-found message missing"

echo "==== T18 results ===="
if grep -q '"foo"' "$SCN_DICT_PATH"; then
  scn_fail "T18: removed word still exists in dictionary file"
else
  scn_pass "T18: removed word no longer exists in dictionary file"
fi
echo "===================="
exit $SCN_FAILED
