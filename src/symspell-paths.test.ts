import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveSymspellPackageRoot } from "./symspell-paths.js";

describe("resolveSymspellPackageRoot", () => {
  test("returns a non-null directory path", () => {
    const root = resolveSymspellPackageRoot();
    expect(root).not.toBeNull();
    expect(typeof root).toBe("string");
  });

  test("returned directory contains data/frequency_dictionary_en_82_765.txt", () => {
    const root = resolveSymspellPackageRoot();
    expect(root).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const dictPath = join(root!, "data", "frequency_dictionary_en_82_765.txt");
    expect(existsSync(dictPath)).toBe(true);
  });
});
