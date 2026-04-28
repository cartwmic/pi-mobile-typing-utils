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
  RERANK_EDIT_DISTANCE_PENALTY_RANGE,
  RERANK_WEIGHT_RANGE,
  SEGMENTATION_LOG_PROB_FLOOR_RANGE,
  SEGMENTATION_MAX_EDIT_DISTANCE_RANGE,
  SEGMENTATION_MIN_LENGTH_RANGE,
  SEGMENTATION_VS_LOOKUP_BIAS_RANGE,
  TELEMETRY_LEVELS,
  normalizeNumberInRange,
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

  // ===========================================================================
  // Phase-1 keys (tasks 1.1–1.6)
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // Bootstrap defaults for all new keys
  // ---------------------------------------------------------------------------
  test("phase-1: returns bootstrap defaults for all new keys when no file exists", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load();

    expect(config.getEnableSegmentation()).toBe(DEFAULT_CONFIG.enableSegmentation);
    expect(config.getEnableSegmentation()).toBe(true);
    expect(config.getSegmentationMinLength()).toBe(DEFAULT_CONFIG.segmentationMinLength);
    expect(config.getSegmentationMinLength()).toBe(6);
    expect(config.getSegmentationMaxEditDistance()).toBe(DEFAULT_CONFIG.segmentationMaxEditDistance);
    expect(config.getSegmentationMaxEditDistance()).toBe(1);
    expect(config.getSegmentationLogProbFloor()).toBe(DEFAULT_CONFIG.segmentationLogProbFloor);
    expect(config.getSegmentationLogProbFloor()).toBe(-12.0);
    expect(config.getSegmentationVsLookupBias()).toBe(DEFAULT_CONFIG.segmentationVsLookupBias);
    expect(config.getSegmentationVsLookupBias()).toBe(0.0);
    expect(config.getEnableContextRerank()).toBe(DEFAULT_CONFIG.enableContextRerank);
    expect(config.getEnableContextRerank()).toBe(true);
    expect(config.getRerankBigramWeight()).toBe(DEFAULT_CONFIG.rerankBigramWeight);
    expect(config.getRerankBigramWeight()).toBe(0.5);
    expect(config.getRerankTrigramWeight()).toBe(DEFAULT_CONFIG.rerankTrigramWeight);
    expect(config.getRerankTrigramWeight()).toBe(0.3);
    expect(config.getRerankEditDistancePenalty()).toBe(DEFAULT_CONFIG.rerankEditDistancePenalty);
    expect(config.getRerankEditDistancePenalty()).toBe(1.0);
    expect(config.getTelemetry()).toBe(DEFAULT_CONFIG.telemetry);
    expect(config.getTelemetry()).toBe("metrics");
  });

  // ---------------------------------------------------------------------------
  // enableSegmentation
  // ---------------------------------------------------------------------------
  test("setEnableSegmentation: round-trips true/false and persists atomically", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setEnableSegmentation(false);
    expect(config.getEnableSegmentation()).toBe(false);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getEnableSegmentation()).toBe(false);

    await config.setEnableSegmentation(true);
    expect(config.getEnableSegmentation()).toBe(true);

    const reloaded2 = new Config({ filePath });
    await reloaded2.load();
    expect(reloaded2.getEnableSegmentation()).toBe(true);
  });

  test("setEnableSegmentation: rejects non-boolean values", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(config.setEnableSegmentation("true" as any)).rejects.toBeInstanceOf(TypeError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(config.setEnableSegmentation(1 as any)).rejects.toBeInstanceOf(TypeError);
  });

  test("load: coerces invalid persisted enableSegmentation to default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, enableSegmentation: "yes" }),
      "utf8",
    );
    const config = new Config({ filePath });
    await config.load();
    expect(config.getEnableSegmentation()).toBe(DEFAULT_CONFIG.enableSegmentation);
  });

  // ---------------------------------------------------------------------------
  // segmentationMinLength
  // ---------------------------------------------------------------------------
  test("setSegmentationMinLength: round-trips and persists in-range integers", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setSegmentationMinLength(SEGMENTATION_MIN_LENGTH_RANGE[0]);
    expect(config.getSegmentationMinLength()).toBe(4);

    await config.setSegmentationMinLength(SEGMENTATION_MIN_LENGTH_RANGE[1]);
    expect(config.getSegmentationMinLength()).toBe(12);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getSegmentationMinLength()).toBe(12);
  });

  test("setSegmentationMinLength: rejects out-of-range and non-integer values", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load();

    await expect(config.setSegmentationMinLength(3)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setSegmentationMinLength(13)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setSegmentationMinLength(6.5)).rejects.toBeInstanceOf(RangeError);
  });

  test("load: coerces out-of-range persisted segmentationMinLength to default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, segmentationMinLength: 99 }),
      "utf8",
    );
    const config = new Config({ filePath });
    await config.load();
    expect(config.getSegmentationMinLength()).toBe(DEFAULT_CONFIG.segmentationMinLength);
  });

  // ---------------------------------------------------------------------------
  // segmentationMaxEditDistance
  // ---------------------------------------------------------------------------
  test("setSegmentationMaxEditDistance: round-trips and persists in-range integers", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setSegmentationMaxEditDistance(SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[0]);
    expect(config.getSegmentationMaxEditDistance()).toBe(0);

    await config.setSegmentationMaxEditDistance(SEGMENTATION_MAX_EDIT_DISTANCE_RANGE[1]);
    expect(config.getSegmentationMaxEditDistance()).toBe(2);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getSegmentationMaxEditDistance()).toBe(2);
  });

  test("setSegmentationMaxEditDistance: rejects out-of-range and non-integer values", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load();

    await expect(config.setSegmentationMaxEditDistance(-1)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setSegmentationMaxEditDistance(3)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setSegmentationMaxEditDistance(1.5)).rejects.toBeInstanceOf(RangeError);
  });

  test("load: coerces out-of-range persisted segmentationMaxEditDistance to default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, segmentationMaxEditDistance: 5 }),
      "utf8",
    );
    const config = new Config({ filePath });
    await config.load();
    expect(config.getSegmentationMaxEditDistance()).toBe(DEFAULT_CONFIG.segmentationMaxEditDistance);
  });

  // ---------------------------------------------------------------------------
  // segmentationLogProbFloor
  // ---------------------------------------------------------------------------
  test("setSegmentationLogProbFloor: round-trips and persists in-range floats", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setSegmentationLogProbFloor(-20.5);
    expect(config.getSegmentationLogProbFloor()).toBe(-20.5);

    await config.setSegmentationLogProbFloor(SEGMENTATION_LOG_PROB_FLOOR_RANGE[0]);
    expect(config.getSegmentationLogProbFloor()).toBe(-30);

    await config.setSegmentationLogProbFloor(SEGMENTATION_LOG_PROB_FLOOR_RANGE[1]);
    expect(config.getSegmentationLogProbFloor()).toBe(0);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getSegmentationLogProbFloor()).toBe(0);
  });

  test("setSegmentationLogProbFloor: rejects out-of-range and non-finite values", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load();

    await expect(config.setSegmentationLogProbFloor(-31)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setSegmentationLogProbFloor(1)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setSegmentationLogProbFloor(Infinity)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setSegmentationLogProbFloor(NaN)).rejects.toBeInstanceOf(RangeError);
  });

  test("load: coerces out-of-range persisted segmentationLogProbFloor to default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, segmentationLogProbFloor: -100 }),
      "utf8",
    );
    const config = new Config({ filePath });
    await config.load();
    expect(config.getSegmentationLogProbFloor()).toBe(DEFAULT_CONFIG.segmentationLogProbFloor);
  });

  // ---------------------------------------------------------------------------
  // segmentationVsLookupBias
  // ---------------------------------------------------------------------------
  test("setSegmentationVsLookupBias: round-trips and persists in-range floats", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setSegmentationVsLookupBias(3.5);
    expect(config.getSegmentationVsLookupBias()).toBe(3.5);

    await config.setSegmentationVsLookupBias(SEGMENTATION_VS_LOOKUP_BIAS_RANGE[0]);
    expect(config.getSegmentationVsLookupBias()).toBe(-10);

    await config.setSegmentationVsLookupBias(SEGMENTATION_VS_LOOKUP_BIAS_RANGE[1]);
    expect(config.getSegmentationVsLookupBias()).toBe(10);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getSegmentationVsLookupBias()).toBe(10);
  });

  test("setSegmentationVsLookupBias: rejects out-of-range and non-finite values", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load();

    await expect(config.setSegmentationVsLookupBias(-11)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setSegmentationVsLookupBias(11)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setSegmentationVsLookupBias(NaN)).rejects.toBeInstanceOf(RangeError);
  });

  test("load: coerces out-of-range persisted segmentationVsLookupBias to default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, segmentationVsLookupBias: 999 }),
      "utf8",
    );
    const config = new Config({ filePath });
    await config.load();
    expect(config.getSegmentationVsLookupBias()).toBe(DEFAULT_CONFIG.segmentationVsLookupBias);
  });

  // ---------------------------------------------------------------------------
  // enableContextRerank
  // ---------------------------------------------------------------------------
  test("setEnableContextRerank: round-trips true/false and persists atomically", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setEnableContextRerank(false);
    expect(config.getEnableContextRerank()).toBe(false);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getEnableContextRerank()).toBe(false);
  });

  test("setEnableContextRerank: rejects non-boolean values", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(config.setEnableContextRerank(0 as any)).rejects.toBeInstanceOf(TypeError);
  });

  test("load: coerces invalid persisted enableContextRerank to default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, enableContextRerank: "true" }),
      "utf8",
    );
    const config = new Config({ filePath });
    await config.load();
    expect(config.getEnableContextRerank()).toBe(DEFAULT_CONFIG.enableContextRerank);
  });

  // ---------------------------------------------------------------------------
  // rerankBigramWeight
  // ---------------------------------------------------------------------------
  test("setRerankBigramWeight: round-trips and persists in-range floats", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setRerankBigramWeight(0.7);
    expect(config.getRerankBigramWeight()).toBe(0.7);

    await config.setRerankBigramWeight(RERANK_WEIGHT_RANGE[0]);
    expect(config.getRerankBigramWeight()).toBe(0);

    await config.setRerankBigramWeight(RERANK_WEIGHT_RANGE[1]);
    expect(config.getRerankBigramWeight()).toBe(1);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getRerankBigramWeight()).toBe(1);
  });

  test("setRerankBigramWeight: rejects out-of-range and non-finite values", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load();

    await expect(config.setRerankBigramWeight(-0.1)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setRerankBigramWeight(1.1)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setRerankBigramWeight(NaN)).rejects.toBeInstanceOf(RangeError);
  });

  test("load: coerces out-of-range persisted rerankBigramWeight to default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, rerankBigramWeight: 2 }),
      "utf8",
    );
    const config = new Config({ filePath });
    await config.load();
    expect(config.getRerankBigramWeight()).toBe(DEFAULT_CONFIG.rerankBigramWeight);
  });

  // ---------------------------------------------------------------------------
  // rerankTrigramWeight
  // ---------------------------------------------------------------------------
  test("setRerankTrigramWeight: round-trips and persists in-range floats", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setRerankTrigramWeight(0.1);
    expect(config.getRerankTrigramWeight()).toBe(0.1);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getRerankTrigramWeight()).toBe(0.1);
  });

  test("setRerankTrigramWeight: rejects out-of-range and non-finite values", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load();

    await expect(config.setRerankTrigramWeight(-0.1)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setRerankTrigramWeight(1.1)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setRerankTrigramWeight(Infinity)).rejects.toBeInstanceOf(RangeError);
  });

  test("load: coerces out-of-range persisted rerankTrigramWeight to default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, rerankTrigramWeight: -1 }),
      "utf8",
    );
    const config = new Config({ filePath });
    await config.load();
    expect(config.getRerankTrigramWeight()).toBe(DEFAULT_CONFIG.rerankTrigramWeight);
  });

  // ---------------------------------------------------------------------------
  // rerankEditDistancePenalty
  // ---------------------------------------------------------------------------
  test("setRerankEditDistancePenalty: round-trips and persists in-range floats", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setRerankEditDistancePenalty(2.5);
    expect(config.getRerankEditDistancePenalty()).toBe(2.5);

    await config.setRerankEditDistancePenalty(RERANK_EDIT_DISTANCE_PENALTY_RANGE[0]);
    expect(config.getRerankEditDistancePenalty()).toBe(0);

    await config.setRerankEditDistancePenalty(RERANK_EDIT_DISTANCE_PENALTY_RANGE[1]);
    expect(config.getRerankEditDistancePenalty()).toBe(5);

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getRerankEditDistancePenalty()).toBe(5);
  });

  test("setRerankEditDistancePenalty: rejects out-of-range and non-finite values", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load();

    await expect(config.setRerankEditDistancePenalty(-0.1)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setRerankEditDistancePenalty(5.1)).rejects.toBeInstanceOf(RangeError);
    await expect(config.setRerankEditDistancePenalty(NaN)).rejects.toBeInstanceOf(RangeError);
  });

  test("load: coerces out-of-range persisted rerankEditDistancePenalty to default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, rerankEditDistancePenalty: 10 }),
      "utf8",
    );
    const config = new Config({ filePath });
    await config.load();
    expect(config.getRerankEditDistancePenalty()).toBe(DEFAULT_CONFIG.rerankEditDistancePenalty);
  });

  // ---------------------------------------------------------------------------
  // telemetry
  // ---------------------------------------------------------------------------
  test("setTelemetry: round-trips each valid level and persists atomically", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    for (const level of TELEMETRY_LEVELS) {
      await config.setTelemetry(level);
      expect(config.getTelemetry()).toBe(level);

      const reloaded = new Config({ filePath });
      await reloaded.load();
      expect(reloaded.getTelemetry()).toBe(level);
    }
  });

  test("setTelemetry: rejects unknown enum values", async () => {
    const config = new Config({ filePath: join(tempDir, "config.json") });
    await config.load();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(config.setTelemetry("verbose" as any)).rejects.toBeInstanceOf(RangeError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(config.setTelemetry("" as any)).rejects.toBeInstanceOf(RangeError);
  });

  test("load: coerces unknown persisted telemetry value to default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, telemetry: "verbose" }),
      "utf8",
    );
    const config = new Config({ filePath });
    await config.load();
    expect(config.getTelemetry()).toBe(DEFAULT_CONFIG.telemetry);
  });

  // ---------------------------------------------------------------------------
  // normalizeNumberInRange (exported helper)
  // ---------------------------------------------------------------------------
  test("normalizeNumberInRange: accepts boundary values and rejects invalid inputs", () => {
    expect(normalizeNumberInRange(-12.0, [-30, 0])).toBe(-12.0);
    expect(normalizeNumberInRange(-30, [-30, 0])).toBe(-30);
    expect(normalizeNumberInRange(0, [-30, 0])).toBe(0);
    expect(normalizeNumberInRange(-30.1, [-30, 0])).toBeUndefined();
    expect(normalizeNumberInRange(0.1, [-30, 0])).toBeUndefined();
    expect(normalizeNumberInRange(NaN, [-30, 0])).toBeUndefined();
    expect(normalizeNumberInRange(Infinity, [-30, 0])).toBeUndefined();
    expect(normalizeNumberInRange("hello", [-30, 0])).toBeUndefined();
    expect(normalizeNumberInRange(null, [-30, 0])).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // All new keys survive a full round-trip (snapshot includes them)
  // ---------------------------------------------------------------------------
  test("phase-1: all new keys survive a full round-trip via snapshot()", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setEnableSegmentation(false);
    await config.setSegmentationMinLength(8);
    await config.setSegmentationMaxEditDistance(2);
    await config.setSegmentationLogProbFloor(-20.0);
    await config.setSegmentationVsLookupBias(1.5);
    await config.setEnableContextRerank(false);
    await config.setRerankBigramWeight(0.8);
    await config.setRerankTrigramWeight(0.2);
    await config.setRerankEditDistancePenalty(3.0);
    await config.setTelemetry("debug");

    const snap = config.snapshot();
    expect(snap.enableSegmentation).toBe(false);
    expect(snap.segmentationMinLength).toBe(8);
    expect(snap.segmentationMaxEditDistance).toBe(2);
    expect(snap.segmentationLogProbFloor).toBe(-20.0);
    expect(snap.segmentationVsLookupBias).toBe(1.5);
    expect(snap.enableContextRerank).toBe(false);
    expect(snap.rerankBigramWeight).toBe(0.8);
    expect(snap.rerankTrigramWeight).toBe(0.2);
    expect(snap.rerankEditDistancePenalty).toBe(3.0);
    expect(snap.telemetry).toBe("debug");

    // Reload from disk
    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getEnableSegmentation()).toBe(false);
    expect(reloaded.getSegmentationMinLength()).toBe(8);
    expect(reloaded.getSegmentationMaxEditDistance()).toBe(2);
    expect(reloaded.getSegmentationLogProbFloor()).toBe(-20.0);
    expect(reloaded.getSegmentationVsLookupBias()).toBe(1.5);
    expect(reloaded.getEnableContextRerank()).toBe(false);
    expect(reloaded.getRerankBigramWeight()).toBe(0.8);
    expect(reloaded.getRerankTrigramWeight()).toBe(0.2);
    expect(reloaded.getRerankEditDistancePenalty()).toBe(3.0);
    expect(reloaded.getTelemetry()).toBe("debug");
  });

  // ---------------------------------------------------------------------------
  // load: multiple invalid new keys in a single file all coerce to defaults
  // ---------------------------------------------------------------------------
  test("load: all new keys coerce to defaults when stored with invalid values", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        enableSegmentation: "yes",
        segmentationMinLength: 1,
        segmentationMaxEditDistance: 99,
        segmentationLogProbFloor: 5,
        segmentationVsLookupBias: 100,
        enableContextRerank: null,
        rerankBigramWeight: -1,
        rerankTrigramWeight: 2,
        rerankEditDistancePenalty: -1,
        telemetry: "silent",
      }),
      "utf8",
    );

    const config = new Config({ filePath });
    await config.load();

    expect(config.getEnableSegmentation()).toBe(DEFAULT_CONFIG.enableSegmentation);
    expect(config.getSegmentationMinLength()).toBe(DEFAULT_CONFIG.segmentationMinLength);
    expect(config.getSegmentationMaxEditDistance()).toBe(DEFAULT_CONFIG.segmentationMaxEditDistance);
    expect(config.getSegmentationLogProbFloor()).toBe(DEFAULT_CONFIG.segmentationLogProbFloor);
    expect(config.getSegmentationVsLookupBias()).toBe(DEFAULT_CONFIG.segmentationVsLookupBias);
    expect(config.getEnableContextRerank()).toBe(DEFAULT_CONFIG.enableContextRerank);
    expect(config.getRerankBigramWeight()).toBe(DEFAULT_CONFIG.rerankBigramWeight);
    expect(config.getRerankTrigramWeight()).toBe(DEFAULT_CONFIG.rerankTrigramWeight);
    expect(config.getRerankEditDistancePenalty()).toBe(DEFAULT_CONFIG.rerankEditDistancePenalty);
    expect(config.getTelemetry()).toBe(DEFAULT_CONFIG.telemetry);
  });
});
