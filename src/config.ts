import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type DefaultMode = "on" | "off";

export type TelemetryLevel = "off" | "metrics" | "debug";

export type ConfigSnapshot = {
  defaultMode: DefaultMode;
  /**
   * Maximum SymSpell edit distance for typo lookups. Higher values catch
   * more typos but generate more false positives and grow memory cost.
   * The library's internal `prefixLength` (default 7) caps the theoretical
   * max; the practical cap below is much tighter for usability.
   */
  maxEditDistance: number;
  /**
   * Minimum word length eligible for correction. Tokens shorter than this
   * are passed through untouched. Keeps short noisy sequences like `tx`
   * or `wq` from triggering wild corrections.
   */
  minWordLength: number;
  /**
   * Floor edit distance for the adaptive ED curve: ED(L) = clamp(minED +
   * floor((L − minWordLength) / step), minED, maxED). Words at or below
   * minWordLength are looked up at exactly this distance.
   */
  minEditDistance: number;
  /**
   * How many additional characters of word length it takes to ramp the
   * effective edit distance up by one step. Lower values ramp more
   * aggressively; higher values keep the distance tighter for longer.
   */
  editDistanceStepEvery: number;
  /** Whether the word-segmentation correction path is enabled. */
  enableSegmentation: boolean;
  /** Minimum token length before segmentation is attempted. */
  segmentationMinLength: number;
  /** Maximum per-segment edit distance allowed during segmentation scoring. */
  segmentationMaxEditDistance: number;
  /**
   * Minimum log-probability sum for a segmentation result to be accepted.
   * Results below this floor are discarded.
   */
  segmentationLogProbFloor: number;
  /**
   * Bias added to the segmentation score before comparing head-to-head
   * against the lookup-rerank score. Positive values favour segmentation;
   * negative values favour the lookup path.
   */
  segmentationVsLookupBias: number;
  /** Whether the n-gram context rerank pass is enabled. */
  enableContextRerank: boolean;
  /** Weight for the bigram log-probability term in the rerank scoring formula. */
  rerankBigramWeight: number;
  /** Weight for the trigram log-probability term in the rerank scoring formula. */
  rerankTrigramWeight: number;
  /** Penalty multiplied by the candidate's edit distance in the rerank score. */
  rerankEditDistancePenalty: number;
  /** Telemetry privacy level. */
  telemetry: TelemetryLevel;
};

type PersistedConfig = {
  version: 1;
  defaultMode?: DefaultMode;
  maxEditDistance?: number;
  minWordLength?: number;
  minEditDistance?: number;
  editDistanceStepEvery?: number;
  enableSegmentation?: boolean;
  segmentationMinLength?: number;
  segmentationMaxEditDistance?: number;
  segmentationLogProbFloor?: number;
  segmentationVsLookupBias?: number;
  enableContextRerank?: boolean;
  rerankBigramWeight?: number;
  rerankTrigramWeight?: number;
  rerankEditDistancePenalty?: number;
  telemetry?: TelemetryLevel;
};

export const DEFAULT_CONFIG: ConfigSnapshot = Object.freeze({
  defaultMode: "off" as const,
  maxEditDistance: 2,
  minWordLength: 2,
  minEditDistance: 1,
  editDistanceStepEvery: 4,
  enableSegmentation: true,
  segmentationMinLength: 6,
  segmentationMaxEditDistance: 1,
  segmentationLogProbFloor: -12.0,
  segmentationVsLookupBias: 0.0,
  enableContextRerank: true,
  rerankBigramWeight: 0.5,
  rerankTrigramWeight: 0.3,
  rerankEditDistancePenalty: 1.0,
  telemetry: "metrics" as const,
});

export const MAX_EDIT_DISTANCE_RANGE = Object.freeze({ min: 1, max: 4 });
export const MIN_WORD_LENGTH_RANGE = Object.freeze({ min: 2, max: 8 });
/** Absolute minimum value for minEditDistance (the lower bound never changes). */
export const MIN_EDIT_DISTANCE_RANGE_MIN = 0;
/** Range for editDistanceStepEvery: number of characters of word-length growth per +1 ED step. */
export const EDIT_DISTANCE_STEP_EVERY_RANGE = Object.freeze({ min: 1, max: 8 });

export const SEGMENTATION_MIN_LENGTH_RANGE = [4, 12] as const;
export const SEGMENTATION_MAX_EDIT_DISTANCE_RANGE = [0, 2] as const;
export const SEGMENTATION_LOG_PROB_FLOOR_RANGE = [-30, 0] as const;
export const SEGMENTATION_VS_LOOKUP_BIAS_RANGE = [-10, 10] as const;
/** Used by both rerankBigramWeight and rerankTrigramWeight. */
export const RERANK_WEIGHT_RANGE = [0, 1] as const;
export const RERANK_EDIT_DISTANCE_PENALTY_RANGE = [0, 5] as const;
export const TELEMETRY_LEVELS = ["off", "metrics", "debug"] as const;

export class Config {
  private state: ConfigSnapshot = { ...DEFAULT_CONFIG };
  private readonly filePath: string;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(opts: { filePath: string }) {
    this.filePath = opts.filePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedConfig;

      if (!parsed || typeof parsed !== "object") {
        throw new InvalidConfigError("Invalid config file format");
      }

      const resolvedMaxEditDistance =
        normalizeIntInRange(parsed.maxEditDistance, MAX_EDIT_DISTANCE_RANGE) ??
        DEFAULT_CONFIG.maxEditDistance;

      this.state = {
        defaultMode: normalizeDefaultMode(parsed.defaultMode) ?? DEFAULT_CONFIG.defaultMode,
        maxEditDistance: resolvedMaxEditDistance,
        minWordLength:
          normalizeIntInRange(parsed.minWordLength, MIN_WORD_LENGTH_RANGE) ??
          DEFAULT_CONFIG.minWordLength,
        minEditDistance: resolveMinEditDistance(parsed.minEditDistance, resolvedMaxEditDistance),
        editDistanceStepEvery:
          normalizeIntInRange(parsed.editDistanceStepEvery, EDIT_DISTANCE_STEP_EVERY_RANGE) ??
          DEFAULT_CONFIG.editDistanceStepEvery,
        enableSegmentation:
          normalizeBoolean(parsed.enableSegmentation) ?? DEFAULT_CONFIG.enableSegmentation,
        segmentationMinLength:
          normalizeIntInRange(parsed.segmentationMinLength, {
            min: SEGMENTATION_MIN_LENGTH_RANGE[0],
            max: SEGMENTATION_MIN_LENGTH_RANGE[1],
          }) ?? DEFAULT_CONFIG.segmentationMinLength,
        segmentationMaxEditDistance:
          normalizeIntInRange(parsed.segmentationMaxEditDistance, {
            min: SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[0],
            max: SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[1],
          }) ?? DEFAULT_CONFIG.segmentationMaxEditDistance,
        segmentationLogProbFloor:
          normalizeNumberInRange(parsed.segmentationLogProbFloor, SEGMENTATION_LOG_PROB_FLOOR_RANGE) ??
          DEFAULT_CONFIG.segmentationLogProbFloor,
        segmentationVsLookupBias:
          normalizeNumberInRange(parsed.segmentationVsLookupBias, SEGMENTATION_VS_LOOKUP_BIAS_RANGE) ??
          DEFAULT_CONFIG.segmentationVsLookupBias,
        enableContextRerank:
          normalizeBoolean(parsed.enableContextRerank) ?? DEFAULT_CONFIG.enableContextRerank,
        rerankBigramWeight:
          normalizeNumberInRange(parsed.rerankBigramWeight, RERANK_WEIGHT_RANGE) ??
          DEFAULT_CONFIG.rerankBigramWeight,
        rerankTrigramWeight:
          normalizeNumberInRange(parsed.rerankTrigramWeight, RERANK_WEIGHT_RANGE) ??
          DEFAULT_CONFIG.rerankTrigramWeight,
        rerankEditDistancePenalty:
          normalizeNumberInRange(
            parsed.rerankEditDistancePenalty,
            RERANK_EDIT_DISTANCE_PENALTY_RANGE,
          ) ?? DEFAULT_CONFIG.rerankEditDistancePenalty,
        telemetry:
          normalizeEnum(parsed.telemetry, TELEMETRY_LEVELS) ?? DEFAULT_CONFIG.telemetry,
      };
    } catch (error) {
      this.state = { ...DEFAULT_CONFIG };

      if (isMissingFileError(error)) {
        return;
      }

      if (error instanceof SyntaxError || error instanceof InvalidConfigError) {
        console.warn(`Failed to load mobile-autocorrect config from ${this.filePath}: ${formatError(error)}`);
        return;
      }

      throw error;
    }
  }

  async save(): Promise<void> {
    const snapshot = JSON.stringify(
      {
        version: 1,
        defaultMode: this.state.defaultMode,
        maxEditDistance: this.state.maxEditDistance,
        minWordLength: this.state.minWordLength,
        minEditDistance: this.state.minEditDistance,
        editDistanceStepEvery: this.state.editDistanceStepEvery,
        enableSegmentation: this.state.enableSegmentation,
        segmentationMinLength: this.state.segmentationMinLength,
        segmentationMaxEditDistance: this.state.segmentationMaxEditDistance,
        segmentationLogProbFloor: this.state.segmentationLogProbFloor,
        segmentationVsLookupBias: this.state.segmentationVsLookupBias,
        enableContextRerank: this.state.enableContextRerank,
        rerankBigramWeight: this.state.rerankBigramWeight,
        rerankTrigramWeight: this.state.rerankTrigramWeight,
        rerankEditDistancePenalty: this.state.rerankEditDistancePenalty,
        telemetry: this.state.telemetry,
      } satisfies PersistedConfig,
      null,
      2,
    ).concat("\n");

    const operation = this.saveQueue.then(() => this.writeSnapshot(snapshot));
    this.saveQueue = operation.catch(() => undefined);
    return operation;
  }

  getDefaultMode(): DefaultMode {
    return this.state.defaultMode;
  }

  /**
   * Set the default mode and persist asynchronously. Returns immediately;
   * await the returned promise to observe the persisted result.
   */
  async setDefaultMode(mode: DefaultMode): Promise<void> {
    if (this.state.defaultMode === mode) {
      return;
    }
    this.state.defaultMode = mode;
    await this.save();
  }

  getMaxEditDistance(): number {
    return this.state.maxEditDistance;
  }

  async setMaxEditDistance(value: number): Promise<void> {
    const validated = normalizeIntInRange(value, MAX_EDIT_DISTANCE_RANGE);
    if (validated === undefined) {
      throw new RangeError(
        `maxEditDistance must be an integer in [${MAX_EDIT_DISTANCE_RANGE.min}, ${MAX_EDIT_DISTANCE_RANGE.max}]`,
      );
    }
    if (this.state.maxEditDistance === validated) {
      return;
    }
    this.state.maxEditDistance = validated;
    await this.save();
  }

  getMinWordLength(): number {
    return this.state.minWordLength;
  }

  async setMinWordLength(value: number): Promise<void> {
    const validated = normalizeIntInRange(value, MIN_WORD_LENGTH_RANGE);
    if (validated === undefined) {
      throw new RangeError(
        `minWordLength must be an integer in [${MIN_WORD_LENGTH_RANGE.min}, ${MIN_WORD_LENGTH_RANGE.max}]`,
      );
    }
    if (this.state.minWordLength === validated) {
      return;
    }
    this.state.minWordLength = validated;
    await this.save();
  }

  /** Read the current minEditDistance on every call (no rebuild). */
  getMinEditDistance(): number {
    return this.state.minEditDistance;
  }

  /**
   * Set minEditDistance and persist asynchronously.
   * Throws {@link RangeError} if `value` is non-integer, less than
   * {@link MIN_EDIT_DISTANCE_RANGE_MIN} (0), or greater than the current
   * `maxEditDistance`.
   */
  async setMinEditDistance(value: number): Promise<void> {
    if (
      !Number.isInteger(value) ||
      value < MIN_EDIT_DISTANCE_RANGE_MIN ||
      value > this.state.maxEditDistance
    ) {
      throw new RangeError(
        `minEditDistance must be a non-negative integer not greater than maxEditDistance (${this.state.maxEditDistance})`,
      );
    }
    if (this.state.minEditDistance === value) {
      return;
    }
    this.state.minEditDistance = value;
    await this.save();
  }

  /** Read the current editDistanceStepEvery on every call (no rebuild). */
  getEditDistanceStepEvery(): number {
    return this.state.editDistanceStepEvery;
  }

  /**
   * Set editDistanceStepEvery and persist asynchronously.
   * Throws {@link RangeError} if `value` is outside
   * {@link EDIT_DISTANCE_STEP_EVERY_RANGE} or non-integer.
   */
  async setEditDistanceStepEvery(value: number): Promise<void> {
    const validated = normalizeIntInRange(value, EDIT_DISTANCE_STEP_EVERY_RANGE);
    if (validated === undefined) {
      throw new RangeError(
        `editDistanceStepEvery must be an integer in [${EDIT_DISTANCE_STEP_EVERY_RANGE.min}, ${EDIT_DISTANCE_STEP_EVERY_RANGE.max}]`,
      );
    }
    if (this.state.editDistanceStepEvery === validated) {
      return;
    }
    this.state.editDistanceStepEvery = validated;
    await this.save();
  }

  // ---------------------------------------------------------------------------
  // Task 1.3 — Live accessors for phase-1 keys
  // ---------------------------------------------------------------------------

  getEnableSegmentation(): boolean {
    return this.state.enableSegmentation;
  }

  getSegmentationMinLength(): number {
    return this.state.segmentationMinLength;
  }

  getSegmentationMaxEditDistance(): number {
    return this.state.segmentationMaxEditDistance;
  }

  getSegmentationLogProbFloor(): number {
    return this.state.segmentationLogProbFloor;
  }

  getSegmentationVsLookupBias(): number {
    return this.state.segmentationVsLookupBias;
  }

  getEnableContextRerank(): boolean {
    return this.state.enableContextRerank;
  }

  getRerankBigramWeight(): number {
    return this.state.rerankBigramWeight;
  }

  getRerankTrigramWeight(): number {
    return this.state.rerankTrigramWeight;
  }

  getRerankEditDistancePenalty(): number {
    return this.state.rerankEditDistancePenalty;
  }

  getTelemetry(): TelemetryLevel {
    return this.state.telemetry;
  }

  // ---------------------------------------------------------------------------
  // Task 1.4 — Setters for phase-1 keys
  // ---------------------------------------------------------------------------

  async setEnableSegmentation(value: boolean): Promise<void> {
    if (typeof value !== "boolean") {
      throw new TypeError("enableSegmentation must be a boolean");
    }
    if (this.state.enableSegmentation === value) {
      return;
    }
    this.state.enableSegmentation = value;
    await this.save();
  }

  async setSegmentationMinLength(value: number): Promise<void> {
    const validated = normalizeIntInRange(value, {
      min: SEGMENTATION_MIN_LENGTH_RANGE[0],
      max: SEGMENTATION_MIN_LENGTH_RANGE[1],
    });
    if (validated === undefined) {
      throw new RangeError(
        `segmentationMinLength must be an integer in [${SEGMENTATION_MIN_LENGTH_RANGE[0]}, ${SEGMENTATION_MIN_LENGTH_RANGE[1]}]`,
      );
    }
    if (this.state.segmentationMinLength === validated) {
      return;
    }
    this.state.segmentationMinLength = validated;
    await this.save();
  }

  async setSegmentationMaxEditDistance(value: number): Promise<void> {
    const validated = normalizeIntInRange(value, {
      min: SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[0],
      max: SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[1],
    });
    if (validated === undefined) {
      throw new RangeError(
        `segmentationMaxEditDistance must be an integer in [${SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[0]}, ${SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[1]}]`,
      );
    }
    if (this.state.segmentationMaxEditDistance === validated) {
      return;
    }
    this.state.segmentationMaxEditDistance = validated;
    await this.save();
  }

  async setSegmentationLogProbFloor(value: number): Promise<void> {
    const validated = normalizeNumberInRange(value, SEGMENTATION_LOG_PROB_FLOOR_RANGE);
    if (validated === undefined) {
      throw new RangeError(
        `segmentationLogProbFloor must be a number in [${SEGMENTATION_LOG_PROB_FLOOR_RANGE[0]}, ${SEGMENTATION_LOG_PROB_FLOOR_RANGE[1]}]`,
      );
    }
    if (this.state.segmentationLogProbFloor === validated) {
      return;
    }
    this.state.segmentationLogProbFloor = validated;
    await this.save();
  }

  async setSegmentationVsLookupBias(value: number): Promise<void> {
    const validated = normalizeNumberInRange(value, SEGMENTATION_VS_LOOKUP_BIAS_RANGE);
    if (validated === undefined) {
      throw new RangeError(
        `segmentationVsLookupBias must be a number in [${SEGMENTATION_VS_LOOKUP_BIAS_RANGE[0]}, ${SEGMENTATION_VS_LOOKUP_BIAS_RANGE[1]}]`,
      );
    }
    if (this.state.segmentationVsLookupBias === validated) {
      return;
    }
    this.state.segmentationVsLookupBias = validated;
    await this.save();
  }

  async setEnableContextRerank(value: boolean): Promise<void> {
    if (typeof value !== "boolean") {
      throw new TypeError("enableContextRerank must be a boolean");
    }
    if (this.state.enableContextRerank === value) {
      return;
    }
    this.state.enableContextRerank = value;
    await this.save();
  }

  async setRerankBigramWeight(value: number): Promise<void> {
    const validated = normalizeNumberInRange(value, RERANK_WEIGHT_RANGE);
    if (validated === undefined) {
      throw new RangeError(
        `rerankBigramWeight must be a number in [${RERANK_WEIGHT_RANGE[0]}, ${RERANK_WEIGHT_RANGE[1]}]`,
      );
    }
    if (this.state.rerankBigramWeight === validated) {
      return;
    }
    this.state.rerankBigramWeight = validated;
    await this.save();
  }

  async setRerankTrigramWeight(value: number): Promise<void> {
    const validated = normalizeNumberInRange(value, RERANK_WEIGHT_RANGE);
    if (validated === undefined) {
      throw new RangeError(
        `rerankTrigramWeight must be a number in [${RERANK_WEIGHT_RANGE[0]}, ${RERANK_WEIGHT_RANGE[1]}]`,
      );
    }
    if (this.state.rerankTrigramWeight === validated) {
      return;
    }
    this.state.rerankTrigramWeight = validated;
    await this.save();
  }

  async setRerankEditDistancePenalty(value: number): Promise<void> {
    const validated = normalizeNumberInRange(value, RERANK_EDIT_DISTANCE_PENALTY_RANGE);
    if (validated === undefined) {
      throw new RangeError(
        `rerankEditDistancePenalty must be a number in [${RERANK_EDIT_DISTANCE_PENALTY_RANGE[0]}, ${RERANK_EDIT_DISTANCE_PENALTY_RANGE[1]}]`,
      );
    }
    if (this.state.rerankEditDistancePenalty === validated) {
      return;
    }
    this.state.rerankEditDistancePenalty = validated;
    await this.save();
  }

  async setTelemetry(value: TelemetryLevel): Promise<void> {
    const validated = normalizeEnum(value, TELEMETRY_LEVELS);
    if (validated === undefined) {
      throw new RangeError(
        `telemetry must be one of ${TELEMETRY_LEVELS.map((l) => `"${l}"`).join(", ")}`,
      );
    }
    if (this.state.telemetry === validated) {
      return;
    }
    this.state.telemetry = validated;
    await this.save();
  }

  snapshot(): ConfigSnapshot {
    return { ...this.state };
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, snapshot, "utf8");
    await rename(tempPath, this.filePath);
  }
}

function normalizeDefaultMode(value: unknown): DefaultMode | undefined {
  if (value === "on" || value === "off") {
    return value;
  }
  return undefined;
}

function normalizeIntInRange(
  value: unknown,
  range: { min: number; max: number },
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }
  if (value < range.min || value > range.max) {
    return undefined;
  }
  return value;
}

/**
 * Normalize a finite floating-point number to the given inclusive range.
 * Returns `undefined` for non-numbers, NaN, Infinity, and out-of-range values.
 * Exported so callers outside this module can reuse it for validation.
 */
export function normalizeNumberInRange(
  value: unknown,
  range: readonly [number, number],
): number | undefined {
  if (typeof value !== "number" || !isFinite(value)) {
    return undefined;
  }
  if (value < range[0] || value > range[1]) {
    return undefined;
  }
  return value;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function normalizeEnum<T extends string>(
  value: unknown,
  levels: readonly T[],
): T | undefined {
  if (typeof value === "string" && (levels as readonly string[]).includes(value)) {
    return value as T;
  }
  return undefined;
}

/**
 * Resolve the persisted `minEditDistance` value against the already-resolved
 * `maxEditDistance`.
 *
 * Rules (in order):
 * 1. If the raw value is not a non-negative integer, fall back to the bootstrap
 *    default (`DEFAULT_CONFIG.minEditDistance`).
 * 2. If the raw value is valid but exceeds `resolvedMaxEditDistance` (invariant
 *    violation), **preserve** `resolvedMaxEditDistance` (the user may have set
 *    it deliberately) and repair `minEditDistance` to
 *    `min(DEFAULT_CONFIG.minEditDistance, resolvedMaxEditDistance)`.
 * 3. Otherwise accept the raw value as-is.
 */
function resolveMinEditDistance(rawValue: unknown, resolvedMaxEditDistance: number): number {
  if (
    typeof rawValue !== "number" ||
    !Number.isInteger(rawValue) ||
    rawValue < MIN_EDIT_DISTANCE_RANGE_MIN
  ) {
    return DEFAULT_CONFIG.minEditDistance;
  }
  if (rawValue > resolvedMaxEditDistance) {
    return Math.min(DEFAULT_CONFIG.minEditDistance, resolvedMaxEditDistance);
  }
  return rawValue;
}

class InvalidConfigError extends Error {}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
