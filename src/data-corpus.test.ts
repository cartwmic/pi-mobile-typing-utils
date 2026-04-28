/**
 * src/data-corpus.test.ts — Smoke check for data/trigram-top500k.tsv shape.
 *
 * This test is AUTOMATICALLY SKIPPED when the TSV is absent (which it is
 * until §16.2 is run). Once the user runs the trigram build pipeline and
 * commits data/trigram-top500k.tsv, this test activates and acts as a
 * regression guard against accidentally committing a malformed corpus.
 *
 * Phase 13, task §16.4.
 */

import { createReadStream } from "node:fs";
import { existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tsvPath = join(__dirname, "..", "data", "trigram-top500k.tsv");

describe("data/trigram-top500k.tsv shape (smoke check)", () => {
  test.skipIf(!existsSync(tsvPath))(
    "TSV exists with expected shape",
    async () => {
      const stats = statSync(tsvPath);
      // Sanity bounds: at least 1 KB, at most 50 MB. The v1 ship uses the
      // orgtre top-3 000 corpus (~60 KB after vocab filtering); a future
      // v1.1 swap to the full Google Books v2/v3 pipeline will land in the
      // ~5–20 MB range. The bounds accommodate both regimes.
      expect(stats.size).toBeGreaterThan(1_000);
      expect(stats.size).toBeLessThan(50_000_000);

      // Stream and validate format
      const linePattern = /^[a-z]+\t[a-z]+\t[a-z]+\t\d+$/;
      let lineCount = 0;
      let badLine: string | null = null;
      const rl = createInterface({
        input: createReadStream(tsvPath),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (line === "") continue; // tolerate trailing newline
        if (!linePattern.test(line)) {
          badLine = line;
          break;
        }
        lineCount++;
      }
      expect(badLine).toBeNull();
      // Lower bound: any reasonable corpus must have >=100 trigrams. Upper:
      // 1M caps the original "top-500k" intent with headroom.
      expect(lineCount).toBeGreaterThan(100);
      expect(lineCount).toBeLessThan(1_000_000);
    },
    30_000, // 30s timeout for a multi-MB stream
  );
});
