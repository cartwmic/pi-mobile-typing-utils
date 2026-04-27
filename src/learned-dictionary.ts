import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type DictEntry = {
  added: string;
  source: "learned" | "manual";
  rejections: number;
};

type PersistedDictionary = {
  version: 1;
  words: Record<string, DictEntry>;
  pendingRejections?: Record<string, number>;
};

export class LearnedDictionary {
  private words: Map<string, DictEntry> = new Map();
  private pendingRejections: Map<string, number> = new Map();
  private readonly filePath: string;
  private readonly maxSize = 10000;
  private readonly rejectionThreshold = 2;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(opts: { filePath: string }) {
    this.filePath = opts.filePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedDictionary;

      if (!parsed || typeof parsed !== "object" || !parsed.words || typeof parsed.words !== "object") {
        throw new InvalidDictionaryError("Invalid learned dictionary file format");
      }

      this.words = new Map(
        Object.entries(parsed.words).map(([word, entry]) => [
          word.toLowerCase(),
          {
            added: String(entry.added),
            source: entry.source === "manual" ? "manual" : "learned",
            rejections: Number.isFinite(entry.rejections) ? entry.rejections : 0,
          },
        ]),
      );

      this.pendingRejections = new Map(
        Object.entries(parsed.pendingRejections ?? {}).map(([word, count]) => [
          word.toLowerCase(),
          Number.isFinite(count) ? count : 0,
        ]),
      );
    } catch (error) {
      this.words = new Map();
      this.pendingRejections = new Map();

      // Missing file on first run is the expected initial state, not an error.
      // Per spec (Scenario: Dictionary file does not exist) we start with an empty
      // dictionary and create the file on first write — silently.
      if (isMissingFileError(error)) {
        return;
      }

      if (error instanceof SyntaxError || error instanceof InvalidDictionaryError) {
        console.warn(`Failed to load learned dictionary from ${this.filePath}: ${formatError(error)}`);
        return;
      }

      throw error;
    }
  }

  async save(): Promise<void> {
    const snapshot = JSON.stringify(
      {
        version: 1,
        words: Object.fromEntries(this.words),
        pendingRejections: Object.fromEntries(this.pendingRejections),
      },
      null,
      2,
    ).concat("\n");

    const operation = this.saveQueue.then(() => this.writeSnapshot(snapshot));
    this.saveQueue = operation.catch(() => undefined);
    return operation;
  }

  has(word: string): boolean {
    return this.words.has(normalizeWord(word));
  }

  add(word: string, source: "learned" | "manual"): void {
    const lower = normalizeWord(word);
    const entry: DictEntry = {
      added: new Date().toISOString(),
      source,
      rejections: 0,
    };

    this.insertWord(lower, entry);
    void this.save();
  }

  remove(word: string): boolean {
    const lower = normalizeWord(word);
    const removed = this.words.delete(lower);

    if (removed) {
      void this.save();
    }

    return removed;
  }

  search(term: string): Array<{ word: string; entry: DictEntry }> {
    const lowerTerm = normalizeWord(term);
    return this.getSortedEntries().filter(({ word }) => word.includes(lowerTerm));
  }

  clear(): number {
    const removed = this.words.size;

    if (removed === 0) {
      return 0;
    }

    this.words.clear();
    void this.save();
    return removed;
  }

  getAll(): Array<{ word: string; entry: DictEntry }> {
    return this.getSortedEntries();
  }

  getPending(): Array<{ word: string; rejections: number }> {
    return [...this.pendingRejections.entries()]
      .map(([word, rejections]) => ({ word, rejections }))
      .sort((a, b) => {
        if (b.rejections !== a.rejections) {
          return b.rejections - a.rejections;
        }

        return a.word.localeCompare(b.word);
      });
  }

  get size(): number {
    return this.words.size;
  }

  recordRejection(originalWord: string): { learned: boolean; word: string } {
    const lower = normalizeWord(originalWord);

    if (this.words.has(lower)) {
      return { learned: false, word: lower };
    }

    const count = (this.pendingRejections.get(lower) ?? 0) + 1;
    this.pendingRejections.set(lower, count);

    if (count >= this.rejectionThreshold) {
      this.pendingRejections.delete(lower);
      this.insertWord(lower, {
        added: new Date().toISOString(),
        source: "learned",
        rejections: count,
      });
      void this.save();
      return { learned: true, word: lower };
    }

    void this.save();
    return { learned: false, word: lower };
  }

  private insertWord(word: string, entry: DictEntry): void {
    const exists = this.words.has(word);

    if (!exists && this.words.size >= this.maxSize) {
      let oldestWord: string | undefined;
      let oldestAdded: string | undefined;

      for (const [candidateWord, candidateEntry] of this.words.entries()) {
        if (!oldestAdded || candidateEntry.added < oldestAdded) {
          oldestWord = candidateWord;
          oldestAdded = candidateEntry.added;
        }
      }

      if (oldestWord) {
        this.words.delete(oldestWord);
      }
    }

    this.words.set(word, entry);
  }

  private getSortedEntries(): Array<{ word: string; entry: DictEntry }> {
    return [...this.words.entries()]
      .map(([word, entry]) => ({ word, entry }))
      .sort((a, b) => b.entry.added.localeCompare(a.entry.added));
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    const parentDir = dirname(this.filePath);
    const tempPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;

    await mkdir(parentDir, { recursive: true });

    try {
      await writeFile(tempPath, snapshot, "utf8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}

function normalizeWord(word: string): string {
  return word.toLowerCase();
}

class InvalidDictionaryError extends Error {}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
