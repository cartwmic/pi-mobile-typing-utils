import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // SymSpell default-dictionary load can take several seconds, and multiple
    // test files now initialize it in parallel (engine bundled-dict suite +
    // symspell probe). The default 5s timeout is too tight under that load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
