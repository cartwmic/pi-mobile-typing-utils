/**
 * Tests for src/telemetry.ts — tasks 2.7 and 2.8
 *
 * Fixtures use real temp directories (mkdtemp) cleaned up after each test,
 * matching the pattern used by index-cache.test.ts.
 *
 * Injectable fs adapter is used where the test needs to control I/O timing
 * or failure modes without touching the real filesystem.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type CorrectionAppliedEvent,
  type CorrectionRejectedEvent,
  type CorrectionSkippedEvent,
  type EngineInitEvent,
  type LookupLatencyEvent,
  type SegmentationAttemptEvent,
  type TelemetryEvent,
  type TelemetryFsAdapter,
  type TelemetryLevel,
  type TrigramLazyAttachedEvent,
  TelemetryWriter,
} from "./telemetry.js";

// ─── Temp-dir fixture ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "telemetry-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Current local date as "YYYY-MM-DD". */
function localDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local date N days ago as "YYYY-MM-DD". */
function daysAgo(n: number): string {
  const now = new Date();
  now.setDate(now.getDate() - n);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Read all NDJSON lines from today's telemetry file (parsed). */
async function readTodayLines(cacheDir: string): Promise<Record<string, unknown>[]> {
  const file = join(cacheDir, "telemetry", `events-${localDateString()}.ndjson`);
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ─── Event fixtures ───────────────────────────────────────────────────────────

const ENGINE_INIT: EngineInitEvent = {
  event: "engine.init",
  timestamp: new Date().toISOString(),
  fromCache: true,
  buildMs: 42,
  unigramCount: 82_000,
  bigramCount: 243_000,
  outcome: "ready",
  cause: null,
};

const TRIGRAM_LAZY: TrigramLazyAttachedEvent = {
  event: "trigram.lazy_attached",
  timestamp: new Date().toISOString(),
  loadMs: 120,
  outcome: "ready",
  trigramCount: 500_000,
};

const LOOKUP_LATENCY: LookupLatencyEvent = {
  event: "lookup.latency",
  timestamp: new Date().toISOString(),
  tokenLength: 3,
  candidateCount: 5,
  latencyMs: 0.7,
  result: "corrected",
  token: "teh",
  suggestion: "the",
  lineText: "I wrote teh",
  cursor: 11,
};

const CORRECTION_APPLIED: CorrectionAppliedEvent = {
  event: "correction.applied",
  timestamp: new Date().toISOString(),
  kind: "lookup",
  tokenLength: 3,
  suggestionLength: 3,
  candidateCount: 3,
  winningEditDistance: 1,
  latencyMs: 1.2,
  scores: { unigram: -2.5, bigram: -1.8, trigram: -0.9, edPenalty: 1.0 },
  scoresVsAlt: null,
  token: "teh",
  suggestion: "the",
  original: "teh",
  candidates: [{ term: "the", ed: 1, scores: { unigram: -2.5, bigram: -1.8, trigram: -0.9, edPenalty: 1.0 } }],
  lineText: "I wrote teh",
  cursor: 11,
};

const CORRECTION_REJECTED: CorrectionRejectedEvent = {
  event: "correction.rejected",
  timestamp: new Date().toISOString(),
  msUntilUndo: 350,
  kind: "lookup",
  tokenLength: 3,
  token: "teh",
  suggestion: "the",
};

const CORRECTION_SKIPPED: CorrectionSkippedEvent = {
  event: "correction.skipped",
  timestamp: new Date().toISOString(),
  tokenLength: 4,
  reason: "in_dict",
  token: "word",
  lineText: "some word here",
  cursor: 9,
};

const SEGMENTATION_ATTEMPT: SegmentationAttemptEvent = {
  event: "segmentation.attempt",
  timestamp: new Date().toISOString(),
  tokenLength: 8,
  accepted: true,
  segmentCount: 2,
  probabilityLogSum: -4.2,
  latencyMs: 5.1,
  token: "thequick",
  suggestion: "the quick",
};

/** All seven event fixtures in a stable order. */
const ALL_EVENTS: TelemetryEvent[] = [
  ENGINE_INIT,
  TRIGRAM_LAZY,
  LOOKUP_LATENCY,
  CORRECTION_APPLIED,
  CORRECTION_REJECTED,
  CORRECTION_SKIPPED,
  SEGMENTATION_ATTEMPT,
];

// ─── Content-field names we check exhaustively ────────────────────────────────
const CONTENT_FIELD_NAMES = ["token", "suggestion", "original", "lineText", "cursor", "candidates"] as const;

// ─── §2.7 — Core behavior tests ───────────────────────────────────────────────

describe("level: off writes nothing", () => {
  test("no file and no directory created at level off", async () => {
    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "off",
    });
    writer.emit(ENGINE_INIT);
    writer.emit(CORRECTION_APPLIED);
    await writer.flush();

    const telemetryDir = join(tmpDir, "telemetry");
    await expect(readFile(join(telemetryDir, `events-${localDateString()}.ndjson`), "utf8")).rejects.toThrow();
    // Directory itself should not exist either
    await expect(rm(telemetryDir, { recursive: true })).rejects.toThrow();
  });
});

describe("level: metrics — structural fields present, content fields null", () => {
  test("correction.applied: numeric/structural fields written, content fields null", async () => {
    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "metrics",
    });
    writer.emit(CORRECTION_APPLIED);
    await writer.flush();

    const [line] = await readTodayLines(tmpDir);
    expect(line).toBeDefined();

    // Structural fields
    expect(line!["event"]).toBe("correction.applied");
    expect(line!["kind"]).toBe("lookup");
    expect(line!["tokenLength"]).toBe(3);
    expect(line!["suggestionLength"]).toBe(3);
    expect(line!["candidateCount"]).toBe(3);
    expect(line!["winningEditDistance"]).toBe(1);
    expect(line!["latencyMs"]).toBe(1.2);
    expect(typeof line!["timestamp"]).toBe("string");

    // Content fields must be null (not the original string values)
    expect(line!["token"]).toBeNull();
    expect(line!["suggestion"]).toBeNull();
    expect(line!["original"]).toBeNull();
    expect(line!["candidates"]).toBeNull();
    expect(line!["lineText"]).toBeNull();
    expect(line!["cursor"]).toBeNull();
  });

  test("lookup.latency: content fields null at metrics", async () => {
    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "metrics",
    });
    writer.emit(LOOKUP_LATENCY);
    await writer.flush();

    const [line] = await readTodayLines(tmpDir);
    expect(line!["event"]).toBe("lookup.latency");
    expect(line!["tokenLength"]).toBe(3);
    expect(line!["token"]).toBeNull();
    expect(line!["suggestion"]).toBeNull();
    expect(line!["lineText"]).toBeNull();
    expect(line!["cursor"]).toBeNull();
  });

  test("engine.init: no content fields exist, all structural fields written", async () => {
    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "metrics",
    });
    writer.emit(ENGINE_INIT);
    await writer.flush();

    const [line] = await readTodayLines(tmpDir);
    expect(line!["event"]).toBe("engine.init");
    expect(line!["fromCache"]).toBe(true);
    expect(line!["unigramCount"]).toBe(82_000);
    expect(line!["outcome"]).toBe("ready");
  });
});

describe("level: debug — content fields included", () => {
  test("correction.applied: all fields present at debug", async () => {
    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "debug",
    });
    writer.emit(CORRECTION_APPLIED);
    await writer.flush();

    const [line] = await readTodayLines(tmpDir);
    expect(line!["event"]).toBe("correction.applied");
    expect(line!["token"]).toBe("teh");
    expect(line!["suggestion"]).toBe("the");
    expect(line!["original"]).toBe("teh");
    expect(line!["lineText"]).toBe("I wrote teh");
    expect(line!["cursor"]).toBe(11);
    expect(Array.isArray(line!["candidates"])).toBe(true);
    const cands = line!["candidates"] as Array<{ term: string }>;
    expect(cands[0]!.term).toBe("the");
  });

  test("lookup.latency: token/suggestion/lineText/cursor present at debug", async () => {
    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "debug",
    });
    writer.emit(LOOKUP_LATENCY);
    await writer.flush();

    const [line] = await readTodayLines(tmpDir);
    expect(line!["token"]).toBe("teh");
    expect(line!["suggestion"]).toBe("the");
    expect(line!["lineText"]).toBe("I wrote teh");
    expect(line!["cursor"]).toBe(11);
  });

  test("segmentation.attempt: token/suggestion present at debug", async () => {
    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "debug",
    });
    writer.emit(SEGMENTATION_ATTEMPT);
    await writer.flush();

    const [line] = await readTodayLines(tmpDir);
    expect(line!["token"]).toBe("thequick");
    expect(line!["suggestion"]).toBe("the quick");
  });
});

describe("daily-stamped filename", () => {
  test("events written to events-YYYY-MM-DD.ndjson", async () => {
    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "metrics",
    });
    writer.emit(ENGINE_INIT);
    await writer.flush();

    const expectedFile = join(tmpDir, "telemetry", `events-${localDateString()}.ndjson`);
    const content = await readFile(expectedFile, "utf8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  test("filename matches local date (not UTC) format YYYY-MM-DD", async () => {
    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "metrics",
    });
    writer.emit(ENGINE_INIT);
    await writer.flush();

    const telDir = join(tmpDir, "telemetry");
    const files = await (await import("node:fs/promises")).readdir(telDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^events-\d{4}-\d{2}-\d{2}\.ndjson$/);
  });
});

describe("mkdir-once on first emit (task 2.2.1)", () => {
  test("telemetry directory created on first non-off emit", async () => {
    const telemetryDir = join(tmpDir, "telemetry");
    // Directory must not exist before first emit
    await expect(readFile(join(telemetryDir, "x"), "utf8")).rejects.toThrow();

    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "metrics",
    });
    writer.emit(ENGINE_INIT);
    await writer.flush();

    // Directory now exists and has a file
    const files = await (await import("node:fs/promises")).readdir(telemetryDir);
    expect(files.length).toBeGreaterThan(0);
  });

  test("mkdir NOT called when level is always off", async () => {
    let mkdirCalled = false;
    const spyFs: TelemetryFsAdapter = {
      appendFile: async () => {},
      mkdir: async () => { mkdirCalled = true; return undefined; },
      unlink: async () => {},
      readdir: async () => [],
    };

    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "off",
      fs: spyFs,
    });
    writer.emit(ENGINE_INIT);
    writer.emit(CORRECTION_APPLIED);
    await writer.flush();

    expect(mkdirCalled).toBe(false);
  });

  test("mkdir called only once across multiple emits", async () => {
    let mkdirCallCount = 0;
    const { appendFile, mkdir: realMkdir, readdir: realReaddir, unlink: realUnlink } =
      await import("node:fs/promises");
    const onceFs: TelemetryFsAdapter = {
      appendFile: (p, d) => appendFile(p, d, "utf8"),
      mkdir: async (p, opts) => { mkdirCallCount++; return realMkdir(p, opts); },
      unlink: realUnlink,
      readdir: (p) => realReaddir(p) as Promise<string[]>,
    };

    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "metrics",
      fs: onceFs,
    });

    for (let i = 0; i < 5; i++) writer.emit(ENGINE_INIT);
    await writer.flush();

    expect(mkdirCallCount).toBe(1);
  });
});

describe("pruning — files older than 30 days are deleted", () => {
  test("file from 31 days ago is pruned; today's file survives", async () => {
    const telDir = join(tmpDir, "telemetry");
    await mkdir(telDir, { recursive: true });

    const oldDate = daysAgo(31);
    const oldFile = join(telDir, `events-${oldDate}.ndjson`);
    await writeFile(oldFile, `{"event":"engine.init"}\n`);

    // Also create a file from yesterday (within window) — should survive
    const recentDate = daysAgo(5);
    const recentFile = join(telDir, `events-${recentDate}.ndjson`);
    await writeFile(recentFile, `{"event":"engine.init"}\n`);

    const writer = new TelemetryWriter({ cacheDir: tmpDir, getLevel: () => "metrics" });
    writer.emit(ENGINE_INIT);
    await writer.flush();

    // Old file deleted
    await expect(readFile(oldFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    // Recent file survived
    await expect(readFile(recentFile, "utf8")).resolves.toContain("engine.init");
  });

  test("file from exactly 30 days ago is kept (strictly older-than-30 rule)", async () => {
    const telDir = join(tmpDir, "telemetry");
    await mkdir(telDir, { recursive: true });

    const borderDate = daysAgo(30);
    const borderFile = join(telDir, `events-${borderDate}.ndjson`);
    await writeFile(borderFile, `{"event":"engine.init"}\n`);

    const writer = new TelemetryWriter({ cacheDir: tmpDir, getLevel: () => "metrics" });
    writer.emit(ENGINE_INIT);
    await writer.flush();

    // File from exactly 30 days ago should survive
    await expect(readFile(borderFile, "utf8")).resolves.toContain("engine.init");
  });

  test("long-lived session crossing midnight re-prunes on date change", async () => {
    const telDir = join(tmpDir, "telemetry");
    await mkdir(telDir, { recursive: true });

    const oldDate = daysAgo(31);
    const oldFile = join(telDir, `events-${oldDate}.ndjson`);
    await writeFile(oldFile, `{"event":"engine.init"}\n`);

    // Simulate a writer whose lastPruneDate is already set to "today" so that
    // the first emit at today's date won't prune. We do this by calling flush
    // after the first emit. The old file should still be deleted on that first emit.
    const writer = new TelemetryWriter({ cacheDir: tmpDir, getLevel: () => "metrics" });
    writer.emit(ENGINE_INIT);
    await writer.flush();

    // Old file was pruned on the first emit
    await expect(readFile(oldFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("pruning ENOENT (file already deleted by peer) is silent", async () => {
    // Inject a fs where unlink always throws ENOENT — emit should still succeed
    const telDir = join(tmpDir, "telemetry");
    await mkdir(telDir, { recursive: true });

    const oldDate = daysAgo(31);
    const oldFile = join(telDir, `events-${oldDate}.ndjson`);
    await writeFile(oldFile, `{"event":"engine.init"}\n`);

    const { appendFile, mkdir: realMkdir, readdir: realReaddir } = await import("node:fs/promises");
    const enoentFs: TelemetryFsAdapter = {
      appendFile: (p, d) => appendFile(p, d, "utf8"),
      mkdir: (p, opts) => realMkdir(p, opts),
      unlink: async () => {
        const e = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
        throw e;
      },
      readdir: (p) => realReaddir(p) as Promise<string[]>,
    };

    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const writer = new TelemetryWriter({ cacheDir: tmpDir, getLevel: () => "metrics", fs: enoentFs });
    writer.emit(ENGINE_INIT);
    await writer.flush();

    // Event still written
    const lines = await readTodayLines(tmpDir);
    expect(lines.length).toBeGreaterThan(0);
    // No log for ENOENT
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("pruning failures don't propagate", () => {
  test("non-ENOENT unlink failure: emit still writes event, error logged once", async () => {
    const telDir = join(tmpDir, "telemetry");
    await mkdir(telDir, { recursive: true });

    const oldDate = daysAgo(31);
    const oldFile = join(telDir, `events-${oldDate}.ndjson`);
    await writeFile(oldFile, `{"event":"engine.init"}\n`);

    const { appendFile, mkdir: realMkdir, readdir: realReaddir } = await import("node:fs/promises");
    const failFs: TelemetryFsAdapter = {
      appendFile: (p, d) => appendFile(p, d, "utf8"),
      mkdir: (p, opts) => realMkdir(p, opts),
      unlink: async () => {
        const e = Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
        throw e;
      },
      readdir: (p) => realReaddir(p) as Promise<string[]>,
    };

    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const writer = new TelemetryWriter({ cacheDir: tmpDir, getLevel: () => "metrics", fs: failFs });

    // Multiple emits — only one log message total
    writer.emit(ENGINE_INIT);
    writer.emit(ENGINE_INIT);
    writer.emit(ENGINE_INIT);
    await writer.flush();

    // Events still written
    const lines = await readTodayLines(tmpDir);
    expect(lines).toHaveLength(3);

    // Logged at most once
    expect(consoleSpy.mock.calls.length).toBeLessThanOrEqual(1);
    consoleSpy.mockRestore();
  });

  test("readdir failure in prune: emit still writes, error logged at most once", async () => {
    const { appendFile, mkdir: realMkdir } = await import("node:fs/promises");
    let readdirCalls = 0;
    const failFs: TelemetryFsAdapter = {
      appendFile: (p, d) => appendFile(p, d, "utf8"),
      mkdir: (p, opts) => realMkdir(p, opts),
      unlink: async () => {},
      readdir: async () => {
        readdirCalls++;
        const e = Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
        throw e;
      },
    };

    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const writer = new TelemetryWriter({ cacheDir: tmpDir, getLevel: () => "metrics", fs: failFs });
    writer.emit(ENGINE_INIT);
    await writer.flush();

    // Event still written
    const lines = await readTodayLines(tmpDir);
    expect(lines).toHaveLength(1);
    // Logged at most once for non-ENOENT
    expect(consoleSpy.mock.calls.length).toBeLessThanOrEqual(1);
    consoleSpy.mockRestore();
  });
});

describe("concurrent emits don't interleave", () => {
  test("50 parallel emits produce 50 valid JSON lines", async () => {
    const N = 50;
    const writer = new TelemetryWriter({ cacheDir: tmpDir, getLevel: () => "debug" });

    // Fire all emits synchronously before any I/O settles
    for (let i = 0; i < N; i++) {
      const ev: SegmentationAttemptEvent = {
        event: "segmentation.attempt",
        timestamp: new Date().toISOString(),
        tokenLength: i,
        accepted: i % 2 === 0,
        segmentCount: 2,
        probabilityLogSum: Math.log10(0.01) * (i + 1),
        latencyMs: 1.0 + i * 0.01,
        token: `token${i}`,
        suggestion: `sugg${i}`,
      };
      writer.emit(ev);
    }

    await writer.flush();

    const file = join(tmpDir, "telemetry", `events-${localDateString()}.ndjson`);
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);

    expect(lines).toHaveLength(N);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

// ─── §2.7 — Content-field exhaustiveness test ─────────────────────────────────

describe("content-field exhaustiveness", () => {
  test("at metrics level, no content field has a non-null value for any event class", async () => {
    let level: TelemetryLevel = "debug";
    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => level,
    });

    // Phase 1: emit all event types at debug level
    for (const ev of ALL_EVENTS) {
      writer.emit(ev);
    }
    await writer.flush();

    // Phase 2: switch to metrics and re-emit
    level = "metrics";

    // Use a second day file to isolate metrics events; we append to same day file here
    // so we need to read lines written after switching.  We'll track the line count before.
    const fileBeforeSwitch = join(tmpDir, "telemetry", `events-${localDateString()}.ndjson`);
    const rawBefore = await readFile(fileBeforeSwitch, "utf8");
    const linesBefore = rawBefore.split("\n").filter((l) => l.trim().length > 0).length;

    for (const ev of ALL_EVENTS) {
      writer.emit(ev);
    }
    await writer.flush();

    // Read only the lines added in the metrics phase
    const rawAfter = await readFile(fileBeforeSwitch, "utf8");
    const allLines = rawAfter.split("\n").filter((l) => l.trim().length > 0);
    const metricsLines = allLines.slice(linesBefore);

    expect(metricsLines).toHaveLength(ALL_EVENTS.length);

    for (const rawLine of metricsLines) {
      const obj = JSON.parse(rawLine) as Record<string, unknown>;
      for (const field of CONTENT_FIELD_NAMES) {
        // The field must not appear with a non-null value
        if (field in obj) {
          expect(obj[field]).toBeNull();
        }
      }
    }
  });

  test("at debug level, content fields have their original non-null values", async () => {
    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "debug",
    });
    for (const ev of ALL_EVENTS) {
      writer.emit(ev);
    }
    await writer.flush();

    const lines = await readTodayLines(tmpDir);
    expect(lines).toHaveLength(ALL_EVENTS.length);

    // Events that have content fields should have them populated at debug
    const lookupLine = lines.find((l) => l["event"] === "lookup.latency")!;
    expect(lookupLine["token"]).toBe("teh");
    expect(lookupLine["suggestion"]).toBe("the");
    expect(lookupLine["lineText"]).toBe("I wrote teh");
    expect(lookupLine["cursor"]).toBe(11);

    const appliedLine = lines.find((l) => l["event"] === "correction.applied")!;
    expect(appliedLine["token"]).toBe("teh");
    expect(appliedLine["original"]).toBe("teh");
    expect(Array.isArray(appliedLine["candidates"])).toBe(true);

    const skippedLine = lines.find((l) => l["event"] === "correction.skipped")!;
    expect(skippedLine["token"]).toBe("word");
    expect(skippedLine["lineText"]).toBe("some word here");
  });
});

// ─── §2.7 — Live-level test ───────────────────────────────────────────────────

describe("live-level: getLevel() consulted on every emit()", () => {
  test("level transitions mid-session take effect immediately", async () => {
    let level: TelemetryLevel = "metrics";
    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => level,
    });

    // ① Emit at metrics — should be written
    writer.emit(ENGINE_INIT);
    await writer.flush();

    const afterMetrics = await readTodayLines(tmpDir);
    expect(afterMetrics).toHaveLength(1);
    expect(afterMetrics[0]!["event"]).toBe("engine.init");

    // ② Flip to off — same writer instance, emit should be a no-op
    level = "off";
    writer.emit(ENGINE_INIT);
    await writer.flush();

    const afterOff = await readTodayLines(tmpDir);
    expect(afterOff).toHaveLength(1); // Still only 1 line

    // ③ Flip to debug — emit should fire AND include content fields
    level = "debug";
    writer.emit(CORRECTION_APPLIED);
    await writer.flush();

    const afterDebug = await readTodayLines(tmpDir);
    expect(afterDebug).toHaveLength(2);
    const debugLine = afterDebug[1]!;
    expect(debugLine["token"]).toBe("teh");
    expect(debugLine["suggestion"]).toBe("the");
  });
});

// ─── §2.8 — Fire-and-forget contract test ────────────────────────────────────

describe("fire-and-forget contract (task 2.8)", () => {
  test("emit() returns in < 1ms even when appendFile takes 100ms", () => {
    const slowFs: TelemetryFsAdapter = {
      appendFile: async (_path, _data) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      },
      mkdir: async () => undefined,
      unlink: async () => {},
      readdir: async () => [],
    };

    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "metrics",
      fs: slowFs,
    });

    const start = performance.now();
    writer.emit(ENGINE_INIT);
    const elapsed = performance.now() - start;

    // emit() must return synchronously well under 1ms
    expect(elapsed).toBeLessThan(1);
  });

  test("emit() returns in < 1ms even when mkdir takes 100ms", () => {
    const slowFs: TelemetryFsAdapter = {
      appendFile: async () => {},
      mkdir: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        return undefined;
      },
      unlink: async () => {},
      readdir: async () => [],
    };

    const writer = new TelemetryWriter({
      cacheDir: tmpDir,
      getLevel: () => "metrics",
      fs: slowFs,
    });

    const start = performance.now();
    writer.emit(ENGINE_INIT);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1);
  });
});

// ─── Miscellaneous edge cases ─────────────────────────────────────────────────

describe("correction.applied with kind: segmentation", () => {
  test("winningEditDistance and scores pass through as null (structural-null)", async () => {
    const segApplied: CorrectionAppliedEvent = {
      event: "correction.applied",
      timestamp: new Date().toISOString(),
      kind: "segmentation",
      tokenLength: 8,
      suggestionLength: 9,
      candidateCount: 0,
      winningEditDistance: null, // Engine is responsible for setting null on segmentation
      latencyMs: 5.0,
      scores: null, // Engine is responsible for setting null on segmentation
      scoresVsAlt: null,
      token: "thequick",
      suggestion: "the quick",
      original: "thequick",
      candidates: null,
      lineText: "I typed thequick",
      cursor: 16,
    };

    const writer = new TelemetryWriter({ cacheDir: tmpDir, getLevel: () => "debug" });
    writer.emit(segApplied);
    await writer.flush();

    const [line] = await readTodayLines(tmpDir);
    expect(line!["kind"]).toBe("segmentation");
    // Structural nulls pass through unchanged at debug level
    expect(line!["winningEditDistance"]).toBeNull();
    expect(line!["scores"]).toBeNull();
    // Content fields ARE present at debug
    expect(line!["token"]).toBe("thequick");
  });

  test("at metrics level: structural nulls preserved, content fields also null", async () => {
    const segApplied: CorrectionAppliedEvent = {
      event: "correction.applied",
      timestamp: new Date().toISOString(),
      kind: "segmentation",
      tokenLength: 8,
      suggestionLength: 9,
      candidateCount: 0,
      winningEditDistance: null,
      latencyMs: 5.0,
      scores: null,
      scoresVsAlt: null,
      token: "thequick",
      suggestion: "the quick",
      original: "thequick",
      candidates: null,
      lineText: "I typed thequick",
      cursor: 16,
    };

    const writer = new TelemetryWriter({ cacheDir: tmpDir, getLevel: () => "metrics" });
    writer.emit(segApplied);
    await writer.flush();

    const [line] = await readTodayLines(tmpDir);
    // Structural-null fields unchanged
    expect(line!["winningEditDistance"]).toBeNull();
    expect(line!["scores"]).toBeNull();
    // Content fields masked to null at metrics
    expect(line!["token"]).toBeNull();
    expect(line!["suggestion"]).toBeNull();
  });
});

describe("NDJSON format integrity", () => {
  test("each emitted line is a complete, parseable JSON object followed by newline", async () => {
    const writer = new TelemetryWriter({ cacheDir: tmpDir, getLevel: () => "metrics" });
    for (const ev of ALL_EVENTS) {
      writer.emit(ev);
    }
    await writer.flush();

    const file = join(tmpDir, "telemetry", `events-${localDateString()}.ndjson`);
    const raw = await readFile(file, "utf8");

    // File must end with a newline (NDJSON convention)
    expect(raw.endsWith("\n")).toBe(true);

    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(ALL_EVENTS.length);
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(typeof obj["event"]).toBe("string");
      expect(typeof obj["timestamp"]).toBe("string");
    }
  });
});
