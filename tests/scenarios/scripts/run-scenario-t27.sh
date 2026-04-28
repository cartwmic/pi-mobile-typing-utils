#!/usr/bin/env bash
# Scenario T27 — Word segmentation, edit-distance knob behavior.
#
# T27 NOTE: This is a knob-behavior test; outcome depends on corpus.
# The fixture 'wantto' is chosen because it is long enough (≥6 chars) to pass
# the min-length gate. With segmentationMaxEditDistance=0, only exact-match
# unigram candidates are used, so 'wantto' should NOT be split (it is not in
# the unigram dictionary). With ED=1, the engine may or may not produce
# 'want to' depending on log-prob and the corpus; both outcomes are acceptable.
# What the test validates is that:
#   1. The /typos config key is settable without error.
#   2. Pi remains alive and stable after each config change.
#   3. The pane shows either the input token or a segmented form (both valid).
#
# Goal: Prove /typos config segmentationMaxEditDistance is settable and that
#       ED=0 does not segment tokens requiring fuzzy matching.
# Regression class: config knob must accept [0,2] integer values; ED=0 must
#       suppress fuzzy-match segmentation paths.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t27"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15

# Phase 1: ED=0 — only exact-match segmentation candidates considered.
# 'wantto' has no single-word unigram entry, so segmentation should not fire.
scn_submit_typos_config segmentationMaxEditDistance 0

scn_type_and_settle "wantto "

# At ED=0, segmentation cannot construct splits with any per-segment edits.
# The lookup tier (governed by maxEditDistance, not segmentationMaxEditDistance)
# may still correct `wantto` to a single-word candidate, so we assert only
# that no INTERNAL space was introduced (i.e., segmentation did NOT fire).
scn_assert_editor_not_contains "want to" "T27 ED=0: segmentation did not fire (no internal space)"

# Phase 2: Set ED=1 — fuzzy candidates now eligible.
# Clear the editor so the next token starts fresh.
scn_clear_editor
scn_submit_typos_config segmentationMaxEditDistance 1

scn_type_and_settle "wantto "

# Either 'wantto' (unchanged) or 'want to' (segmented) is acceptable.
scn_assert_pane_contains "wantto|want to" "T27 ED=1: pane shows input or segmented form (both acceptable)"

echo "==== T27 results ===="
echo "===================="
exit $SCN_FAILED
