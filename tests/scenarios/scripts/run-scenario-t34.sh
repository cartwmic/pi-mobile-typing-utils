#!/usr/bin/env bash
# Scenario T34 — /typos stats summary renders in the pane.
#
# Goal: Verify that after firing several corrections, the /typos stats command
#       outputs a formatted summary into the Pi TUI pane containing the heading
#       "Mobile autocorrect telemetry summary" and the line "corrections applied:".
# Regression class: the /typos stats slash command must aggregate telemetry and
#       deliver the formatted report via ctx.ui.notify so it appears in the pane.
#
# Heading locked in src/telemetry-aggregate.ts:
#   `Mobile autocorrect telemetry summary (${rangeLabel}):`
#
# Cache-dir isolation: scn_setup sets SCN_CACHE_DIR; scn_pi_start passes it
# to Pi as MOBILE_AUTOCORRECT_CACHE_DIR so telemetry and the stats command use
# the same isolated directory.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t34"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15

# Fire ~10 corrections of varying inputs to populate the telemetry log.
# Not all tokens will produce corrections (corpus-dependent), but enough
# should to yield a non-empty stats report.
scn_type_and_settle "teh "
scn_type_and_settle "recieve "
scn_type_and_settle "seperate "
scn_type_and_settle "definately "
scn_type_and_settle "existance "
scn_type_and_settle "occurence "
scn_type_and_settle "peice "
scn_type_and_settle "untill "
scn_type_and_settle "acommodate "
scn_type_and_settle "succesful "

# Allow async telemetry writes to flush before querying stats.
sleep 3

# Each scn_type_and_settle leaves text in the editor buffer; clear it before
# submitting `/typos stats` so the slash command isn't appended to typed text
# and incorrectly sent to the model as part of a freeform message.
scn_clear_editor

# Submit /typos stats (trailing space cancels autocomplete; double Enter executes).
scn_send_no_enter "/typos stats "
sleep 0.5
scn_send_keys Enter Enter
sleep 1

# Wait for the stats heading to appear in the pane (or in scrollback). The
# notification is non-modal and may scroll out as the model query that also
# echoed `/typos stats` produces a response, but `capture-pane -S -2000`
# preserves recent scrollback.
scn_wait_for "Mobile autocorrect telemetry summary" 30 || \
	scn_fail "T34: stats heading did not appear in pane within 30s"

echo "==== T34 results ===="
scn_assert_pane_contains "Mobile autocorrect telemetry summary" \
	"T34: stats heading visible in pane"
scn_assert_pane_contains "corrections applied:" \
	"T34: 'corrections applied:' line visible in stats output"
echo "===================="
exit $SCN_FAILED
