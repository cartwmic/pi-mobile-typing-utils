#!/usr/bin/env bash
# Scenario T35 — In-dictionary guard prevents false-positive corrections.
#
# Goal: Verify that valid English words present in the SymSpell unigram dictionary
# (e.g., `they`, `makes`, `their`, `does`) are NOT silently rewritten to
# higher-frequency neighbors (`the`, `make`, etc.) — even when the rerank's
# `unigram + α₁·bigram + α₂·trigram − δ·ed` score for the neighbor would
# otherwise outscore the identity term.
#
# Regression class: post-rerank identity-suppression bug (`openspec/changes/
# guard-in-dictionary-tokens/`). Before the fix, `they → the`, `makes → make`,
# `their → the` could leak through because the rerank would pick the higher-
# frequency neighbor as winner and the identity-suppression rule fired only
# when the winner equaled the identity.
#
# Also includes positive controls: `teh → the` (regression safety, true typo
# correction must still fire) and `tHe → the` (mixed-case normalization must
# still fire — guard does not apply to mixed-case input).

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t35"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15

# --- Negative-correction cases (the actual bug fix) ---

scn_clear_editor
scn_type_and_settle "they "
echo "==== T35a: 'they' (in-dict, must NOT be rewritten to 'the') ===="
scn_assert_editor_contains "they$|they " "T35a: 'they' is preserved verbatim"
scn_assert_editor_not_contains "^the$|^the |[^y]the$|[^y]the " "T35a: 'they' is NOT rewritten to 'the'"

scn_clear_editor
scn_type_and_settle "makes "
echo "==== T35b: 'makes' (in-dict, must NOT be rewritten to 'make') ===="
scn_assert_editor_contains "makes$|makes " "T35b: 'makes' is preserved verbatim"
scn_assert_editor_not_contains "^make$|^make |[^s]make$|[^s]make " "T35b: 'makes' is NOT rewritten to 'make'"

scn_clear_editor
scn_type_and_settle "their "
echo "==== T35c: 'their' (in-dict, must NOT be rewritten) ===="
scn_assert_editor_contains "their$|their " "T35c: 'their' is preserved verbatim"
scn_assert_editor_not_contains "^the$|^the |[^iy]the$|[^iy]the " "T35c: 'their' is NOT rewritten to 'the'"

scn_clear_editor
scn_type_and_settle "does "
echo "==== T35d: 'does' (in-dict, must NOT be rewritten) ===="
scn_assert_editor_contains "does$|does " "T35d: 'does' is preserved verbatim"

# --- Positive-correction control: real typo must still correct ---

scn_clear_editor
scn_type_and_settle "teh "
echo "==== T35e: 'teh' control (out-of-dict typo, MUST still correct to 'the') ===="
scn_assert_editor_contains "the$|the " "T35e: real typo 'teh' still corrects to 'the'"
scn_assert_editor_not_contains "teh$|teh " "T35e: original typo is not orphaned"

# --- Mixed-case control: case normalization must still fire ---

scn_clear_editor
scn_type_and_settle "tHe "
echo "==== T35f: 'tHe' control (mixed-case in-dict, MUST normalize to 'the') ===="
scn_assert_editor_contains "the$|the " "T35f: mixed-case 'tHe' normalizes to 'the'"

echo ""
echo "==== T35 summary ===="
if [ "$SCN_FAILED" -eq 0 ]; then
  echo "  All 6 sub-cases PASSED — guard works in real Pi TUI"
else
  echo "  Some sub-cases FAILED — see above"
fi
echo "====================="
exit $SCN_FAILED
