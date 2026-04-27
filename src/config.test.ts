import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Config, DEFAULT_CONFIG } from "./config.js";

describe("Config", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = join(tmpdir(), `config-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns the bootstrap default mode when the file does not exist", async () => {
    const config = new Config({ filePath: join(tempDir, "missing.json") });
    await config.load();

    expect(config.getDefaultMode()).toBe(DEFAULT_CONFIG.defaultMode);
    expect(config.getDefaultMode()).toBe("off");
  });

  test("setDefaultMode persists the new value atomically", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setDefaultMode("on");

    const persisted = await readFile(filePath, "utf8");
    const parsed = JSON.parse(persisted) as { version: number; defaultMode: string };
    expect(parsed.version).toBe(1);
    expect(parsed.defaultMode).toBe("on");

    const reloaded = new Config({ filePath });
    await reloaded.load();
    expect(reloaded.getDefaultMode()).toBe("on");
  });

  test("setDefaultMode is a no-op when the value is unchanged", async () => {
    const filePath = join(tempDir, "config.json");
    const config = new Config({ filePath });
    await config.load();

    await config.setDefaultMode("off");

    // No save happened — no file written.
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("falls back to the bootstrap default for malformed JSON without throwing", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(filePath, "{ not valid json", "utf8");

    const config = new Config({ filePath });
    await config.load();

    expect(config.getDefaultMode()).toBe("off");
  });

  test("ignores unknown defaultMode values and falls back to the bootstrap default", async () => {
    const filePath = join(tempDir, "config.json");
    await writeFile(filePath, JSON.stringify({ version: 1, defaultMode: "maybe" }), "utf8");

    const config = new Config({ filePath });
    await config.load();

    expect(config.getDefaultMode()).toBe("off");
  });
});
