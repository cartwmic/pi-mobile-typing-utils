import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type DefaultMode = "on" | "off";

export type ConfigSnapshot = {
  defaultMode: DefaultMode;
};

type PersistedConfig = {
  version: 1;
  defaultMode?: DefaultMode;
};

export const DEFAULT_CONFIG: ConfigSnapshot = Object.freeze({
  defaultMode: "off" as const,
});

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
