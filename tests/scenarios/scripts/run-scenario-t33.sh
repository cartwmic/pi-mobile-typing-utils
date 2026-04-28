#!/usr/bin/env bash
# Scenario T33 — Telemetry off writes nothing.
#
# Goal: Verify that setting telemetry to "off" before enabling autocorrect
#       prevents any telemetry directory or NDJSON file from being created,
#       even when corrections fire.
# Regression class: TelemetryWriter must early-return without mkdir on every
#       emit() call when getLevel() === "off"; no directory must be created.
#
# Cache-dir isolation: scn_setup sets SCN_CACHE_DIR; scn_pi_start passes it
# to Pi as MOBILE_AUTOCORRECT_CACHE_DIR.

set -euo pipefail
source "$(dirname "$0")/scenario-lib.sh"

SCN_FAILED=0
scn_setup "t33"
trap 'scn_pi_stop' EXIT

# Override the default per-scenario config to set telemetry="off" BEFORE pi
# starts. The default scenario config (in scn_setup) sets defaultMode="on"
# so the engine pre-warms during extension load — with telemetry="metrics"
# (the bootstrap default) the pre-warm's `engine.init` event would create
# the telemetry directory before the test's `/typos config telemetry off`
# could take effect. Pre-writing telemetry="off" prevents the writer from
# ever calling mkdir (per spec).
cat > "$SCN_CONFIG_PATH" <<'JSON'
{
  "version": 1,
  "defaultMode": "on",
  "maxEditDistance": 2,
  "minWordLength": 2,
  "minEditDistance": 1,
  "editDistanceStepEvery": 4,
  "telemetry": "off"
}
JSON

scn_pi_start

scn_enable_autocorrect 15

# Fire a correction that would normally produce a telemetry event.
scn_type_and_settle "teh "

# Allow time for any async writes to settle (there should be none).
sleep 3

TELEMETRY_DIR="$SCN_CACHE_DIR/telemetry"

echo "==== T33 results ===="

# Assert no telemetry directory was created.
if [[ -d "$TELEMETRY_DIR" ]]; then
	scn_fail "T33: telemetry directory should NOT exist when telemetry=off (found: $TELEMETRY_DIR)"
else
	scn_pass "T33: telemetry directory not created when telemetry=off"
fi

# Assert no events-*.ndjson file was written anywhere under the cache dir.
NDJSON_COUNT="$(find "$SCN_CACHE_DIR" -name 'events-*.ndjson' 2>/dev/null | wc -l | tr -d ' ' || echo 0)"
if [[ "$NDJSON_COUNT" -eq 0 ]]; then
	scn_pass "T33: no NDJSON files written when telemetry=off"
else
	scn_fail "T33: found $NDJSON_COUNT NDJSON file(s) under $SCN_CACHE_DIR — expected none"
fi

echo "===================="
exit $SCN_FAILED
