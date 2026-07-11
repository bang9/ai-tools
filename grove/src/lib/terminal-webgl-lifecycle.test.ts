import { describe, expect, it, vi } from "vitest";
import type { WebglAddon } from "@xterm/addon-webgl";
import {
  captureTerminalTextSnapshot,
  releaseXtermWebglContext,
  WEBGL_CONSTRUCTION_COOLDOWN_MS,
  WEBGL_CONTEXT_LOSS_LATCH_WINDOW_MS,
  WebglRenderLatch,
  type TextSnapshotTerminal,
} from "./terminal-webgl-lifecycle";

describe("WebglRenderLatch context-loss latch", () => {
  it("recovers to WebGL on a single transient context loss", () => {
    const latch = new WebglRenderLatch();
    const { latched } = latch.recordContextLoss(1_000);
    expect(latched).toBe(false);
    expect(latch.isDomLatched()).toBe(false);
    // First loss must leave WebGL construction allowed for the reschedule.
    expect(latch.canConstruct(1_000)).toBe(true);
  });

  it("latches to the DOM renderer on a rapid second loss within the window", () => {
    const latch = new WebglRenderLatch();
    latch.recordContextLoss(1_000);
    const second = latch.recordContextLoss(1_000 + WEBGL_CONTEXT_LOSS_LATCH_WINDOW_MS);
    expect(second.latched).toBe(true);
    expect(latch.isDomLatched()).toBe(true);
    // No further WebGL construction is permitted once latched.
    expect(latch.canConstruct(2_000_000)).toBe(false);
  });

  it("does not latch when the second loss falls outside the window", () => {
    const latch = new WebglRenderLatch();
    latch.recordContextLoss(1_000);
    const second = latch.recordContextLoss(1_000 + WEBGL_CONTEXT_LOSS_LATCH_WINDOW_MS + 1);
    expect(second.latched).toBe(false);
    expect(latch.isDomLatched()).toBe(false);
  });

  it("clears the latch on a display-wake reset", () => {
    const latch = new WebglRenderLatch();
    latch.recordContextLoss(1_000);
    latch.recordContextLoss(1_500);
    expect(latch.isDomLatched()).toBe(true);

    latch.resetForWake();
    expect(latch.isDomLatched()).toBe(false);
    expect(latch.canConstruct(1_600)).toBe(true);
    // A fresh single loss after wake recovers rather than immediately re-latching.
    expect(latch.recordContextLoss(1_700).latched).toBe(false);
  });
});

describe("WebglRenderLatch construction cool-down", () => {
  it("blocks reconstruction during the cool-down after a failed construction", () => {
    const latch = new WebglRenderLatch();
    latch.recordConstructionFailure(10_000);
    expect(latch.canConstruct(10_000)).toBe(false);
    expect(latch.canConstruct(10_000 + WEBGL_CONSTRUCTION_COOLDOWN_MS - 1)).toBe(false);
    // Cool-down elapsed: a single reconstruction attempt is allowed again.
    expect(latch.canConstruct(10_000 + WEBGL_CONSTRUCTION_COOLDOWN_MS)).toBe(true);
  });

  it("clears the cool-down on a successful construction", () => {
    const latch = new WebglRenderLatch();
    latch.recordConstructionFailure(10_000);
    latch.recordConstructionSuccess();
    expect(latch.canConstruct(10_000)).toBe(true);
  });
});

describe("releaseXtermWebglContext", () => {
  it("calls WEBGL_lose_context.loseContext and drops the canvas", () => {
    const loseContext = vi.fn();
    const canvas = { width: 200, height: 100 } as HTMLCanvasElement;
    const getExtension = vi.fn(() => ({ loseContext }) as unknown as WEBGL_lose_context);
    const addon = {
      _renderer: { _gl: { getExtension }, _canvas: canvas },
    } as unknown as WebglAddon;

    releaseXtermWebglContext(addon);

    expect(getExtension).toHaveBeenCalledWith("WEBGL_lose_context");
    expect(loseContext).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("is a no-op on a null addon", () => {
    expect(() => releaseXtermWebglContext(null)).not.toThrow();
  });
});

describe("captureTerminalTextSnapshot", () => {
  function makeTerm(rows: string[]): TextSnapshotTerminal {
    return {
      element: { clientWidth: 320, clientHeight: 200 },
      rows: rows.length,
      options: {
        theme: { background: "#101010", foreground: "#e0e0e0" },
        fontSize: 13,
        fontFamily: "Menlo, monospace",
      },
      buffer: {
        active: {
          viewportY: 0,
          getLine: (index: number) =>
            index < rows.length ? { translateToString: () => rows[index] } : undefined,
        },
      },
    };
  }

  it("returns a usable data URL rasterized from the visible buffer text", () => {
    const fillText = vi.fn();
    const ctx = {
      scale: vi.fn(),
      fillRect: vi.fn(),
      fillText,
      set fillStyle(_v: string) {},
      set font(_v: string) {},
      set textBaseline(_v: string) {},
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ctx),
      toDataURL: vi.fn(() => "data:image/png;base64,SNAP"),
    };
    const doc = { createElement: vi.fn(() => canvas) } as unknown as Document;

    const result = captureTerminalTextSnapshot(makeTerm(["hello", "world"]), doc);

    expect(result).toBe("data:image/png;base64,SNAP");
    expect(fillText).toHaveBeenCalledTimes(2);
    expect(fillText).toHaveBeenCalledWith("hello", 0, 0);
  });

  it("returns null when the terminal has no measurable element", () => {
    const term = makeTerm(["x"]);
    term.element = { clientWidth: 0, clientHeight: 0 };
    const doc = { createElement: vi.fn() } as unknown as Document;
    expect(captureTerminalTextSnapshot(term, doc)).toBeNull();
  });
});
