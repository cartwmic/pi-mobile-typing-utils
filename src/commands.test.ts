import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTyposCommand, prewarmEngine } from "./commands.js";
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

  // ---------------------------------------------------------------------------
  // Section 5: Lazy/non-blocking initialization tests (5.7.1 – 5.7.7)
  // ---------------------------------------------------------------------------

  // Helper: build a minimal fake engine with controllable readiness state
  function makeFakeEngine(
    initDeferred: { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void },
    readinessOverride?: "building" | "ready" | "degraded",
  ) {
    let readiness: "building" | "ready" | "degraded" = "building";
    const initialize = vi.fn(async () => {
      try {
        await initDeferred.promise;
        readiness = "ready";
      } catch (err) {
        readiness = "degraded";
        throw err;
      }
    });
    return {
      initialize,
      getReadinessState: () => readinessOverride ?? readiness,
      getLastInitError: () => undefined,
    };
  }

  // 5.7.1: /typos on returns immediately; editor installed before init resolves
  test("5.7.1: /typos on returns within a few ms and installs editor before init resolves", async () => {
    const dictionary = await createDictionary();
    const initDeferred = createDeferred<void>();
    const fakeEngine = makeFakeEngine(initDeferred);

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () => fakeEngine as never,
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    const start = Date.now();
    await command.handler("on", ctx);
    const elapsed = Date.now() - start;

    // Returns well before any real init (mocked deferred still pending).
    expect(elapsed).toBeLessThan(200);
    // Editor installed immediately, even before init resolves.
    expect(ctx.setEditorComponentCalls.at(-1)).toEqual(expect.any(Function));
    expect(command.state.enabled).toBe(true);
    // Persistent indicator shows loading.
    expect(ctx.statusUpdates).toContainEqual({ key: "typos", value: "Autocorrect loading…" });
    // Notification says loading.
    expect(ctx.notifications.at(-1)).toEqual({ message: "Autocorrect ON (loading…)", level: "info" });
    // Init is still pending.
    expect(fakeEngine.initialize).toHaveBeenCalledTimes(1);
    // Cleanup: resolve so the unhandled promise doesn't linger.
    initDeferred.resolve();
    await Promise.resolve();
  });

  // 5.7.2: /typos off while init pending — orphaned init callbacks are no-ops
  test("5.7.2: /typos off while init is pending does not trigger UI updates from orphaned init", async () => {
    const dictionary = await createDictionary();
    const initDeferred = createDeferred<void>();
    const fakeEngine = makeFakeEngine(initDeferred);

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () => fakeEngine as never,
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    // Enable — non-blocking, editor installed immediately.
    await command.handler("on", ctx);
    expect(command.state.enabled).toBe(true);
    const genAfterEnable = command.state.generation;

    // Disable while init is still pending.
    await command.handler("off", ctx);
    expect(command.state.enabled).toBe(false);
    expect(command.state.generation).toBeGreaterThan(genAfterEnable); // gen bumped
    expect(ctx.setEditorComponentCalls.at(-1)).toBeUndefined(); // editor removed
    expect(ctx.statusUpdates.at(-1)).toEqual({ key: "typos", value: undefined }); // status cleared
    expect(ctx.notifications.at(-1)).toEqual({ message: "Autocorrect OFF", level: "info" });

    // Record notification count before the orphaned init resolves.
    const notificationsCountBefore = ctx.notifications.length;
    const statusCountBefore = ctx.statusUpdates.length;

    // Resolve the now-orphaned init promise.
    initDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve(); // flush any chained microtasks

    // Orphan guard: no new UI side effects.
    expect(ctx.notifications).toHaveLength(notificationsCountBefore);
    expect(ctx.statusUpdates).toHaveLength(statusCountBefore);
    // Engine and initInFlight remain dropped.
    expect(command.state.engine).toBeUndefined();
    expect(command.state.initInFlight).toBeUndefined();
  });

  // 5.7.3: Double /typos on does not start a second build
  test("5.7.3: double /typos on does not start a second build", async () => {
    const dictionary = await createDictionary();
    const initDeferred = createDeferred<void>();
    const fakeEngine = makeFakeEngine(initDeferred);

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () => fakeEngine as never,
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    // First enable — starts the build.
    await command.handler("on", ctx);
    expect(fakeEngine.initialize).toHaveBeenCalledTimes(1);
    expect(command.state.enabled).toBe(true);

    // Second enable — already enabled, should emit "already on" and NOT start a second init.
    await command.handler("on", ctx);
    expect(fakeEngine.initialize).toHaveBeenCalledTimes(1); // still only one call
    expect(ctx.notifications.filter((n) => n.message === "Autocorrect is already on")).toHaveLength(1);
    expect(ctx.notifications.filter((n) => n.message === "Autocorrect ON (loading…)")).toHaveLength(1); // only from first enable

    // Cleanup.
    initDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  // 5.7.4: maxEditDistance change during in-flight init is non-blocking; prior init orphaned
  test("5.7.4: maxEditDistance config change during in-flight init orphans the prior init callbacks", async () => {
    const dictionary = await createDictionary();
    const firstInitDeferred = createDeferred<void>();
    const secondInitDeferred = createDeferred<void>();
    let callCount = 0;
    const initialize = vi.fn(async () => {
      const n = ++callCount;
      if (n === 1) {
        await firstInitDeferred.promise;
      } else {
        await secondInitDeferred.promise;
      }
    });
    const getReadinessState = () => "building" as const;

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () => ({ initialize, getReadinessState } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    // Start the first enable (init in flight).
    await command.handler("on", ctx);
    expect(initialize).toHaveBeenCalledTimes(1);
    const genAfterEnable = command.state.generation;

    // Change maxEditDistance while first init is still pending — must return quickly.
    const start = Date.now();
    await command.handler("config maxEditDistance 3", ctx);
    expect(Date.now() - start).toBeLessThan(200);

    // Generation bumped — first init is now orphaned.
    expect(command.state.generation).toBeGreaterThan(genAfterEnable);
    // A fresh init was started for the new engine.
    expect(initialize).toHaveBeenCalledTimes(2);
    // Notification: only the config-change message, no "Autocorrect ON/OFF".
    expect(ctx.notifications.at(-1)).toEqual({ message: "maxEditDistance set to 3", level: "info" });

    const notificationsCountBefore = ctx.notifications.length;
    const statusCountBefore = ctx.statusUpdates.length;

    // Resolve the first (orphaned) init — must produce zero UI side effects.
    firstInitDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.notifications).toHaveLength(notificationsCountBefore);
    expect(ctx.statusUpdates).toHaveLength(statusCountBefore);

    // Resolve the second (live) init — status should update.
    secondInitDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.statusUpdates.at(-1)).toEqual({ key: "typos", value: "✓ Autocorrect" });
  });

  // 5.7.5: maxEditDistance < minEditDistance is rejected with actionable error
  test("5.7.5: /typos config maxEditDistance where n < minEditDistance is rejected before persisting", async () => {
    const dictionary = await createDictionary();
    const cfg = createConfig();
    // Set minEditDistance to 2 (default maxEditDistance is 2, so this is valid).
    await cfg.setMinEditDistance(2);
    expect(cfg.getMinEditDistance()).toBe(2);

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: cfg,
    });
    const ctx = createCommandContext();

    // Try to set maxEditDistance to 1 (less than minEditDistance=2).
    await command.handler("config maxEditDistance 1", ctx);

    expect(ctx.notifications.at(-1)).toEqual({
      message: "maxEditDistance cannot be less than current minEditDistance (2); change minEditDistance first",
      level: "warning",
    });
    // Config must NOT have been mutated.
    expect(cfg.getMaxEditDistance()).toBe(2);
  });

  // 5.7.6: /typos on while degraded and disabled discards old engine and rebuilds fresh
  test("5.7.6: /typos on while engine is degraded and disabled discards old engine and rebuilds fresh", async () => {
    const dictionary = await createDictionary();
    const freshInitDeferred = createDeferred<void>();
    const freshInitialize = vi.fn(async () => {
      await freshInitDeferred.promise;
    });

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () =>
        ({ initialize: freshInitialize, getReadinessState: () => "building" as const } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    // Manually seed a degraded engine (simulates a failed pre-warm).
    const degradedEngine = {
      getReadinessState: () => "degraded" as const,
      getLastInitError: () => new Error("prior failure"),
      initialize: vi.fn(),
    };
    command.state.engine = degradedEngine as never;

    const genBefore = command.state.generation;

    // /typos on while degraded and disabled: should discard degraded engine and build fresh.
    await command.handler("on", ctx);

    // Generation bumped (orphans any stale callbacks from the degraded engine).
    expect(command.state.generation).toBeGreaterThan(genBefore);
    // Degraded engine initialize must NOT have been called again.
    expect(degradedEngine.initialize).not.toHaveBeenCalled();
    // Fresh engine was constructed and its init was started.
    expect(freshInitialize).toHaveBeenCalledTimes(1);
    // Editor installed and state is enabled.
    expect(command.state.enabled).toBe(true);
    expect(ctx.setEditorComponentCalls.at(-1)).toEqual(expect.any(Function));
    // Status reflects building state.
    expect(ctx.statusUpdates).toContainEqual({ key: "typos", value: "Autocorrect loading…" });

    // Cleanup.
    freshInitDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  // 5.7.7: Engine init failure surfaces degraded notification and status
  test("5.7.7: engine init failure surfaces degraded notification and sets status to unavailable", async () => {
    const dictionary = await createDictionary();
    const initDeferred = createDeferred<void>();
    const initError = new Error("dictionary load failed");
    const fakeEngine = makeFakeEngine(initDeferred);

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () => fakeEngine as never,
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    await command.handler("on", ctx);
    expect(command.state.enabled).toBe(true);

    // Reject the init promise to simulate failure.
    initDeferred.reject(initError);
    await Promise.resolve();
    await Promise.resolve(); // flush chained microtasks

    // Status updated to "unavailable".
    expect(ctx.statusUpdates).toContainEqual({ key: "typos", value: "Autocorrect unavailable" });
    // Error notification surfaced.
    expect(ctx.notifications).toContainEqual({
      message: "Autocorrect initialization failed: dictionary load failed",
      level: "error",
    });
    // Editor remains installed (engine still in degraded state, corrections silently no-op).
    expect(ctx.setEditorComponentCalls.at(-1)).toEqual(expect.any(Function));
  });

  // ---------------------------------------------------------------------------
  // Legacy toggle serialization tests (updated for non-blocking design)
  // ---------------------------------------------------------------------------

  test("legacy: /typos on then /typos off — orphaned init callback is a no-op", async () => {
    const dictionary = await createDictionary();
    const initDeferred = createDeferred<void>();
    const initialize = vi.fn(async () => {
      await initDeferred.promise;
    });

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () => ({ initialize, getReadinessState: () => "building" as const } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    // Enable is now non-blocking: returns after editor is installed.
    const enablePromise = command.handler("on", ctx);
    await enablePromise;

    // Editor installed, state enabled, init still pending.
    expect(command.state.enabled).toBe(true);
    expect(ctx.setEditorComponentCalls[0]).toEqual(expect.any(Function));
    expect(ctx.statusUpdates).toContainEqual({ key: "typos", value: "Autocorrect loading…" });

    // Disable while init is pending.
    const genAfterEnable = command.state.generation;
    await command.handler("off", ctx);
    expect(command.state.enabled).toBe(false);
    expect(command.state.generation).toBeGreaterThan(genAfterEnable);

    // Resolve the now-orphaned init.
    initDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Engine was dropped by disable; orphaned callbacks are no-ops.
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(command.state.enabled).toBe(false);
    expect(ctx.setEditorComponentCalls.at(-1)).toBeUndefined(); // editor removed
    // "✓ Autocorrect" must NOT appear (orphan guard blocked it).
    expect(ctx.statusUpdates.map((s) => s.value)).not.toContain("✓ Autocorrect");
    expect(ctx.statusUpdates).toContainEqual({ key: "typos", value: undefined });
    expect(ctx.notifications.at(-1)).toEqual({ message: "Autocorrect OFF", level: "info" });
  });

  test("legacy: double /typos on emits \"Autocorrect is already on\" and starts no second init", async () => {
    const dictionary = await createDictionary();
    const initDeferred = createDeferred<void>();
    const initialize = vi.fn(async () => {
      await initDeferred.promise;
    });

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () => ({ initialize, getReadinessState: () => "building" as const } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    // First enable — returns immediately after installing editor.
    await command.handler("on", ctx);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(command.state.enabled).toBe(true);

    // Second enable — must NOT start a second init.
    await command.handler("on", ctx);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(command.state.enabled).toBe(true);
    // Per spec "Double enable during initialization": emits "already on".
    expect(ctx.notifications.filter((n) => n.message === "Autocorrect is already on")).toHaveLength(1);
    // Only one "Autocorrect ON (loading…)" from the first enable.
    expect(ctx.notifications.filter((n) => n.message === "Autocorrect ON (loading…)")).toHaveLength(1);

    // Cleanup.
    initDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  test("legacy: second bare /typos during load toggle sequence ends with autocorrect OFF", async () => {
    const dictionary = await createDictionary();
    const initDeferred = createDeferred<void>();
    const initialize = vi.fn(async () => {
      await initDeferred.promise;
    });

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () => ({ initialize, getReadinessState: () => "building" as const } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    // First bare /typos → enable (non-blocking).
    await command.handler("", ctx);
    expect(command.state.enabled).toBe(true);
    expect(initialize).toHaveBeenCalledTimes(1);

    // Second bare /typos → disable (sees enabled=true, goes to disable).
    await command.handler("   ", ctx);
    expect(command.state.enabled).toBe(false);

    // Resolve the orphaned init.
    initDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();

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
      {
        message: "Unknown command. Usage: /typos [on|off|dict ...|default ...|config ...]",
        level: "warning",
      },
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
      { label: "config", value: "config" },
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
      createCorrectionEngine: () => ({ initialize, getReadinessState: () => "building" as const } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    await command.applyDefaultMode(ctx);

    expect(command.state.enabled).toBe(true);
    expect(initialize).toHaveBeenCalledTimes(1);
    // With non-blocking init, the notification is "loading…" since the engine
    // hasn't reached ready state synchronously.
    expect(ctx.notifications).toContainEqual({ message: "Autocorrect ON (loading…)", level: "info" });
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
      createCorrectionEngine: () => ({ initialize, getReadinessState: () => "building" as const } as never),
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

  test("/typos config lists all configured values", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config", ctx);

    const message = ctx.notifications.at(-1)?.message ?? "";
    expect(message.startsWith("Mobile autocorrect config:")).toBe(true);
    expect(message).toMatch(/defaultMode\s+off/);
    expect(message).toMatch(/maxEditDistance\s+2\s+\(range 1-4\)/);
    expect(message).toMatch(/minWordLength\s+2\s+\(range 2-8\)/);
  });

  test("/typos config <key> shows a single value", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config maxEditDistance", ctx);

    expect(ctx.notifications.at(-1)).toEqual({
      message: "maxEditDistance = 2 (range 1-4)",
      level: "info",
    });
  });

  test("/typos config rejects unknown keys", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config wibble 5", ctx);

    expect(ctx.notifications.at(-1)).toEqual({
      message: "Usage: /typos config [defaultMode|maxEditDistance|minWordLength|minEditDistance|editDistanceStepEvery] [<value>]",
      level: "warning",
    });
  });

  test("/typos config defaultMode delegates to the same path as /typos default", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config defaultMode on", ctx);

    expect(config.getDefaultMode()).toBe("on");
    expect(ctx.notifications.at(-1)).toEqual({
      message: "Default mode for new sessions set to on",
      level: "info",
    });
  });

  test("/typos config maxEditDistance validates the integer range", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config maxEditDistance 0", ctx);
    await command.handler("config maxEditDistance 5", ctx);
    await command.handler("config maxEditDistance two", ctx);
    await command.handler("config maxEditDistance 1.5", ctx);

    expect(config.getMaxEditDistance()).toBe(2); // unchanged
    expect(ctx.notifications.map((n) => n.message)).toEqual([
      "Usage: /typos config maxEditDistance <integer 1-4>",
      "Usage: /typos config maxEditDistance <integer 1-4>",
      "Usage: /typos config maxEditDistance <integer 1-4>",
      "Usage: /typos config maxEditDistance <integer 1-4>",
    ]);
  });

  test("/typos config maxEditDistance persists and rebuilds the engine when not enabled", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const initialize = vi.fn(async () => undefined);
    const createCorrectionEngine = vi.fn(() => ({ initialize, getReadinessState: () => "building" as const } as never));
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
      createCorrectionEngine,
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    // Bring the engine into existence once.
    await command.handler("on", ctx);
    await command.handler("off", ctx);
    expect(createCorrectionEngine).toHaveBeenCalledTimes(1);

    await command.handler("config maxEditDistance 3", ctx);

    expect(config.getMaxEditDistance()).toBe(3);
    expect(ctx.notifications.at(-1)).toEqual({ message: "maxEditDistance set to 3", level: "info" });

    // Next enable must rebuild the engine with the new value.
    await command.handler("on", ctx);
    expect(createCorrectionEngine).toHaveBeenCalledTimes(2);
    expect(createCorrectionEngine.mock.calls[1][0].maxEditDistance).toBe(3);
  });

  test("/typos config maxEditDistance hot-reloads when autocorrect is currently on", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const initialize = vi.fn(async () => undefined);
    const createCorrectionEngine = vi.fn(() => ({ initialize, getReadinessState: () => "building" as const } as never));
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
      createCorrectionEngine,
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    await command.handler("on", ctx);
    expect(command.state.enabled).toBe(true);
    expect(createCorrectionEngine).toHaveBeenCalledTimes(1);
    expect(createCorrectionEngine.mock.calls[0][0].maxEditDistance).toBe(2);

    await command.handler("config maxEditDistance 3", ctx);

    expect(command.state.enabled).toBe(true); // back on after the hot-reload
    expect(createCorrectionEngine).toHaveBeenCalledTimes(2);
    expect(createCorrectionEngine.mock.calls[1][0].maxEditDistance).toBe(3);
  });

  test("/typos config minWordLength persists and is read live without an engine rebuild", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const initialize = vi.fn(async () => undefined);
    const createCorrectionEngine = vi.fn((opts: { getMinWordLength?: () => number }) => ({
      initialize,
      getMinWordLengthRef: opts.getMinWordLength,
      getReadinessState: () => "building" as const,
    }) as never);
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
      createCorrectionEngine,
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    await command.handler("on", ctx);
    const accessor = (command.state.engine as unknown as { getMinWordLengthRef?: () => number })
      .getMinWordLengthRef;
    expect(accessor).toBeTypeOf("function");
    expect(accessor!()).toBe(2);

    await command.handler("config minWordLength 4", ctx);

    expect(config.getMinWordLength()).toBe(4);
    expect(ctx.notifications.at(-1)).toEqual({ message: "minWordLength set to 4", level: "info" });
    // Same engine instance — no rebuild.
    expect(createCorrectionEngine).toHaveBeenCalledTimes(1);
    // The live accessor reflects the new value immediately.
    expect(accessor!()).toBe(4);
  });

  test("/typos config minWordLength validates the integer range", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config minWordLength 1", ctx);
    await command.handler("config minWordLength 9", ctx);

    expect(config.getMinWordLength()).toBe(2); // unchanged
    expect(ctx.notifications.map((n) => n.message)).toEqual([
      "Usage: /typos config minWordLength <integer 2-8>",
      "Usage: /typos config minWordLength <integer 2-8>",
    ]);
  });

  test("/typos config completion produces correct lines under Pi's applyCompletion", async () => {
    // Same regression check as second-level completions: value must include
    // the full argument path so applyCompletion (which replaces the entire
    // argument text) doesn't drop tokens.
    const dictionary = await createDictionary();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });

    const simulateApply = (line: string, completionValue: string): string => {
      const cursorCol = line.length;
      const spaceIndex = line.indexOf(" ");
      const argumentText = line.slice(spaceIndex + 1);
      const beforePrefix = line.slice(0, cursorCol - argumentText.length);
      return beforePrefix + completionValue;
    };

    // /typos config <empty> → selecting "maxEditDistance" yields full path.
    const keyItem = command
      .getArgumentCompletions("config ")
      ?.find((item) => item.label === "maxEditDistance");
    expect(keyItem).toBeDefined();
    expect(simulateApply("/typos config ", keyItem!.value)).toBe("/typos config maxEditDistance");

    // /typos config maxEditDistance <empty> → selecting "3" yields full path.
    const valueItem = command
      .getArgumentCompletions("config maxEditDistance ")
      ?.find((item) => item.label === "3");
    expect(valueItem).toBeDefined();
    expect(simulateApply("/typos config maxEditDistance ", valueItem!.value)).toBe(
      "/typos config maxEditDistance 3",
    );

    // Partial filter on the value position.
    const partialItems = command.getArgumentCompletions("config minWordLength 3");
    expect(partialItems?.map((item) => item.label)).toEqual(["3"]);
    expect(partialItems?.[0]?.value).toBe("config minWordLength 3");
  });

  // ---------------------------------------------------------------------------
  // Section 6.10 — new config keys, indicator values, completions
  // ---------------------------------------------------------------------------

  test("6.10: /typos config lists minEditDistance and editDistanceStepEvery in bare listing", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config", ctx);

    const message = ctx.notifications.at(-1)?.message ?? "";
    expect(message.startsWith("Mobile autocorrect config:")).toBe(true);
    // Existing keys still present.
    expect(message).toMatch(/defaultMode\s+off/);
    expect(message).toMatch(/maxEditDistance\s+2\s+\(range 1-4\)/);
    expect(message).toMatch(/minWordLength\s+2\s+\(range 2-8\)/);
    // New keys with correct dynamic ranges (maxED=2 so minED upper bound is 2).
    expect(message).toMatch(/minEditDistance\s+1\s+\(range 0-2\)/);
    expect(message).toMatch(/editDistanceStepEvery\s+4\s+\(range 1-8\)/);
  });

  test("6.10: /typos config minEditDistance shows single-key display", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config minEditDistance", ctx);

    expect(ctx.notifications.at(-1)).toEqual({
      message: "minEditDistance = 1 (range 0-2)",
      level: "info",
    });
  });

  test("6.10: /typos config editDistanceStepEvery shows single-key display", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config editDistanceStepEvery", ctx);

    expect(ctx.notifications.at(-1)).toEqual({
      message: "editDistanceStepEvery = 4 (range 1-8)",
      level: "info",
    });
  });

  test("6.10: /typos config minEditDistance SET success paths (0, 1, 2 when maxED=2)", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    expect(config.getMaxEditDistance()).toBe(2);

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    // 0 — valid floor
    await command.handler("config minEditDistance 0", ctx);
    expect(config.getMinEditDistance()).toBe(0);
    expect(ctx.notifications.at(-1)).toEqual({ message: "minEditDistance set to 0", level: "info" });

    // 1 — default, but since we changed to 0 first it's now a change back
    await command.handler("config minEditDistance 1", ctx);
    expect(config.getMinEditDistance()).toBe(1);
    expect(ctx.notifications.at(-1)).toEqual({ message: "minEditDistance set to 1", level: "info" });

    // 2 — valid upper bound (equals current maxED)
    await command.handler("config minEditDistance 2", ctx);
    expect(config.getMinEditDistance()).toBe(2);
    expect(ctx.notifications.at(-1)).toEqual({ message: "minEditDistance set to 2", level: "info" });
  });

  test("6.10: /typos config editDistanceStepEvery SET success paths (4, 8)", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config editDistanceStepEvery 4", ctx);
    expect(ctx.notifications.at(-1)).toEqual({ message: "editDistanceStepEvery is already 4", level: "info" });

    await command.handler("config editDistanceStepEvery 8", ctx);
    expect(config.getEditDistanceStepEvery()).toBe(8);
    expect(ctx.notifications.at(-1)).toEqual({ message: "editDistanceStepEvery set to 8", level: "info" });

    await command.handler("config editDistanceStepEvery 1", ctx);
    expect(config.getEditDistanceStepEvery()).toBe(1);
    expect(ctx.notifications.at(-1)).toEqual({ message: "editDistanceStepEvery set to 1", level: "info" });
  });

  test("6.10: /typos config minEditDistance rejects -1 (out of range)", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config minEditDistance -1", ctx);

    expect(config.getMinEditDistance()).toBe(1); // unchanged
    expect(ctx.notifications.at(-1)).toEqual({
      message: "Usage: /typos config minEditDistance <integer 0-2>",
      level: "warning",
    });
  });

  test("6.10: /typos config minEditDistance 3 when maxEditDistance=2 is rejected with actionable error", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    expect(config.getMaxEditDistance()).toBe(2);

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config minEditDistance 3", ctx);

    expect(config.getMinEditDistance()).toBe(1); // unchanged
    expect(ctx.notifications.at(-1)).toEqual({
      message: "Usage: /typos config minEditDistance <integer 0-2>",
      level: "warning",
    });
  });

  test("6.10: /typos config minEditDistance abc rejects non-integer", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config minEditDistance abc", ctx);

    expect(config.getMinEditDistance()).toBe(1); // unchanged
    expect(ctx.notifications.at(-1)).toEqual({
      message: "Usage: /typos config minEditDistance <integer 0-2>",
      level: "warning",
    });
  });

  test("6.10: /typos config editDistanceStepEvery rejects 0 and 9 (out of range)", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });
    const ctx = createCommandContext();

    await command.handler("config editDistanceStepEvery 0", ctx);
    await command.handler("config editDistanceStepEvery 9", ctx);

    expect(config.getEditDistanceStepEvery()).toBe(4); // unchanged
    expect(ctx.notifications.map((n) => n.message)).toEqual([
      "Usage: /typos config editDistanceStepEvery <integer 1-8>",
      "Usage: /typos config editDistanceStepEvery <integer 1-8>",
    ]);
  });

  test("6.10: completion suggestions for maxEditDistance use dynamic lower bound from minEditDistance", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });

    // Default minEditDistance = 1: suggestions start at 1.
    const defaultCompletions = command.getArgumentCompletions("config maxEditDistance ");
    expect(defaultCompletions?.map((item) => item.label)).toEqual(["1", "2", "3", "4"]);

    // Set minEditDistance = 2: suggestions start at 2.
    await config.setMinEditDistance(2);
    const shiftedCompletions = command.getArgumentCompletions("config maxEditDistance ");
    expect(shiftedCompletions?.map((item) => item.label)).toEqual(["2", "3", "4"]);

    // Set minEditDistance = 0: suggestions start at 0.
    await config.setMinEditDistance(0);
    const zeroCompletions = command.getArgumentCompletions("config maxEditDistance ");
    expect(zeroCompletions?.map((item) => item.label)).toEqual(["0", "1", "2", "3", "4"]);
  });

  test("6.10: completion suggestions for minEditDistance use dynamic upper bound from maxEditDistance", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    // Default maxEditDistance = 2: upper bound is 2.
    await config.setMinEditDistance(0); // lower bound always 0
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
    });

    const completions = command.getArgumentCompletions("config minEditDistance ");
    expect(completions?.map((item) => item.label)).toEqual(["0", "1", "2"]);

    // After raising maxEditDistance to 4 the upper bound expands.
    await config.setMaxEditDistance(4);
    const expandedCompletions = command.getArgumentCompletions("config minEditDistance ");
    expect(expandedCompletions?.map((item) => item.label)).toEqual(["0", "1", "2", "3", "4"]);
  });

  test("6.10: completion suggestions for editDistanceStepEvery are fixed 1-8", async () => {
    const dictionary = await createDictionary();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });

    const completions = command.getArgumentCompletions("config editDistanceStepEvery ");
    expect(completions?.map((item) => item.label)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    // Value includes the parent path per Pi's applyCompletion contract.
    expect(completions?.[0]?.value).toBe("config editDistanceStepEvery 1");
  });

  test("6.10: minEditDistance and editDistanceStepEvery appear in second-level config key completions", async () => {
    const dictionary = await createDictionary();
    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
    });

    const completions = command.getArgumentCompletions("config ");
    const labels = completions?.map((item) => item.label);
    expect(labels).toContain("minEditDistance");
    expect(labels).toContain("editDistanceStepEvery");
    // Values must include the parent token for Pi's applyCompletion.
    const minEdItem = completions?.find((item) => item.label === "minEditDistance");
    expect(minEdItem?.value).toBe("config minEditDistance");
  });

  test("6.10: setStatus('typos-loading', ...) is never called from any code path", async () => {
    const dictionary = await createDictionary();
    const initDeferred = createDeferred<void>();
    const fakeEngine = makeFakeEngine(initDeferred);

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config: createConfig(),
      createCorrectionEngine: () => fakeEngine as never,
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    // Enable (triggers background init → loading state).
    await command.handler("on", ctx);
    // Disable (clears status).
    await command.handler("off", ctx);
    // Resolve orphaned init.
    initDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // None of the status updates should use the deprecated "typos-loading" key.
    const typosLoadingCalls = ctx.statusUpdates.filter((s) => s.key === "typos-loading");
    expect(typosLoadingCalls).toHaveLength(0);
    // All calls should use "typos".
    const typosCalls = ctx.statusUpdates.filter((s) => s.key === "typos");
    expect(typosCalls.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Section 7.4 — Pre-warm tests
  // ---------------------------------------------------------------------------

  // 7.4.1: prewarmEngine schedules init; createTyposCommand seeds state
  test("7.4.1: prewarmEngine seeds state.engine and state.initInFlight for later reuse", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();
    await config.setDefaultMode("on");

    const initDeferred = createDeferred<void>();
    const initialize = vi.fn(async () => {
      await initDeferred.promise;
    });
    const fakeEngineForPrewarm = {
      initialize,
      getReadinessState: () => "building" as const,
      getLastInitError: () => undefined,
    };

    const prewarm = prewarmEngine({
      techDictPath: "/tmp/tech-dict.txt",
      learnedDictionary: dictionary,
      config,
      createCorrectionEngine: () => fakeEngineForPrewarm as never,
    });

    // initialize() was called once during prewarm
    expect(initialize).toHaveBeenCalledTimes(1);

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
      prewarm,
      createAutocorrectEditor: (() => ({}) as never) as never,
    });

    // State is seeded without calling enable() yet
    expect(command.state.engine).toBe(fakeEngineForPrewarm);
    expect(command.state.initInFlight).toBe(prewarm.initPromise);
    expect(command.state.enabled).toBe(false);

    // Cleanup
    initDeferred.resolve();
    await Promise.resolve();
  });

  // 7.4.2: No prewarm when defaultMode is off
  test("7.4.2: when prewarm is omitted, state.engine and state.initInFlight start undefined", () => {
    const dictionary = new LearnedDictionary({ filePath: "/tmp/nonexistent.json" });
    const config = new Config({ filePath: "/tmp/nonexistent-config.json" });
    // defaultMode is "off" (the default bootstrap value).

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
      // prewarm omitted intentionally
    });

    expect(command.state.engine).toBeUndefined();
    expect(command.state.initInFlight).toBeUndefined();
    expect(command.state.enabled).toBe(false);
  });

  // 7.4.3: Pre-warm hit — engine already ready → "Autocorrect ON" (no loading suffix)
  test("7.4.3: enable() reuses a pre-warmed engine that is already ready → 'Autocorrect ON'", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();

    const initialize = vi.fn(async () => undefined);
    const readyEngine = {
      initialize,
      getReadinessState: () => "ready" as const,
      getLastInitError: () => undefined,
    };

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
      prewarm: { engine: readyEngine as never, initPromise: Promise.resolve() },
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    await command.handler("on", ctx);

    // No second initialize call — the pre-warm already ran it.
    expect(initialize).not.toHaveBeenCalled();
    expect(command.state.enabled).toBe(true);
    // "Autocorrect ON" without loading suffix (pre-warm hit).
    expect(ctx.notifications.at(-1)).toEqual({ message: "Autocorrect ON", level: "info" });
    // Status immediately shows ready.
    expect(ctx.statusUpdates.at(-1)).toEqual({ key: "typos", value: "\u2713 Autocorrect" });
  });

  // 7.4.4: Pre-warm in flight — enable() reuses engine + promise → only one initialize call
  test("7.4.4: enable() reuses a pre-warmed in-flight engine → only one initialize call total", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();

    const initDeferred = createDeferred<void>();
    const initialize = vi.fn(async () => {
      await initDeferred.promise;
    });
    const buildingEngine = {
      initialize,
      getReadinessState: () => "building" as const,
      getLastInitError: () => undefined,
    };

    // Simulate: prewarmEngine already called initialize() once and returned the promise.
    const initPromise = buildingEngine.initialize();
    expect(initialize).toHaveBeenCalledTimes(1);

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
      prewarm: { engine: buildingEngine as never, initPromise },
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    // enable() should attach to the existing in-flight promise, not start a second init.
    await command.handler("on", ctx);

    // Still only one initialize call (from the simulated pre-warm).
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(command.state.engine).toBe(buildingEngine);
    expect(command.state.initInFlight).toBe(initPromise);
    expect(command.state.enabled).toBe(true);
    expect(ctx.notifications.at(-1)).toEqual({ message: "Autocorrect ON (loading\u2026)", level: "info" });
    expect(ctx.statusUpdates).toContainEqual({ key: "typos", value: "Autocorrect loading\u2026" });

    // Resolve the pre-warm promise — status should update to ready.
    initDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.statusUpdates.at(-1)).toEqual({ key: "typos", value: "\u2713 Autocorrect" });
  });

  // 7.4.5: Pre-warm failure → degraded → first enable() discards and retries fresh
  test("7.4.5: pre-warm failure leaves engine degraded; first enable() discards and rebuilds fresh", async () => {
    const dictionary = await createDictionary();
    const config = createConfig();

    const freshInitDeferred = createDeferred<void>();
    const freshInitialize = vi.fn(async () => {
      await freshInitDeferred.promise;
    });

    const command = createTyposCommand({
      learnedDictionary: dictionary,
      techDictPath: "/tmp/tech-dict.txt",
      config,
      // Seed a degraded engine as if prewarmEngine failed before enable() ran.
      // Attach .catch() to suppress the unhandled-rejection warning — mirroring
      // what prewarmEngine() does internally before returning the handle.
      prewarm: (() => {
        const failedInit = Promise.reject(new Error("prewarm failed"));
        void failedInit.catch(() => undefined);
        return {
          engine: {
            initialize: vi.fn(),
            getReadinessState: () => "degraded" as const,
            getLastInitError: () => new Error("prewarm failed"),
          } as never,
          initPromise: failedInit,
        };
      })(),
      createCorrectionEngine: () =>
        ({ initialize: freshInitialize, getReadinessState: () => "building" as const } as never),
      createAutocorrectEditor: (() => ({}) as never) as never,
    });
    const ctx = createCommandContext();

    const genBefore = command.state.generation;

    // enable() should detect degraded, bump generation, discard, and build fresh.
    await command.handler("on", ctx);

    expect(command.state.generation).toBeGreaterThan(genBefore);
    expect(freshInitialize).toHaveBeenCalledTimes(1);
    expect(command.state.enabled).toBe(true);
    expect(ctx.statusUpdates).toContainEqual({ key: "typos", value: "Autocorrect loading\u2026" });

    // Cleanup.
    freshInitDeferred.resolve();
    await Promise.resolve();
    await Promise.resolve();
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
