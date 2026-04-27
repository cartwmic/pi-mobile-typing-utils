import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LearnedDictionary } from "./learned-dictionary.js";

type PersistedDictionary = {
  version: 1;
  words: Record<string, { added: string; source: "learned" | "manual"; rejections: number }>;
  pendingRejections: Record<string, number>;
};

describe("LearnedDictionary", () => {
  let tempDir = "";
  let filePath = "";

  beforeEach(async () => {
    tempDir = join(tmpdir(), `learned-dict-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    filePath = join(tempDir, "dictionary.json");
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("persists learned words and pending rejections across load/save", async () => {
    const dictionaryA = createDictionary();

    dictionaryA.add("nginx", "manual");
    dictionaryA.add("graphql", "manual");
    expect(dictionaryA.recordRejection("termux")).toEqual({ learned: false, word: "termux" });
    await dictionaryA.save();

    const dictionaryB = createDictionary();
    await dictionaryB.load();

    expect(dictionaryB.has("nginx")).toBe(true);
    expect(dictionaryB.has("GRAPHQL")).toBe(true);

    await dictionaryB.save();

    const persisted = await readPersisted();
    expect(persisted.words.nginx.source).toBe("manual");
    expect(persisted.words.graphql.source).toBe("manual");
    expect(persisted.pendingRejections).toEqual({ termux: 1 });
  });

  test("counts rejections across simulated sessions", async () => {
    const dictionaryA = createDictionary();

    expect(dictionaryA.recordRejection("termux")).toEqual({ learned: false, word: "termux" });
    await dictionaryA.save();

    const dictionaryB = createDictionary();
    await dictionaryB.load();

    expect(dictionaryB.recordRejection("TERMUX")).toEqual({ learned: true, word: "termux" });
    await dictionaryB.save();

    expect(dictionaryB.has("termux")).toBe(true);

    const persisted = await readPersisted();
    expect(persisted.words.termux.source).toBe("learned");
    expect(persisted.words.termux.rejections).toBe(2);
    expect(persisted.pendingRejections).not.toHaveProperty("termux");
  });

  test("learns a word after two rejections", async () => {
    const dictionary = createDictionary();

    expect(dictionary.recordRejection("Termux")).toEqual({ learned: false, word: "termux" });
    expect(dictionary.recordRejection("TERMUX")).toEqual({ learned: true, word: "termux" });
    await dictionary.save();

    expect(dictionary.has("termux")).toBe(true);

    const persisted = await readPersisted();
    expect(persisted.words.termux.source).toBe("learned");
    expect(persisted.words.termux.rejections).toBe(2);
    expect(persisted.pendingRejections).not.toHaveProperty("termux");
  });

  test("enforces the size cap with FIFO eviction", () => {
    vi.useFakeTimers();

    const dictionary = createDictionary();
    vi.spyOn(dictionary, "save").mockResolvedValue();

    const start = Date.parse("2024-01-01T00:00:00.000Z");

    for (let index = 0; index <= 10000; index += 1) {
      vi.setSystemTime(new Date(start + index));
      dictionary.add(`word${index}`, "manual");
    }

    expect(dictionary.size).toBe(10000);
    expect(dictionary.has("word0")).toBe(false);
    expect(dictionary.has("word1")).toBe(true);
    expect(dictionary.has("word10000")).toBe(true);
  });

  test("search performs case-insensitive substring matching", () => {
    vi.useFakeTimers();

    const dictionary = createDictionary();
    vi.spyOn(dictionary, "save").mockResolvedValue();

    const start = Date.parse("2024-01-01T00:00:00.000Z");

    vi.setSystemTime(new Date(start));
    dictionary.add("Termux", "manual");

    vi.setSystemTime(new Date(start + 1));
    dictionary.add("terminal", "manual");

    vi.setSystemTime(new Date(start + 2));
    dictionary.add("alpha", "manual");

    expect(dictionary.search("TER").map(({ word }) => word)).toEqual(["terminal", "termux"]);
  });

  test("add, remove, clear, getAll, and size behave as expected", async () => {
    vi.useFakeTimers();

    const dictionary = createDictionary();
    const start = Date.parse("2024-01-01T00:00:00.000Z");

    vi.setSystemTime(new Date(start));
    dictionary.add("alpha", "manual");

    vi.setSystemTime(new Date(start + 1));
    dictionary.add("beta", "manual");

    expect(dictionary.size).toBe(2);
    expect(dictionary.getAll().map(({ word }) => word)).toEqual(["beta", "alpha"]);
    expect(dictionary.remove("ALPHA")).toBe(true);
    expect(dictionary.remove("alpha")).toBe(false);
    expect(dictionary.size).toBe(1);

    expect(dictionary.recordRejection("termux")).toEqual({ learned: false, word: "termux" });

    const cleared = dictionary.clear();
    await dictionary.save();

    expect(cleared).toBe(1);
    expect(dictionary.size).toBe(0);

    const persisted = await readPersisted();
    expect(persisted.words).toEqual({});
    expect(persisted.pendingRejections).toEqual({ termux: 1 });
  });

  test("handles corrupt dictionary files without throwing", async () => {
    await writeFile(filePath, "this is not json", "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dictionary = createDictionary();

    await expect(dictionary.load()).resolves.toBeUndefined();

    expect(dictionary.size).toBe(0);
    expect(dictionary.getAll()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  test("normalizes case for add, has, remove, and search", async () => {
    const dictionary = createDictionary();

    dictionary.add("Termux", "manual");
    await dictionary.save();

    const persisted = await readPersisted();
    expect(Object.keys(persisted.words)).toEqual(["termux"]);
    expect(dictionary.has("TERMUX")).toBe(true);
    expect(dictionary.search("TER").map(({ word }) => word)).toEqual(["termux"]);
    expect(dictionary.remove("Termux")).toBe(true);
    await dictionary.save();
    expect(dictionary.has("termux")).toBe(false);
  });

  test("loads silently when dictionary file does not exist (first run)", async () => {
    // Per spec (dictionary-management): missing file on startup is the expected
    // initial state. The extension SHALL start with an empty dictionary and
    // SHALL NOT log a warning.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dictionary = createDictionary();
      await expect(dictionary.load()).resolves.toBeUndefined();
      expect(dictionary.size).toBe(0);
      expect(dictionary.getAll()).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("creates missing parent directories on first save", async () => {
    const nestedFilePath = join(tempDir, "missing", "nested", "dictionary.json");
    const dictionary = createDictionary(nestedFilePath);

    dictionary.add("termux", "manual");
    await dictionary.save();

    await expect(access(nestedFilePath)).resolves.toBeUndefined();

    const persisted = JSON.parse(await readFile(nestedFilePath, "utf8")) as PersistedDictionary;
    expect(persisted.words.termux.source).toBe("manual");
  });

  function createDictionary(customFilePath = filePath): LearnedDictionary {
    return new LearnedDictionary({ filePath: customFilePath });
  }

  async function readPersisted(customFilePath = filePath): Promise<PersistedDictionary> {
    return JSON.parse(await readFile(customFilePath, "utf8")) as PersistedDictionary;
  }
});
