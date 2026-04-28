#!/usr/bin/env bash
# scenario-lib.sh — shared helpers for tmux-driven Pi TUI scenario validation.
# Source from any scenario script: `source "$(dirname "$0")/scenario-lib.sh"`.
#
# Conventions:
#   - tmux session name is exported as $SESSION
#   - tmux pane is always 0 (single-pane sessions)
#   - per-scenario captures + logs go to $OUT_DIR/<scenario>.{pane,bridge}.log
#
# Defaults read from environment:
#   SCENARIO_PROVIDER  default: claude-bridge
#   SCENARIO_MODEL     default: claude-bridge/claude-haiku-4-5
#   SCENARIO_CWD       default: <repo root>
#   SCENARIO_PI_ARGS   default: "--no-session -ne -e ./index.ts -e <claude-bridge-path>"
#                       Loads the local workspace's index.ts directly (Pi loads
#                       TypeScript natively per package.json's pi.extensions),
#                       disables auto-discovery so installed copies don't shadow
#                       the workspace, and explicitly re-loads pi-claude-bridge
#                       (resolved via `pi list`) since `-ne` would otherwise
#                       block the `claude-bridge` provider used by SCENARIO_PROVIDER.
#                       This is the equivalent of "pi dev-mode" for this repo:
#                       the local code is the source of truth, with no risk of
#                       running an outdated installed copy.
#
# Cache-dir isolation (added for Phase 12 telemetry scenarios):
#   scn_setup() now exports SCN_CACHE_DIR="$OUT_DIR/<name>.cache" and
#   scn_pi_start() passes MOBILE_AUTOCORRECT_CACHE_DIR='$SCN_CACHE_DIR' to
#   the spawned Pi process inline, giving every scenario a private cache
#   tree (trigram cache, telemetry NDJSON files, etc.).
#
# New helpers (Phase 12):
#   scn_submit_typos_config <key> <value>  — submit /typos config <key> <value>
#   SCENARIO_OUT_DIR   default: <repo>/.test-output/scenarios
#
# Completion-signal selection (for scn_send waits):
#   SCN_PROVIDER_DEBUG_LOG    if set, watch this file for SCN_COMPLETION_SIGNAL_REGEX
#   SCN_COMPLETION_SIGNAL_REGEX  default: "caching session="  (claude-bridge)
#   SCN_IDLE_REGEX            default: "escape interrupt"     (Pi footer; absence = idle)
#                              When SCN_PROVIDER_DEBUG_LOG is unset, scn_send waits for
#                              this regex to DISAPPEAR from the pane capture.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || (cd "$SCRIPT_DIR/../../.." && pwd))"
OUT_DIR="${SCENARIO_OUT_DIR:-$REPO_DIR/.test-output/scenarios}"
mkdir -p "$OUT_DIR"

: "${SCENARIO_PROVIDER:=claude-bridge}"
: "${SCENARIO_MODEL:=claude-bridge/claude-haiku-4-5}"
: "${SCENARIO_CWD:=$REPO_DIR}"
# Resolve pi-claude-bridge's install path once (lazily) via `pi list`.
if [[ -z "${SCN_CLAUDE_BRIDGE_PATH:-}" ]]; then
	SCN_CLAUDE_BRIDGE_PATH="$(pi list 2>/dev/null | awk '/pi-claude-bridge$/{getline; gsub(/^[[:space:]]+/, ""); print}' | head -1)"
	export SCN_CLAUDE_BRIDGE_PATH
fi

if [[ -n "${SCN_CLAUDE_BRIDGE_PATH}" && -f "${SCN_CLAUDE_BRIDGE_PATH}/index.ts" ]]; then
	SCN_CLAUDE_BRIDGE_ENTRY="${SCN_CLAUDE_BRIDGE_PATH}/index.ts"
elif [[ -n "${SCN_CLAUDE_BRIDGE_PATH}" && -f "${SCN_CLAUDE_BRIDGE_PATH}/dist/index.js" ]]; then
	SCN_CLAUDE_BRIDGE_ENTRY="${SCN_CLAUDE_BRIDGE_PATH}/dist/index.js"
else
	SCN_CLAUDE_BRIDGE_ENTRY=""
fi

: "${SCENARIO_PI_ARGS:=--no-session -ne -e ./index.ts${SCN_CLAUDE_BRIDGE_ENTRY:+ -e ${SCN_CLAUDE_BRIDGE_ENTRY}}}"
: "${SCN_PROVIDER_DEBUG_LOG:=}"
: "${SCN_COMPLETION_SIGNAL_REGEX:=caching session=}"
: "${SCN_IDLE_REGEX:=escape interrupt}"

# ─── Private tmux server (parallel-safe) ─────────────────────────────────────
# Every scenario runs against its own tmux server, selected via `tmux -L`.
# This makes scenarios independent: kill-server in one cannot affect another,
# stray pi processes from one cannot poison another, and parallel runs
# trivially don't collide. The socket is namespaced by PID by default, but
# the batch dispatcher overrides it per-scenario so concurrent siblings each
# get a unique server. CRITICAL: every tmux invocation in this file MUST go
# through ${TMUX_CMD[@]}; a single bare `tmux` would target the user's
# default server and break parallel isolation.
: "${SCN_TMUX_SOCKET:=pi-scn-$$}"
TMUX_CMD=(tmux -L "$SCN_TMUX_SOCKET")

# Pi's interrupt key is Escape, not Ctrl-C. (See SKILL.md for full key table.)
PI_INTERRUPT_KEY="Escape"

# ─── Setup / teardown ────────────────────────────────────────────────────────

scn_setup() {
	local name="$1"
	export SESSION="pi-scn-${name}-$$"
	export BRIDGE_LOG="$OUT_DIR/${name}.bridge.log"
	export PANE_LOG="$OUT_DIR/${name}.pane.log"
	export SCN_DICT_PATH="$OUT_DIR/${name}.dictionary.json"
	export SCN_CACHE_DIR="$OUT_DIR/${name}.cache"
	export SCN_CONFIG_PATH="$OUT_DIR/${name}.config.json"

	# Pre-populate the per-scenario config file with `defaultMode: "on"` so the
	# engine pre-warms during extension load. This avoids racing the toggle
	# command's deferred-init callback against pi-coding-agent's ctx-staleness
	# guard (which fires when `/typos on` triggers a fresh init that resolves
	# AFTER the toggle handler's ctx has been invalidated). With a pre-warmed
	# engine, `/typos on` takes the synchronous "already ready" branch and the
	# init callbacks never run with a captured ctx.
	mkdir -p "$(dirname "$SCN_CONFIG_PATH")"
	cat > "$SCN_CONFIG_PATH" <<'JSON'
{
  "version": 1,
  "defaultMode": "on",
  "maxEditDistance": 2,
  "minWordLength": 2,
  "minEditDistance": 1,
  "editDistanceStepEvery": 4
}
JSON
	rm -f "$BRIDGE_LOG" "$PANE_LOG"
	scn_reset_dict
	# Honor user-set debug log path if explicitly given.
	if [[ -n "$SCN_PROVIDER_DEBUG_LOG" ]]; then
		BRIDGE_LOG="$SCN_PROVIDER_DEBUG_LOG"
	fi
	# Default opt-in: enable claude-bridge debug logs unless caller already set them.
	if [[ "$SCENARIO_PROVIDER" == "claude-bridge" ]]; then
		export CLAUDE_BRIDGE_DEBUG="${CLAUDE_BRIDGE_DEBUG:-1}"
		export CLAUDE_BRIDGE_DEBUG_PATH="${CLAUDE_BRIDGE_DEBUG_PATH:-$BRIDGE_LOG}"
	fi
}

scn_pi_start() {
	# Start pi in a fresh tmux session on this scenario's PRIVATE tmux server.
	# Caller can pass extra args; SCENARIO_PI_ARGS gives a stable per-project default.
	local extra_args="${SCENARIO_PI_ARGS}"
	if (( $# > 0 )); then extra_args="$extra_args $*"; fi

	scn_ensure_build

	# Align this scenario's tmux server with Pi's documented requirements so
	# Enter / Alt+Enter / completion keys are encoded distinctly. Each tmux
	# server keeps its own option state, so we set these on OUR server
	# (-L "$SCN_TMUX_SOCKET") rather than the user's default server.
	# `set-option -g` requires a running server; `start-server` (or any
	# command that touches the socket) brings one up cheaply.
	"${TMUX_CMD[@]}" start-server >/dev/null 2>&1 || true
	"${TMUX_CMD[@]}" set-option -g extended-keys on >/dev/null 2>&1 || true
	"${TMUX_CMD[@]}" set-option -g extended-keys-format csi-u >/dev/null 2>&1 || true

	local provider_env="MOBILE_AUTOCORRECT_DICT_PATH='$SCN_DICT_PATH' MOBILE_AUTOCORRECT_CACHE_DIR='$SCN_CACHE_DIR' MOBILE_AUTOCORRECT_CONFIG_PATH='$SCN_CONFIG_PATH'"
	if [[ "$SCENARIO_PROVIDER" == "claude-bridge" ]]; then
		provider_env="$provider_env CLAUDE_BRIDGE_DEBUG=1 CLAUDE_BRIDGE_DEBUG_PATH='$BRIDGE_LOG'"
	fi

	"${TMUX_CMD[@]}" new-session -d -s "$SESSION" -x 200 -y 50 \
		"cd '$SCENARIO_CWD' && $provider_env \
		 pi --provider '$SCENARIO_PROVIDER' --model '$SCENARIO_MODEL' $extra_args"

	# Readiness: poll the pane until pi has rendered its bottom-status
	# `(<provider>) <model>` marker rather than a fixed sleep. A fixed sleep
	# loses keystrokes when pi's startup is slow (tmux contention, opus boot)
	# — the tmux session exists but pi's input isn't focused yet, so
	# `tmux send-keys` fires into the void and the test silently hangs.
	# Symptom: bridge log only shows "provider: registered" with no fresh
	# query line.
	local deadline=$((SECONDS + 30))
	local ready_pat="\\(${SCENARIO_PROVIDER}\\)"
	while (( SECONDS < deadline )); do
		if "${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -100 2>/dev/null | grep -qE "$ready_pat"; then
			break
		fi
		sleep 0.5
	done
	# Settle the draw loop after the ready marker appears.
	sleep 1
}

scn_pi_stop() {
	# Tear down the entire private tmux server. Since the server is dedicated
	# to this scenario (per SCN_TMUX_SOCKET), kill-server cleanly disposes of
	# the session, the pi process inside it, and the server itself. No risk
	# to parallel siblings on different sockets, no risk to the user's
	# ambient default-socket tmux server.
	"${TMUX_CMD[@]}" kill-server 2>/dev/null || true
}

scn_pi_restart() {
	# Stop the running pi session, wait briefly for the socket to be reaped,
	# then start fresh. kill-server is fast; 1s settle is enough.
	scn_pi_stop
	sleep 1
	scn_pi_start "$@"
}

scn_wait_for_startup_ready() {
	# Pi may continue rendering startup widgets and package-update notices for a
	# few seconds. Wait until the pane content stabilizes before sending keys.
	local timeout="${SCN_STARTUP_TIMEOUT:-25}"
	local start=$SECONDS
	local last_checksum=""
	local stable_count=0
	while (( SECONDS - start < timeout )); do
		"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -400 > "$PANE_LOG" 2>/dev/null || true
		if grep -qE 'pi v|/ commands|claude-haiku-4-5|claude-opus|gpt-5\.4' "$PANE_LOG"; then
			local checksum
			checksum=$(cksum < "$PANE_LOG" | awk '{print $1":"$2}')
			if [[ "$checksum" == "$last_checksum" ]]; then
				stable_count=$((stable_count + 1))
			else
				stable_count=0
				last_checksum="$checksum"
			fi
			if (( stable_count >= 2 )); then
				return 0
			fi
		fi
		sleep 1
	done
	echo "WARN: proceeding before Pi startup fully stabilized" >&2
}

# ─── Input ───────────────────────────────────────────────────────────────────

scn_send() {
	# scn_send "<text>"
	# Sends text + Enter, then waits for the next-turn completion signal.
	# Pass --no-wait as the first arg to skip the wait (e.g. before a steer).
	#
	# Completion signal:
	#   - If SCN_PROVIDER_DEBUG_LOG is set OR claude-bridge is the provider:
	#     watch BRIDGE_LOG for new occurrences of SCN_COMPLETION_SIGNAL_REGEX.
	#   - Else: poll capture-pane until SCN_IDLE_REGEX is ABSENT (idle indicator).
	local wait_for_completion=1
	if [[ "${1:-}" == "--no-wait" ]]; then wait_for_completion=0; shift; fi

	local pre_count=0
	if [[ -f "$BRIDGE_LOG" ]]; then
		pre_count=$(scn_grep_count "$SCN_COMPLETION_SIGNAL_REGEX" "$BRIDGE_LOG")
	fi

	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "$1"
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" Enter

	(( wait_for_completion )) || return 0

	local timeout=120
	local start=$SECONDS
	# Phase 1: wait for Pi to START generating (idle marker must appear first).
	# This prevents false "completion" on turns that haven't begun yet.
	sleep 0.5
	local active_seen=0
	local phase1_start=$SECONDS
	while (( SECONDS - phase1_start < 10 )); do
		"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -200 > "$PANE_LOG" 2>/dev/null || true
		if grep -qE "$SCN_IDLE_REGEX" "$PANE_LOG" 2>/dev/null; then
			active_seen=1
			break
		fi
		# Also accept provider debug log signal as evidence generation started
		if [[ -f "$BRIDGE_LOG" ]] && [[ "$BRIDGE_LOG" != "/dev/null" ]]; then
			local cur
			cur=$(scn_grep_count "$SCN_COMPLETION_SIGNAL_REGEX" "$BRIDGE_LOG")
			if (( cur > pre_count )); then
				active_seen=1
				break
			fi
		fi
		sleep 0.2
	done

	# Phase 2: wait for completion (idle marker absent for ≥1s sustained).
	while (( SECONDS - start < timeout )); do
		# Strategy 1: provider debug log signal
		if [[ -f "$BRIDGE_LOG" ]] && [[ "$BRIDGE_LOG" != "/dev/null" ]]; then
			local cur
			cur=$(scn_grep_count "$SCN_COMPLETION_SIGNAL_REGEX" "$BRIDGE_LOG")
			if (( cur > pre_count )); then
				sleep 0.5
				return 0
			fi
		fi
		# Strategy 2: pane idle (idle-regex absent)
		"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -200 > "$PANE_LOG" 2>/dev/null || true
		if ! grep -qE "$SCN_IDLE_REGEX" "$PANE_LOG" 2>/dev/null; then
			# Once-idle confirmation: ensure it stays idle for 1s
			sleep 1
			"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -200 > "$PANE_LOG" 2>/dev/null || true
			if ! grep -qE "$SCN_IDLE_REGEX" "$PANE_LOG" 2>/dev/null; then
				return 0
			fi
		fi
		sleep 0.5
	done
	echo "WARN: scn_send timed out waiting for turn completion ('$1')" >&2
}

scn_send_no_enter() {
	# scn_send_no_enter "<text>"
	# Type text WITHOUT submitting. Use for pre-submit assertions
	# (extension transformations like autocorrect happen in the editor before Enter).
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" -- "$1"
}

scn_send_keys() {
	# scn_send_keys Escape   (raw tmux key names, no Enter appended)
	"${TMUX_CMD[@]}" send-keys -t "$SESSION:0" "$@"
}

# ─── Capture ─────────────────────────────────────────────────────────────────

scn_capture() {
	# Save the entire scrollback to PANE_LOG, then stream to stdout.
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
	cat "$PANE_LOG"
}

scn_wait_for() {
	# scn_wait_for "regex" [timeout_seconds]
	# Polls capture-pane until regex matches OR timeout.
	local pat="$1"
	local timeout="${2:-30}"
	local start=$SECONDS
	while ((SECONDS - start < timeout)); do
		"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG" 2>/dev/null || true
		if grep -qE "$pat" "$PANE_LOG"; then return 0; fi
		sleep 0.5
	done
	echo "TIMEOUT waiting for: $pat" >&2
	return 1
}

scn_wait_for_absent() {
	# scn_wait_for_absent "regex" [timeout_seconds]
	# Polls capture-pane until regex is GONE from the buffer (e.g. status flash cleared).
	local pat="$1"
	local timeout="${2:-5}"
	local start=$SECONDS
	while ((SECONDS - start < timeout)); do
		"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -200 > "$PANE_LOG" 2>/dev/null || true
		if ! grep -qE "$pat" "$PANE_LOG"; then return 0; fi
		sleep 0.2
	done
	echo "TIMEOUT waiting for absence of: $pat" >&2
	return 1
}

# ─── Assertions ──────────────────────────────────────────────────────────────

scn_pass() { echo "  PASS: $1"; }
scn_fail() { echo "  FAIL: $1"; SCN_FAILED=1; }

scn_assert_pane_contains() {
	# scn_assert_pane_contains "<regex>" "<descr>"
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
	if grep -qE -- "$1" "$PANE_LOG"; then
		scn_pass "$2"
	else
		scn_fail "$2 — pattern not in pane: $1"
	fi
}

scn_assert_pane_not_contains() {
	# scn_assert_pane_not_contains "<regex>" "<descr>"
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
	if grep -qE -- "$1" "$PANE_LOG"; then
		scn_fail "$2 — pattern unexpectedly in pane: $1"
	else
		scn_pass "$2"
	fi
}

scn_assert_file_contains() {
	# scn_assert_file_contains "<file>" "<regex>" "<descr>"
	if [[ ! -f "$1" ]]; then
		scn_fail "$3 — file does not exist: $1"
		return
	fi
	if grep -qE -- "$2" "$1"; then
		scn_pass "$3"
	else
		scn_fail "$3 — pattern not in file: $2 (file: $1)"
	fi
}

# Helper: count regex matches, sanitizing output to a single integer.
scn_grep_count() {
	# scn_grep_count "<regex>" "<file>"
	# grep -c returns 1 when no matches — under set -euo pipefail this would
	# abort. Combining with `| head | tr || echo 0` produces a double-emit
	# bug ("0\n0") because the partial "0" is already on stdout when the
	# `|| echo 0` fallback runs. Single-call form with `|| true` plus
	# `${n:-0}` avoids both pitfalls.
	local n
	n=$(grep -cE -- "$1" "$2" 2>/dev/null || true)
	echo "${n:-0}"
}

# Extract the model's response text after a specific user prompt by looking at
# the pane log for the prompt line, then capturing lines that follow until
# the next visual separator or a new prompt line.
scn_probe_response() {
	# scn_probe_response "<prompt-substring>"  -> writes response text to stdout
	local prompt_marker="$1"
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -3000 > "$PANE_LOG"
	awk -v pat="$prompt_marker" '
		BEGIN { capture = 0 }
		capture == 0 && index($0, pat) > 0 { buf = ""; capture = 1; next }
		capture && /^─{20,}/ { capture = 0 }
		capture { buf = buf "\n" $0 }
		END { print buf }
	' "$PANE_LOG"
}

scn_assert_response() {
	# scn_assert_response "<prompt-substring>" "<positive-regex>" "<negative-regex>" "<descr>"
	# A response must AFFIRM (positive matches) and NOT DENY (negative absent).
	# The negative is critical: without it, "I don't recall X" passes a "X" check.
	local prompt="$1"; shift
	local positive="$1"; shift
	local negative="$1"; shift
	local descr="$1"
	local resp
	resp=$(scn_probe_response "$prompt")
	if [[ -z "$resp" ]]; then
		scn_fail "$descr — no response captured for prompt"
		return
	fi
	if echo "$resp" | grep -qiE "$negative"; then
		scn_fail "$descr — model gave a NEGATIVE response: '$(echo "$resp" | grep -iE "$negative" | head -1 | tr -d '\n' | cut -c1-120)'"
		return
	fi
	if echo "$resp" | grep -qiE "$positive"; then
		scn_pass "$descr — model affirmed: '$(echo "$resp" | grep -iE "$positive" | head -1 | tr -d '\n' | cut -c1-120)'"
		return
	fi
	scn_fail "$descr — neither positive nor negative pattern matched"
}

# ─── Bridge-specific helpers (claude-bridge debug log) ───────────────────────
# Optional. Call from scenarios that explicitly test provider/bridge behavior.
# No-op (or empty output) when SCENARIO_PROVIDER != claude-bridge.

scn_cache_profile() {
	# Print (creation, read) tuple per usage line in the bridge log.
	[[ -f "$BRIDGE_LOG" ]] || { echo "  (no bridge log)"; return; }
	grep -E '"msg":"usage:' "$BRIDGE_LOG" 2>/dev/null | awk '{
		for (i = 1; i <= NF; i++) {
			if ($i ~ /^cacheRead=/)  { gsub(/^cacheRead=/,  "", $i); read = $i  }
			if ($i ~ /^cacheWrite=/) { gsub(/^cacheWrite=/, "", $i); write = $i }
		}
		printf "  creation=%s read=%s\n", write, read
	}'
}

scn_session_count() {
	# How many distinct CC session_ids did the bridge cache during this run?
	[[ -f "$BRIDGE_LOG" ]] || { echo 0; return; }
	grep -oE 'caching session=[a-f0-9]+' "$BRIDGE_LOG" 2>/dev/null \
		| sort -u | wc -l | tr -d ' \n' || echo 0
}

# ─── Project-specific mobile-autocorrect helpers ─────────────────────────────

scn_ensure_build() {
	local dist_file="$SCENARIO_CWD/dist/index.js"
	local needs_build=0

	if [[ ! -f "$dist_file" ]]; then
		needs_build=1
	elif find "$SCENARIO_CWD/src" "$SCENARIO_CWD/index.ts" -type f -newer "$dist_file" -print -quit | grep -q .; then
		needs_build=1
	fi

	if (( needs_build == 0 )); then
		return
	fi

	local start_ts=$SECONDS
	echo "Building extension before scenario run..."
	(
		cd "$SCENARIO_CWD"
		npm run build
	)
	local elapsed=$((SECONDS - start_ts))
	if (( elapsed > 5 )); then
		echo "WARN: npm run build took ${elapsed}s; first enable may still need dictionary load time." >&2
	fi
}

scn_reset_dict() {
	mkdir -p "$(dirname "$SCN_DICT_PATH")"
	cat > "$SCN_DICT_PATH" <<'JSON'
{
  "version": 1,
  "words": {},
  "pendingRejections": {}
}
JSON
}

scn_seed_dict_from_stdin() {
	mkdir -p "$(dirname "$SCN_DICT_PATH")"
	cat > "$SCN_DICT_PATH"
}

scn_submit_typos_toggle() {
	scn_send_no_enter "/typos"
	scn_send_keys Enter
}

scn_submit_typos_explicit_state() {
	# `/typos on` / `/typos off` only dispatch reliably when the completed command
	# line includes a trailing space and Pi receives two Enters: the first accepts
	# the slash-command line, the second executes it.
	local state="$1"
	scn_send_no_enter "/typos $state "
	sleep 0.5
	scn_send_keys Enter Enter
}

scn_submit_typos_on() {
	# Bare `/typos` toggles. If the current state was off we get ON; if it was on
	# we get OFF and need to toggle again to reach ON.
	scn_submit_typos_toggle
	if scn_wait_for "Autocorrect ON" 10; then
		return 0
	fi
	# We toggled from on -> off; flip back to on.
	scn_submit_typos_toggle
	scn_wait_for "Autocorrect ON" 10 || scn_fail "Failed to enable autocorrect"
}

scn_submit_typos_off() {
	# Bare `/typos` toggles. If the current state was on we get OFF; if it was off
	# we get ON and need to toggle again to reach OFF.
	scn_submit_typos_toggle
	if scn_wait_for "Autocorrect OFF" 10; then
		return 0
	fi
	# We toggled from off -> on; flip back to off.
	scn_submit_typos_toggle
	scn_wait_for "Autocorrect OFF" 10 || scn_fail "Failed to disable autocorrect"
}

scn_submit_typos_dict() {
	# Pi's slash-command palette interferes with inline arguments.
	# Strategy depends on the subcommand:
	#   - Bare "dict" (no args): the first Enter applies the /typos argument
	#     completion "dict"; a second Enter submits the command.
	#   - Subcommands with args (add, remove, search) or "clear": append a
	#     trailing space to force the autocomplete to cancel (no matching prefix),
	#     then submit with a single Enter.
	local tail="${1:-}"
	local cmd="/typos dict"
	if [[ -n "$tail" ]]; then
		cmd="$cmd $tail"
	fi

	if [[ -z "$tail" ]]; then
		# Bare /typos dict — double Enter
		scn_send_no_enter "$cmd"
		sleep 0.5
		scn_send_keys Enter Enter
		sleep 0.3
	else
		# Subcommand with args — trailing space cancels autocomplete, single Enter
		cmd="$cmd "
		scn_send_no_enter "$cmd"
		sleep 0.5
		scn_send_keys Enter
	fi
}

scn_submit_typos_config() {
	# scn_submit_typos_config <key> <value>
	# Submit /typos config <key> <value>. Appends trailing space to cancel Pi's
	# slash-command autocomplete, then double-Enter to execute (same pattern as
	# scn_submit_typos_explicit_state).
	local key="$1"
	local value="$2"
	scn_send_no_enter "/typos config $key $value "
	sleep 0.5
	scn_send_keys Enter Enter
	sleep 0.3
}

scn_enable_autocorrect() {
	local timeout="${1:-15}"
	scn_submit_typos_explicit_state on
	scn_wait_for "Autocorrect ON|Autocorrect is already on" "$timeout" || scn_fail "Autocorrect ON notification missing"
}

scn_disable_autocorrect() {
	local timeout="${1:-5}"
	scn_submit_typos_explicit_state off
	scn_wait_for "Autocorrect OFF|Autocorrect is already off" "$timeout" || scn_fail "Autocorrect OFF notification missing"
}

scn_clear_editor() {
	# Avoid Ctrl-C here: in Pi it doubles as clear/exit and proved flaky in batch runs.
	# Also avoid Backspace: corrected words treat it as an explicit undo, which changes
	# learned-dictionary state and suppresses later corrections in the same position.
	# Home + Delete clears the draft without exercising undo semantics.
	local editor_text
	editor_text=$(scn_editor_text_normalized)
	if [[ -z "$editor_text" ]]; then
		return 0
	fi

	local char_count
	char_count=$(printf '%s' "$editor_text" | python3 -c 'import sys; print(sum(1 for ch in sys.stdin.read() if ch not in "\n\r"))')
	local total=$((char_count + 1))
	local keys=(Home)
	for ((i = 0; i < total; i += 1)); do
		keys+=(Delete)
	done
	scn_send_keys "${keys[@]}"
	sleep 0.2
}

scn_type_and_settle() {
	scn_send_no_enter "$1"
	sleep "${2:-0.3}"
}

scn_assert_pane_count_at_most() {
	# scn_assert_pane_count_at_most "<regex>" <max> "<descr>"
	local pattern="$1"
	local max="$2"
	local descr="$3"
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
	local count
	count=$(scn_grep_count "$pattern" "$PANE_LOG")
	if (( count <= max )); then
		scn_pass "$descr"
	else
		scn_fail "$descr — found $count matches for pattern: $pattern"
	fi
}

scn_editor_text_normalized() {
	# Extract the last editor block between Pi's horizontal separators and return it verbatim.
	"${TMUX_CMD[@]}" capture-pane -t "$SESSION:0" -p -S -2000 > "$PANE_LOG"
	python3 - "$PANE_LOG" <<'PY'
import re
import sys
from pathlib import Path

lines = Path(sys.argv[1]).read_text().splitlines()
blocks = []
current = []
in_block = False
for line in lines:
    if re.match(r'^─{20,}$', line):
        if in_block:
            blocks.append(current)
            current = []
        in_block = True
        continue
    if in_block:
        current.append(line)
if current:
    blocks.append(current)

candidate = ""
for block in reversed(blocks):
    text = "\n".join(block).strip("\n")
    if not text.strip():
        continue
    if any(marker in text for marker in ("~/", "MCP:", "%/200k", "Claude │", "claude-haiku-4-5")):
        continue
    candidate = text
    break
if not candidate:
    for block in reversed(blocks):
        text = "\n".join(block).strip("\n")
        if text.strip():
            candidate = text
            break

print(candidate)
PY
}

scn_assert_editor_contains() {
	local pattern="$1"
	local descr="$2"
	local editor_text
	editor_text=$(scn_editor_text_normalized)
	if printf '%s\n' "$editor_text" | grep -qE -- "$pattern"; then
		scn_pass "$descr"
	else
		scn_fail "$descr — pattern not in normalized editor text: $pattern"
	fi
}

scn_assert_editor_not_contains() {
	local pattern="$1"
	local descr="$2"
	local editor_text
	editor_text=$(scn_editor_text_normalized)
	if printf '%s\n' "$editor_text" | grep -qE -- "$pattern"; then
		scn_fail "$descr — pattern unexpectedly in normalized editor text: $pattern"
	else
		scn_pass "$descr"
	fi
}

# Each scenario script begins with `SCN_FAILED=0` and ends with
# `exit $SCN_FAILED`. scn_pass/scn_fail collect into that.
