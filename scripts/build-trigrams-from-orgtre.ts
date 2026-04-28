#!/usr/bin/env tsx
/**
 * build-trigrams-from-orgtre.ts — Pragmatic v1 trigram-corpus builder.
 *
 * Background: `scripts/build-trigrams.ts` targets the full Google Books v2
 * snapshot (20120701), which Google retired in favour of v3 (20200217). The
 * v3 dataset is ~2.4 TB and infeasible to download on a developer
 * workstation. Until that script is adapted, this slim builder ingests
 * `orgtre/google-books-ngram-frequency`'s pre-aggregated, cleaned
 * top-3 000 English 3-grams CSV (derived from the SAME Google Books v3
 * source, restricted to 2010–2019, ~63 KB on disk) and converts it to the
 * TSV format the runtime expects.
 *
 *   Source : https://github.com/orgtre/google-books-ngram-frequency
 *   File   : ngrams/3grams_english.csv
 *   License: CC-BY 3.0 (see attribution in data/LICENSES.md)
 *
 * Output: `data/trigram-top500k.tsv` (filename retained for runtime stability;
 * actual row count is the orgtre 3 000 minus rows filtered for non-ASCII /
 * non-alphabetic / pre-existing-vocab violations).
 *
 * Filters applied (matching `scripts/build-trigrams.ts`'s spec):
 *   - lowercase the ngram tokens
 *   - drop trigrams with any non-alphabetic-ASCII character
 *   - drop trigrams containing words ABSENT from BOTH the bundled SymSpell
 *     unigram dictionary AND the package tech-dictionary
 *
 * Run:
 *   npx tsx scripts/build-trigrams-from-orgtre.ts
 */

import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const SOURCE_URL =
  "https://raw.githubusercontent.com/orgtre/google-books-ngram-frequency/main/ngrams/3grams_english.csv";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const OUT_PATH = resolve(REPO, "data/trigram-top500k.tsv");
const TECH_DICT_PATH = resolve(REPO, "data/tech-dictionary.txt");

function findSymspellRoot(): string {
  const req = createRequire(import.meta.url);
  // resolve("symspell-ts") returns the entrypoint file; walk up to its package.json.
  let p = req.resolve("symspell-ts");
  for (let i = 0; i < 8; i++) {
    p = dirname(p);
    try {
      const pkg = JSON.parse(readFileSync(join(p, "package.json"), "utf8"));
      if (pkg.name === "symspell-ts") return p;
    } catch {}
  }
  throw new Error("Could not locate symspell-ts package root");
}

function loadUnigramSet(): Set<string> {
  const root = findSymspellRoot();
  const txt = readFileSync(join(root, "data/frequency_dictionary_en_82_765.txt"), "utf8");
  const out = new Set<string>();
  for (const line of txt.split(/\r?\n/)) {
    const word = line.split(/\s+/)[0]?.trim();
    if (word) out.add(word.toLowerCase());
  }
  return out;
}

function loadTechDict(): Set<string> {
  const txt = readFileSync(TECH_DICT_PATH, "utf8");
  const out = new Set<string>();
  for (const line of txt.split(/\r?\n/)) {
    const w = line.trim().toLowerCase();
    if (w) out.add(w);
  }
  return out;
}

function isLowerAsciiAlpha(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x61 || c > 0x7a) return false;
  }
  return s.length > 0;
}

async function main() {
  console.error(`Source: ${SOURCE_URL}`);
  console.error(`Output: ${OUT_PATH}\n`);

  console.error("Loading SymSpell unigram dictionary…");
  const unigrams = loadUnigramSet();
  console.error(`  ${unigrams.size.toLocaleString()} unigrams`);

  console.error("Loading tech-dictionary…");
  const techDict = loadTechDict();
  console.error(`  ${techDict.size.toLocaleString()} tech-dict entries`);

  const allowed = new Set<string>([...unigrams, ...techDict]);

  console.error(`Fetching ${SOURCE_URL}…`);
  const resp = await fetch(SOURCE_URL);
  if (!resp.ok) {
    throw new Error(`Source fetch failed: HTTP ${resp.status}`);
  }
  const csv = await resp.text();
  console.error(`  ${(csv.length / 1024).toFixed(1)} KB downloaded\n`);

  const lines = csv.split(/\r?\n/);
  let scanned = 0;
  let kept = 0;
  let droppedShape = 0;
  let droppedVocab = 0;
  let droppedNonAlpha = 0;

  const out: { triple: string; count: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line.startsWith("ngram")) continue; // header
    if (!line) continue;
    scanned++;

    // CSV: "w1 w2 w3,count"
    const lastComma = line.lastIndexOf(",");
    if (lastComma <= 0) {
      droppedShape++;
      continue;
    }
    const ngram = line.slice(0, lastComma).toLowerCase();
    const countStr = line.slice(lastComma + 1).trim();
    const count = Number(countStr);
    if (!Number.isFinite(count) || count <= 0) {
      droppedShape++;
      continue;
    }

    const words = ngram.split(/\s+/);
    if (words.length !== 3) {
      droppedShape++;
      continue;
    }

    if (!isLowerAsciiAlpha(words[0]) || !isLowerAsciiAlpha(words[1]) || !isLowerAsciiAlpha(words[2])) {
      droppedNonAlpha++;
      continue;
    }

    if (!allowed.has(words[0]) || !allowed.has(words[1]) || !allowed.has(words[2])) {
      droppedVocab++;
      continue;
    }

    out.push({ triple: `${words[0]}\t${words[1]}\t${words[2]}`, count });
    kept++;
  }

  // Sort count-descending, ties by lexicographic triple for determinism.
  out.sort((a, b) => (b.count - a.count) || a.triple.localeCompare(b.triple));

  const body = out.map((r) => `${r.triple}\t${r.count}`).join("\n");
  await writeFile(OUT_PATH, body + (body ? "\n" : ""), "utf8");

  console.error("\n=== Summary ===");
  console.error(`Scanned:           ${scanned.toLocaleString()}`);
  console.error(`Dropped (shape):   ${droppedShape.toLocaleString()}`);
  console.error(`Dropped (alpha):   ${droppedNonAlpha.toLocaleString()}`);
  console.error(`Dropped (vocab):   ${droppedVocab.toLocaleString()}`);
  console.error(`Kept:              ${kept.toLocaleString()}`);
  console.error(`Output bytes:      ${body.length.toLocaleString()}`);

  console.error("\n=== Top 10 ===");
  for (const r of out.slice(0, 10)) {
    console.error(`  ${r.triple}\t${r.count}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
