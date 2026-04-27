import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTyposCommand } from "./commands.js";
import { Config } from "./config.js";
import { LearnedDictionary } from "./learned-dictionary.js";

type Notification = {
  message: string;
  level?: "info" | "warning" | "error";
};

type StatusUpdate = {
  key: string;
  value: string | undefined;
};

type MockCommandContext = ExtensionCommandContext & {
  notifications: Notification[];
  statusUpdates: StatusUpdate[];
  setEditorComponentCalls: unknown[];
};

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

describe("createTyposCommand", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = join(tmpdir(), `commands-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("serializes /typos on then /typos off during engine initialization", async () => {
    const dictionary = await createDictionary();
    const initializeDeferred = createDeferred<void>();
    const initialize = vi.fn(async () => {
      await initializeDeferred.promise;
    });

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () => ({ initialize } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    const enablePromise = command.handler("on", ctx);
    await vi.waitFor(() => {
      expect(initialize).toHaveBeenCalledTimes(1);
    });

    expect(command.state.enabled).toBe(false);
    expect(ctx.statusUpdates).toContainEqual({ key: "typos-loading", value: "Loading autocorrect..." });

    const disablePromise = command.handler("off", ctx);
    await Promise.resolve();

    initializeDeferred.resolve();
    await Promise.all([enablePromise, disablePromise]);

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(command.state.enabled).toBe(false);
    expect(ctx.setEditorComponentCalls[0]).toEqual(expect.any(Function));
    expect(ctx.setEditorComponentCalls.at(-1)).toBeUndefined();
    expect(ctx.statusUpdates).toContainEqual({ key: "typos-loading", value: undefined });
    expect(ctx.statusUpdates).toContainEqual({ key: "typos", value: "✓ Autocorrect" });
    expect(ctx.statusUpdates).toContainEqual({ key: "typos", value: undefined });
    expect(ctx.notifications.at(-1)).toEqual({ message: "Autocorrect OFF", level: "info" });
  });

  test("coalesces duplicate /typos on requests while loading", async () => {
    const dictionary = await createDictionary();
    const initializeDeferred = createDeferred<void>();
    const initialize = vi.fn(async () => {
      await initializeDeferred.promise;
    });

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () => ({ initialize } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    const firstEnable = command.handler("on", ctx);
    await vi.waitFor(() => {
      expect(initialize).toHaveBeenCalledTimes(1);
    });

    const secondEnable = command.handler("on", ctx);
    await Promise.resolve();

    initializeDeferred.resolve();
    await Promise.all([firstEnable, secondEnable]);

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(command.state.enabled).toBe(true);
    expect(ctx.notifications.filter((entry) => entry.message === "Autocorrect ON")).toHaveLength(1);
    expect(ctx.notifications.map((entry) => entry.message)).not.toContain("Autocorrect is already on");
  });

  test("treats a second bare /typos during load as a queued toggle", async () => {
    const dictionary = await createDictionary();
    const initializeDeferred = createDeferred<void>();
    const initialize = vi.fn(async () => {
      await initializeDeferred.promise;
    });

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () => ({ initialize } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    const firstToggle = command.handler("", ctx);
    await vi.waitFor(() => {
      expect(initialize).toHaveBeenCalledTimes(1);
    });

    const secondToggle = command.handler("   ", ctx);
    await Promise.resolve();

    initializeDeferred.resolve();
    await Promise.all([firstToggle, secondToggle]);

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(command.state.enabled).toBe(false);
    expect(ctx.notifications.at(-1)).toEqual({ message: "Autocorrect OFF", level: "info" });
  });

  test("formats /typos dict output and truncates to 50 entries", async () => {
    vi.useFakeTimers();

    const dictionary = await createDictionary();
    vi.spyOn(dictionary, "save").mockResolvedValue();

    const start = Date.parse("2024-01-01T00:00:00.000Z");
    for (let index = 0; index < 60; index += 1) {
      vi.setSystemTime(new Date(start + index));
      dictionary.add(`word${index}`, "manual");
    }

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });
    const ctx = createCommandContext();

    await command.handler("dict", ctx);

    const message = ctx.notifications.at(-1)?.message ?? "";
    const [results, note] = message.split("\n\n");

    expect(results.split("\n")).toHaveLength(50);
    expect(results).toContain("word59  2024-01-01T00:00:00.059Z  (manual)");
    expect(results).toContain("word10  2024-01-01T00:00:00.010Z  (manual)");
    expect(results).not.toMatch(/^word9  /m);
    expect(note).toBe("Showing 50 of 60 words — use `/typos dict search <term>` to filter");
  });

  test("filters and truncates /typos dict search results", async () => {
    vi.useFakeTimers();

    const dictionary = await createDictionary();
    vi.spyOn(dictionary, "save").mockResolvedValue();

    const start = Date.parse("2024-01-01T00:00:00.000Z");
    for (let index = 0; index < 55; index += 1) {
      vi.setSystemTime(new Date(start + index));
      dictionary.add(`term${index}`, "manual");
    }

    for (let index = 0; index < 5; index += 1) {
      vi.setSystemTime(new Date(start + 100 + index));
      dictionary.add(`other${index}`, "manual");
    }

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });
    const ctx = createCommandContext();

    await command.handler("dict search term", ctx);

    const message = ctx.notifications.at(-1)?.message ?? "";
    const [results, note] = message.split("\n\n");

    expect(results.split("\n")).toHaveLength(50);
    expect(results).toContain("term54");
    expect(results).toContain("term5");
    expect(results).not.toContain("other0");
    expect(note).toBe("Showing 50 of 55 matches");
  });

  test("/typos dict shows graduated and pending sections together", async () => {
    vi.useFakeTimers();

    const dictionary = await createDictionary();
    vi.spyOn(dictionary, "save").mockResolvedValue();

    const start = Date.parse("2024-01-01T00:00:00.000Z");
    vi.setSystemTime(new Date(start));
    dictionary.add("omega", "manual");    // graduated entry

    // Pending entries (1 rejection each — threshold is 2, so they stay pending).
    dictionary.recordRejection("nicee");
    dictionary.recordRejection("ths");

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });
    const ctx = createCommandContext();

    await command.handler("dict", ctx);

    const message = ctx.notifications.at(-1)?.message ?? "";
    const [graduatedSection, pendingSection] = message.split("\n\n");

    // Graduated section uses the standard word/date/source format.
    expect(graduatedSection).toBe("omega  2024-01-01T00:00:00.000Z  (manual)");

    // Pending section header and per-word lines.
    expect(pendingSection).toContain("Pending (1 more rejection to learn):");
    // Alphabetical order (both have count=1).
    expect(pendingSection).toContain("nicee  (1 of 2 rejections)");
    expect(pendingSection).toContain("ths  (1 of 2 rejections)");
    expect(pendingSection.indexOf("nicee")).toBeLessThan(pendingSection.indexOf("ths"));
  });

  test("shows the empty dictionary message for /typos dict", async () => {
    const dictionary = await createDictionary();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });
    const ctx = createCommandContext();

    await command.handler("dict", ctx);

    expect(ctx.notifications.at(-1)).toEqual({
      message:
        "No words in dictionary yet. Words are learned when you reject a correction by pressing backspace within 1 character of the correction.",
      level: "info",
    });
  });

  test("validates /typos dict add arguments", async () => {
    const dictionary = await createDictionary();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });
    const ctx = createCommandContext();

    await command.handler("dict add", ctx);
    await command.handler("dict add foo bar", ctx);
    await command.handler("dict add foo123", ctx);

    expect(ctx.notifications).toEqual([
      { message: "Usage: /typos dict add <word>", level: "warning" },
      { message: "Usage: /typos dict add <word>", level: "warning" },
      { message: "Usage: /typos dict add <word>", level: "warning" },
    ]);
  });

  test("reports missing dictionary entries on remove", async () => {
    const dictionary = await createDictionary();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });
    const ctx = createCommandContext();

    await command.handler("dict remove missing", ctx);

    expect(ctx.notifications.at(-1)).toEqual({ message: '"missing" not found in dictionary', level: "info" });
  });

  test("keeps the dictionary intact when clear is cancelled", async () => {
    const dictionary = await createDictionary();
    vi.spyOn(dictionary, "save").mockResolvedValue();
    dictionary.add("termux", "manual");

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });
    const ctx = createCommandContext({ confirmResult: false });

    await command.handler("dict clear", ctx);

    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Clear dictionary?",
      "This will remove all 1 learned words. Continue?",
    );
    expect(dictionary.size).toBe(1);
    expect(ctx.notifications.at(-1)).toEqual({ message: "Clear cancelled", level: "info" });
  });

  test("shows invalid subcommand errors", async () => {
    const dictionary = await createDictionary();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });
    const ctx = createCommandContext();

    await command.handler("maybe", ctx);
    await command.handler("dict frobnicate", ctx);
    await command.handler("dict search", ctx);

    expect(ctx.notifications).toEqual([
      { message: "Unknown command. Usage: /typos [on|off|dict ...|default ...]", level: "warning" },
      { message: "Usage: /typos dict [search <term>|add <word>|remove <word>|clear]", level: "warning" },
      { message: "Usage: /typos dict search <term>", level: "warning" },
    ]);
  });

  test("provides first-level and second-level argument completions", async () => {
    const dictionary = await createDictionary();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });

    // Top-level completions: value === label, since Pi replaces the whole
    // argument text and the parent is the slash command itself.
    expect(command.getArgumentCompletions("")).toEqual([
      { label: "on", value: "on" },
      { label: "off", value: "off" },
      { label: "dict", value: "dict" },
      { label: "default", value: "default" },
    ]);
    expect(command.getArgumentCompletions("o")?.map((item) => item.value)).toEqual(["on", "off"]);
    expect(command.getArgumentCompletions("d")?.map((item) => item.value)).toEqual(["dict", "default"]);
    expect(command.getArgumentCompletions("di")?.map((item) => item.value)).toEqual(["dict"]);
    expect(command.getArgumentCompletions("def")?.map((item) => item.value)).toEqual(["default"]);

    // Second-level completions: label is the leaf token, but value must
    // include the parent so applyCompletion (which replaces the whole
    // argument text) doesn't drop the `dict` / `default` word.
    expect(command.getArgumentCompletions("dict ")).toEqual([
      { label: "add", value: "dict add" },
      { label: "remove", value: "dict remove" },
      { label: "search", value: "dict search" },
      { label: "clear", value: "dict clear" },
    ]);
    expect(command.getArgumentCompletions("dict s")).toEqual([
      { label: "search", value: "dict search" },
    ]);
    expect(command.getArgumentCompletions("default ")).toEqual([
      { label: "on", value: "default on" },
      { label: "off", value: "default off" },
    ]);
    expect(command.getArgumentCompletions("default o")).toEqual([
      { label: "on", value: "default on" },
      { label: "off", value: "default off" },
    ]);
    expect(command.getArgumentCompletions("default of")).toEqual([
      { label: "off", value: "default off" },
    ]);
  });

  test("second-level completion values produce correct lines under Pi's applyCompletion", async () => {
    // Regression test for the autocomplete bug where selecting a second-level
    // completion (e.g. `on` from `/typos default `) dropped the parent token.
    // Pi's CombinedAutocompleteProvider.applyCompletion replaces the entire
    // argument text (everything after `/typos `) with the chosen item.value,
    // so item.value must include the parent token.
    const dictionary = await createDictionary();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });

    const simulateApply = (line: string, completionValue: string): string => {
      // Mirror the substring math in pi-tui's applyCompletion: prefix is the
      // argumentText returned from getSuggestions (everything after the
      // first space following the slash command name), and beforePrefix is
      // the text up to but not including that argumentText.
      const cursorCol = line.length;
      const spaceIndex = line.indexOf(" ");
      const argumentText = line.slice(spaceIndex + 1);
      const beforePrefix = line.slice(0, cursorCol - argumentText.length);
      return beforePrefix + completionValue;
    };

    // /typos default <empty> → selecting "on" must yield "/typos default on".
    const defaultOn = command.getArgumentCompletions("default ")?.[0];
    expect(defaultOn).toBeDefined();
    expect(simulateApply("/typos default ", defaultOn!.value)).toBe("/typos default on");

    // /typos default of → selecting "off" must yield "/typos default off".
    const defaultOff = command.getArgumentCompletions("default of")?.[0];
    expect(defaultOff).toBeDefined();
    expect(simulateApply("/typos default of", defaultOff!.value)).toBe("/typos default off");

    // Same regression for /typos dict subcommands.
    const dictAdd = command.getArgumentCompletions("dict a")?.[0];
    expect(dictAdd).toBeDefined();
    expect(simulateApply("/typos dict a", dictAdd!.value)).toBe("/typos dict add");
  });

  test("/typos default reports the current default mode", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("default", ctx);

    expect(ctx.notifications).toEqual([
      { message: "Default mode for new sessions: off", level: "info" },
    ]);
  });

  test("/typos default on persists the new default mode and notifies", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("default on", ctx);

    expect(config.getDefaultMode()).toBe("on");
    expect(ctx.notifications.at(-1)).toEqual({
      message: "Default mode for new sessions set to on",
      level: "info",
    });

    // A second handler instance loading the same file should observe the change.
    const reloaded = new Config({ filePath: (config as unknown as { filePath: string }).filePath });
    await reloaded.load();
    expect(reloaded.getDefaultMode()).toBe("on");
  });

  test("/typos default off is a no-op when already off", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("default off", ctx);

    expect(ctx.notifications.at(-1)).toEqual({
      message: "Default mode is already off",
      level: "info",
    });
  });

  test("/typos default rejects unknown sub-arguments", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("default maybe", ctx);

    expect(ctx.notifications.at(-1)).toEqual({
      message: "Usage: /typos default [on|off]",
      level: "warning",
    });
    expect(config.getDefaultMode()).toBe("off");
  });

  test("applyDefaultMode enables autocorrect when defaultMode is on", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    await config.setDefaultMode("on");

    const initialize = vi.fn(async () => undefined);
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
      createCorrectionEngine: () => ({ initialize } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    await command.applyDefaultMode(ctx);

    expect(command.state.enabled).toBe(true);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(ctx.notifications.at(-1)).toEqual({ message: "Autocorrect ON", level: "info" });
  });

  test("applyDefaultMode is a silent no-op when state already matches default", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    // defaultMode left at the bootstrap value "off".

    const initialize = vi.fn(async () => undefined);
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
      createCorrectionEngine: () => ({ initialize } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    await command.applyDefaultMode(ctx);

    expect(command.state.enabled).toBe(false);
    expect(initialize).not.toHaveBeenCalled();
    expect(ctx.notifications).toEqual([]);
  });

  test("applyDefaultMode disables a session that is on when defaultMode is off", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    // defaultMode "off" — also asserts the reverse-direction reconcile.

    const initialize = vi.fn(async () => undefined);
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
      createCorrectionEngine: () => ({ initialize } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    // Force the command into the enabled state via the public toggle path.
    await command.handler("on", ctx);
    expect(command.state.enabled).toBe(true);

    await command.applyDefaultMode(ctx);

    expect(command.state.enabled).toBe(false);
    expect(ctx.notifications.at(-1)).toEqual({ message: "Autocorrect OFF", level: "info" });
  });

  async function createDictionary(): Promise<LearnedDictionary> {
    const filePath = join(tempDir, `dictionary-${randomUUID()}.json`);
    return new LearnedDictionary({ filePath });
  }

  function createConfig(): Config {
    const filePath = join(tempDir, `config-${randomUUID()}.json`);
    return new Config({ filePath });
  }
});

function createCommandContext(options?: { confirmResult?: boolean }): MockCommandContext {
  const notifications: Notification[] = [];
  const statusUpdates: StatusUpdate[] = [];
  const setEditorComponentCalls: unknown[] = [];

  const ctx = {
    ui: {
      notify: vi.fn((message: string, level?: "info" | "warning" | "error") => {
        notifications.push({ message, level });
      }),
      setStatus: vi.fn((key: string, value: string | undefined) => {
        statusUpdates.push({ key, value });
      }),
      setEditorComponent: vi.fn((factory: unknown) => {
        setEditorComponentCalls.push(factory);
      }),
      confirm: vi.fn(async () => options?.confirmResult ?? true),
    },
    notifications,
    statusUpdates,
    setEditorComponentCalls,
  };

  return ctx as unknown as MockCommandContext;
}
