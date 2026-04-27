/**
 * API verification probe for mobile-autocorrect task 4.7.
 *
 * Run with:
 *   pi -e ./probe.ts
 *
 * Then interact in Pi:
 * - Wait for the startup autoswap (5s) while typing to probe editor replacement during active typing.
 * - Press Ctrl+G to toggle between the default editor and the probe editor without submitting the current draft.
 * - Paste single-line and multi-line text.
 * - Press Backspace, arrow keys, Tab, Enter, Alt+Backspace, etc.
 * - Type a word plus trailing space (for example `teh `), then run `/probe replace the` and press undo/backspace to inspect programmatic replace undo semantics.
 * - Optional helper commands:
 *   - /probe autoswap 1500
 *   - /probe on
 *   - /probe off
 *   - /probe replace the
 *   - /probe notify-long
 *   - /probe confirm
 *
 * Findings are logged to ~/.pi/agent/typos-probe.log and echoed to stdout.
 *
 * Note: this file intentionally uses `export default async function` so loading it also
 * live-probes the extension entrypoint async contract.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionCommandContext, type ExtensionUIContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, parseKey } from "@mariozechner/pi-tui";

const LOG_PATH = path.join(os.homedir(), ".pi", "agent", "typos-probe.log");
const STATUS_KEY = "typos-probe";

type TimerHandle = ReturnType<typeof setTimeout>;

type ProbeState = {
	ui?: ExtensionUIContext;
	installed: boolean;
	editorGeneration: number;
	autoswapTimer?: TimerHandle;
	inputUnsubscribe?: () => void;
	activeEditor?: ProbeEditor;
};

const state: ProbeState = {
	installed: false,
	editorGeneration: 0,
};

class Logger {
	private queue: Promise<void> = Promise.resolve();

	async init(): Promise<void> {
		await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
		await this.log("=== probe session start ===");
	}

	log(message: string): Promise<void> {
		this.queue = this.queue
			.then(async () => {
				const line = `[${new Date().toISOString()}] ${message}`;
				console.log(`[probe] ${line}`);
				await fs.appendFile(LOG_PATH, `${line}\n`, "utf8");
			})
			.catch(async (error) => {
				console.error("[probe] log failure", error);
				try {
					await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
					await fs.appendFile(LOG_PATH, `[${new Date().toISOString()}] logger recovery after error: ${String(error)}\n`, "utf8");
				} catch {
					// Ignore secondary logging failures.
				}
			});
		return this.queue;
	}
}

const logger = new Logger();

function clip(value: string, max = 80): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max)}…`;
}

function tail(value: string, max = 80): string {
	if (value.length <= max) return value;
	return `…${value.slice(-max)}`;
}

function describeInput(data: string): string {
	const key = parseKey(data) ?? "null";
	const codeUnits = Array.from(data, (char) => `0x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
	return `parseKey=${key} len=${data.length} json=${JSON.stringify(data)} codeUnits=[${codeUnits.join(", ")}]`;
}

class ProbeEditor extends CustomEditor {
	private readonly label: string;
	private readonly log: (message: string) => Promise<void>;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		label: string,
		log: (message: string) => Promise<void>,
	) {
		super(tui, theme, keybindings);
		this.label = label;
		this.log = log;
		state.activeEditor = this;
		queueMicrotask(() => {
			void this.log(
				`editor-mounted label=${this.label} textLen=${this.getText().length} cursor=${JSON.stringify(this.getCursor())} textTail=${JSON.stringify(tail(this.getText()))}`,
			);
		});
	}

	replaceWordBeforeCursor(replacement: string): { original: string; trigger: string } | null {
		const cursor = this.getCursor();
		const lineText = this.getLines()[cursor.line] ?? "";
		const beforeCursor = lineText.slice(0, cursor.col);
		const match = beforeCursor.match(/([A-Za-z]+)([ .,;:!?])$/);
		if (!match) {
			void this.log(
				`probe-replace-skip label=${this.label} cursor=${cursor.line}:${cursor.col} beforeCursor=${JSON.stringify(clip(beforeCursor))}`,
			);
			return null;
		}

		const [, original, trigger] = match;
		void this.log(
			`probe-replace-start label=${this.label} original=${JSON.stringify(original)} replacement=${JSON.stringify(replacement)} trigger=${JSON.stringify(trigger)} cursor=${cursor.line}:${cursor.col}`,
		);
		for (let index = 0; index < original.length + trigger.length; index += 1) {
			super.handleInput("\x7f");
		}
		this.insertTextAtCursor(`${replacement}${trigger}`);
		void this.log(
			`probe-replace-complete label=${this.label} textLen=${this.getText().length} cursor=${JSON.stringify(this.getCursor())} textTail=${JSON.stringify(tail(this.getText()))}`,
		);
		return { original, trigger };
	}

	override handleInput(data: string): void {
		const beforeCursor = this.getCursor();
		const beforeText = this.getText();
		void this.log(
			`handleInput-before label=${this.label} cursor=${beforeCursor.line}:${beforeCursor.col} autocomplete=${this.isShowingAutocomplete()} textLen=${beforeText.length} textTail=${JSON.stringify(tail(beforeText))} ${describeInput(data)}`,
		);
		super.handleInput(data);
		const afterCursor = this.getCursor();
		const afterText = this.getText();
		void this.log(
			`handleInput-after label=${this.label} cursor=${afterCursor.line}:${afterCursor.col} autocomplete=${this.isShowingAutocomplete()} textLen=${afterText.length} textTail=${JSON.stringify(tail(afterText))} ${describeInput(data)}`,
		);
	}
}

function requireUi(ctx?: ExtensionCommandContext): ExtensionUIContext {
	const ui = ctx?.ui ?? state.ui;
	if (!ui) {
		throw new Error("UI context is not available yet. Wait for session_start before using the probe.");
	}
	state.ui = ui;
	return ui;
}

function clearAutoswap(): void {
	if (state.autoswapTimer) {
		clearTimeout(state.autoswapTimer);
		state.autoswapTimer = undefined;
	}
}

async function installProbeEditor(reason: string, ctx?: ExtensionCommandContext): Promise<void> {
	const ui = requireUi(ctx);
	const beforeText = ui.getEditorText();
	state.editorGeneration += 1;
	const label = `probe-${state.editorGeneration}`;
	await logger.log(
		`installProbeEditor reason=${reason} beforeLen=${beforeText.length} beforeTail=${JSON.stringify(tail(beforeText))} installed=${state.installed}`,
	);
	ui.setEditorComponent((tui, theme, keybindings) => new ProbeEditor(tui, theme, keybindings, label, (message) => logger.log(message)));
	state.installed = true;
	const afterText = ui.getEditorText();
	await logger.log(
		`installProbeEditor-complete reason=${reason} afterLen=${afterText.length} afterTail=${JSON.stringify(tail(afterText))} installed=${state.installed}`,
	);
	ui.setStatus(STATUS_KEY, `Probe editor active (${label})`);
	ui.notify(`Probe editor ON (${reason}). Press Ctrl+G to toggle without submitting the draft.`, "info");
}

async function restoreDefaultEditor(reason: string, ctx?: ExtensionCommandContext): Promise<void> {
	const ui = requireUi(ctx);
	const beforeText = ui.getEditorText();
	await logger.log(
		`restoreDefaultEditor reason=${reason} beforeLen=${beforeText.length} beforeTail=${JSON.stringify(tail(beforeText))} installed=${state.installed}`,
	);
	ui.setEditorComponent(undefined);
	state.installed = false;
	state.activeEditor = undefined;
	const afterText = ui.getEditorText();
	await logger.log(
		`restoreDefaultEditor-complete reason=${reason} afterLen=${afterText.length} afterTail=${JSON.stringify(tail(afterText))} installed=${state.installed}`,
	);
	ui.setStatus(STATUS_KEY, undefined);
	ui.notify(`Probe editor OFF (${reason}). Press Ctrl+G to toggle without submitting the draft.`, "info");
}

async function toggleEditor(reason: string, ctx?: ExtensionCommandContext): Promise<void> {
	clearAutoswap();
	if (state.installed) {
		await restoreDefaultEditor(reason, ctx);
	} else {
		await installProbeEditor(reason, ctx);
	}
}

async function scheduleAutoswap(ms: number, reason: string, ctx?: ExtensionCommandContext): Promise<void> {
	const ui = requireUi(ctx);
	clearAutoswap();
	await logger.log(`scheduleAutoswap ms=${ms} reason=${reason} installed=${state.installed}`);
	state.autoswapTimer = setTimeout(() => {
		void toggleEditor(`autoswap:${reason}`);
	}, ms);
	ui.notify(`Probe autoswap scheduled in ${ms}ms (${reason}). Start typing now and watch what survives the swap.`, "info");
}

async function showLongNotify(ctx: ExtensionCommandContext): Promise<void> {
	const lines = Array.from({ length: 60 }, (_, index) => `${String(index + 1).padStart(2, "0")}  /typos dict probe line ${index + 1}`);
	const message = [
		"Probe notify-long output:",
		"This checks ctx.ui.notify() multiline suitability.",
		...lines,
	].join("\n");
	ctx.ui.notify(message, "info");
	await logger.log(`notify-long lines=${lines.length + 2}`);
}

async function runProgrammaticReplace(ctx: ExtensionCommandContext, replacement: string): Promise<void> {
	if (!state.installed || !state.activeEditor) {
		ctx.ui.notify("Turn the probe editor on first (`/probe on` or Ctrl+G).", "warning");
		await logger.log(`probe-replace-rejected reason=no-active-editor replacement=${JSON.stringify(replacement)}`);
		return;
	}

	const result = state.activeEditor.replaceWordBeforeCursor(replacement);
	if (!result) {
		ctx.ui.notify("Place the cursor after a word plus trailing space/punctuation (for example `teh `) before running `/probe replace`.", "warning");
		return;
	}

	ctx.ui.notify(
		`Programmatic replace applied: ${result.original}${result.trigger} → ${replacement}${result.trigger}. Now press undo/backspace and inspect the result/log.`,
		"info",
	);
}

async function runConfirm(ctx: ExtensionCommandContext): Promise<void> {
	await logger.log("confirm-start");
	const result = await ctx.ui.confirm(
		"Probe confirm",
		"If this dialog appeared, ctx.ui.confirm() exists and is async. Choose Yes or No; the result is logged.",
	);
	await logger.log(`confirm-result value=${result}`);
	ctx.ui.notify(`Probe confirm result: ${result}`, "info");
}

function buildHelpText(): string {
	return [
		"mobile-autocorrect API probe ready.",
		`Log file: ${LOG_PATH}`,
		"",
		"Controls:",
		"- Ctrl+G toggles ProbeEditor/default editor without submitting the draft.",
		"- Startup also schedules an autoswap in 5000ms so you can type during the swap.",
		"",
		"Commands:",
		"- /probe autoswap 1500",
		"- /probe on",
		"- /probe off",
		"- /probe replace the",
		"- /probe notify-long",
		"- /probe confirm",
		"",
		"Suggested live checks:",
		"1. Type draft text, move cursor into the middle, then press Ctrl+G.",
		"2. While ProbeEditor is active, press Backspace, arrows, Enter, Tab, Alt+Backspace.",
		"3. Paste single-line and multi-line text; note whether logs show bracketed paste markers.",
		"4. Type `teh `, run `/probe replace the`, then press undo/backspace to inspect programmatic replace undo semantics.",
		"5. Run /probe autoswap 1500 and keep typing through the swap.",
	].join("\n");
}

export default async function probe(api: ExtensionAPI): Promise<void> {
	await logger.init();
	await logger.log("extension-factory-loaded asyncDefault=true");

	api.registerCommand("probe", {
		description: "Run live API probe helpers for mobile-autocorrect task 4.7",
		getArgumentCompletions: async (argumentPrefix) => {
			const subcommands = ["autoswap", "on", "off", "replace", "notify-long", "confirm", "help"];
			const trimmed = argumentPrefix.trimStart();
			if (trimmed.length === 0) {
				return subcommands.map((value) => ({ value }));
			}
			if (trimmed.startsWith("autoswap ")) {
				return ["500", "1500", "5000"].map((value) => ({ value: `autoswap ${value}` }));
			}
			if (trimmed.startsWith("replace ")) {
				return ["the", "and", "fix"].map((value) => ({ value: `replace ${value}` }));
			}
			return subcommands.filter((value) => value.startsWith(trimmed)).map((value) => ({ value }));
		},
		handler: async (args, ctx) => {
			state.ui = ctx.ui;
			const [subcommand = "help", rawValue] = args.trim().split(/\s+/, 2).filter(Boolean);
			switch (subcommand) {
				case "on":
					await installProbeEditor("/probe on", ctx);
					break;
				case "off":
					await restoreDefaultEditor("/probe off", ctx);
					break;
				case "autoswap": {
					const ms = Number.parseInt(rawValue ?? "1500", 10);
					if (!Number.isFinite(ms) || ms < 0) {
						ctx.ui.notify("Usage: /probe autoswap <milliseconds>", "error");
						return;
					}
					await scheduleAutoswap(ms, "/probe autoswap", ctx);
					break;
				}
				case "replace":
					await runProgrammaticReplace(ctx, rawValue ?? "the");
					break;
				case "notify-long":
					await showLongNotify(ctx);
					break;
				case "confirm":
					await runConfirm(ctx);
					break;
				case "help":
				default:
					ctx.ui.notify(buildHelpText(), "info");
					await logger.log(`help-shown subcommand=${JSON.stringify(subcommand)}`);
					break;
			}
		},
	});

	api.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) {
			await logger.log("session_start no-ui");
			return;
		}
		state.ui = ctx.ui;
		state.inputUnsubscribe?.();
		state.inputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (matchesKey(data, "ctrl+g")) {
				void logger.log(`terminal-toggle ${describeInput(data)}`);
				void toggleEditor("ctrl+g");
				return { consume: true };
			}
			return undefined;
		});
		await logger.log(`session_start cwd=${ctx.cwd} hasUI=${ctx.hasUI}`);
		ctx.ui.notify(buildHelpText(), "info");
		await scheduleAutoswap(5000, "session_start", ctx);
	});

	api.on("session_shutdown", async () => {
		clearAutoswap();
		state.inputUnsubscribe?.();
		state.inputUnsubscribe = undefined;
		await logger.log("session_shutdown");
	});
}
