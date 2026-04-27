#!/usr/bin/env bash
# Scenario T20 — Slash menu still works.
#
# Goal: Verify slash-command completion remains available while autocorrect is enabled.
# Regression class: editor interception must not swallow slash-command UI entry points.
#
# Verified palette format (pi v0.70.2):
#   → settings                        Open settings menu
#     model                           Select model (opens selector UI)
#     scoped-models                   Enable/disable models for Ctrl+P cycling
#     export                          Export session (HTML default, or specify path: .html/.jsonl)
#     import                          Import and resume a session from a JSONL file
#     (1/69)
# The arrow prefix (→) and description column are stable; we match on visible entries.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t20"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_send_no_enter "/"
sleep 0.3
if ! scn_wait_for "→ settings|→ model|→ scoped-models|→ export|→ import" 1; then
  scn_send_keys Tab
fi
scn_wait_for "→ settings|→ model|→ scoped-models|→ export|→ import" 5 || scn_fail "T20: slash menu suggestions missing"

echo "==== T20 results ===="
scn_assert_pane_contains "settings|model|scoped-models|export|import" "T20: slash command UI is visible with autocorrect on"
echo "===================="
exit $SCN_FAILED
