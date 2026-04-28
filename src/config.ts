import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type DefaultMode = "on" | "off";

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
};

type PersistedConfig = {
  version: 1;
  defaultMode?: DefaultMode;
  maxEditDistance?: number;
  minWordLength?: number;
  minEditDistance?: number;
  editDistanceStepEvery?: number;
};

export const DEFAULT_CONFIG: ConfigSnapshot = Object.freeze({
  defaultMode: "off" as const,
  maxEditDistance: 2,
  minWordLength: 2,
  minEditDistance: 1,
  editDistanceStepEvery: 4,
});

export const MAX_EDIT_DISTANCE_RANGE = Object.freeze({ min: 1, max: 4 });
export const MIN_WORD_LENGTH_RANGE = Object.freeze({ min: 2, max: 8 });
/** Absolute minimum value for minEditDistance (the lower bound never changes). */
export const MIN_EDIT_DISTANCE_RANGE_MIN = 0;
/** Range for editDistanceStepEvery: number of characters of word-length growth per +1 ED step. */
export const EDIT_DISTANCE_STEP_EVERY_RANGE = Object.freeze({ min: 1, max: 8 });

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
