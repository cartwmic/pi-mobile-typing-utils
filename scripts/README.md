# Build Scripts

## build-tech-dict.ts

Assembles `data/tech-dictionary.txt` from cspell package dictionaries.

```bash
npm run build:dict
```

See `package.json` for the full command.

---

## build-trigrams.ts — Google Books 3-gram extractor

Produces `data/trigram-top500k.tsv` from the Google Books English 3-gram dataset
(year ≥ 1990, lowercase-ASCII words in the SymSpell unigram or tech dictionary,
top 500,000 trigrams by aggregated count).

This script is committed for documentation and reproducibility purposes. It is **NOT**
invoked by `npm test`, `npm run build`, or CI. Run it manually when the TSV needs to
be regenerated (initial generation or corpus update only).

### Source dataset

| Field          | Value                                                                          |
|----------------|--------------------------------------------------------------------------------|
| Name           | Google Books English 3-grams, all (case-sensitive)                             |
| Snapshot       | **20120701** (2012-07-01)                                                      |
| License        | [Creative Commons Attribution-ShareAlike 3.0 Unported (CC-BY-SA 3.0)][cc-by-sa-3] |
| Homepage       | http://storage.googleapis.com/books/ngrams/books/datasetsv2.html               |
| Attribution    | Required in `data/LICENSES.md` per CC-BY-SA 3.0 terms                         |
| Expected output size | 5–20 MB (`data/trigram-top500k.tsv`, uncompressed TSV)             |

[cc-by-sa-3]: https://creativecommons.org/licenses/by-sa/3.0/

> **License obligation:** CC-BY-SA 3.0 requires attribution in any distributed form. The required attribution text is in `data/LICENSES.md`. Do not ship `data/trigram-top500k.tsv` without also shipping `data/LICENSES.md`.

URL pattern:
```
http://storage.googleapis.com/books/ngrams/books/googlebooks-eng-all-3gram-20120701-{NN}.gz
```
where `NN` runs from `00` to `99` (100 files total).

> **⚠ KNOWN ISSUE — SOURCE URL ROT (verified 2026-04-28):** The v2 URLs above
> return 404. Google has retired the v2 snapshot in favour of
> [v3 (snapshot 20200217)](http://storage.googleapis.com/books/ngrams/books/datasetsv3.html)
> at `http://storage.googleapis.com/books/ngrams/books/20200217/eng/3-{NNNNN}-of-06881.gz`.
> The v3 dataset is **~2.4 TB total** (6 881 files × ~350 MB each), making the
> full download infeasible on a typical workstation. Two paths forward, both
> deferred from this change:
>
> 1. Adapt `build-trigrams.ts` to consume v3 AND accept sampled input
>    (e.g. the first 1% of shards, ~24 GB), trading some long-tail
>    aggregation accuracy for tractability.
> 2. Swap the corpus source to something smaller and more terminal-relevant
>    (Stack Exchange data dump, Wikipedia simplified, conversational chat).
>    The Known limitations section in `README.md` already names this as a
>    candidate v2 swap.
>
> Until one of those lands, the autocorrect engine operates without the
> trigram tier (the lazy-attach singleton resolves to `null` when
> `data/trigram-top500k.tsv` is absent; the rerank's trigram tier is a
> strict no-op per design.md Decision 6, leaving bigram + unigram + edit
> distance scoring intact).

### Prerequisites

- **Node.js ≥ 18** (for the streams API used by `createGunzip`)
- **`tsx`** installed (`npm install -g tsx` or use `npx tsx`)
- **~4 GB free disk space** for temporary shard files (auto-deleted on success)
- **~1 GB peak resident memory** (one shard's aggregation Map at a time)
- **Internet access** (or pre-downloaded source files — see below)

### Runtime expectations

| Phase          | Wall time | Notes                                         |
|----------------|-----------|-----------------------------------------------|
| Download (100 gzipped files, ~7 GB total) | 20–60 min | Depends on bandwidth |
| Pass 1 (shard) | 30–60 min | Decompresses, filters, writes 64 shard files  |
| Pass 2 (merge) | 5–15 min  | Per-shard aggregation + top-500K min-heap      |
| **Total**      | **60–120 min** |                                          |

Peak shard disk usage: ~2–4 GB (deleted after completion).  
Peak RSS: ~500 MB–1 GB (dominated by one shard's aggregation Map).

### How to run

#### Step 1 — Download source files

```bash
mkdir -p /tmp/google-books-3gram
for i in $(seq -w 0 99); do
  curl -C - -o "/tmp/google-books-3gram/googlebooks-eng-all-3gram-20120701-${i}.gz" \
    "http://storage.googleapis.com/books/ngrams/books/googlebooks-eng-all-3gram-20120701-${i}.gz"
done
```

(`-C -` resumes partial downloads in case of interruption.)

#### Step 2 — Run the build script

```bash
npx tsx scripts/build-trigrams.ts /tmp/google-books-3gram/*.gz
```

Or with a custom shard directory (useful to inspect shards after the run):

```bash
npx tsx scripts/build-trigrams.ts \
  --shard-dir /tmp/trigram-shards \
  --keep-shards \
  /tmp/google-books-3gram/*.gz
```

#### Step 3 — Commit outputs

After completion:

```bash
# Create the license attribution file if it doesn't exist yet
cat > data/LICENSES.md << 'EOF'
# Data Licenses

## data/trigram-top500k.tsv

Source: Google Books Ngram Viewer dataset, English 3-grams, snapshot 20120701.

> Jean-Baptiste Michel*, Yuan Kui Shen, Aviva Presser Aiden, Adrian Veres,
> Matthew K. Gray, William Brockman, The Google Books Team, Joseph P. Pickett,
> Dale Hoiberg, Dan Clancy, Peter Norvig, Jon Orwant, Steven Pinker,
> Martin A. Nowak, and Erez Lieberman Aiden*. Quantitative Analysis of Culture
> Using Millions of Digitized Books. *Science* (Published online ahead of print:
> 12/16/2010).

License: [Creative Commons Attribution 3.0 Unported (CC BY 3.0)](https://creativecommons.org/licenses/by/3.0/)

Dataset homepage: http://storage.googleapis.com/books/ngrams/books/datasetsv2.html
EOF

git add data/trigram-top500k.tsv data/LICENSES.md
git commit -m "data: add trigram-top500k.tsv (Google Books 3-gram, 20120701 snapshot)"
```

Then run task 3.3 to add `data/trigram-top500k.tsv` and `data/LICENSES.md` to
`package.json`'s `files` array.

### Summary statistics printed to stderr

After completion the script prints:
- Total source rows scanned (all years + all words)
- Retained rows (after year ≥ 1990, lowercase-ASCII, dictionary filters)
- Shard sizes (min / median / max retained rows per shard)
- Top 10 trigrams by aggregated count

### Algorithm

The script uses a **two-pass shard+merge** approach for an exactly-correct
top-500K extraction (a naïve bounded-heap over a streaming pass would be wrong
because evicted triples may re-accumulate qualifying counts later in the stream):

**Pass 1 — sharding:**  
Stream each source file (decompressing on the fly via `zlib.createGunzip`).
For each retained `(w1, w2, w3, year_count)`, compute `FNV-1a(w1+w2+w3) % 64`
and append the line to one of 64 shard files. All occurrences of the same
triple land in the same shard by construction.

**Pass 2 — merge:**  
For each shard file, build an exact `Map<triple, total_count>` (possible because
each triple's counts are all in one shard). Feed the map into a global
fixed-capacity min-heap (capacity = 500,000). After all shards are processed,
the heap contains the top 500,000 triples by count. Sort descending and write
to `data/trigram-top500k.tsv`.
