#!/usr/bin/env bash
set -euo pipefail

npm run build

pack_output="$(npm pack --dry-run 2>&1)"
printf '%s
' "$pack_output"

if ! grep -Fq 'data/tech-dictionary.txt' <<<"$pack_output"; then
  echo "ERROR: data/tech-dictionary.txt is missing from npm pack --dry-run output." >&2
  exit 1
fi

node --input-type=module <<'EOF'
import { readFileSync } from "node:fs";
import { TECH_DICTIONARY_PATH } from "./dist/index.js";

const contents = readFileSync(TECH_DICTIONARY_PATH, "utf8");
const words = contents.split(/\r?\n/).filter(Boolean);

if (words.length < 15000 || words.length > 30000) {
  throw new Error(`Tech dictionary word count ${words.length} is outside the expected 15000-30000 range.`);
}

console.log(`ESM smoke test passed: ${TECH_DICTIONARY_PATH} (${words.length} words)`);
EOF
