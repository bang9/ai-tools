import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import {
  _resetWriteCompletionReportsForTests,
  runGuardedWriteCompletionStep,
} from "./terminal-write-callback-guard";

// Repro for the frozen-terminal wedge: the vendored @xterm/xterm WriteBuffer
// (6.0.0) permanently stalls when a synchronous exception escapes a
// write-completion callback. `_innerWrite` has no try/catch around the callback,
// its tail re-schedule never runs, and later `write()` calls only re-arm
// processing when the buffer is EMPTY — which a stalled buffer never is again.
describe("xterm WriteBuffer stall (vendored @xterm/xterm 6.0.0)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("permanently stops completing writes after an UNGUARDED sync throw in a completion callback", () => {
    vi.useFakeTimers();
    const term = new Terminal({ allowProposedApi: true });
    const completed: string[] = [];

    term.write("first", () => {
      completed.push("first");
      throw new Error("synthetic renderer failure during write completion");
    });
    term.write("second", () => {
      completed.push("second");
    });

    expect(() => vi.runAllTimers()).toThrow("synthetic renderer failure");

    // The wedge: the stalled buffer is never empty again, so new writes only
    // enqueue — no drain is scheduled and no later callback ever fires.
    term.write("third", () => {
      completed.push("third");
    });
    vi.runAllTimers();
    expect(completed).toEqual(["first"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps flushing subsequent writes when the throwing step is wrapped in the guard", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    _resetWriteCompletionReportsForTests();
    vi.useFakeTimers();
    const term = new Terminal({ allowProposedApi: true });
    const completed: string[] = [];

    term.write("first", () => {
      runGuardedWriteCompletionStep("test-completion", () => {
        completed.push("first");
        throw new Error("synthetic renderer failure during write completion");
      });
    });
    term.write("second", () => {
      completed.push("second");
    });
    vi.runAllTimers();

    // Without the guard's try/catch this write would only enqueue against a
    // wedged buffer; with the guard the buffer drained normally and re-arms.
    term.write("third", () => {
      completed.push("third");
    });
    vi.runAllTimers();

    expect(completed).toEqual(["first", "second", "third"]);
    errorSpy.mockRestore();
  });
});

describe("runGuardedWriteCompletionStep", () => {
  beforeEach(() => {
    _resetWriteCompletionReportsForTests();
  });

  it("swallows a synchronous throw so it never escapes into the caller", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      runGuardedWriteCompletionStep("ctx", () => {
        throw new Error("boom");
      }),
    ).not.toThrow();
    errorSpy.mockRestore();
  });

  it("runs a later step even when an earlier step throws", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];
    runGuardedWriteCompletionStep("first-step", () => {
      throw new Error("boom");
    });
    runGuardedWriteCompletionStep("second-step", () => {
      ran.push("second");
    });
    expect(ran).toEqual(["second"]);
    errorSpy.mockRestore();
  });

  it("rate-limits reporting per context to avoid flooding the console", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 10; i += 1) {
      runGuardedWriteCompletionStep("noisy", () => {
        throw new Error("boom");
      });
    }
    expect(errorSpy).toHaveBeenCalledTimes(5);
    errorSpy.mockRestore();
  });
});

describe("terminal-runtime write-completion wiring", () => {
  const runtimeSource = readFileSync(
    fileURLToPath(new URL("./terminal-runtime.ts", import.meta.url)),
    "utf8",
  );

  it("guards every write-completion callback site", () => {
    expect(runtimeSource).toContain('runGuardedWriteCompletionStep("hydration-finish"');
    expect(runtimeSource).toContain('runGuardedWriteCompletionStep("hydration-flush"');
    expect(runtimeSource).toContain('runGuardedWriteCompletionStep("pending-output-flush"');
  });

  it("leaves the WebLinks link-activation handler unguarded (not a write-completion callback)", () => {
    const start = runtimeSource.indexOf("new WebLinksAddon(");
    const end = runtimeSource.indexOf("this.term.loadAddon(webLinksAddon)");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const linkActivationHandler = runtimeSource.slice(start, end);
    expect(linkActivationHandler).not.toContain("runGuardedWriteCompletionStep");
  });
});
