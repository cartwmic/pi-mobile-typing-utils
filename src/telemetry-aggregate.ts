/**
 * telemetry-aggregate.ts — Aggregates local telemetry NDJSON files into a
 * summary report for the /typos stats command.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type StatsRange = "24h" | "7d" | "all";

export interface SummaryReport {
  range: StatsRange;
  rangeLabel: string;
  oldestEventDate: string | null;
  newestEventDate: string | null;
  fileCount: number;
  totalFileSizeBytes: number;
  correctionAppliedTotal: number;
  correctionAppliedByKind: { lookup: number; segmentation: number };
  correctionRejectedTotal: number;
  acceptanceRate: number | null;
  lookupLatency: { count: number; p50: number | null; p95: number | null };
  segmentationLatency: { count: number; p50: number | null; p95: number | null };
  engineInit: {
    count: number;
    cacheHits: number;
    freshBuilds: number;
    avgBuildMsCache: number | null;
    avgBuildMsFresh: number | null;
  };
  cacheHitRate: number | null;
  formatted: string;
}

const MS_PER_DAY = 24 * 3600 * 1000;

/** Parse a local-date string (YYYY-MM-DD) from an events-YYYY-MM-DD.ndjson filename. */
function parseDateFromFilename(filename: string): string | null {
  const m = /^events-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(filename);
  return m ? m[1] : null;
}

/** Format today's date as YYYY-MM-DD (local time). */
function localDateString(ms: number = Date.now()): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${dy}`;
}

/** Compute percentile from a sorted array using floor index. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/** Stream an NDJSON file and yield each parsed line. */
async function* streamNdjson(filePath: string): AsyncGenerator<unknown> {
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(filePath, { encoding: "utf8" });
  } catch {
    return;
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // Skip malformed lines silently
    }
  }
}

export async function aggregateRange(
  telemetryDir: string,
  range: StatsRange,
): Promise<SummaryReport> {
  const now = Date.now();

  // Determine the cutoff timestamp and candidate file logic
  let cutoffMs: number;
  switch (range) {
    case "24h":
      cutoffMs = now - MS_PER_DAY;
      break;
    case "7d":
      cutoffMs = now - 7 * MS_PER_DAY;
      break;
    case "all":
      cutoffMs = 0;
      break;
  }

  const rangeLabel =
    range === "24h" ? "last 24h" : range === "7d" ? "last 7 days" : "all time";

  // List candidate files
  let allFiles: string[];
  try {
    allFiles = await readdir(telemetryDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      allFiles = [];
    } else {
      throw err;
    }
  }

  // Filter to events-*.ndjson and select candidates based on date
  const ndjsonFiles = allFiles
    .filter((f) => parseDateFromFilename(f) !== null)
    .sort(); // ascending by date (lexicographic = chronological for YYYY-MM-DD)

  let candidateFiles: string[];
  if (range === "all") {
    candidateFiles = ndjsonFiles;
  } else if (range === "24h") {
    // Today's and yesterday's files
    const today = localDateString(now);
    const yesterday = localDateString(now - MS_PER_DAY);
    candidateFiles = ndjsonFiles.filter((f) => {
      const d = parseDateFromFilename(f)!;
      return d === today || d === yesterday;
    });
  } else {
    // 7d: most recent 8 files (to handle window edge spanning the 8th file)
    candidateFiles = ndjsonFiles.slice(-8);
  }

  // Accumulate counters
  let correctionAppliedLookup = 0;
  let correctionAppliedSegmentation = 0;
  let correctionRejectedTotal = 0;
  const lookupLatencies: number[] = [];
  const segmentationLatencies: number[] = [];
  let engineInitCount = 0;
  let engineInitCacheHits = 0;
  let engineInitFreshBuilds = 0;
  let engineInitBuildMsCacheSum = 0;
  let engineInitBuildMsFreshSum = 0;
  let oldestTs: number | null = null;
  let newestTs: number | null = null;
  let totalFileSizeBytes = 0;
  let fileCount = 0;

  for (const filename of candidateFiles) {
    const filePath = join(telemetryDir, filename);
    let fileStat: { size: number } | null = null;
    try {
      fileStat = await stat(filePath);
    } catch {
      // Skip if unreadable
    }
    if (fileStat) {
      totalFileSizeBytes += fileStat.size;
    }

    let hasEventsInRange = false;
    for await (const raw of streamNdjson(filePath)) {
      const ev = raw as Record<string, unknown>;
      if (typeof ev !== "object" || ev === null) continue;

      // Parse timestamp — may be ISO string or ms number
      let ts: number;
      const rawTs = ev["timestamp"];
      if (typeof rawTs === "number") {
        ts = rawTs;
      } else if (typeof rawTs === "string") {
        ts = new Date(rawTs).getTime();
      } else {
        continue;
      }

      // Per-event timestamp filter (authoritative for non-all ranges)
      if (range !== "all" && ts < cutoffMs) continue;

      hasEventsInRange = true;
      if (oldestTs === null || ts < oldestTs) oldestTs = ts;
      if (newestTs === null || ts > newestTs) newestTs = ts;

      const eventType = ev["event"];
      switch (eventType) {
        case "correction.applied": {
          const kind = ev["kind"];
          if (kind === "lookup") correctionAppliedLookup++;
          else if (kind === "segmentation") correctionAppliedSegmentation++;
          // Also accumulate latency for lookup corrections
          if (kind === "lookup" && typeof ev["latencyMs"] === "number") {
            lookupLatencies.push(ev["latencyMs"] as number);
          }
          break;
        }
        case "lookup.latency": {
          if (typeof ev["latencyMs"] === "number") {
            lookupLatencies.push(ev["latencyMs"] as number);
          }
          break;
        }
        case "segmentation.attempt": {
          if (ev["accepted"] === true && typeof ev["latencyMs"] === "number") {
            segmentationLatencies.push(ev["latencyMs"] as number);
          }
          break;
        }
        case "correction.rejected": {
          correctionRejectedTotal++;
          break;
        }
        case "engine.init": {
          engineInitCount++;
          const fromCache = ev["fromCache"];
          const buildMs = ev["buildMs"];
          if (fromCache === true) {
            engineInitCacheHits++;
            if (typeof buildMs === "number") engineInitBuildMsCacheSum += buildMs;
          } else {
            engineInitFreshBuilds++;
            if (typeof buildMs === "number") engineInitBuildMsFreshSum += buildMs;
          }
          break;
        }
      }
    }

    if (hasEventsInRange) fileCount++;
  }

  const correctionAppliedTotal = correctionAppliedLookup + correctionAppliedSegmentation;
  const totalOutcomes = correctionAppliedTotal + correctionRejectedTotal;
  const acceptanceRate =
    totalOutcomes > 0 ? correctionAppliedTotal / totalOutcomes : null;

  // Sort latency arrays for percentile computation
  lookupLatencies.sort((a, b) => a - b);
  segmentationLatencies.sort((a, b) => a - b);

  const lookupLatencyP50 = percentile(lookupLatencies, 0.5);
  const lookupLatencyP95 = percentile(lookupLatencies, 0.95);
  const segmentationLatencyP50 = percentile(segmentationLatencies, 0.5);
  const segmentationLatencyP95 = percentile(segmentationLatencies, 0.95);

  const cacheHitRate =
    engineInitCount > 0 ? engineInitCacheHits / engineInitCount : null;
  const avgBuildMsCache =
    engineInitCacheHits > 0 ? engineInitBuildMsCacheSum / engineInitCacheHits : null;
  const avgBuildMsFresh =
    engineInitFreshBuilds > 0 ? engineInitBuildMsFreshSum / engineInitFreshBuilds : null;

  const oldestEventDate = oldestTs !== null ? localDateString(oldestTs) : null;
  const newestEventDate = newestTs !== null ? localDateString(newestTs) : null;

  // Build formatted summary
  const lines: string[] = [`Mobile autocorrect telemetry summary (${rangeLabel}):`];

  if (correctionAppliedTotal === 0 && correctionRejectedTotal === 0 && engineInitCount === 0) {
    lines.push("No autocorrect telemetry recorded");
  } else {
    lines.push("");
    lines.push("Corrections:");
    lines.push(`  corrections applied: ${correctionAppliedTotal}`);
    lines.push(`    lookup: ${correctionAppliedLookup}  segmentation: ${correctionAppliedSegmentation}`);
    lines.push(`  corrections rejected: ${correctionRejectedTotal}`);
    if (acceptanceRate !== null) {
      lines.push(`  acceptance rate: ${(acceptanceRate * 100).toFixed(1)}%`);
    }

    lines.push("");
    lines.push("Lookup latency:");
    lines.push(`  count: ${lookupLatencies.length}`);
    if (lookupLatencyP50 !== null) lines.push(`  p50: ${lookupLatencyP50.toFixed(2)}ms  p95: ${lookupLatencyP95!.toFixed(2)}ms`);

    if (segmentationLatencies.length > 0) {
      lines.push("");
      lines.push("Segmentation latency:");
      lines.push(`  count: ${segmentationLatencies.length}`);
      if (segmentationLatencyP50 !== null)
        lines.push(`  p50: ${segmentationLatencyP50.toFixed(2)}ms  p95: ${segmentationLatencyP95!.toFixed(2)}ms`);
    }

    lines.push("");
    lines.push("Engine init:");
    lines.push(`  count: ${engineInitCount}  cache hits: ${engineInitCacheHits}  fresh builds: ${engineInitFreshBuilds}`);
    if (cacheHitRate !== null) lines.push(`  cache hit rate: ${(cacheHitRate * 100).toFixed(1)}%`);
    if (avgBuildMsCache !== null) lines.push(`  avg build ms (cache): ${avgBuildMsCache.toFixed(0)}ms`);
    if (avgBuildMsFresh !== null) lines.push(`  avg build ms (fresh): ${avgBuildMsFresh.toFixed(0)}ms`);

    lines.push("");
    lines.push(`Files: ${fileCount}  total size: ${(totalFileSizeBytes / 1024).toFixed(1)}KB`);
    if (oldestEventDate) lines.push(`Date range: ${oldestEventDate} – ${newestEventDate ?? oldestEventDate}`);
  }

  const formatted = lines.join("\n");

  return {
    range,
    rangeLabel,
    oldestEventDate,
    newestEventDate,
    fileCount,
    totalFileSizeBytes,
    correctionAppliedTotal,
    correctionAppliedByKind: { lookup: correctionAppliedLookup, segmentation: correctionAppliedSegmentation },
    correctionRejectedTotal,
    acceptanceRate,
    lookupLatency: {
      count: lookupLatencies.length,
      p50: lookupLatencyP50,
      p95: lookupLatencyP95,
    },
    segmentationLatency: {
      count: segmentationLatencies.length,
      p50: segmentationLatencyP50,
      p95: segmentationLatencyP95,
    },
    engineInit: {
      count: engineInitCount,
      cacheHits: engineInitCacheHits,
      freshBuilds: engineInitFreshBuilds,
      avgBuildMsCache,
      avgBuildMsFresh,
    },
    cacheHitRate,
    formatted,
  };
}
