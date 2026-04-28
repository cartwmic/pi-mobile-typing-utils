/**
 * telemetry.ts — Local NDJSON telemetry writer for the mobile-autocorrect extension.
 *
 * Writes events to <cacheDir>/telemetry/events-YYYY-MM-DD.ndjson (local date).
 * Three privacy levels (sourced from config.ts but re-declared here to keep this
 * module self-contained and avoid circular imports):
 *
 *   off     — no events written, no directory created.
 *   metrics — structural/numeric fields only; content fields set to null.
 *   debug   — full event including tokens, suggestions, candidate lists.
 *
 * Design decisions:
 *
 * FIELD MASKING: content fields are set to null (not omitted) at "metrics" level
 * so that NDJSON parsers downstream maintain a stable JSON shape across privacy
 * levels. Omitting keys would require consumers to branch on key presence; null
 * signals "intentionally redacted" while keeping the schema predictable.
 *
 * FIRE-AND-FORGET: emit() is synchronous from the caller's perspective.  Disk
 * I/O is chained through an internal promise queue (writeChain) so concurrent
 * emit() calls cannot interleave bytes within a single NDJSON line.
 *
 * MKDIR-ONCE: the first emit at a non-off level creates the telemetry directory
 * inside the promise chain (still invisible to the caller).  Subsequent emits
 * skip the mkdir step (mkdirDone flag).
 *
 * ERROR BUDGET: non-ENOENT failures from the write chain are logged at most
 * once per writer instance (hasLoggedError flag).  ENOENT from the prune step
 * (a peer process already deleted a file) is always silent.
 *
 * NOTE — correction.applied with kind:"segmentation":
 *   winningEditDistance and scores MUST be null for segmentation corrections
 *   (segmentation has no single-candidate winner; rerank scores do not apply).
 *   The masking module passes these structural-null fields through unchanged.
 *   The engine call site (Phase 3 integration, out of scope here) is responsible
 *   for setting winningEditDistance: null and scores: null when kind === "segmentation".
 */

import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

// ─── Privacy level type ───────────────────────────────────────────────────────
// Re-declared here (mirrors config.ts TelemetryLevel) to keep this module
// self-contained.  Structurally identical so callers can pass config.getTelemetry()
// directly without a cast.
export type TelemetryLevel = "off" | "metrics" | "debug";

// ─── Injectable filesystem adapter ───────────────────────────────────────────
// Injected via constructor for testability (task 2.8 fire-and-forget test).
// Default-shimmed against node:fs/promises for production use.
export interface TelemetryFsAdapter {
  appendFile(path: string, data: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

const defaultFsAdapter: TelemetryFsAdapter = {
  appendFile: (path, data) => appendFile(path, data, "utf8"),
  mkdir: async (path, options) => {
    const result = await mkdir(path, options);
    return result;
  },
  unlink,
  readdir: (path) => readdir(path) as Promise<string[]>,
};

// ─── Content-field mapping ────────────────────────────────────────────────────
// Maps each event discriminant to the set of field names that are "content
// fields" — masked to null at "metrics" level.  Using a module-level mapping
// (rather than per-type annotations that TypeScript cannot introspect at
// runtime) keeps the masking logic simple and in one place.
const CONTENT_FIELDS_BY_EVENT: Record<string, ReadonlySet<string>> = {
  "engine.init": new Set<string>(),
  "trigram.lazy_attached": new Set<string>(),
  "lookup.latency": new Set(["token", "suggestion", "lineText", "cursor"]),
  "correction.applied": new Set(["token", "suggestion", "original", "candidates", "lineText", "cursor"]),
  "correction.rejected": new Set(["token", "suggestion"]),
  "correction.skipped": new Set(["token", "lineText", "cursor"]),
  "segmentation.attempt": new Set(["token", "suggestion"]),
};

// ─── Event types ─────────────────────────────────────────────────────────────
// Discriminated union over the `event` field.  Content fields (masked at
// "metrics" level) are typed as `… | null` to reflect the masker's behavior.
// Callers MUST supply null for content fields they cannot populate (e.g., token
// is unavailable at metrics level in production — the writer handles the null
// assignment, but the TypeScript type allows null at the call site too).

export interface EngineInitEvent {
  event: "engine.init";
  timestamp: string;
  fromCache: boolean;
  buildMs: number;
  unigramCount: number;
  bigramCount: number;
  outcome: "ready" | "degraded";
  cause: string | null;
}

export interface TrigramLazyAttachedEvent {
  event: "trigram.lazy_attached";
  timestamp: string;
  loadMs: number;
  outcome: "ready" | "failed";
  trigramCount: number | null;
}

export interface LookupLatencyEvent {
  event: "lookup.latency";
  timestamp: string;
  tokenLength: number;
  candidateCount: number;
  latencyMs: number;
  result: "corrected" | "skipped";
  /** contentField: true — set to null at "metrics" level */
  token: string | null;
  /** contentField: true — set to null at "metrics" level */
  suggestion: string | null;
  /** contentField: true — set to null at "metrics" level */
  lineText: string | null;
  /** contentField: true — set to null at "metrics" level */
  cursor: number | null;
}

/** Per-candidate score breakdown included at "debug" level. */
export interface CorrectionCandidate {
  term: string;
  ed: number;
  scores: { unigram: number; bigram: number; trigram: number; edPenalty: number };
}

export interface CorrectionAppliedEvent {
  event: "correction.applied";
  timestamp: string;
  kind: "lookup" | "segmentation";
  tokenLength: number;
  suggestionLength: number;
  candidateCount: number;
  /**
   * null when kind === "segmentation": segmentation has no single-candidate
   * winner; the engine call site (Phase 3, out of scope) passes null here.
   * The masking module passes this structural-null through unchanged.
   */
  winningEditDistance: number | null;
  latencyMs: number;
  /**
   * null when kind === "segmentation": rerank scores do not apply to the
   * segmentation path.  Engine call site is responsible for null when kind
   * is "segmentation".
   */
  scores: { unigram: number; bigram: number; trigram: number; edPenalty: number } | null;
  /**
   * Populated only when both head-to-head paths produced a viable result
   * (for v1.1 tuning analysis); null otherwise.
   */
  scoresVsAlt: { lookupScore: number | null; segmentationScore: number | null } | null;
  /** contentField: true — set to null at "metrics" level */
  token: string | null;
  /** contentField: true — set to null at "metrics" level */
  suggestion: string | null;
  /** contentField: true — set to null at "metrics" level */
  original: string | null;
  /** contentField: true — set to null at "metrics" level */
  candidates: CorrectionCandidate[] | null;
  /** contentField: true — set to null at "metrics" level */
  lineText: string | null;
  /** contentField: true — set to null at "metrics" level */
  cursor: number | null;
}

export interface CorrectionRejectedEvent {
  event: "correction.rejected";
  timestamp: string;
  msUntilUndo: number;
  kind: "lookup" | "segmentation";
  tokenLength: number;
  /** contentField: true — set to null at "metrics" level */
  token: string | null;
  /** contentField: true — set to null at "metrics" level */
  suggestion: string | null;
}

export interface CorrectionSkippedEvent {
  event: "correction.skipped";
  timestamp: string;
  tokenLength: number;
  reason:
    | "in_dict"
    | "not_eligible"
    | "no_candidates"
    | "low_confidence"
    | "segmentation_rejected"
    | "adaptive_ed_too_high";
  /** contentField: true — set to null at "metrics" level */
  token: string | null;
  /** contentField: true — set to null at "metrics" level */
  lineText: string | null;
  /** contentField: true — set to null at "metrics" level */
  cursor: number | null;
}

export interface SegmentationAttemptEvent {
  event: "segmentation.attempt";
  timestamp: string;
  tokenLength: number;
  accepted: boolean;
  segmentCount: number | null;
  probabilityLogSum: number;
  latencyMs: number;
  /** contentField: true — set to null at "metrics" level */
  token: string | null;
  /** contentField: true — set to null at "metrics" level */
  suggestion: string | null;
}

export type TelemetryEvent =
  | EngineInitEvent
  | TrigramLazyAttachedEvent
  | LookupLatencyEvent
  | CorrectionAppliedEvent
  | CorrectionRejectedEvent
  | CorrectionSkippedEvent
  | SegmentationAttemptEvent;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the current local date as "YYYY-MM-DD". */
function localDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Returns the local date 30 days before `fromDate` (format "YYYY-MM-DD").
 * Files with a date strictly less than the returned cutoff are older than
 * 30 days and should be pruned.
 */
function cutoffDateString(fromDate: string): string {
  const parts = fromDate.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  // new Date(y, m-1, d) creates a local-time Date.
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() - 30);
  const cy = date.getFullYear();
  const cm = String(date.getMonth() + 1).padStart(2, "0");
  const cd = String(date.getDate()).padStart(2, "0");
  return `${cy}-${cm}-${cd}`;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Returns a shallow copy of the event with all content fields for its type
 * set to null.  Structural fields (including structural-null fields like
 * winningEditDistance for segmentation corrections) are passed through
 * unchanged.
 */
function maskContentFields(event: TelemetryEvent): Record<string, unknown> {
  const contentFields = CONTENT_FIELDS_BY_EVENT[event.event] ?? (new Set<string>());
  const obj: Record<string, unknown> = { ...(event as unknown as Record<string, unknown>) };
  for (const field of contentFields) {
    obj[field] = null;
  }
  return obj;
}

// ─── TelemetryWriter ──────────────────────────────────────────────────────────

export class TelemetryWriter {
  private readonly telemetryDir: string;
  private readonly getLevel: () => TelemetryLevel;
  private readonly fsAdapter: TelemetryFsAdapter;

  /** Internal serialization queue — prevents concurrent emits from interleaving bytes. */
  private writeChain: Promise<void> = Promise.resolve();

  /** True after the first successful mkdir on this instance. */
  private mkdirDone = false;

  /** Local date of the last prune run; undefined means prune has never run. */
  private lastPruneDate: string | undefined = undefined;

  /**
   * True once a non-ENOENT failure has been logged.  Caps log output to at most
   * one info-level message per writer instance.
   */
  private hasLoggedError = false;

  constructor({
    cacheDir,
    getLevel,
    fs: fsAdapter = defaultFsAdapter,
  }: {
    cacheDir: string;
    getLevel: () => TelemetryLevel;
    fs?: TelemetryFsAdapter;
  }) {
    this.telemetryDir = join(cacheDir, "telemetry");
    this.getLevel = getLevel;
    this.fsAdapter = fsAdapter;
  }

  /**
   * Emit a telemetry event.  Fire-and-forget: returns synchronously; disk I/O
   * is chained through the internal write queue.
   *
   * getLevel() is consulted on every call — NOT cached at construction — so
   * live transitions (off → metrics → debug) take effect immediately.
   */
  emit(event: TelemetryEvent): void {
    // Consult getLevel() synchronously on every emit() call.
    const level = this.getLevel();
    if (level === "off") return;

    // Date computed once per call, synchronously, before the async chain.
    const dateStr = localDateString();

    this.writeChain = this.writeChain
      .then(() => this.doAppend(event, dateStr, level))
      .catch((err: unknown) => {
        if (!this.hasLoggedError) {
          this.hasLoggedError = true;
          console.info(`[mobile-autocorrect] telemetry write error: ${formatError(err)}`);
        }
      });
  }

  /**
   * Resolves when all currently-queued writes have settled.
   * Useful for testing; safe to call in production (always resolves, never rejects).
   */
  flush(): Promise<void> {
    return this.writeChain;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async doAppend(
    event: TelemetryEvent,
    dateStr: string,
    level: TelemetryLevel,
  ): Promise<void> {
    // Task 2.2.1: mkdir once on the first non-off emit for this instance.
    if (!this.mkdirDone) {
      await this.fsAdapter.mkdir(this.telemetryDir, { recursive: true });
      this.mkdirDone = true;
    }

    // Task 2.5: date-aware pruning — re-run whenever the local date changes.
    if (dateStr !== this.lastPruneDate) {
      await this.prune(dateStr);
      this.lastPruneDate = dateStr;
    }

    // Task 2.3: field masking.
    // At "metrics": content fields → null (structural fields unchanged).
    // At "debug": emit as-is.
    const toWrite: Record<string, unknown> =
      level === "metrics"
        ? maskContentFields(event)
        : (event as unknown as Record<string, unknown>);

    // Task 2.4: filename rotation — append to today's file.
    const filename = join(this.telemetryDir, `events-${dateStr}.ndjson`);
    await this.fsAdapter.appendFile(filename, JSON.stringify(toWrite) + "\n");
  }

  /**
   * Lists the telemetry directory and unlinks files older than 30 days.
   * Handles all errors internally — never throws.
   * ENOENT from unlink (peer process already deleted the file) is silently ignored.
   * Other failures are logged at most once per instance (shared hasLoggedError budget).
   */
  private async prune(currentDate: string): Promise<void> {
    const cutoff = cutoffDateString(currentDate);

    let files: string[];
    try {
      files = await this.fsAdapter.readdir(this.telemetryDir);
    } catch (err) {
      // ENOENT: telemetry dir was just created (or doesn't exist yet) — nothing to prune.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      if (!this.hasLoggedError) {
        this.hasLoggedError = true;
        console.info(`[mobile-autocorrect] telemetry prune readdir error: ${formatError(err)}`);
      }
      return;
    }

    for (const file of files) {
      const match = /^events-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(file);
      if (!match) continue;
      const fileDate = match[1]!;
      if (fileDate < cutoff) {
        try {
          await this.fsAdapter.unlink(join(this.telemetryDir, file));
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") continue; // Peer process already deleted; silent.
          if (!this.hasLoggedError) {
            this.hasLoggedError = true;
            console.info(`[mobile-autocorrect] telemetry prune unlink error: ${formatError(err)}`);
          }
        }
      }
    }
  }
}
