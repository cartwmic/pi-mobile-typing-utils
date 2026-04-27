import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Config, DEFAULT_CONFIG } from "./config.js";

describe("Config", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = join(tmpdir(), `config-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns the bootstrap default mode when the file does not exist", async () => {
    const config = new Config({ filePath: join(tempDir, "missing.json") });
    await config.load();

    expect(config.getDefaultMode()).toBe(DEFAULT_CONFIG.defaultMode);
    expect(config.getDefaultMode()).toBe("off");
  });

  test("setDefaultMode persists the new value atomically", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setDefaultMode("on");

    const persisted = await readFile(filePath, "utf8");
    const parsed = JSON.parse(persisted) as { version: number; defaultMode: string };
    expect(parsed.version).toBe(1);
    expect(parsed.defaultMode).toBe("on");

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getDefaultMode()).toBe("on");
  });

  test("setDefaultMode is a no-op when the value is unchanged", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setDefaultMode("off");

    // No save happened — no file written.
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("falls back to the bootstrap default for malformed JSON without throwing", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(filePath, "{ not valid json", "utf8");

    const config = new Config({ filePath });
    await config.load();

    expect(config.getDefaultMode()).toBe("off");
  });

  test("ignores unknown defaultMode values and falls back to the bootstrap default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(filePath, JSON.stringify({ version: 1, defaultMode: "maybe" }), "utf8");

    const config = new Config({ filePath });
    await config.load();

    expect(config.getDefaultMode()).toBe("off");
  });

  test("returns the bootstrap defaults for the tuning fields", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load();

    expect(config.getMaxEditDistance()).toBe(2);
    expect(config.getMinWordLength()).toBe(2);
  });

  test("setMaxEditDistance persists in-range integers and rejects everything else", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setMaxEditDistance(3);
    expect(config.getMaxEditDistance()).toBe(3);

    await expect(config.setMaxEditDistance(0)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setMaxEditDistance(4)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setMaxEditDistance(1.5)).rejects.toBeInstanceOf(RangeError);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getMaxEditDistance()).toBe(3);
  });

  test("setMinWordLength persists in-range integers and rejects everything else", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setMinWordLength(5);
    expect(config.getMinWordLength()).toBe(5);

    await expect(config.setMinWordLength(1)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setMinWordLength(9)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setMinWordLength(2.5)).rejects.toBeInstanceOf(RangeError);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getMinWordLength()).toBe(5);
  });

  test("out-of-range persisted values fall back to the bootstrap defaults", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, defaultMode: "on", maxEditDistance: 99, minWordLength: 0 }),
      "utf8",
    );

    const config = new Config({ filePath });
    await config.load();

    expect(config.getDefaultMode()).toBe("on"); // valid — preserved
    expect(config.getMaxEditDistance()).toBe(2); // out of range — default
    expect(config.getMinWordLength()).toBe(2); // out of range — default
  });
});
