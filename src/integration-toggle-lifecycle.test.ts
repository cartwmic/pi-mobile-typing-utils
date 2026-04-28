import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FakeCustomEditor, fakeMatchesKey, typeText } from "../test/fake-custom-editor.js";
import { Config } from "./config.js";
import { LearnedDictionary } from "./learned-dictionary.js";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  CustomEditor: FakeCustomEditor,
}));

vi.mock("@mariozechner/pi-tui", () => ({
  matchesKey: fakeMatchesKey,
}));

const { createTyposCommand } = await import("./commands.js");

type Notification = {
  message: string;
  level?: "info" | "warning" | "error";
};

type PersistedDictionary = {
  version: 1;
  words: Record<string, { added: string; source: "learned" | "manual"; rejections: number }>;
  pendingRejections: Record<string, number>;
};

type MockCommandContext = ExtensionCommandContext & {
  notifications: Notification[];
  setEditorComponentCalls: unknown[];
  currentEditor?: FakeCustomEditor;
};

describe("toggle lifecycle integration", () => {
  let tempDir = "";
  let filePath = "";

  beforeEach(async () => {
    tempDir = join(tmpdir(), `toggle-lifecycle-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    filePath = join(tempDir, "dictionary.json");
    await writeFile(filePath, JSON.stringify({ version: 1, words: {}, pendingRejections: {} }, null, 2) + "\n", "utf8");

    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reuses the engine across toggles and preserves learned dictionary state", async () => {
    const learnedDictionary = new LearnedDictionary({ filePath });
    await learnedDictionary.load();

    const initialize = vi.fn(async () => undefined);
    const shouldCorrect = vi.fn((word: string) => {
      if (word === "teh" && !learnedDictionary.has(word)) {
        return { corrected: true as const, suggestion: "the" };
      }

      return { corrected: false as const };
    });

    const command = createTyposCommand({
      learnedDictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: new Config({ filePath: join(tempDir, `config-${randomUUID()}.json`) }),
      createCorrectionEngine: () => ({ initialize, shouldCorrect, getReadinessState: () => "building" as const } as never),
    });
    const ctx = createCommandContext();

    await command.handler("on", ctx);

    expect(command.state.enabled).toBe(true);
    // With the new non-blocking design, initialize() is called once on first enable.
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(ctx.setEditorComponentCalls.at(-1)).toEqual(expect.any(Function));
    expect(ctx.currentEditor).toBeDefined();

    typeText(ctx.currentEditor!, "teh ");
    ctx.currentEditor!.handleInput("\x7f");
    await learnedDictionary.save();

    expect(learnedDictionary.has("teh")).toBe(false);
    expect(await readPersisted(filePath)).toMatchObject({
      words: {},
      pendingRejections: { teh: 1 },
    });

    await command.handler("off", ctx);

    expect(command.state.enabled).toBe(false);
    expect(ctx.setEditorComponentCalls.at(-1)).toBeUndefined();

    await command.handler("on", ctx);

    expect(command.state.enabled).toBe(true);
    // disable() now drops the engine, so the second enable() constructs a fresh one
    // and calls initialize() again (Section 5.3: always discard, always rebuild).
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(ctx.setEditorComponentCalls.filter((call) => typeof call === "function")).toHaveLength(2);
    expect(await readPersisted(filePath)).toMatchObject({
      words: {},
      pendingRejections: { teh: 1 },
    });

    typeText(ctx.currentEditor!, "teh ");
    ctx.currentEditor!.handleInput("\x7f");
    await learnedDictionary.save();

    expect(learnedDictionary.has("teh")).toBe(true);
    expect(await readPersisted(filePath)).toMatchObject({
      words: {
        teh: {
          source: "learned",
          rejections: 2,
        },
      },
      pendingRejections: {},
    });
  });
});

function createCommandContext(): MockCommandContext {
  const notifications: Notification[] = [];
  const setEditorComponentCalls: unknown[] = [];

  const ctx = {
    notifications,
    setEditorComponentCalls,
    ui: {
      notify(message: string, level?: "info" | "warning" | "error") {
        notifications.push({ message, level });
      },
      setStatus: vi.fn(),
      confirm: vi.fn(async () => true),
      setEditorComponent(factory?: ((tui: unknown, theme: unknown, keybindings: unknown) => FakeCustomEditor) | undefined) {
        setEditorComponentCalls.push(factory);
        ctx.currentEditor = factory ? factory({} as never, {} as never, {} as never) : undefined;
      },
    },
  } as unknown as MockCommandContext;

  return ctx;
}

async function readPersisted(filePath: string): Promise<PersistedDictionary> {
  return JSON.parse(await readFile(filePath, "utf8")) as PersistedDictionary;
}
