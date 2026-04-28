/**
 * integration-telemetry.test.ts
 *
 * Integration tests for the TelemetryWriter module in a real session context:
 * NDJSON files are written to an isolated temp directory, level transitions are
 * observed live, and field masking is verified end-to-end.
 *
 * ## Approach
 *
 * Events are emitted directly to TelemetryWriter (bypassing the CorrectionEngine)
 * so that content fields (token, suggestion, etc.) can be controlled precisely.
 * This is necessary because the current CorrectionEngine implementation always
 * passes null for content fields in telemetry emissions (the engine serializes
 * structural metrics only; populating content fields is deferred to a future
 * phase). Emitting directly lets us exercise the masking and level-switching
 * logic with populated content fields.
 *
 * A supplementary "engine-driven" sub-test verifies that calling shouldCorrect()
 * on a real CorrectionEngine fires at least one correction.applied event.
 *
 * ## Level switching
 *
 * The TelemetryWriter.getLevel accessor is backed by a mutable variable rather
 * than a real Config to avoid async file I/O in the hot path of level-switch
 * assertions. The live-level contract (getLevel consulted on every emit) is already
 * verified by telemetry.test.ts task 2.7; here we verify it within a multi-event
 * session across multiple file-system writes.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { CorrectionAppliedEvent, TelemetryLevel } from "./telemetry.js";
import { TelemetryWriter } from "./telemetry.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Read all NDJSON lines from the telemetry directory. */
function readAllEvents(cacheDir: string): Record<string, unknown>[] {
  const telemetryDir = join(cacheDir, "telemetry");
  let files: string[];
  try {
    files = readdirSync(telemetryDir);
  } catch {
    return [];
  }
  const events: Record<string, unknown>[] = [];
  for (const file of files) {
    if (!file.startsWith("events-") || !file.endsWith(".ndjson")) continue;
    const content = readFileSync(join(telemetryDir, file), "utf8");
    for (const line of content.split("\n")) {
      if (line.trim()) {
        events.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
  }
  return events;
}

/** Filter events by the 'event' discriminant. */
function filterByKind(
  events: Record<string, unknown>[],
  kind: string,
): Record<string, unknown>[] {
  return events.filter((e) => e["event"] === kind);
}

/** Build a correction.applied event with populated content fields. */
function makeAppliedEvent(token: string, suggestion: string): CorrectionAppliedEvent {
  return {
    event: "correction.applied",
    timestamp: new Date().toISOString(),
    kind: "lookup",
    tokenLength: token.length,
    suggestionLength: suggestion.length,
    candidateCount: 5,
    winningEditDistance: 1,
    latencyMs: 1,
    scores: { unigram: -5, bigram: -2, trigram: 0, edPenalty: 1 },
    scoresVsAlt: null,
    // Content fields — masked to null at "metrics" level, preserved at "debug".
    token,
    suggestion,
    original: token,
    candidates: null,
    lineText: "/some/line/text that should be masked",
    cursor: 42,
  };
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let cacheDir: string;
let level: TelemetryLevel;
let writer: TelemetryWriter;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "integration-telemetry-"));
  level = "metrics";
  writer = new TelemetryWriter({
    cacheDir,
    getLevel: () => level,
  });
});

afterEach(async () => {
  await writer.flush();
  rmSync(cacheDir, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("telemetry integration", () => {
  // ── NDJSON files are written under <cacheDir>/telemetry/ ──────────────────────

  test("metrics level: NDJSON file is created under <cacheDir>/telemetry/", async () => {
    writer.emit(makeAppliedEvent("teh", "the"));
    await writer.flush();

    const telemetryDir = join(cacheDir, "telemetry");
    const files = readdirSync(telemetryDir);
    expect(files.some((f) => f.startsWith("events-") && f.endsWith(".ndjson"))).toBe(true);
  });

  // ── Event count matches driven corrections ────────────────────────────────────

  test("event count matches: 3 emits → 3 correction.applied lines in NDJSON", async () => {
    level = "metrics";
    writer.emit(makeAppliedEvent("teh", "the"));
    writer.emit(makeAppliedEvent("modle", "model"));
    writer.emit(makeAppliedEvent("reccomend", "recommend"));
    await writer.flush();

    const allEvents = readAllEvents(cacheDir);
    const applied = filterByKind(allEvents, "correction.applied");
    expect(applied).toHaveLength(3);
  });

  // ── Metrics level: content fields are null ────────────────────────────────────
  //
  // The masker sets token, suggestion, original, lineText, cursor, candidates to
  // null at "metrics" level even when the caller supplied real values.

  test("metrics level: content fields (token, suggestion, original, lineText, cursor) are null", async () => {
    level = "metrics";
    writer.emit(makeAppliedEvent("teh", "the"));
    await writer.flush();

    const events = readAllEvents(cacheDir);
    const applied = filterByKind(events, "correction.applied");
    expect(applied).toHaveLength(1);

    const e = applied[0]!;
    expect(e["token"]).toBeNull();
    expect(e["suggestion"]).toBeNull();
    expect(e["original"]).toBeNull();
    expect(e["lineText"]).toBeNull();
    expect(e["cursor"]).toBeNull();
  });

  // Structural (non-content) fields must NOT be masked at metrics level.
  test("metrics level: structural fields (tokenLength, latencyMs, kind) are preserved", async () => {
    level = "metrics";
    writer.emit(makeAppliedEvent("teh", "the"));
    await writer.flush();

    const applied = filterByKind(readAllEvents(cacheDir), "correction.applied");
    expect(applied).toHaveLength(1);

    const e = applied[0]!;
    expect(e["kind"]).toBe("lookup");
    expect(typeof e["tokenLength"]).toBe("number");
    expect(typeof e["latencyMs"]).toBe("number");
    expect(typeof e["winningEditDistance"]).toBe("number");
  });

  // ── Debug level: content fields are preserved ─────────────────────────────────
  //
  // At "debug", the writer passes the event through unchanged, so all content
  // fields populated by the caller appear in the NDJSON output.

  test("debug level: content fields (token, suggestion, lineText, cursor) are preserved", async () => {
    level = "debug";
    writer.emit(makeAppliedEvent("teh", "the"));
    await writer.flush();

    const applied = filterByKind(readAllEvents(cacheDir), "correction.applied");
    expect(applied).toHaveLength(1);

    const e = applied[0]!;
    expect(e["token"]).toBe("teh");
    expect(e["suggestion"]).toBe("the");
    expect(e["original"]).toBe("teh");
    expect(e["lineText"]).toBe("/some/line/text that should be masked");
    expect(e["cursor"]).toBe(42);
  });

  // ── Off level: no events written ──────────────────────────────────────────────

  test("off level: emit() is a no-op; no NDJSON file is created", async () => {
    level = "off";
    writer.emit(makeAppliedEvent("teh", "the"));
    writer.emit(makeAppliedEvent("modle", "model"));
    await writer.flush();

    // The telemetry directory must NOT have been created.
    let dirExists = false;
    try {
      readdirSync(join(cacheDir, "telemetry"));
      dirExists = true;
    } catch {
      // Expected: ENOENT.
    }
    expect(dirExists).toBe(false);
  });

  // ── Live level switching mid-session ──────────────────────────────────────────
  //
  // Verifies that getLevel() is consulted on every emit() call — not cached at
  // construction time — so live transitions take effect immediately.

  test("live level switching: metrics → debug → off within one session", async () => {
    // Phase 1: metrics — 2 events, content fields masked.
    level = "metrics";
    writer.emit(makeAppliedEvent("teh", "the"));
    writer.emit(makeAppliedEvent("modle", "model"));
    await writer.flush();

    const afterPhase1 = filterByKind(readAllEvents(cacheDir), "correction.applied");
    expect(afterPhase1).toHaveLength(2);
    expect(afterPhase1[0]!["token"]).toBeNull();

    // Phase 2: debug — 1 more event, content fields preserved.
    level = "debug";
    writer.emit(makeAppliedEvent("reccomend", "recommend"));
    await writer.flush();

    const afterPhase2 = filterByKind(readAllEvents(cacheDir), "correction.applied");
    expect(afterPhase2).toHaveLength(3);
    // The third event (at debug level) has a real token.
    const debugEvent = afterPhase2[2]!;
    expect(debugEvent["token"]).toBe("reccomend");
    expect(debugEvent["suggestion"]).toBe("recommend");

    // Phase 3: off — additional emits produce no new lines.
    level = "off";
    writer.emit(makeAppliedEvent("speling", "spelling"));
    writer.emit(makeAppliedEvent("anothr", "another"));
    await writer.flush();

    const afterPhase3 = filterByKind(readAllEvents(cacheDir), "correction.applied");
    // Still only 3 events — the two "off" emits were no-ops.
    expect(afterPhase3).toHaveLength(3);
  });

  // ── Daily filename rotation ───────────────────────────────────────────────────
  //
  // Each emit computes the local date and appends to events-YYYY-MM-DD.ndjson.
  // The file must match the expected pattern.

  test("NDJSON filename matches events-YYYY-MM-DD.ndjson pattern", async () => {
    level = "metrics";
    writer.emit(makeAppliedEvent("teh", "the"));
    await writer.flush();

    const telemetryDir = join(cacheDir, "telemetry");
    const files = readdirSync(telemetryDir);
    const ndjsonFiles = files.filter((f) => /^events-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f));
    expect(ndjsonFiles.length).toBe(1);
  });

  // ── Engine-driven: shouldCorrect fires correction.applied via TelemetryWriter ──
  //
  // Verifies the integration between CorrectionEngine and TelemetryWriter:
  // calling shouldCorrect on a correction-eligible token emits at least one
  // correction.applied event.
  //
  // NOTE: The engine always passes token=null, suggestion=null in its emissions
  // (content fields are structural-null per the current implementation). This test
  // validates that events ARE written and are structurally correct, NOT that
  // content fields are populated.

  test("engine-driven: shouldCorrect emits correction.applied for a known typo", async () => {
    const { CorrectionEngine } = await import("./correction-engine.js");
    const { __resetCacheDisabledForTests } = await import("./index-cache.js");
    const { __resetTrigramSingletonForTests } = await import("./trigram-table.js");

    const engineCacheDir = mkdtempSync(join(tmpdir(), "integration-telemetry-engine-"));
    const techDictPath = join(engineCacheDir, "tech.txt");
    writeFileSync(techDictPath, "", "utf8");

    vi.stubEnv("MOBILE_AUTOCORRECT_CACHE_DIR", join(engineCacheDir, "cache"));
    __resetCacheDisabledForTests();

    let engineLevel: TelemetryLevel = "metrics";
    const engineWriter = new TelemetryWriter({
      cacheDir: join(engineCacheDir, "cache"),
      getLevel: () => engineLevel,
    });

    try {
      const eng = new CorrectionEngine({
        techDictPath,
        isLearned: () => false,
        telemetry: engineWriter,
      });
      await eng.initialize();

      // Drive three corrections: "teh" corrects to "the" (verified in unit tests).
      eng.shouldCorrect("teh");
      eng.shouldCorrect("teh");
      eng.shouldCorrect("teh");

      await engineWriter.flush();

      const allEvents = readAllEvents(join(engineCacheDir, "cache"));
      const applied = filterByKind(allEvents, "correction.applied");

      // At least 3 correction.applied events from the 3 shouldCorrect calls.
      expect(applied.length).toBeGreaterThanOrEqual(3);

      // Engine always passes token=null (current implementation: structural-null).
      for (const e of applied) {
        expect(e["token"]).toBeNull();
        expect(e["suggestion"]).toBeNull();
        // Structural fields are present.
        expect(e["kind"]).toBe("lookup");
        expect(typeof e["tokenLength"]).toBe("number");
      }

      // Switch to off mid-session and verify no further events are written.
      const countBefore = applied.length;
      engineLevel = "off";
      eng.shouldCorrect("teh");
      eng.shouldCorrect("teh");
      await engineWriter.flush();

      const appliedAfterOff = filterByKind(
        readAllEvents(join(engineCacheDir, "cache")),
        "correction.applied",
      );
      expect(appliedAfterOff.length).toBe(countBefore);
    } finally {
      __resetTrigramSingletonForTests();
      vi.unstubAllEnvs();
      __resetCacheDisabledForTests();
      rmSync(engineCacheDir, { recursive: true, force: true });
    }
  }, 60_000);
});
