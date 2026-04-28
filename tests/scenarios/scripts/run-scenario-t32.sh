#!/usr/bin/env bash
# Scenario T32 — Telemetry metrics file written by default.
#
# Goal: Verify that firing a correction with the default telemetry level
#       ("metrics") writes an NDJSON events file to <cacheDir>/telemetry/,
#       that the file contains a "correction.applied" event, and that the
#       token field is masked (null/absent) at the metrics level.
# Regression class: telemetry must write on every correction at the default
#       level; metrics-level masking must suppress the 'token' content field.
#
# Cache-dir isolation: scn_setup sets SCN_CACHE_DIR; scn_pi_start passes it
# to Pi as MOBILE_AUTOCORRECT_CACHE_DIR so telemetry lands in an isolated tree.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t32"
trap 'scn_pi_stop' EXIT

scn_pi_start
scn_enable_autocorrect 15

# Fire one correction to generate a telemetry event.
scn_type_and_settle "teh "

# Telemetry is fire-and-forget; allow time for the async write to flush.
sleep 3

TELEMETRY_DIR="$SCN_CACHE_DIR/telemetry"

echo "==== T32 results ===="

# Assert the telemetry directory was created.
if [[ ! -d "$TELEMETRY_DIR" ]]; then
	scn_fail "T32: telemetry directory not created ($TELEMETRY_DIR)"
	echo "===================="
	exit $SCN_FAILED
fi
scn_pass "T32: telemetry directory exists"

# Assert at least one events-*.ndjson file was written.
NDJSON_FILE="$(ls "$TELEMETRY_DIR"/events-*.ndjson 2>/dev/null | head -1 || true)"
if [[ -z "$NDJSON_FILE" ]]; then
	scn_fail "T32: no events-*.ndjson file found in $TELEMETRY_DIR"
	echo "===================="
	exit $SCN_FAILED
fi
scn_pass "T32: events NDJSON file written"

# Assert the file contains at least one correction.applied event.
scn_assert_file_contains "$NDJSON_FILE" '"event":"correction\.applied"' \
	"T32: correction.applied event present in NDJSON"

# Assert the token field is masked (metrics level must omit/null it).
# At "metrics" level, content fields such as 'token' must not appear as
# non-null values. The field should be absent or null — never "token":"teh".
if grep -qE '"token":"teh"' "$NDJSON_FILE"; then
	scn_fail "T32: token field NOT masked — 'token':'teh' present in metrics-level NDJSON"
else
	scn_pass "T32: token field correctly masked at metrics level"
fi

echo "===================="
exit $SCN_FAILED
