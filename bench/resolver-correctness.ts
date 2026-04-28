/**
 * bench/resolver-correctness.ts — Assert that resolveSymspellPackageRoot()
 * returns a directory containing `data/frequency_dictionary_en_82_765.txt`.
 *
 * Run: npx tsx bench/resolver-correctness.ts
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { resolveSymspellPackageRoot } from "../src/symspell-paths.js";

async function main() {
  console.log("## Resolver correctness check\n");

  const root = resolveSymspellPackageRoot();
  if (root === null) {
    console.error("✗ resolveSymspellPackageRoot() returned null — resolver failed.");
    console.error("  This means the caching + unigram-only loader will fall back to");
    console.error("  upstream loadDefaultDictionaries (bigrams loaded as side effect).");
    process.exit(1);
  }

  console.log(`Resolved package root: ${root}`);

  const dictPath = join(root, "data", "frequency_dictionary_en_82_765.txt");
  try {
    await access(dictPath);
    console.log(`✓ Dictionary file exists: ${dictPath}`);
  } catch {
    console.error(`✗ Dictionary file NOT found at: ${dictPath}`);
    console.error("  The symspell-ts package layout may have changed — update resolveSymspellPackageRoot().");
    process.exit(1);
  }

  console.log("\nResolver is correctly configured.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
