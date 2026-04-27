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
};

type PersistedConfig = {
  version: 1;
  defaultMode?: DefaultMode;
  maxEditDistance?: number;
  minWordLength?: number;
};

export const DEFAULT_CONFIG: ConfigSnapshot = Object.freeze({
  defaultMode: "off" as const,
  maxEditDistance: 2,
  minWordLength: 2,
});

export const MAX_EDIT_DISTANCE_RANGE = Object.freeze({ min: 1, max: 3 });
export const MIN_WORD_LENGTH_RANGE = Object.freeze({ min: 2, max: 8 });

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

      this.state = {
        defaultMode: normalizeDefaultMode(parsed.defaultMode) ?? DEFAULT_CONFIG.defaultMode,
        maxEditDistance:
          normalizeIntInRange(parsed.maxEditDistance, MAX_EDIT_DISTANCE_RANGE) ??
          DEFAULT_CONFIG.maxEditDistance,
        minWordLength:
          normalizeIntInRange(parsed.minWordLength, MIN_WORD_LENGTH_RANGE) ??
          DEFAULT_CONFIG.minWordLength,
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
