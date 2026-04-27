import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SymSpell, Verbosity, loadDefaultDictionaries } from "symspell-ts";
import { describe, expect, test } from "vitest";

const notesPath = fileURLToPath(new URL("../NOTES.md", import.meta.url));
const notesHeading = "## symspell-ts contraction probe (task 3.0)";

function formatResults(word: string, distance: 1 | 2, symSpell: SymSpell): string {
  const results = symSpell.lookup(word, Verbosity.Top, distance);
  return JSON.stringify(
    results.map((result) => ({
      term: result.term,
      distance: result.distance,
      count: result.count,
    })),
  );
}

function upsertNotesSection(section: string): void {
  let current = "";

  try {
    current = readFileSync(notesPath, "utf8");
  } catch {
    current = "";
  }

  const normalized = current.trimEnd();
  const escapedHeading = notesHeading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)${escapedHeading}(?:[\\s\\S]*?)(?=\\n## |$)`, "g");
  const withoutExistingSections = normalized.replace(pattern, "").trim();

  const nextContent = normalized.match(pattern)
    ? [section, withoutExistingSections].filter(Boolean).join("\n\n")
    : [normalized, section].filter(Boolean).join("\n\n");

  writeFileSync(notesPath, `${nextContent.trimEnd()}\n`, "utf8");
}

describe("symspell-ts probe", () => {
  test("confirms teh resolves to the at distance 1 and records contraction results", () => {
    const symSpell = new SymSpell();
    loadDefaultDictionaries(symSpell);

    const tehResults = symSpell.lookup("teh", Verbosity.Top, 1);
    const topSuggestion = tehResults[0];

    if (!topSuggestion || topSuggestion.term !== "the" || topSuggestion.distance !== 1) {
      throw new Error(
        `Hard stop: expected lookup(\"teh\", Verbosity.Top, 1) to return \"the\" at distance 1, got ${JSON.stringify(
          tehResults.map((result) => ({
            term: result.term,
            distance: result.distance,
            count: result.count,
          })),
        )}`,
      );
    }

    expect(topSuggestion.term).toBe("the");
    expect(topSuggestion.distance).toBe(1);

    const lines = [
      notesHeading,
      `- lookup("dont", dist=1): ${formatResults("dont", 1, symSpell)}`,
      `- lookup("dont", dist=2): ${formatResults("dont", 2, symSpell)}`,
      `- lookup("wont", dist=1): ${formatResults("wont", 1, symSpell)}`,
      `- lookup("wont", dist=2): ${formatResults("wont", 2, symSpell)}`,
      `- lookup("its", dist=1): ${formatResults("its", 1, symSpell)}`,
      `- lookup("its", dist=2): ${formatResults("its", 2, symSpell)}`,
      `- lookup("cant", dist=1): ${formatResults("cant", 1, symSpell)}`,
      `- lookup("cant", dist=2): ${formatResults("cant", 2, symSpell)}`,
      "",
      "Known limitation: apostrophe handling is not reliable for mobile-style contraction input. The English SymSpell dictionary may treat apostrophe-free forms like `wont`, `its`, and `cant` as valid words, while `dont` prefers `done` instead of `don't`, and the engine deliberately skips tokens containing apostrophes (for example `don't`) because task 3.2 only allows `^[A-Za-z]{3,}$`. README task 8.8 should call out that apostrophe/contraction autocorrect is limited.",
    ];

    upsertNotesSection(lines.join("\n"));
  });
});
