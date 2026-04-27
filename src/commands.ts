import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { AutocorrectEditor } from "./autocorrect-editor.js";
import {
  MAX_EDIT_DISTANCE_RANGE,
  MIN_WORD_LENGTH_RANGE,
  type Config,
  type DefaultMode,
} from "./config.js";
import { CorrectionEngine, type CorrectionEngineOptions } from "./correction-engine.js";
import type { LearnedDictionary } from "./learned-dictionary.js";

const TOP_LEVEL_COMMANDS = ["on", "off", "dict", "default", "config"] as const;
const DICTIONARY_SUBCOMMANDS = ["add", "remove", "search", "clear"] as const;
const DEFAULT_SUBCOMMANDS = ["on", "off"] as const;
const CONFIG_KEYS = ["defaultMode", "maxEditDistance", "minWordLength"] as const;
const DICTIONARY_WORD_PATTERN = /^[A-Za-z]+$/;
const MAX_DICTIONARY_RESULTS = 50;
const DICTIONARY_USAGE = "Usage: /typos dict [search <term>|add <word>|remove <word>|clear]";
const DEFAULT_USAGE = "Usage: /typos default [on|off]";
const CONFIG_USAGE = `Usage: /typos config [${CONFIG_KEYS.join("|")}] [<value>]`;
const TOP_LEVEL_USAGE = "Unknown command. Usage: /typos [on|off|dict ...|default ...|config ...]";

type ConfigKey = (typeof CONFIG_KEYS)[number];

/**
 * Subset of {@link ExtensionContext} actually used by the typos command.
 * Both `ExtensionCommandContext` (passed to `registerCommand` handlers) and
 * `ExtensionContext` (passed to `pi.on("session_start", ...)` handlers) satisfy
 * this — letting `applyDefaultMode` reuse the same enable/disable plumbing
 * from a session-start hook.
 */
export type TyposCommandContext = Pick<ExtensionContext, "ui">;
const EMPTY_DICTIONARY_MESSAGE =
  "No words in dictionary yet. Words are learned when you reject a correction by pressing backspace within 1 character of the correction.";

export type TyposCommandState = {
  enabled: boolean;
  engine?: CorrectionEngine;
  toggleInFlight?: Promise<void>;
};

export type CreateTyposCommandOptions = {
  learnedDictionary: LearnedDictionary;
  techDictPath: string;
  config: Config;
  createCorrectionEngine?: (options: CorrectionEngineOptions) => CorrectionEngine;
  createAutocorrectEditor?: (...args: ConstructorParameters<typeof AutocorrectEditor>) => AutocorrectEditor;
};

type ScheduledAction = "enable" | "disable" | "toggle";

export function createTyposCommand({
  learnedDictionary,
  techDictPath,
  config,
  createCorrectionEngine = (options) => new CorrectionEngine(options),
  createAutocorrectEditor = (...args) => new AutocorrectEditor(...args),
}: CreateTyposCommandOptions): {
  state: TyposCommandState;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  getArgumentCompletions: (argumentPrefix: string) => AutocompleteItem[] | null;
  /**
   * Reconcile session state with the configured default mode. Intended to be
   * called from a `session_start` event handler. Silent no-op when already in
   * the desired state; otherwise transitions through the same
   * enable/disable path as a user-issued `/typos on|off`.
   */
  applyDefaultMode: (ctx: TyposCommandContext) => Promise<void>;
} {
  const state: TyposCommandState = {
    enabled: false,
  };

  let inFlightAction: ScheduledAction | undefined;
  let inFlightToken: symbol | undefined;
  let queuedTailAction: ScheduledAction | undefined;

  async function handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const trimmedArgs = args.trim();

    if (trimmedArgs.length === 0) {
      await scheduleToggle(ctx, "toggle");
      return;
    }

    if (trimmedArgs === "on") {
      await requestExplicitToggle(ctx, true);
      return;
    }

    if (trimmedArgs === "off") {
      await requestExplicitToggle(ctx, false);
      return;
    }

    if (trimmedArgs === "dict") {
      showBareDict(ctx, learnedDictionary);
      return;
    }

    if (trimmedArgs.startsWith("dict ")) {
      await handleDictionaryCommand(ctx, trimmedArgs.slice(5));
      return;
    }

    if (trimmedArgs === "default") {
      showDefaultMode(ctx);
      return;
    }

    if (trimmedArgs.startsWith("default ")) {
      await handleDefaultModeCommand(ctx, trimmedArgs.slice(8));
      return;
    }

    if (trimmedArgs === "config") {
      showAllConfig(ctx);
      return;
    }

    if (trimmedArgs.startsWith("config ")) {
      await handleConfigCommand(ctx, trimmedArgs.slice(7));
      return;
    }

    ctx.ui.notify(TOP_LEVEL_USAGE, "warning");
  }

  function getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
    const prefix = argumentPrefix.trimStart();

    if (!prefix.includes(" ")) {
      return buildCompletions(TOP_LEVEL_COMMANDS, prefix);
    }

    if (prefix.startsWith("dict ")) {
      const dictPrefix = prefix.slice(5).trimStart();
      if (dictPrefix.includes(" ")) {
        return null;
      }
      return buildSubcommandCompletions("dict", DICTIONARY_SUBCOMMANDS, dictPrefix);
    }

    if (prefix.startsWith("default ")) {
      const defaultPrefix = prefix.slice(8).trimStart();
      if (defaultPrefix.includes(" ")) {
        return null;
      }
      return buildSubcommandCompletions("default", DEFAULT_SUBCOMMANDS, defaultPrefix);
    }

    if (prefix.startsWith("config ")) {
      const configRest = prefix.slice(7).trimStart();
      const spaceAt = configRest.indexOf(" ");

      // Second token: completing the config key.
      if (spaceAt === -1) {
        return buildSubcommandCompletions("config", CONFIG_KEYS, configRest);
      }

      // Third token: completing the value for a known key.
      const key = configRest.slice(0, spaceAt);
      const valuePrefix = configRest.slice(spaceAt + 1).trimStart();
      if (valuePrefix.includes(" ")) {
        return null;
      }
      const valueChoices = configValueChoices(key);
      if (!valueChoices) {
        return null;
      }
      return buildKeyValueCompletions("config", key, valueChoices, valuePrefix);
    }

    return null;
  }

  async function requestExplicitToggle(ctx: TyposCommandContext, enabled: boolean): Promise<void> {
    const requestedAction = enabled ? "enable" : "disable";

    if (state.toggleInFlight && queuedTailAction === requestedAction) {
      await state.toggleInFlight;
      return;
    }

    await scheduleToggle(ctx, requestedAction);
  }

  async function scheduleToggle(ctx: TyposCommandContext, action: ScheduledAction): Promise<void> {
    const previous = state.toggleInFlight ?? Promise.resolve();
    const token = Symbol(action);

    queuedTailAction = action;

    const current = previous.catch(() => undefined).then(async () => {
      inFlightAction = action;
      inFlightToken = token;

      try {
        if (action === "toggle") {
          if (state.enabled) {
            await disable(ctx);
          } else {
            await enable(ctx);
          }
          return;
        }

        if (action === "enable") {
          await enable(ctx);
          return;
        }

        await disable(ctx);
      } finally {
        if (inFlightToken === token) {
          inFlightAction = undefined;
          inFlightToken = undefined;
        }
      }
    });

    let tracked!: Promise<void>;
    tracked = current.finally(() => {
      if (state.toggleInFlight === tracked) {
        state.toggleInFlight = undefined;
        queuedTailAction = undefined;
      }
    });

    state.toggleInFlight = tracked;
    await tracked;
  }

  async function enable(ctx: TyposCommandContext): Promise<void> {
    if (state.enabled) {
      ctx.ui.notify("Autocorrect is already on", "info");
      return;
    }

    if (!state.engine) {
      ctx.ui.setStatus("typos-loading", "Loading autocorrect...");

      try {
        const engine = createCorrectionEngine({
          techDictPath,
          isLearned: (word) => learnedDictionary.has(word),
          maxEditDistance: config.getMaxEditDistance(),
          getMinWordLength: () => config.getMinWordLength(),
        });

        await engine.initialize();
        state.engine = engine;
      } catch (error) {
        ctx.ui.notify(`Autocorrect failed to initialize: ${formatError(error)}`, "error");
        return;
      } finally {
        ctx.ui.setStatus("typos-loading", undefined);
      }
    }

    state.enabled = true;
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      createAutocorrectEditor(tui, theme, keybindings, {
        correctionEngine: state.engine!,
        learnedDictionary,
        uiAdapter: {
          setStatus: (key, value) => ctx.ui.setStatus(key, value),
          notify: (message, level) => ctx.ui.notify(message, level),
        },
      }),
    );
    ctx.ui.setStatus("typos", "✓ Autocorrect");
    ctx.ui.notify("Autocorrect ON", "info");
  }

  async function disable(ctx: TyposCommandContext): Promise<void> {
    if (!state.enabled) {
      ctx.ui.notify("Autocorrect is already off", "info");
      return;
    }

    state.enabled = false;
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setStatus("typos", undefined);
    ctx.ui.notify("Autocorrect OFF", "info");
  }

  async function applyDefaultMode(ctx: TyposCommandContext): Promise<void> {
    if (state.toggleInFlight) {
      try {
        await state.toggleInFlight;
      } catch {
        // Prior toggle failed; we still want to attempt reconciliation.
      }
    }

    const desired = config.getDefaultMode();

    // The configured `defaultMode` is the single source of truth for new
    // sessions and replaces the prior hardcoded "always off" default. The
    // config field's own bootstrap value is "off", so unconfigured users
    // see no behavior change. When the user sets it to "on", session_start
    // reconciles to enabled; flipping it back to "off" reconciles to
    // disabled. Already-in-state cases are silent no-ops to avoid spamming
    // "already on/off" toasts during session switches.
    if (desired === "on" && !state.enabled) {
      await scheduleToggle(ctx, "enable");
      return;
    }

    if (desired === "off" && state.enabled) {
      await scheduleToggle(ctx, "disable");
    }
  }

  function showDefaultMode(ctx: TyposCommandContext): void {
    const mode = config.getDefaultMode();
    ctx.ui.notify(`Default mode for new sessions: ${mode}`, "info");
  }

  async function handleDefaultModeCommand(ctx: TyposCommandContext, rawArgs: string): Promise<void> {
    const trimmed = rawArgs.trim();

    if (trimmed.length === 0) {
      showDefaultMode(ctx);
      return;
    }

    if (!isDefaultMode(trimmed)) {
      ctx.ui.notify(DEFAULT_USAGE, "warning");
      return;
    }

    const previous = config.getDefaultMode();
    if (previous === trimmed) {
      ctx.ui.notify(`Default mode is already ${trimmed}`, "info");
      return;
    }

    try {
      await config.setDefaultMode(trimmed);
    } catch (error) {
      ctx.ui.notify(`Failed to save default mode: ${formatError(error)}`, "error");
      return;
    }

    ctx.ui.notify(`Default mode for new sessions set to ${trimmed}`, "info");
  }

  function showAllConfig(ctx: TyposCommandContext): void {
    const lines = [
      `defaultMode      ${config.getDefaultMode()}`,
      `maxEditDistance  ${config.getMaxEditDistance()}  (range ${MAX_EDIT_DISTANCE_RANGE.min}-${MAX_EDIT_DISTANCE_RANGE.max})`,
      `minWordLength    ${config.getMinWordLength()}  (range ${MIN_WORD_LENGTH_RANGE.min}-${MIN_WORD_LENGTH_RANGE.max})`,
    ];
    ctx.ui.notify(`Mobile autocorrect config:\n${lines.join("\n")}`, "info");
  }

  async function handleConfigCommand(ctx: TyposCommandContext, rawArgs: string): Promise<void> {
    const trimmed = rawArgs.trim();
    if (trimmed.length === 0) {
      showAllConfig(ctx);
      return;
    }

    const firstSpace = trimmed.indexOf(" ");
    const key = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)) as ConfigKey;
    const remainder = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

    if (!isConfigKey(key)) {
      ctx.ui.notify(CONFIG_USAGE, "warning");
      return;
    }

    if (remainder.length === 0) {
      showSingleConfig(ctx, key);
      return;
    }

    if (key === "defaultMode") {
      // Reuse the validated path so /typos config defaultMode <v> stays in
      // lock-step with /typos default <v>.
      await handleDefaultModeCommand(ctx, remainder);
      return;
    }

    if (key === "maxEditDistance") {
      await handleSetMaxEditDistance(ctx, remainder);
      return;
    }

    if (key === "minWordLength") {
      await handleSetMinWordLength(ctx, remainder);
      return;
    }
  }

  function showSingleConfig(ctx: TyposCommandContext, key: ConfigKey): void {
    switch (key) {
      case "defaultMode":
        ctx.ui.notify(`defaultMode = ${config.getDefaultMode()}`, "info");
        return;
      case "maxEditDistance":
        ctx.ui.notify(
          `maxEditDistance = ${config.getMaxEditDistance()} (range ${MAX_EDIT_DISTANCE_RANGE.min}-${MAX_EDIT_DISTANCE_RANGE.max})`,
          "info",
        );
        return;
      case "minWordLength":
        ctx.ui.notify(
          `minWordLength = ${config.getMinWordLength()} (range ${MIN_WORD_LENGTH_RANGE.min}-${MIN_WORD_LENGTH_RANGE.max})`,
          "info",
        );
        return;
    }
  }

  async function handleSetMaxEditDistance(ctx: TyposCommandContext, raw: string): Promise<void> {
    const value = parseIntInRange(raw, MAX_EDIT_DISTANCE_RANGE);
    if (value === undefined) {
      ctx.ui.notify(
        `Usage: /typos config maxEditDistance <integer ${MAX_EDIT_DISTANCE_RANGE.min}-${MAX_EDIT_DISTANCE_RANGE.max}>`,
        "warning",
      );
      return;
    }

    if (config.getMaxEditDistance() === value) {
      ctx.ui.notify(`maxEditDistance is already ${value}`, "info");
      return;
    }

    try {
      await config.setMaxEditDistance(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save maxEditDistance: ${formatError(error)}`, "error");
      return;
    }

    // maxEditDistance is baked into the SymSpell index at initialize().
    // Drop the cached engine so the next enable() rebuilds with the new
    // value. If autocorrect is currently running, tear it down and bring
    // it right back up so the user sees the change take effect now
    // (mirrors a manual /typos off; /typos on, but automated).
    const wasEnabled = state.enabled;
    if (wasEnabled) {
      await disable(ctx);
    }
    state.engine = undefined;
    ctx.ui.notify(`maxEditDistance set to ${value}`, "info");
    if (wasEnabled) {
      await enable(ctx);
    }
  }

  async function handleSetMinWordLength(ctx: TyposCommandContext, raw: string): Promise<void> {
    const value = parseIntInRange(raw, MIN_WORD_LENGTH_RANGE);
    if (value === undefined) {
      ctx.ui.notify(
        `Usage: /typos config minWordLength <integer ${MIN_WORD_LENGTH_RANGE.min}-${MIN_WORD_LENGTH_RANGE.max}>`,
        "warning",
      );
      return;
    }

    if (config.getMinWordLength() === value) {
      ctx.ui.notify(`minWordLength is already ${value}`, "info");
      return;
    }

    try {
      await config.setMinWordLength(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save minWordLength: ${formatError(error)}`, "error");
      return;
    }

    // minWordLength is read live by the engine via getMinWordLength(), so
    // no rebuild is needed — the next correction picks up the new value.
    ctx.ui.notify(`minWordLength set to ${value}`, "info");
  }

  async function handleDictionaryCommand(ctx: TyposCommandContext, rawArgs: string): Promise<void> {
    const trimmedArgs = rawArgs.trim();

    if (trimmedArgs.length === 0) {
      showBareDict(ctx, learnedDictionary);
      return;
    }

    const firstSpace = trimmedArgs.indexOf(" ");
    const subcommand = firstSpace === -1 ? trimmedArgs : trimmedArgs.slice(0, firstSpace);
    const remainder = firstSpace === -1 ? "" : trimmedArgs.slice(firstSpace + 1).trim();

    switch (subcommand) {
      case "search": {
        if (!remainder) {
          ctx.ui.notify("Usage: /typos dict search <term>", "warning");
          return;
        }

        const matches = learnedDictionary.search(remainder);
        const pendingMatchCount = learnedDictionary
          .getPending()
          .filter(({ word }) => word.includes(remainder.toLowerCase())).length;

        if (matches.length === 0) {
          ctx.ui.notify(`No matches for "${remainder}"`, "info");
          return;
        }

        showDictionary(ctx, matches, {
          totalLabel: "matches",
          truncatedNote: `Showing ${MAX_DICTIONARY_RESULTS} of ${matches.length} matches`,
          pendingMatchCount,
        });
        return;
      }

      case "add": {
        if (!remainder || !DICTIONARY_WORD_PATTERN.test(remainder)) {
          ctx.ui.notify("Usage: /typos dict add <word>", "warning");
          return;
        }

        if (learnedDictionary.has(remainder)) {
          ctx.ui.notify(`"${remainder}" is already in the dictionary`, "info");
          return;
        }

        learnedDictionary.add(remainder.toLowerCase(), "manual");
        ctx.ui.notify(`Added "${remainder}" to dictionary`, "info");
        return;
      }

      case "remove": {
        if (!remainder) {
          ctx.ui.notify("Usage: /typos dict remove <word>", "warning");
          return;
        }

        const existed = learnedDictionary.remove(remainder);
        ctx.ui.notify(existed ? `Removed "${remainder}"` : `"${remainder}" not found in dictionary`, "info");
        return;
      }

      case "clear": {
        if (remainder) {
          ctx.ui.notify(DICTIONARY_USAGE, "warning");
          return;
        }

        const count = learnedDictionary.size;

        if (count === 0) {
          ctx.ui.notify("Dictionary is already empty", "info");
          return;
        }

        const confirmed = await ctx.ui.confirm(
          "Clear dictionary?",
          `This will remove all ${count} learned words. Continue?`,
        );

        if (!confirmed) {
          ctx.ui.notify("Clear cancelled", "info");
          return;
        }

        learnedDictionary.clear();
        ctx.ui.notify(`Cleared ${count} words from dictionary`, "info");
        return;
      }

      default:
        ctx.ui.notify(DICTIONARY_USAGE, "warning");
    }
  }

  function showDictionary(
    ctx: TyposCommandContext,
    entries: ReturnType<LearnedDictionary["getAll"]>,
    options?: { totalLabel: "words" | "matches"; truncatedNote?: string; pendingMatchCount?: number },
  ): void {
    if (entries.length === 0) {
      ctx.ui.notify(EMPTY_DICTIONARY_MESSAGE, "info");
      return;
    }

    const limitedEntries = entries.slice(0, MAX_DICTIONARY_RESULTS);
    const lines = limitedEntries.map(({ word, entry }) => `${word}  ${entry.added}  (${entry.source})`);
    const totalLabel = options?.totalLabel ?? "words";

    let message = lines.join("\n");

    if (entries.length > MAX_DICTIONARY_RESULTS) {
      const note =
        options?.truncatedNote ??
        `Showing ${MAX_DICTIONARY_RESULTS} of ${entries.length} ${totalLabel} — use \`/typos dict search <term>\` to filter`;
      message = `${message}\n\n${note}`;
    }

    const pendingCount = options?.pendingMatchCount ?? 0;
    if (pendingCount > 0) {
      const plural = pendingCount === 1 ? "match" : "matches";
      message = `${message}\n\n(Plus ${pendingCount} pending ${plural} — see /typos dict)`;
    }

    ctx.ui.notify(message, "info");
  }

  function showBareDict(ctx: TyposCommandContext, dictionary: LearnedDictionary): void {
    const graduated = dictionary.getAll();
    const pending = dictionary.getPending();

    if (graduated.length === 0 && pending.length === 0) {
      ctx.ui.notify(EMPTY_DICTIONARY_MESSAGE, "info");
      return;
    }

    const parts: string[] = [];

    if (graduated.length > 0) {
      const limitedGraduated = graduated.slice(0, MAX_DICTIONARY_RESULTS);
      const lines = limitedGraduated.map(({ word, entry }) => `${word}  ${entry.added}  (${entry.source})`);
      let section = lines.join("\n");

      if (graduated.length > MAX_DICTIONARY_RESULTS) {
        const note = `Showing ${MAX_DICTIONARY_RESULTS} of ${graduated.length} words — use \`/typos dict search <term>\` to filter`;
        section = `${section}\n\n${note}`;
      }

      parts.push(section);
    }

    if (pending.length > 0) {
      const limitedPending = pending.slice(0, MAX_DICTIONARY_RESULTS);
      const pendingLines = limitedPending.map(({ word, rejections }) => `${word}  (${rejections} of 2 rejections)`);
      const pendingSection = `Pending (1 more rejection to learn):\n${pendingLines.join("\n")}`;
      parts.push(pendingSection);
    }

    ctx.ui.notify(parts.join("\n\n"), "info");
  }

  return {
    state,
    handler,
    getArgumentCompletions,
    applyDefaultMode,
  };
}

function isDefaultMode(value: string): value is DefaultMode {
  return value === "on" || value === "off";
}

function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value);
}

function configValueChoices(key: string): readonly string[] | null {
  if (key === "defaultMode") {
    return DEFAULT_SUBCOMMANDS;
  }
  if (key === "maxEditDistance") {
    return integerChoices(MAX_EDIT_DISTANCE_RANGE);
  }
  if (key === "minWordLength") {
    return integerChoices(MIN_WORD_LENGTH_RANGE);
  }
  return null;
}

function integerChoices(range: { min: number; max: number }): readonly string[] {
  const out: string[] = [];
  for (let value = range.min; value <= range.max; value += 1) {
    out.push(String(value));
  }
  return out;
}

function parseIntInRange(raw: string, range: { min: number; max: number }): number | undefined {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) {
    return undefined;
  }
  return parsed;
}

function buildKeyValueCompletions(
  parent: string,
  key: string,
  values: readonly string[],
  prefix: string,
): AutocompleteItem[] | null {
  const matches = values
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({
      label: value,
      value: `${parent} ${key} ${value}`,
    }));

  return matches.length > 0 ? matches : null;
}

function buildCompletions(values: readonly string[], prefix: string): AutocompleteItem[] | null {
  const matches = values
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({
      label: value,
      value,
    }));

  return matches.length > 0 ? matches : null;
}

/**
 * Build completion items for a second-level subcommand (e.g. `dict add`,
 * `default on`).
 *
 * Pi's `applyCompletion` replaces the entire argument text (everything after
 * `/<command> `) with the chosen item's `value`. That means a second-level
 * completion can't return just the leaf token — selecting `"on"` from a
 * `/typos default ` dropdown would otherwise rewrite the line to `/typos on`,
 * dropping the `default` parent. So `value` must include the parent token,
 * while `label` stays the leaf token for a clean dropdown UI.
 */
function buildSubcommandCompletions(
  parent: string,
  values: readonly string[],
  prefix: string,
): AutocompleteItem[] | null {
  const matches = values
    .filter((value) => value.startsWith(prefix))
    .map((value) => ({
      label: value,
      value: `${parent} ${value}`,
    }));

  return matches.length > 0 ? matches : null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
