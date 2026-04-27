#!/usr/bin/env bash
# Scenario T21 — @ file-ref menu still works.
#
# Goal: Verify file-reference autocomplete remains available while autocorrect is enabled.
# Regression class: editor interception must not break Pi's @-mention file picker.
#
# Verified palette format (pi v0.70.2):
#   → .claude/                        .claude
#     commands/                       .claude/commands
#     skills/                         .claude/skills
#     openspec-apply-change/          .claude/skills/openspec-apply-change
#     SKILL.md                        .claude/skills/openspec-apply-change/SKILL.md
#     (1/20)
# The entries are relative paths from the repo root; we match on visible directory/file names.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t21"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15
scn_send_no_enter "@"
sleep 0.3
if ! scn_wait_for "\.claude/|commands/|skills/|openspec-apply-change/|SKILL\.md" 1; then
  scn_send_keys Tab
fi
scn_wait_for "\.claude/|commands/|skills/|openspec-apply-change/|SKILL\.md" 5 || scn_fail "T21: file-ref suggestions missing"

echo "==== T21 results ===="
scn_assert_pane_contains "\.claude/|commands/|skills/|openspec-apply-change/|SKILL\.md" "T21: file-reference UI is visible with autocorrect on"
echo "===================="
exit $SCN_FAILED
