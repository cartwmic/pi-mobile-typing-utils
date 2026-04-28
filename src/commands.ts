import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import { AutocorrectEditor } from "./autocorrect-editor.js";
import {
  EDIT_DISTANCE_STEP_EVERY_RANGE,
  MAX_EDIT_DISTANCE_RANGE,
  MIN_EDIT_DISTANCE_RANGE_MIN,
  MIN_WORD_LENGTH_RANGE,
  RERANK_EDIT_DISTANCE_PENALTY_RANGE,
  RERANK_WEIGHT_RANGE,
  SEGMENTATION_LOG_PROB_FLOOR_RANGE,
  SEGMENTATION_MAX_EDIT_DISTANCE_RANGE,
  SEGMENTATION_MIN_LENGTH_RANGE,
  SEGMENTATION_VS_LOOKUP_BIAS_RANGE,
  TELEMETRY_LEVELS,
  type Config,
  type DefaultMode,
} from "./config.js";
import type { ReadinessState } from "./correction-engine.js";
import { CorrectionEngine, type CorrectionEngineOptions } from "./correction-engine.js";
import type { LearnedDictionary } from "./learned-dictionary.js";
import type { TelemetryWriter } from "./telemetry.js";
import { aggregateRange, type StatsRange } from "./telemetry-aggregate.js";

const TOP_LEVEL_COMMANDS = ["on", "off", "dict", "default", "config", "stats"] as const;
const DICTIONARY_SUBCOMMANDS = ["add", "remove", "search", "clear"] as const;
const DEFAULT_SUBCOMMANDS = ["on", "off"] as const;
const CONFIG_KEYS = [
  "defaultMode",
  "maxEditDistance",
  "minWordLength",
  "minEditDistance",
  "editDistanceStepEvery",
  "enableSegmentation",
  "segmentationMinLength",
  "segmentationMaxEditDistance",
  "segmentationLogProbFloor",
  "segmentationVsLookupBias",
  "enableContextRerank",
  "rerankBigramWeight",
  "rerankTrigramWeight",
  "rerankEditDistancePenalty",
  "telemetry",
] as const;
const STATS_SUBCOMMANDS = ["24h", "7d", "all", "reset"] as const;
const DICTIONARY_WORD_PATTERN = /^[A-Za-z]+$/;
const MAX_DICTIONARY_RESULTS = 50;
const DICTIONARY_USAGE = "Usage: /typos dict [search <term>|add <word>|remove <word>|clear]";
const DEFAULT_USAGE = "Usage: /typos default [on|off]";
const CONFIG_USAGE = `Usage: /typos config [${CONFIG_KEYS.join("|")}] [<value>]`;
const TOP_LEVEL_USAGE = "Unknown command. Usage: /typos [on|off|dict ...|default ...|config ...|stats ...]";

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
  /**
   * The currently-tracked engine-initialization promise. Set when a background
   * initialize() call is in flight; cleared by disable() and config rebuilds.
   * Section 7 pre-warm can seed this alongside state.engine before the first
   * enable() so the promise is reused rather than a second init started.
   */
  initInFlight?: Promise<void>;
  /**
   * Monotonically-increasing generation counter. Bumped whenever state.engine
   * is torn down (disable(), maxEditDistance rebuild, degraded-state retry).
   * Every .then/.catch callback attached to initInFlight captures this value
   * at attachment time; the callback early-returns if the generation no longer
   * matches ("orphan-promise generation guard", per design.md).
   */
  generation: number;
  /**
   * Timestamp (ms) of the first /typos stats reset invocation in a session.
   * Null when no reset is pending. Per-process only; not persisted.
   */
  pendingResetAt: number | null;
};

/**
 * Handle returned by {@link prewarmEngine} representing an engine whose
 * initialization has been kicked off but not yet awaited.
 */
export type PrewarmHandle = {
  engine: CorrectionEngine;
  initPromise: Promise<void>;
};

export type CreateTyposCommandOptions = {
  learnedDictionary: LearnedDictionary;
  techDictPath: string;
  config: Config;
  /**
   * Optional pre-warmed engine from {@link prewarmEngine}. When supplied the
   * state is seeded with the existing engine and its in-flight init promise so
   * {@link enable} reuses them rather than starting a second initialization.
   */
  prewarm?: PrewarmHandle;
  /**
   * Telemetry writer instance constructed once per process in index.ts.
   * Optional — when absent (no cache dir or tests), telemetry is silently skipped.
   */
  telemetry?: TelemetryWriter;
  /**
   * Cache directory for resolving telemetry NDJSON files in /typos stats.
   * When absent (cache disabled), /typos stats notifies the user.
   */
  cacheDir?: string;
  createCorrectionEngine?: (options: CorrectionEngineOptions) => CorrectionEngine;
  createAutocorrectEditor?: (...args: ConstructorParameters<typeof AutocorrectEditor>) => AutocorrectEditor;
};

type ScheduledAction = "enable" | "disable" | "toggle";

export function createTyposCommand({
  learnedDictionary,
  techDictPath,
  config,
  prewarm,
  telemetry,
  cacheDir,
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
    generation: 0,
    engine: prewarm?.engine,
    initInFlight: prewarm?.initPromise,
    pendingResetAt: null,
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

    if (trimmedArgs === "stats") {
      await handleStatsCommand(ctx, "");
      return;
    }

    if (trimmedArgs.startsWith("stats ")) {
      await handleStatsCommand(ctx, trimmedArgs.slice(6));
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
      const valueChoices = configValueChoices(key, config);
      if (!valueChoices) {
        return null;
      }
      return buildKeyValueCompletions("config", key, valueChoices, valuePrefix);
    }

    if (prefix.startsWith("stats ")) {
      const statsPrefix = prefix.slice(6).trimStart();
      if (statsPrefix.includes(" ")) {
        return null;
      }
      return buildSubcommandCompletions("stats", STATS_SUBCOMMANDS, statsPrefix);
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

  // ---------------------------------------------------------------------------
  // Section 5: Orphan-promise generation guard helpers
  // ---------------------------------------------------------------------------

  /** Capture the current generation token for attachment to an init callback. */
  function captureGen(): number {
    return state.generation;
  }

  /**
   * Returns true when a callback's captured generation no longer matches the
   * current state. Used by every .then/.catch attached to state.initInFlight.
   */
  function isOrphan(captured: number): boolean {
    return captured !== state.generation;
  }

  /**
   * Construct a fresh CorrectionEngine and start its initialization promise.
   * Sets both state.engine and state.initInFlight.
   *
   * Wire all live-accessor knobs (getMinWordLength, getMinEditDistance,
   * getEditDistanceStepEvery) so the adaptive-ED curve is hot-reloadable
   * without rebuilding the engine. maxEditDistance is baked at construction
   * and is the only knob that requires a full rebuild (Section 5.4).
   *
   * Intentionally does NOT attach .then/.catch callbacks — callers call
   * attachInitCallbacks(ctx, captured) with the right context.
   * This lets Section 7's pre-warm seed state.engine + state.initInFlight
   * without a ctx, and have enable() attach callbacks later.
   */
  function constructEngine(): void {
    const engine = createCorrectionEngine(
      buildEngineOptions(techDictPath, learnedDictionary, config, telemetry, () => state.generation),
    );
    state.engine = engine;
    state.initInFlight = engine.initialize();
  }

  /**
   * Install (or re-install) the AutocorrectEditor using the current state.engine.
   * Single choke-point so Section 7 can reuse it for pre-warm hand-off.
   */
  function installEditor(ctx: TyposCommandContext): void {
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
  }

  /**
   * Single choke-point for updating the persistent "typos" status indicator.
   * Section 6 will extend this to handle additional indicator state.
   */
  function updateTyposStatus(ctx: TyposCommandContext, value: string | undefined): void {
    ctx.ui.setStatus("typos", value);
  }

  /**
   * Attach generation-guarded .then/.catch callbacks to state.initInFlight.
   * Called from enable() and internalRebuild() after state.initInFlight is set.
   */
  function attachInitCallbacks(ctx: TyposCommandContext, captured: number): void {
    void state.initInFlight!.then(
      () => onInitResolved(ctx, captured),
      (err: unknown) => onInitFailed(ctx, captured, err),
    );
  }

  /**
   * Fired when the in-flight initialize() resolves successfully.
   * Guards against orphaned promises (generation mismatch) and early-returns
   * when the user has disabled autocorrect in the meantime.
   */
  function onInitResolved(ctx: TyposCommandContext, captured: number): void {
    if (isOrphan(captured) || !state.enabled) return;
    updateTyposStatus(ctx, "✓ Autocorrect");
  }

  /**
   * Fired when the in-flight initialize() rejects.
   * Guards against orphans the same way as onInitResolved, then surfaces
   * the error once via the persistent indicator and an error notification.
   */
  function onInitFailed(ctx: TyposCommandContext, captured: number, err: unknown): void {
    if (isOrphan(captured) || !state.enabled) return;
    updateTyposStatus(ctx, "Autocorrect unavailable");
    ctx.ui.notify(`Autocorrect initialization failed: ${formatError(err)}`, "error");
  }

  /**
   * Rebuild the engine in the background while autocorrect remains enabled.
   * Used by handleSetMaxEditDistance() after a config change — does NOT emit
   * "Autocorrect OFF" or "Autocorrect ON (loading…)" notifications (only the
   * maxEditDistance success notification fires). The persistent "typos"
   * indicator transitions through readiness states via the callbacks.
   *
   * Precondition: state.generation has already been bumped and the old
   * state.engine / state.initInFlight have been cleared by the caller.
   */
  function internalRebuild(ctx: TyposCommandContext): void {
    constructEngine();
    const captured = captureGen();
    attachInitCallbacks(ctx, captured);
    installEditor(ctx);
    updateTyposStatus(ctx, "Autocorrect loading…");
  }

  // ---------------------------------------------------------------------------
  // Core toggle actions
  // ---------------------------------------------------------------------------

  async function enable(ctx: TyposCommandContext): Promise<void> {
    if (state.enabled) {
      ctx.ui.notify("Autocorrect is already on", "info");
      return;
    }

    // 5.6: degraded-state retry — if the engine (e.g. from a pre-warm) failed
    // initialization while autocorrect was disabled, discard it and build fresh.
    if (state.engine?.getReadinessState() === "degraded") {
      state.generation++;
      state.engine = undefined;
      state.initInFlight = undefined;
    }

    // Construct a fresh engine if we don't have one yet.
    if (!state.engine) {
      constructEngine();
    }

    const readiness = state.engine!.getReadinessState();

    if (readiness === "ready") {
      // Engine already warm (pre-warm hit or reused). Install immediately.
      state.enabled = true;
      installEditor(ctx);
      updateTyposStatus(ctx, "✓ Autocorrect");
      ctx.ui.notify("Autocorrect ON", "info");
      return;
    }

    // Engine is building (fresh construction or pre-warm in flight).
    // Attach generation-guarded callbacks so the status indicator updates
    // when init completes, then return control to the caller immediately
    // (non-blocking per the design.md Orphan-promise generation guard decision).
    const captured = captureGen();
    if (!state.initInFlight) {
      // Defensive: shouldn't happen after constructEngine(), but guard against
      // an externally-seeded engine (Section 7 pre-warm) that somehow has no
      // initInFlight reference.
      state.initInFlight = state.engine!.initialize();
    }
    attachInitCallbacks(ctx, captured);
    state.enabled = true;
    installEditor(ctx);
    updateTyposStatus(ctx, "Autocorrect loading…");
    ctx.ui.notify("Autocorrect ON (loading…)", "info");
  }

  async function disable(ctx: TyposCommandContext): Promise<void> {
    if (!state.enabled) {
      ctx.ui.notify("Autocorrect is already off", "info");
      return;
    }

    // 5.3: Bump generation first — this orphans any in-flight init's callbacks
    // (their captured generation will no longer match state.generation).
    state.generation++;
    state.enabled = false;
    ctx.ui.setEditorComponent(undefined);
    updateTyposStatus(ctx, undefined);
    // Drop engine and initInFlight. The orphaned initialize() MAY complete in
    // the background, but its result SHALL NOT be retained (design.md
    // "Orphan-promise generation guard": always discard, let next enable rebuild).
    state.initInFlight = undefined;
    state.engine = undefined;
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
      `defaultMode                ${config.getDefaultMode()}`,
      `maxEditDistance            ${config.getMaxEditDistance()}  (range ${MAX_EDIT_DISTANCE_RANGE.min}-${MAX_EDIT_DISTANCE_RANGE.max})`,
      `minWordLength              ${config.getMinWordLength()}  (range ${MIN_WORD_LENGTH_RANGE.min}-${MIN_WORD_LENGTH_RANGE.max})`,
      `minEditDistance            ${config.getMinEditDistance()}  (range ${MIN_EDIT_DISTANCE_RANGE_MIN}-${config.getMaxEditDistance()})`,
      `editDistanceStepEvery      ${config.getEditDistanceStepEvery()}  (range ${EDIT_DISTANCE_STEP_EVERY_RANGE.min}-${EDIT_DISTANCE_STEP_EVERY_RANGE.max})`,
      `enableSegmentation         ${config.getEnableSegmentation()}`,
      `segmentationMinLength      ${config.getSegmentationMinLength()}  (range ${SEGMENTATION_MIN_LENGTH_RANGE[0]}-${SEGMENTATION_MIN_LENGTH_RANGE[1]})`,
      `segmentationMaxEditDistance  ${config.getSegmentationMaxEditDistance()}  (range ${SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[0]}-${SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[1]})`,
      `segmentationLogProbFloor   ${config.getSegmentationLogProbFloor()}  (range ${SEGMENTATION_LOG_PROB_FLOOR_RANGE[0]}-${SEGMENTATION_LOG_PROB_FLOOR_RANGE[1]})`,
      `segmentationVsLookupBias   ${config.getSegmentationVsLookupBias()}  (range ${SEGMENTATION_VS_LOOKUP_BIAS_RANGE[0]}-${SEGMENTATION_VS_LOOKUP_BIAS_RANGE[1]})`,
      `enableContextRerank        ${config.getEnableContextRerank()}`,
      `rerankBigramWeight         ${config.getRerankBigramWeight()}  (range ${RERANK_WEIGHT_RANGE[0]}-${RERANK_WEIGHT_RANGE[1]})`,
      `rerankTrigramWeight        ${config.getRerankTrigramWeight()}  (range ${RERANK_WEIGHT_RANGE[0]}-${RERANK_WEIGHT_RANGE[1]})`,
      `rerankEditDistancePenalty  ${config.getRerankEditDistancePenalty()}  (range ${RERANK_EDIT_DISTANCE_PENALTY_RANGE[0]}-${RERANK_EDIT_DISTANCE_PENALTY_RANGE[1]})`,
      `telemetry                  ${config.getTelemetry()}`,
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

    if (key === "minEditDistance") {
      await handleSetMinEditDistance(ctx, remainder);
      return;
    }

    if (key === "editDistanceStepEvery") {
      await handleSetEditDistanceStepEvery(ctx, remainder);
      return;
    }

    if (key === "enableSegmentation") {
      await handleSetEnableSegmentation(ctx, remainder);
      return;
    }

    if (key === "segmentationMinLength") {
      await handleSetSegmentationMinLength(ctx, remainder);
      return;
    }

    if (key === "segmentationMaxEditDistance") {
      await handleSetSegmentationMaxEditDistance(ctx, remainder);
      return;
    }

    if (key === "segmentationLogProbFloor") {
      await handleSetSegmentationLogProbFloor(ctx, remainder);
      return;
    }

    if (key === "segmentationVsLookupBias") {
      await handleSetSegmentationVsLookupBias(ctx, remainder);
      return;
    }

    if (key === "enableContextRerank") {
      await handleSetEnableContextRerank(ctx, remainder);
      return;
    }

    if (key === "rerankBigramWeight") {
      await handleSetRerankBigramWeight(ctx, remainder);
      return;
    }

    if (key === "rerankTrigramWeight") {
      await handleSetRerankTrigramWeight(ctx, remainder);
      return;
    }

    if (key === "rerankEditDistancePenalty") {
      await handleSetRerankEditDistancePenalty(ctx, remainder);
      return;
    }

    if (key === "telemetry") {
      await handleSetTelemetry(ctx, remainder);
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
      case "minEditDistance":
        ctx.ui.notify(
          `minEditDistance = ${config.getMinEditDistance()} (range ${MIN_EDIT_DISTANCE_RANGE_MIN}-${config.getMaxEditDistance()})`,
          "info",
        );
        return;
      case "editDistanceStepEvery":
        ctx.ui.notify(
          `editDistanceStepEvery = ${config.getEditDistanceStepEvery()} (range ${EDIT_DISTANCE_STEP_EVERY_RANGE.min}-${EDIT_DISTANCE_STEP_EVERY_RANGE.max})`,
          "info",
        );
        return;
      case "enableSegmentation":
        ctx.ui.notify(`enableSegmentation = ${config.getEnableSegmentation()}`, "info");
        return;
      case "segmentationMinLength":
        ctx.ui.notify(
          `segmentationMinLength = ${config.getSegmentationMinLength()} (range ${SEGMENTATION_MIN_LENGTH_RANGE[0]}-${SEGMENTATION_MIN_LENGTH_RANGE[1]})`,
          "info",
        );
        return;
      case "segmentationMaxEditDistance":
        ctx.ui.notify(
          `segmentationMaxEditDistance = ${config.getSegmentationMaxEditDistance()} (range ${SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[0]}-${SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[1]})`,
          "info",
        );
        return;
      case "segmentationLogProbFloor":
        ctx.ui.notify(
          `segmentationLogProbFloor = ${config.getSegmentationLogProbFloor()} (range ${SEGMENTATION_LOG_PROB_FLOOR_RANGE[0]}-${SEGMENTATION_LOG_PROB_FLOOR_RANGE[1]})`,
          "info",
        );
        return;
      case "segmentationVsLookupBias":
        ctx.ui.notify(
          `segmentationVsLookupBias = ${config.getSegmentationVsLookupBias()} (range ${SEGMENTATION_VS_LOOKUP_BIAS_RANGE[0]}-${SEGMENTATION_VS_LOOKUP_BIAS_RANGE[1]})`,
          "info",
        );
        return;
      case "enableContextRerank":
        ctx.ui.notify(`enableContextRerank = ${config.getEnableContextRerank()}`, "info");
        return;
      case "rerankBigramWeight":
        ctx.ui.notify(
          `rerankBigramWeight = ${config.getRerankBigramWeight()} (range ${RERANK_WEIGHT_RANGE[0]}-${RERANK_WEIGHT_RANGE[1]})`,
          "info",
        );
        return;
      case "rerankTrigramWeight":
        ctx.ui.notify(
          `rerankTrigramWeight = ${config.getRerankTrigramWeight()} (range ${RERANK_WEIGHT_RANGE[0]}-${RERANK_WEIGHT_RANGE[1]})`,
          "info",
        );
        return;
      case "rerankEditDistancePenalty":
        ctx.ui.notify(
          `rerankEditDistancePenalty = ${config.getRerankEditDistancePenalty()} (range ${RERANK_EDIT_DISTANCE_PENALTY_RANGE[0]}-${RERANK_EDIT_DISTANCE_PENALTY_RANGE[1]})`,
          "info",
        );
        return;
      case "telemetry":
        ctx.ui.notify(`telemetry = ${config.getTelemetry()}`, "info");
        return;
    }
  }

  async function handleSetMaxEditDistance(ctx: TyposCommandContext, raw: string): Promise<void> {
    // 5.4.1: validate range [1, 4]
    const value = parseIntInRange(raw, MAX_EDIT_DISTANCE_RANGE);
    if (value === undefined) {
      ctx.ui.notify(
        `Usage: /typos config maxEditDistance <integer ${MAX_EDIT_DISTANCE_RANGE.min}-${MAX_EDIT_DISTANCE_RANGE.max}>`,
        "warning",
      );
      return;
    }

    // 5.4.1: also reject if n < current minEditDistance (BEFORE persisting)
    const currentMin = config.getMinEditDistance();
    if (value < currentMin) {
      ctx.ui.notify(
        `maxEditDistance cannot be less than current minEditDistance (${currentMin}); change minEditDistance first`,
        "warning",
      );
      return;
    }

    if (config.getMaxEditDistance() === value) {
      ctx.ui.notify(`maxEditDistance is already ${value}`, "info");
      return;
    }

    // 5.4.2: persist
    try {
      await config.setMaxEditDistance(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save maxEditDistance: ${formatError(error)}`, "error");
      return;
    }

    // 5.4.3: bump generation, orphan any in-flight init
    state.generation++;
    state.engine = undefined;
    state.initInFlight = undefined;

    ctx.ui.notify(`maxEditDistance set to ${value}`, "info");

    // 5.4.4: if enabled, rebuild in background (no "Autocorrect OFF/ON" notifications)
    // 5.4.5: if disabled, do nothing — new value takes effect on next /typos on
    if (state.enabled) {
      internalRebuild(ctx);
    }
  }

  async function handleSetMinEditDistance(ctx: TyposCommandContext, raw: string): Promise<void> {
    const currentMax = config.getMaxEditDistance();
    const value = parseIntInRange(raw, { min: MIN_EDIT_DISTANCE_RANGE_MIN, max: currentMax });
    if (value === undefined) {
      ctx.ui.notify(
        `Usage: /typos config minEditDistance <integer ${MIN_EDIT_DISTANCE_RANGE_MIN}-${currentMax}>`,
        "warning",
      );
      return;
    }

    if (config.getMinEditDistance() === value) {
      ctx.ui.notify(`minEditDistance is already ${value}`, "info");
      return;
    }

    try {
      await config.setMinEditDistance(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save minEditDistance: ${formatError(error)}`, "error");
      return;
    }

    // minEditDistance is read live by the engine via getMinEditDistance(), so
    // no rebuild is needed — the next correction picks up the new value.
    ctx.ui.notify(`minEditDistance set to ${value}`, "info");
  }

  async function handleSetEditDistanceStepEvery(ctx: TyposCommandContext, raw: string): Promise<void> {
    const value = parseIntInRange(raw, EDIT_DISTANCE_STEP_EVERY_RANGE);
    if (value === undefined) {
      ctx.ui.notify(
        `Usage: /typos config editDistanceStepEvery <integer ${EDIT_DISTANCE_STEP_EVERY_RANGE.min}-${EDIT_DISTANCE_STEP_EVERY_RANGE.max}>`,
        "warning",
      );
      return;
    }

    if (config.getEditDistanceStepEvery() === value) {
      ctx.ui.notify(`editDistanceStepEvery is already ${value}`, "info");
      return;
    }

    try {
      await config.setEditDistanceStepEvery(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save editDistanceStepEvery: ${formatError(error)}`, "error");
      return;
    }

    // editDistanceStepEvery is read live by the engine via getEditDistanceStepEvery(), so
    // no rebuild is needed — the next correction picks up the new value.
    ctx.ui.notify(`editDistanceStepEvery set to ${value}`, "info");
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

  // ---------------------------------------------------------------------------
  // New live-applied config key handlers (§11.2)
  // ---------------------------------------------------------------------------

  async function handleSetEnableSegmentation(ctx: TyposCommandContext, raw: string): Promise<void> {
    const value = parseBoolean(raw);
    if (value === undefined) {
      ctx.ui.notify("Usage: /typos config enableSegmentation <true|false>", "warning");
      return;
    }
    if (config.getEnableSegmentation() === value) {
      ctx.ui.notify(`enableSegmentation is already ${value}`, "info");
      return;
    }
    try {
      await config.setEnableSegmentation(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save enableSegmentation: ${formatError(error)}`, "error");
      return;
    }
    ctx.ui.notify(`enableSegmentation set to ${value}`, "info");
  }

  async function handleSetSegmentationMinLength(ctx: TyposCommandContext, raw: string): Promise<void> {
    const value = parseIntInRange(raw, {
      min: SEGMENTATION_MIN_LENGTH_RANGE[0],
      max: SEGMENTATION_MIN_LENGTH_RANGE[1],
    });
    if (value === undefined) {
      ctx.ui.notify(
        `Usage: /typos config segmentationMinLength <integer ${SEGMENTATION_MIN_LENGTH_RANGE[0]}-${SEGMENTATION_MIN_LENGTH_RANGE[1]}>`,
        "warning",
      );
      return;
    }
    if (config.getSegmentationMinLength() === value) {
      ctx.ui.notify(`segmentationMinLength is already ${value}`, "info");
      return;
    }
    try {
      await config.setSegmentationMinLength(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save segmentationMinLength: ${formatError(error)}`, "error");
      return;
    }
    ctx.ui.notify(`segmentationMinLength set to ${value}`, "info");
  }

  async function handleSetSegmentationMaxEditDistance(
    ctx: TyposCommandContext,
    raw: string,
  ): Promise<void> {
    const value = parseIntInRange(raw, {
      min: SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[0],
      max: SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[1],
    });
    if (value === undefined) {
      ctx.ui.notify(
        `Usage: /typos config segmentationMaxEditDistance <integer ${SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[0]}-${SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[1]}>`,
        "warning",
      );
      return;
    }
    if (config.getSegmentationMaxEditDistance() === value) {
      ctx.ui.notify(`segmentationMaxEditDistance is already ${value}`, "info");
      return;
    }
    try {
      await config.setSegmentationMaxEditDistance(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save segmentationMaxEditDistance: ${formatError(error)}`, "error");
      return;
    }
    ctx.ui.notify(`segmentationMaxEditDistance set to ${value}`, "info");
  }

  async function handleSetSegmentationLogProbFloor(
    ctx: TyposCommandContext,
    raw: string,
  ): Promise<void> {
    const value = parseNumberInRange(raw, [
      SEGMENTATION_LOG_PROB_FLOOR_RANGE[0],
      SEGMENTATION_LOG_PROB_FLOOR_RANGE[1],
    ]);
    if (value === undefined) {
      ctx.ui.notify(
        `Usage: /typos config segmentationLogProbFloor <number ${SEGMENTATION_LOG_PROB_FLOOR_RANGE[0]}-${SEGMENTATION_LOG_PROB_FLOOR_RANGE[1]}>`,
        "warning",
      );
      return;
    }
    if (config.getSegmentationLogProbFloor() === value) {
      ctx.ui.notify(`segmentationLogProbFloor is already ${value}`, "info");
      return;
    }
    try {
      await config.setSegmentationLogProbFloor(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save segmentationLogProbFloor: ${formatError(error)}`, "error");
      return;
    }
    ctx.ui.notify(`segmentationLogProbFloor set to ${value}`, "info");
  }

  async function handleSetSegmentationVsLookupBias(
    ctx: TyposCommandContext,
    raw: string,
  ): Promise<void> {
    const value = parseNumberInRange(raw, [
      SEGMENTATION_VS_LOOKUP_BIAS_RANGE[0],
      SEGMENTATION_VS_LOOKUP_BIAS_RANGE[1],
    ]);
    if (value === undefined) {
      ctx.ui.notify(
        `Usage: /typos config segmentationVsLookupBias <number ${SEGMENTATION_VS_LOOKUP_BIAS_RANGE[0]}-${SEGMENTATION_VS_LOOKUP_BIAS_RANGE[1]}>`,
        "warning",
      );
      return;
    }
    if (config.getSegmentationVsLookupBias() === value) {
      ctx.ui.notify(`segmentationVsLookupBias is already ${value}`, "info");
      return;
    }
    try {
      await config.setSegmentationVsLookupBias(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save segmentationVsLookupBias: ${formatError(error)}`, "error");
      return;
    }
    ctx.ui.notify(`segmentationVsLookupBias set to ${value}`, "info");
  }

  async function handleSetEnableContextRerank(
    ctx: TyposCommandContext,
    raw: string,
  ): Promise<void> {
    const value = parseBoolean(raw);
    if (value === undefined) {
      ctx.ui.notify("Usage: /typos config enableContextRerank <true|false>", "warning");
      return;
    }
    if (config.getEnableContextRerank() === value) {
      ctx.ui.notify(`enableContextRerank is already ${value}`, "info");
      return;
    }
    try {
      await config.setEnableContextRerank(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save enableContextRerank: ${formatError(error)}`, "error");
      return;
    }
    ctx.ui.notify(`enableContextRerank set to ${value}`, "info");
  }

  async function handleSetRerankBigramWeight(
    ctx: TyposCommandContext,
    raw: string,
  ): Promise<void> {
    const value = parseNumberInRange(raw, [RERANK_WEIGHT_RANGE[0], RERANK_WEIGHT_RANGE[1]]);
    if (value === undefined) {
      ctx.ui.notify(
        `Usage: /typos config rerankBigramWeight <number ${RERANK_WEIGHT_RANGE[0]}-${RERANK_WEIGHT_RANGE[1]}>`,
        "warning",
      );
      return;
    }
    if (config.getRerankBigramWeight() === value) {
      ctx.ui.notify(`rerankBigramWeight is already ${value}`, "info");
      return;
    }
    try {
      await config.setRerankBigramWeight(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save rerankBigramWeight: ${formatError(error)}`, "error");
      return;
    }
    ctx.ui.notify(`rerankBigramWeight set to ${value}`, "info");
  }

  async function handleSetRerankTrigramWeight(
    ctx: TyposCommandContext,
    raw: string,
  ): Promise<void> {
    const value = parseNumberInRange(raw, [RERANK_WEIGHT_RANGE[0], RERANK_WEIGHT_RANGE[1]]);
    if (value === undefined) {
      ctx.ui.notify(
        `Usage: /typos config rerankTrigramWeight <number ${RERANK_WEIGHT_RANGE[0]}-${RERANK_WEIGHT_RANGE[1]}>`,
        "warning",
      );
      return;
    }
    if (config.getRerankTrigramWeight() === value) {
      ctx.ui.notify(`rerankTrigramWeight is already ${value}`, "info");
      return;
    }
    try {
      await config.setRerankTrigramWeight(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save rerankTrigramWeight: ${formatError(error)}`, "error");
      return;
    }
    ctx.ui.notify(`rerankTrigramWeight set to ${value}`, "info");
  }

  async function handleSetRerankEditDistancePenalty(
    ctx: TyposCommandContext,
    raw: string,
  ): Promise<void> {
    const value = parseNumberInRange(raw, [
      RERANK_EDIT_DISTANCE_PENALTY_RANGE[0],
      RERANK_EDIT_DISTANCE_PENALTY_RANGE[1],
    ]);
    if (value === undefined) {
      ctx.ui.notify(
        `Usage: /typos config rerankEditDistancePenalty <number ${RERANK_EDIT_DISTANCE_PENALTY_RANGE[0]}-${RERANK_EDIT_DISTANCE_PENALTY_RANGE[1]}>`,
        "warning",
      );
      return;
    }
    if (config.getRerankEditDistancePenalty() === value) {
      ctx.ui.notify(`rerankEditDistancePenalty is already ${value}`, "info");
      return;
    }
    try {
      await config.setRerankEditDistancePenalty(value);
    } catch (error) {
      ctx.ui.notify(`Failed to save rerankEditDistancePenalty: ${formatError(error)}`, "error");
      return;
    }
    ctx.ui.notify(`rerankEditDistancePenalty set to ${value}`, "info");
  }

  async function handleSetTelemetry(ctx: TyposCommandContext, raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (!(TELEMETRY_LEVELS as readonly string[]).includes(trimmed)) {
      ctx.ui.notify(
        `Usage: /typos config telemetry <${TELEMETRY_LEVELS.join("|")}>`,
        "warning",
      );
      return;
    }
    const level = trimmed as (typeof TELEMETRY_LEVELS)[number];
    if (config.getTelemetry() === level) {
      ctx.ui.notify(`telemetry is already ${level}`, "info");
      return;
    }
    try {
      await config.setTelemetry(level);
    } catch (error) {
      ctx.ui.notify(`Failed to save telemetry: ${formatError(error)}`, "error");
      return;
    }
    ctx.ui.notify(`telemetry set to ${level}`, "info");
  }

  // ---------------------------------------------------------------------------
  // /typos stats handler (§11.6, 11.7, 11.8)
  // ---------------------------------------------------------------------------

  async function handleStatsCommand(ctx: TyposCommandContext, rawArgs: string): Promise<void> {
    const arg = rawArgs.trim();

    if (arg === "reset") {
      await handleStatsReset(ctx);
      return;
    }

    const range: StatsRange = arg === "7d" ? "7d" : arg === "all" ? "all" : "24h";

    const telemetryDir = cacheDir ? join(cacheDir, "telemetry") : null;
    if (!telemetryDir) {
      ctx.ui.notify("Telemetry disabled (no cache directory)", "info");
      return;
    }

    try {
      const report = await aggregateRange(telemetryDir, range);
      ctx.ui.notify(report.formatted, "info");
    } catch (error) {
      ctx.ui.notify(`Failed to read telemetry: ${formatError(error)}`, "error");
    }
  }

  async function handleStatsReset(ctx: TyposCommandContext): Promise<void> {
    const telemetryDir = cacheDir ? join(cacheDir, "telemetry") : null;
    if (!telemetryDir) {
      ctx.ui.notify("Telemetry disabled (no cache directory)", "info");
      return;
    }

    const now = Date.now();

    if (state.pendingResetAt === null) {
      // First invocation: prompt for confirmation
      state.pendingResetAt = now;
      ctx.ui.notify(
        "Run /typos stats reset again within 30 seconds to delete all telemetry NDJSON files.",
        "warning",
      );
      return;
    }

    const elapsed = now - state.pendingResetAt;

    if (elapsed > 30000) {
      // Stale confirmation: re-prompt
      state.pendingResetAt = now;
      ctx.ui.notify(
        "Run /typos stats reset again within 30 seconds to delete all telemetry NDJSON files.",
        "warning",
      );
      return;
    }

    // Valid confirmation window: delete files
    state.pendingResetAt = null;

    let files: string[];
    try {
      const entries = await readdir(telemetryDir);
      files = entries.filter((f) => /^events-.*\.ndjson$/.test(f));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        ctx.ui.notify("No telemetry to reset", "info");
        return;
      }
      ctx.ui.notify(`Failed to list telemetry files: ${formatError(error)}`, "error");
      return;
    }

    if (files.length === 0) {
      ctx.ui.notify("No telemetry to reset", "info");
      return;
    }

    let deleted = 0;
    for (const file of files) {
      try {
        await unlink(join(telemetryDir, file));
        deleted++;
      } catch {
        // Best-effort; swallow per-file errors
      }
    }

    ctx.ui.notify(`Telemetry reset: deleted ${deleted} files.`, "info");
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

// ---------------------------------------------------------------------------
// Pre-warm: kick off engine initialization before the first session_start
// ---------------------------------------------------------------------------

/**
 * Build the shared engine-construction options so {@link prewarmEngine} and
 * {@link constructEngine} (inside createTyposCommand) always wire the same
 * live-accessor knobs.
 *
 * This helper is NOT exported; consumers should call prewarmEngine().
 */
function buildEngineOptions(
  techDictPath: string,
  learnedDictionary: LearnedDictionary,
  config: Config,
  telemetry?: TelemetryWriter,
  getOwnerGeneration?: () => number,
): CorrectionEngineOptions {
  return {
    techDictPath,
    isLearned: (word) => learnedDictionary.has(word),
    maxEditDistance: config.getMaxEditDistance(),
    getMinWordLength: () => config.getMinWordLength(),
    getMinEditDistance: () => config.getMinEditDistance(),
    getEditDistanceStepEvery: () => config.getEditDistanceStepEvery(),
    getEnableSegmentation: () => config.getEnableSegmentation(),
    getSegmentationMinLength: () => config.getSegmentationMinLength(),
    getSegmentationMaxEditDistance: () => config.getSegmentationMaxEditDistance(),
    getSegmentationLogProbFloor: () => config.getSegmentationLogProbFloor(),
    getSegmentationVsLookupBias: () => config.getSegmentationVsLookupBias(),
    getEnableContextRerank: () => config.getEnableContextRerank(),
    getRerankBigramWeight: () => config.getRerankBigramWeight(),
    getRerankTrigramWeight: () => config.getRerankTrigramWeight(),
    getRerankEditDistancePenalty: () => config.getRerankEditDistancePenalty(),
    getOwnerGeneration: getOwnerGeneration ?? (() => 0),
    telemetry,
  };
}

/**
 * Construct a {@link CorrectionEngine} and kick off its initialization in the
 * background. The returned {@link PrewarmHandle} can be passed to
 * {@link createTyposCommand} via the `prewarm` option so that the first
 * `enable()` reuses the in-flight init rather than starting a second one.
 *
 * Errors on the init promise are silently captured via `.catch(() => undefined)`
 * to prevent unhandled-rejection warnings. The engine's `readinessState` will
 * transition to `"degraded"` on failure; the first `enable()` call detects
 * that state and rebuilds from scratch (Section 5.6).
 */
export function prewarmEngine({
  techDictPath,
  learnedDictionary,
  config,
  telemetry,
  createCorrectionEngine: factory = (opts) => new CorrectionEngine(opts),
}: {
  techDictPath: string;
  learnedDictionary: LearnedDictionary;
  config: Config;
  /** Optional writer from index.ts; pre-warm engine emits engine.init via this. */
  telemetry?: TelemetryWriter;
  createCorrectionEngine?: (options: CorrectionEngineOptions) => CorrectionEngine;
}): PrewarmHandle {
  // Pre-warm has no state.generation reference — use () => 0 as documented in
  // design.md Decision 7. The pre-warm engine is the FIRST one; its trigram
  // attach won't be orphaned because no rebuild has happened yet.
  const engine = factory(buildEngineOptions(techDictPath, learnedDictionary, config, telemetry, () => 0));
  const initPromise = engine.initialize();
  // Suppress unhandled-rejection before enable() has a chance to attach its
  // own generation-guarded .catch callback via attachInitCallbacks().
  void initPromise.catch(() => undefined);
  return { engine, initPromise };
}

function isDefaultMode(value: string): value is DefaultMode {
  return value === "on" || value === "off";
}

function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value);
}

function configValueChoices(key: string, cfg: Config): readonly string[] | null {
  if (key === "defaultMode") {
    return DEFAULT_SUBCOMMANDS;
  }
  if (key === "maxEditDistance") {
    // Lower bound is dynamic: suggestions start at the current minEditDistance.
    return integerChoices({ min: cfg.getMinEditDistance(), max: MAX_EDIT_DISTANCE_RANGE.max });
  }
  if (key === "minWordLength") {
    return integerChoices(MIN_WORD_LENGTH_RANGE);
  }
  if (key === "minEditDistance") {
    // Upper bound is dynamic: suggestions cap at the current maxEditDistance.
    return integerChoices({ min: MIN_EDIT_DISTANCE_RANGE_MIN, max: cfg.getMaxEditDistance() });
  }
  if (key === "editDistanceStepEvery") {
    return integerChoices(EDIT_DISTANCE_STEP_EVERY_RANGE);
  }
  if (key === "enableSegmentation" || key === "enableContextRerank") {
    return ["true", "false"];
  }
  if (key === "telemetry") {
    return [...TELEMETRY_LEVELS];
  }
  if (key === "segmentationMinLength") {
    return integerChoices({ min: SEGMENTATION_MIN_LENGTH_RANGE[0], max: SEGMENTATION_MIN_LENGTH_RANGE[1] });
  }
  if (key === "segmentationMaxEditDistance") {
    return integerChoices({
      min: SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[0],
      max: SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[1],
    });
  }
  // Free-form numeric keys: no suggestions
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

function parseNumberInRange(raw: string, range: [number, number]): number | undefined {
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed) || parsed < range[0] || parsed > range[1]) {
    return undefined;
  }
  return parsed;
}

function parseBoolean(raw: string): boolean | undefined {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return undefined;
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
