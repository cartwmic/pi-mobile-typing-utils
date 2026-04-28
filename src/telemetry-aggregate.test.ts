/**
 * telemetry-aggregate.test.ts — Unit tests for aggregateRange().
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { aggregateRange } from "./telemetry-aggregate.js";

describe("aggregateRange", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = join(tmpdir(), `telemetry-agg-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  // Helper to format a date as YYYY-MM-DD (local time)
  function fmtDate(ms: number = Date.now()): string {
    const d = new Date(ms);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dy = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${dy}`;
  }

  // Helper to write NDJSON file
  async function writeEvents(
    telemetryDir: string,
    dateStr: string,
    events: unknown[],
  ): Promise<void> {
    await writeFile(
      join(telemetryDir, `events-${dateStr}.ndjson`),
      events.map((e) => JSON.stringify(e)).join("\n"),
    );
  }

  test("empty directory returns 'No autocorrect telemetry recorded'", async () => {
    await mkdir(tempDir, { recursive: true });
    const report = await aggregateRange(tempDir, "24h");
    expect(report.correctionAppliedTotal).toBe(0);
    expect(report.correctionRejectedTotal).toBe(0);
    expect(report.engineInit.count).toBe(0);
    expect(report.formatted).toContain("No autocorrect telemetry recorded");
  });

  test("non-existent telemetry directory returns empty report", async () => {
    const missingDir = join(tempDir, "does-not-exist");
    const report = await aggregateRange(missingDir, "24h");
    expect(report.correctionAppliedTotal).toBe(0);
    expect(report.formatted).toContain("No autocorrect telemetry recorded");
  });

  test("p50/p95 math correct for N=100 events at known latencies [1..100]", async () => {
    const now = Date.now();
    const dateStr = fmtDate(now);
    const events = [];
    for (let i = 1; i <= 100; i++) {
      events.push({
        event: "correction.applied",
        timestamp: new Date(now - 3600 * 1000 + i * 100).toISOString(),
        kind: "lookup",
        latencyMs: i,
      });
    }
    await writeEvents(tempDir, dateStr, events);

    const report = await aggregateRange(tempDir, "24h");
    expect(report.correctionAppliedTotal).toBe(100);
    expect(report.lookupLatency.count).toBe(100);

    // Sorted array: [1, 2, ..., 100]
    // p50 = sorted[Math.floor(100 * 0.5)] = sorted[50] = 51
    // p95 = sorted[Math.floor(100 * 0.95)] = sorted[95] = 96
    expect(report.lookupLatency.p50).toBe(51);
    expect(report.lookupLatency.p95).toBe(96);
  });

  test("p50/p95 for single event returns same value", async () => {
    const dateStr = fmtDate();
    await writeEvents(tempDir, dateStr, [
      {
        event: "correction.applied",
        timestamp: new Date().toISOString(),
        kind: "lookup",
        latencyMs: 42,
      },
    ]);

    const report = await aggregateRange(tempDir, "all");
    expect(report.lookupLatency.p50).toBe(42);
    expect(report.lookupLatency.p95).toBe(42);
  });

  test("range filtering: 24h vs 7d vs all on same fixture set", async () => {
    const now = Date.now();
    const day = 24 * 3600 * 1000;

    // Create 10 days of events
    for (let daysAgo = 0; daysAgo < 10; daysAgo++) {
      const ts = now - daysAgo * day;
      const dateStr = fmtDate(ts);
      await writeEvents(tempDir, dateStr, [
        {
          event: "correction.applied",
          timestamp: new Date(ts).toISOString(),
          kind: "lookup",
          latencyMs: 1,
        },
      ]);
    }

    const report24h = await aggregateRange(tempDir, "24h");
    const report7d = await aggregateRange(tempDir, "7d");
    const reportAll = await aggregateRange(tempDir, "all");

    // 24h: only today's event (just within 24h window)
    expect(report24h.correctionAppliedTotal).toBe(1);
    // 7d: 7 events
    expect(report7d.correctionAppliedTotal).toBe(7);
    // all: 10 events
    expect(reportAll.correctionAppliedTotal).toBe(10);
  });

  test("engine.init counters and cache hit rate", async () => {
    const dateStr = fmtDate();
    await writeEvents(tempDir, dateStr, [
      {
        event: "engine.init",
        timestamp: new Date().toISOString(),
        fromCache: true,
        buildMs: 100,
        outcome: "ready",
        cause: null,
      },
      {
        event: "engine.init",
        timestamp: new Date().toISOString(),
        fromCache: true,
        buildMs: 80,
        outcome: "ready",
        cause: null,
      },
      {
        event: "engine.init",
        timestamp: new Date().toISOString(),
        fromCache: false,
        buildMs: 2000,
        outcome: "ready",
        cause: null,
      },
    ]);

    const report = await aggregateRange(tempDir, "all");
    expect(report.engineInit.count).toBe(3);
    expect(report.engineInit.cacheHits).toBe(2);
    expect(report.engineInit.freshBuilds).toBe(1);
    expect(report.cacheHitRate).toBeCloseTo(2 / 3);
    expect(report.engineInit.avgBuildMsCache).toBe(90); // (100 + 80) / 2
    expect(report.engineInit.avgBuildMsFresh).toBe(2000);
  });

  test("acceptance rate: correctionApplied / (applied + rejected)", async () => {
    const dateStr = fmtDate();
    await writeEvents(tempDir, dateStr, [
      {
        event: "correction.applied",
        timestamp: new Date().toISOString(),
        kind: "lookup",
        latencyMs: 1,
      },
      {
        event: "correction.applied",
        timestamp: new Date().toISOString(),
        kind: "lookup",
        latencyMs: 1,
      },
      {
        event: "correction.applied",
        timestamp: new Date().toISOString(),
        kind: "lookup",
        latencyMs: 1,
      },
      {
        event: "correction.rejected",
        timestamp: new Date().toISOString(),
      },
    ]);

    const report = await aggregateRange(tempDir, "all");
    expect(report.correctionAppliedTotal).toBe(3);
    expect(report.correctionRejectedTotal).toBe(1);
    expect(report.acceptanceRate).toBeCloseTo(0.75);
  });

  test("acceptanceRate is null when no corrections applied or rejected", async () => {
    const dateStr = fmtDate();
    await writeEvents(tempDir, dateStr, [
      {
        event: "engine.init",
        timestamp: new Date().toISOString(),
        fromCache: false,
        buildMs: 100,
        outcome: "ready",
        cause: null,
      },
    ]);

    const report = await aggregateRange(tempDir, "all");
    expect(report.acceptanceRate).toBeNull();
  });

  test("malformed NDJSON lines are skipped silently", async () => {
    const dateStr = fmtDate();
    const filePath = join(tempDir, `events-${dateStr}.ndjson`);
    await writeFile(
      filePath,
      [
        "this is not json",
        JSON.stringify({ event: "correction.applied", timestamp: new Date().toISOString(), kind: "lookup", latencyMs: 5 }),
        "{broken json",
      ].join("\n"),
    );

    const report = await aggregateRange(tempDir, "all");
    expect(report.correctionAppliedTotal).toBe(1);
  });

  test("segmentation latencies are tracked separately", async () => {
    const dateStr = fmtDate();
    await writeEvents(tempDir, dateStr, [
      // segmentation.attempt events with accepted=true
      { event: "segmentation.attempt", timestamp: new Date().toISOString(), accepted: true, latencyMs: 15 },
      { event: "segmentation.attempt", timestamp: new Date().toISOString(), accepted: true, latencyMs: 25 },
      // accepted=false: should NOT be in segmentation latency
      { event: "segmentation.attempt", timestamp: new Date().toISOString(), accepted: false, latencyMs: 100 },
    ]);

    const report = await aggregateRange(tempDir, "all");
    expect(report.segmentationLatency.count).toBe(2);
    // sorted=[15,25], p50=sorted[floor(2*0.5)]=sorted[1]=25
    expect(report.segmentationLatency.p50).toBe(25);
    // p95=sorted[floor(2*0.95)]=sorted[1]=25
    expect(report.segmentationLatency.p95).toBe(25);
  });

  test("formatted output includes section headings", async () => {
    const dateStr = fmtDate();
    await writeEvents(tempDir, dateStr, [
      { event: "correction.applied", timestamp: new Date().toISOString(), kind: "lookup", latencyMs: 5 },
    ]);

    const report = await aggregateRange(tempDir, "24h");
    expect(report.formatted).toContain("Mobile autocorrect telemetry summary");
    expect(report.formatted).toContain("corrections applied:");
    expect(report.formatted).toContain("Lookup latency:");
    expect(report.formatted).toContain("Engine init:");
  });

  test("rangeLabel is correct per range", async () => {
    const report24h = await aggregateRange(tempDir, "24h");
    expect(report24h.rangeLabel).toBe("last 24h");

    const report7d = await aggregateRange(tempDir, "7d");
    expect(report7d.rangeLabel).toBe("last 7 days");

    const reportAll = await aggregateRange(tempDir, "all");
    expect(reportAll.rangeLabel).toBe("all time");
  });

  test("cacheHitRate is null when no engine.init events", async () => {
    const dateStr = fmtDate();
    await writeEvents(tempDir, dateStr, [
      { event: "correction.applied", timestamp: new Date().toISOString(), kind: "lookup", latencyMs: 1 },
    ]);

    const report = await aggregateRange(tempDir, "all");
    expect(report.cacheHitRate).toBeNull();
  });
});
