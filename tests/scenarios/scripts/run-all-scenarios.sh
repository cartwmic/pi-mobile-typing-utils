#!/usr/bin/env bash
# Run all available scenario scripts and produce a summary.
# Each individual scenario is in scripts/run-scenario-t<N>.sh.
#
# Concurrency:
#   SCENARIO_PARALLEL=N    default 1 (sequential).
#                          Set >1 to run scenarios in parallel.
#   SCENARIO_TIMEOUT=N     per-script timeout in seconds (default 300).
#   SCENARIO_FILTER=regex  filter scenario short names (e.g. 't0[1-3]').
#
# Each scenario gets its own private tmux server (via SCN_TMUX_SOCKET in
# scenario-lib.sh), so parallel runs don't interfere. Bridge logs and pane
# logs are namespaced by scenario name. Each scenario's pi process is
# scoped to its own tmux server — no cross-scenario `pkill` or broad
# `tmux kill-server` is needed (or wanted: such a broad kill would knock
# out parallel siblings or even the user's ambient tmux server).
#
# Be aware of API rate limits when raising parallelism — most providers
# cap concurrent requests per account. SCENARIO_PARALLEL=3-4 is usually
# safe for haiku.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || (cd "$SCRIPT_DIR/../../.." && pwd))"
RESULTS_DIR="${SCENARIO_OUT_DIR:-$REPO_DIR/.test-output/scenarios}"
mkdir -p "$RESULTS_DIR"

SUMMARY="$RESULTS_DIR/SUMMARY.md"
echo "# Scenario run — $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SUMMARY"
echo "" >> "$SUMMARY"

PER_SCRIPT_TIMEOUT="${SCENARIO_TIMEOUT:-300}"
MAX_CONCURRENCY="${SCENARIO_PARALLEL:-1}"

# Use gtimeout if available (macOS coreutils), else timeout, else nothing.
if command -v gtimeout >/dev/null 2>&1; then
	TIMEOUT_BIN=gtimeout
elif command -v timeout >/dev/null 2>&1; then
	TIMEOUT_BIN=timeout
else
	TIMEOUT_BIN=""
fi

# Collect scripts. Bash 3.2-compatible read loop (no `mapfile`, no `wait -n`,
# no `declare -A`). Optionally filter by name prefixes via SCENARIO_FILTER.
SCRIPTS=()
while IFS= read -r line; do
	name="$(basename "$line" .sh | sed 's/^run-scenario-//')"
	if [[ -n "${SCENARIO_FILTER:-}" ]] && ! echo "$name" | grep -qE "$SCENARIO_FILTER"; then
		continue
	fi
	SCRIPTS+=("$line")
done < <(ls "$SCRIPT_DIR"/run-scenario-t*.sh 2>/dev/null | sort)
[[ ${#SCRIPTS[@]} -gt 0 ]] || { echo "No scenarios found in $SCRIPT_DIR"; exit 1; }

# Run a single scenario. Each invocation gets a unique SCN_TMUX_SOCKET
# (combining its own PID with the scenario name), so even when this
# function runs in parallel via `&`, sockets never collide.
#
# Stdout protocol (single line):
#   PASS|<name>      — script exited 0 with no SKIPPED marker
#   SKIPPED|<name>   — script exited 0 and emitted "SKIPPED:" on stdout
#   TIMEOUT|<name>   — script killed by timeout (rc=124)
#   FAIL|<name>|rc   — script exited non-zero
run_one() {
	local script="$1"
	local name="$2"
	local logfile="$RESULTS_DIR/${name}.run.log"
	local socket="pi-scn-${name}-$$"

	local rc=0
	if [[ -n "$TIMEOUT_BIN" ]]; then
		SCN_TMUX_SOCKET="$socket" "$TIMEOUT_BIN" --kill-after=10 "$PER_SCRIPT_TIMEOUT" bash "$script" > "$logfile" 2>&1 || rc=$?
	else
		SCN_TMUX_SOCKET="$socket" bash "$script" > "$logfile" 2>&1 || rc=$?
	fi

	# Best-effort cleanup of this scenario's private tmux server. The
	# script's EXIT trap should already have called scn_pi_stop, but a
	# crash before the trap installs (or before scn_pi_start ran) could
	# leave the server live. This kill is scoped to OUR socket only.
	tmux -L "$socket" kill-server 2>/dev/null || true

	if (( rc == 0 )); then
		if grep -qE '^[[:space:]]*SKIPPED:' "$logfile"; then
			echo "SKIPPED|$name"
		else
			echo "PASS|$name"
		fi
	elif (( rc == 124 )); then
		echo "TIMEOUT|$name"
	else
		echo "FAIL|$name|$rc"
	fi
}

# Append a per-scenario block to SUMMARY (with tail -40 for non-pass results).
write_summary_entry() {
	local name="$1"
	local result="$2"   # PASS / SKIPPED / FAIL / TIMEOUT
	local logfile="$RESULTS_DIR/${name}.run.log"
	echo "## $name — $result" >> "$SUMMARY"
	if [[ "$result" != "PASS" ]]; then
		echo '```' >> "$SUMMARY"
		tail -40 "$logfile" 2>/dev/null >> "$SUMMARY" || true
		echo '```' >> "$SUMMARY"
	fi
	echo "" >> "$SUMMARY"
}

PASS=0
FAIL=0
TIMEOUT=0
SKIPPED=0

if (( MAX_CONCURRENCY <= 1 )); then
	# ─── Sequential branch ─────────────────────────────────────────────
	for s in "${SCRIPTS[@]}"; do
		[[ -x "$s" ]] || continue
		name="$(basename "$s" .sh | sed 's/^run-scenario-//')"
		printf "%-30s " "$name"
		result_line=$(run_one "$s" "$name")
		case "$result_line" in
			PASS\|*)    echo "PASS"   ; PASS=$((PASS+1))      ; write_summary_entry "$name" "PASS" ;;
			SKIPPED\|*) echo "SKIPPED"; SKIPPED=$((SKIPPED+1)); write_summary_entry "$name" "SKIPPED" ;;
			TIMEOUT\|*) echo "TIMEOUT (>${PER_SCRIPT_TIMEOUT}s)"; TIMEOUT=$((TIMEOUT+1)); write_summary_entry "$name" "TIMEOUT" ;;
			FAIL\|*)    echo "FAIL"   ; FAIL=$((FAIL+1))      ; write_summary_entry "$name" "FAIL" ;;
			*)          echo "UNKNOWN: $result_line"; FAIL=$((FAIL+1)); write_summary_entry "$name" "FAIL" ;;
		esac
	done
else
	# ─── Parallel branch ───────────────────────────────────────────────
	# Bash 3.2 compatible: parallel arrays + file-marker completion
	# signaling. NEVER use `kill -0 $pid` to detect "still running":
	# zombies pass kill -0 until reaped, so the dispatcher would loop
	# forever. Instead each child writes $RESULTS_DIR/.<name>.done after
	# its result file is on disk, and the dispatcher polls for those.
	echo "Running with SCENARIO_PARALLEL=$MAX_CONCURRENCY"
	rm -f "$RESULTS_DIR/.summary-raw" "$RESULTS_DIR"/.*.done "$RESULTS_DIR"/.*.result 2>/dev/null || true

	RUNNING_PIDS=()
	RUNNING_NAMES=()

	reap_completed() {
		# Reap entries whose .done file has appeared. Doesn't block.
		local new_pids=() new_names=() i pid name result_line
		for ((i=0; i<${#RUNNING_PIDS[@]}; i++)); do
			pid="${RUNNING_PIDS[$i]}"
			name="${RUNNING_NAMES[$i]}"
			if [[ -f "$RESULTS_DIR/.${name}.done" ]]; then
				wait "$pid" 2>/dev/null || true
				result_line=$(cat "$RESULTS_DIR/.${name}.result" 2>/dev/null || echo "FAIL|$name|missing")
				rm -f "$RESULTS_DIR/.${name}.result" "$RESULTS_DIR/.${name}.done"
				case "$result_line" in
					PASS\|*)    PASS=$((PASS+1)) ;;
					SKIPPED\|*) SKIPPED=$((SKIPPED+1)) ;;
					TIMEOUT\|*) TIMEOUT=$((TIMEOUT+1)) ;;
					FAIL\|*)    FAIL=$((FAIL+1)) ;;
				esac
				printf "  done: %-25s %s\n" "$name" "${result_line%%|*}"
				echo "${result_line}" >> "$RESULTS_DIR/.summary-raw"
			else
				new_pids+=("$pid")
				new_names+=("$name")
			fi
		done
		# Reset arrays cleanly for bash 3.2.
		if [[ ${#new_pids[@]} -gt 0 ]]; then
			RUNNING_PIDS=("${new_pids[@]}")
			RUNNING_NAMES=("${new_names[@]}")
		else
			RUNNING_PIDS=()
			RUNNING_NAMES=()
		fi
	}

	for s in "${SCRIPTS[@]}"; do
		[[ -x "$s" ]] || continue
		name="$(basename "$s" .sh | sed 's/^run-scenario-//')"
		while (( ${#RUNNING_PIDS[@]} >= MAX_CONCURRENCY )); do
			sleep 2
			reap_completed
		done

		(
			r=$(run_one "$s" "$name")
			echo "$r" > "$RESULTS_DIR/.${name}.result"
			# Touch .done LAST — appearance is the dispatcher's reap signal.
			: > "$RESULTS_DIR/.${name}.done"
		) &
		pid=$!
		RUNNING_PIDS+=("$pid")
		RUNNING_NAMES+=("$name")
		printf "  start: %-25s pid=%s\n" "$name" "$pid"
	done

	# Drain remaining.
	while (( ${#RUNNING_PIDS[@]} > 0 )); do
		sleep 2
		reap_completed
	done

	# Write summary in scenario-name (alphabetical) order.
	for s in "${SCRIPTS[@]}"; do
		name="$(basename "$s" .sh | sed 's/^run-scenario-//')"
		result_line=$(grep -E "^[A-Z]+\|${name}(\||$)" "$RESULTS_DIR/.summary-raw" 2>/dev/null | head -1 || echo "MISSING|$name")
		case "$result_line" in
			PASS\|*)    write_summary_entry "$name" "PASS" ;;
			SKIPPED\|*) write_summary_entry "$name" "SKIPPED" ;;
			TIMEOUT\|*) write_summary_entry "$name" "TIMEOUT" ;;
			FAIL\|*)    write_summary_entry "$name" "FAIL" ;;
			*)          write_summary_entry "$name" "FAIL" ;;
		esac
	done
	rm -f "$RESULTS_DIR/.summary-raw"
fi

echo ""
echo "Passed: $PASS  Failed: $FAIL  Timeout: $TIMEOUT  Skipped: $SKIPPED"
echo "Results: $SUMMARY"
[[ $((FAIL + TIMEOUT)) -eq 0 ]]
