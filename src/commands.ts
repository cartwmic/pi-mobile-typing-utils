import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { AutocorrectEditor } from "./autocorrect-editor.js";
import { CorrectionEngine, type CorrectionEngineOptions } from "./correction-engine.js";
import type { LearnedDictionary } from "./learned-dictionary.js";

const TOP_LEVEL_COMMANDS = ["on", "off", "dict"] as const;
const DICTIONARY_SUBCOMMANDS = ["add", "remove", "search", "clear"] as const;
const DICTIONARY_WORD_PATTERN = /^[A-Za-z]+$/;
const MAX_DICTIONARY_RESULTS = 50;
const DICTIONARY_USAGE = "Usage: /typos dict [search <term>|add <word>|remove <word>|clear]";
const TOP_LEVEL_USAGE = "Unknown command. Usage: /typos [on|off|dict ...]";
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
  createCorrectionEngine?: (options: CorrectionEngineOptions) => CorrectionEngine;
  createAutocorrectEditor?: (...args: ConstructorParameters<typeof AutocorrectEditor>) => AutocorrectEditor;
};

type ScheduledAction = "enable" | "disable" | "toggle";

export function createTyposCommand({
  learnedDictionary,
  techDictPath,
  createCorrectionEngine = (options) => new CorrectionEngine(options),
  createAutocorrectEditor = (...args) => new AutocorrectEditor(...args),
}: CreateTyposCommandOptions): {
  state: TyposCommandState;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  getArgumentCompletions: (argumentPrefix: string) => AutocompleteItem[] | null;
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
      showDictionary(ctx, learnedDictionary.getAll());
      return;
    }

    if (trimmedArgs.startsWith("dict ")) {
      await handleDictionaryCommand(ctx, trimmedArgs.slice(5));
      return;
    }

    ctx.ui.notify(TOP_LEVEL_USAGE, "warning");
  }

  function getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
    const prefix = argumentPrefix.trimStart();

    if (!prefix.includes(" ")) {
      return buildCompletions(TOP_LEVEL_COMMANDS, prefix);
    }

    if (!prefix.startsWith("dict ")) {
      return null;
    }

    const dictPrefix = prefix.slice(5).trimStart();

    if (dictPrefix.includes(" ")) {
      return null;
    }

    return buildCompletions(DICTIONARY_SUBCOMMANDS, dictPrefix);
  }

  async function requestExplicitToggle(ctx: ExtensionCommandContext, enabled: boolean): Promise<void> {
    const requestedAction = enabled ? "enable" : "disable";

    if (state.toggleInFlight && queuedTailAction === requestedAction) {
      await state.toggleInFlight;
      return;
    }

    await scheduleToggle(ctx, requestedAction);
  }

  async function scheduleToggle(ctx: ExtensionCommandContext, action: ScheduledAction): Promise<void> {
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

  async function enable(ctx: ExtensionCommandContext): Promise<void> {
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

  async function disable(ctx: ExtensionCommandContext): Promise<void> {
    if (!state.enabled) {
      ctx.ui.notify("Autocorrect is already off", "info");
      return;
    }

    state.enabled = false;
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setStatus("typos", undefined);
    ctx.ui.notify("Autocorrect OFF", "info");
  }

  async function handleDictionaryCommand(ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
    const trimmedArgs = rawArgs.trim();

    if (trimmedArgs.length === 0) {
      showDictionary(ctx, learnedDictionary.getAll());
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

        if (matches.length === 0) {
          ctx.ui.notify(`No matches for "${remainder}"`, "info");
          return;
        }

        showDictionary(ctx, matches, {
          totalLabel: "matches",
          truncatedNote: `Showing ${MAX_DICTIONARY_RESULTS} of ${matches.length} matches`,
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
    ctx: ExtensionCommandContext,
    entries: ReturnType<LearnedDictionary["getAll"]>,
    options?: { totalLabel: "words" | "matches"; truncatedNote?: string },
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

    ctx.ui.notify(message, "info");
  }

  return {
    state,
    handler,
    getArgumentCompletions,
  };
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

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
