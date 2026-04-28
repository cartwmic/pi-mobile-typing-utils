import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Walk up from the resolved symspell-ts entrypoint's directory until we find
 * a `package.json` whose `name` field equals `"symspell-ts"`. Return that
 * directory path, or `null` if resolution fails for any reason.
 *
 * We resolve the bare specifier `"symspell-ts"` (NOT `"symspell-ts/package.json"`)
 * because the upstream `exports` map blocks the `package.json` subpath with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * Used by the correction engine to locate
 * `<pkgRoot>/data/frequency_dictionary_en_82_765.txt` so that it can load
 * only the unigram dictionary (skipping bigrams entirely), which shaves
 * ~24 MB of resident memory and ~30% of cold-start build time versus the
 * upstream `loadDefaultDictionaries` path. See design.md and bench/ for
 * measurements.
 */
export function resolveSymspellPackageRoot(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const entrypoint = require.resolve("symspell-ts");
    let dir = dirname(entrypoint);

    // Walk upward. Stop when we reach the filesystem root (dirname returns the
    // same value as its input) to avoid an infinite loop.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const pkgPath = join(dir, "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown };
        if (pkg.name === "symspell-ts") {
          return dir;
        }
      } catch {
        // No package.json here or parse error — keep walking up.
      }

      const parent = dirname(dir);
      if (parent === dir) {
        // Filesystem root reached; walk exhausted without a match.
        break;
      }
      dir = parent;
    }

    return null;
  } catch {
    return null;
  }
}
