import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  Config,
  DEFAULT_CONFIG,
  EDIT_DISTANCE_STEP_EVERY_RANGE,
  MIN_EDIT_DISTANCE_RANGE_MIN,
} from "./config.js";

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

    // 4 is now valid (ceiling raised from 3 to 4)
    await config.setMaxEditDistance(4);
    expect(config.getMaxEditDistance()).toBe(4);

    await expect(config.setMaxEditDistance(0)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setMaxEditDistance(5)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setMaxEditDistance(1.5)).rejects.toBeInstanceOf(RangeError);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getMaxEditDistance()).toBe(4);
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

  // ---------------------------------------------------------------------------
  // 1.6.1 Defaults applied when keys absent
  // ---------------------------------------------------------------------------
  test("1.6.1 applies bootstrap defaults for minEditDistance and editDistanceStepEvery when keys are absent", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load(); // no file

    expect(config.getMinEditDistance()).toBe(DEFAULT_CONFIG.minEditDistance);
    expect(config.getMinEditDistance()).toBe(1);
    expect(config.getEditDistanceStepEvery()).toBe(DEFAULT_CONFIG.editDistanceStepEvery);
    expect(config.getEditDistanceStepEvery()).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // 1.6.2 Out-of-range persisted values for new keys fall back to defaults
  // ---------------------------------------------------------------------------
  test("1.6.2 out-of-range persisted minEditDistance falls back to the bootstrap default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, minEditDistance: -1 }),
      "utf8",
    );

    const config = new Config({ filePath });
    await config.load();

    expect(config.getMinEditDistance()).toBe(DEFAULT_CONFIG.minEditDistance);
  });

  test("1.6.2 non-integer persisted minEditDistance falls back to the bootstrap default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, minEditDistance: 1.5 }),
      "utf8",
    );

    const config = new Config({ filePath });
    await config.load();

    expect(config.getMinEditDistance()).toBe(DEFAULT_CONFIG.minEditDistance);
  });

  test("1.6.2 out-of-range persisted editDistanceStepEvery falls back to the bootstrap default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, editDistanceStepEvery: 0 }),
      "utf8",
    );

    const config1 = new Config({ filePath });
    await config1.load();
    expect(config1.getEditDistanceStepEvery()).toBe(DEFAULT_CONFIG.editDistanceStepEvery);

    await writeFile(
      filePath,
      JSON.stringify({ version: 1, editDistanceStepEvery: 9 }),
      "utf8",
    );

    const config2 = new Config({ filePath });
    await config2.load();
    expect(config2.getEditDistanceStepEvery()).toBe(DEFAULT_CONFIG.editDistanceStepEvery);
  });

  // ---------------------------------------------------------------------------
  // 1.6.3 setMinEditDistance write validation
  // ---------------------------------------------------------------------------
  test("1.6.3 setMinEditDistance persists valid values and rejects out-of-range inputs", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    // Valid: 0 is allowed (floor = MIN_EDIT_DISTANCE_RANGE_MIN)
    await config.setMinEditDistance(MIN_EDIT_DISTANCE_RANGE_MIN);
    expect(config.getMinEditDistance()).toBe(0);

    // Valid: up to current maxEditDistance (2)
    await config.setMinEditDistance(2);
    expect(config.getMinEditDistance()).toBe(2);

    // Invalid: non-integer
    await expect(config.setMinEditDistance(1.5)).rejects.toBeInstanceOf(RangeError);

    // Invalid: negative
    await expect(config.setMinEditDistance(-1)).rejects.toBeInstanceOf(RangeError);

    // Invalid: exceeds current maxEditDistance (2)
    await expect(config.setMinEditDistance(3)).rejects.toBeInstanceOf(RangeError);

    // Persisted value is last successful write
    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getMinEditDistance()).toBe(2);
  });

  test("1.6.3 setEditDistanceStepEvery persists valid values and rejects out-of-range inputs", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setEditDistanceStepEvery(EDIT_DISTANCE_STEP_EVERY_RANGE.min);
    expect(config.getEditDistanceStepEvery()).toBe(1);

    await config.setEditDistanceStepEvery(EDIT_DISTANCE_STEP_EVERY_RANGE.max);
    expect(config.getEditDistanceStepEvery()).toBe(8);

    await expect(config.setEditDistanceStepEvery(0)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setEditDistanceStepEvery(9)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setEditDistanceStepEvery(2.5)).rejects.toBeInstanceOf(RangeError);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getEditDistanceStepEvery()).toBe(8);
  });

  // ---------------------------------------------------------------------------
  // 1.6.4 Persisted minEditDistance > maxEditDistance: preserve maxEditDistance,
  //        repair minEditDistance to min(default, persisted_max)
  // ---------------------------------------------------------------------------
  test("1.6.4 persisted minEditDistance > maxEditDistance preserves maxEditDistance and repairs minEditDistance", async () => {
    const filePath = join(tempDir, "config.json");
    // maxEditDistance=2 is a valid value the user set; minEditDistance=3
    // violates the invariant (3 > 2) but is a valid absolute integer.
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, maxEditDistance: 2, minEditDistance: 3 }),
      "utf8",
    );

    const config = new Config({ filePath });
    await config.load();

    // User's maxEditDistance MUST be preserved
    expect(config.getMaxEditDistance()).toBe(2);
    // minEditDistance is repaired to min(DEFAULT=1, persistedMax=2) = 1
    expect(config.getMinEditDistance()).toBe(Math.min(DEFAULT_CONFIG.minEditDistance, 2));
    expect(config.getMinEditDistance()).toBe(1);
  });

  test("1.6.4 persisted minEditDistance > maxEditDistance with very low maxEditDistance still preserves maxEditDistance", async () => {
    const filePath = join(tempDir, "config.json");
    // maxEditDistance=1 (the minimum valid value); minEditDistance=2 violates invariant
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, maxEditDistance: 1, minEditDistance: 2 }),
      "utf8",
    );

    const config = new Config({ filePath });
    await config.load();

    expect(config.getMaxEditDistance()).toBe(1);
    // min(DEFAULT=1, persistedMax=1) = 1
    expect(config.getMinEditDistance()).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 1.6.5 Existing config files (without new keys) load unchanged
  // ---------------------------------------------------------------------------
  test("1.6.5 existing config files without new keys load with defaults for the new fields", async () => {
    const filePath = join(tempDir, "config.json");
    // Simulate a config file written before the new keys were introduced
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, defaultMode: "on", maxEditDistance: 3, minWordLength: 3 }),
      "utf8",
    );

    const config = new Config({ filePath });
    await config.load();

    // Existing values must be preserved exactly
    expect(config.getDefaultMode()).toBe("on");
    expect(config.getMaxEditDistance()).toBe(3);
    expect(config.getMinWordLength()).toBe(3);

    // New keys fall back to bootstrap defaults
    expect(config.getMinEditDistance()).toBe(DEFAULT_CONFIG.minEditDistance);
    expect(config.getEditDistanceStepEvery()).toBe(DEFAULT_CONFIG.editDistanceStepEvery);
  });
});
