# Data attributions

## Google Books n-grams (English, 2010–2019)

The trigram side-table corpus at `data/trigram-top500k.tsv` is derived from the
**Google Books English n-gram corpus** via the cleaned, pre-aggregated lists
published at:

> orgtre/google-books-ngram-frequency
> https://github.com/orgtre/google-books-ngram-frequency
> Specifically: `ngrams/3grams_english.csv` (top-3 000 English 3-grams from
> Google Books v3, snapshot 20200217, restricted to 2010–2019)

The Google Books n-gram dataset itself is published by Google under the
**Creative Commons Attribution 3.0 Unported license (CC BY 3.0)**:

  https://creativecommons.org/licenses/by/3.0/

The orgtre cleaned lists are published under the same license per the upstream
repository's README.

`scripts/build-trigrams-from-orgtre.ts` downloads this CSV, filters trigrams
to those whose three words all appear in either the bundled SymSpell unigram
dictionary or this package's `data/tech-dictionary.txt`, drops trigrams with
non-alphabetic tokens, and emits `data/trigram-top500k.tsv` in the
`w1<TAB>w2<TAB>w3<TAB>count<NEWLINE>` format the runtime expects.

Note on filename: the file is named `trigram-top500k.tsv` for runtime stability
across cache key versions and code references; the actual row count of the
v1 ship is roughly 2 700 (after vocabulary filtering of the orgtre top-3 000).
A larger corpus (e.g. via the legacy `scripts/build-trigrams.ts` running over
the full Google Books v2/v3 snapshot, or a swap to a Stack Exchange / Wikipedia
source per `README.md` "Known limitations") is a v1.1 candidate.
