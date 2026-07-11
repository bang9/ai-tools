import { describe, expect, it, vi } from "vitest";
import {
  createDisplayWakeDebouncer,
  recoverTerminalForWake,
  type TerminalWakeTarget,
} from "./terminal-display-wake";

function makeTarget(visible: boolean) {
  const resetWebglLatch = vi.fn();
  const clearGlyphAtlas = vi.fn();
  const refreshViewport = vi.fn();
  const target: TerminalWakeTarget = {
    isVisible: () => visible,
    resetWebglLatch,
    clearGlyphAtlas,
    refreshViewport,
  };
  return { target, resetWebglLatch, clearGlyphAtlas, refreshViewport };
}

describe("recoverTerminalForWake", () => {
  it("resets the latch and repaints a visible pane", () => {
    const { target, resetWebglLatch, clearGlyphAtlas, refreshViewport } = makeTarget(true);

    recoverTerminalForWake(target);

    expect(resetWebglLatch).toHaveBeenCalledTimes(1);
    expect(clearGlyphAtlas).toHaveBeenCalledTimes(1);
    expect(refreshViewport).toHaveBeenCalledTimes(1);
  });

  it("resets the latch on a hidden pane but does not touch its atlas or repaint", () => {
    const { target, resetWebglLatch, clearGlyphAtlas, refreshViewport } = makeTarget(false);

    recoverTerminalForWake(target);

    // Hidden panes still clear the latch so they retry WebGL on next reveal.
    expect(resetWebglLatch).toHaveBeenCalledTimes(1);
    // No immediate atlas rebuild / repaint on a pane the user cannot see.
    expect(clearGlyphAtlas).not.toHaveBeenCalled();
    expect(refreshViewport).not.toHaveBeenCalled();
  });

  it("refreshes only visible runtimes across a mixed set", () => {
    const visibleA = makeTarget(true);
    const hidden = makeTarget(false);
    const visibleB = makeTarget(true);

    for (const { target } of [visibleA, hidden, visibleB]) {
      recoverTerminalForWake(target);
    }

    expect(visibleA.refreshViewport).toHaveBeenCalledTimes(1);
    expect(visibleB.refreshViewport).toHaveBeenCalledTimes(1);
    expect(hidden.refreshViewport).not.toHaveBeenCalled();
    // Every pane, visible or not, clears its latch.
    expect(visibleA.resetWebglLatch).toHaveBeenCalledTimes(1);
    expect(hidden.resetWebglLatch).toHaveBeenCalledTimes(1);
    expect(visibleB.resetWebglLatch).toHaveBeenCalledTimes(1);
  });
});

describe("createDisplayWakeDebouncer", () => {
  it("coalesces a burst of wake signals into one recovery pass", () => {
    let now = 1_000;
    const recover = vi.fn();
    const handleWake = createDisplayWakeDebouncer(recover, {
      now: () => now,
      debounceMs: 300,
    });

    handleWake();
    now = 1_050;
    handleWake();
    now = 1_299;
    handleWake();

    // All three landed inside the 300ms window → a single recovery.
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it("recovers again once the debounce window has elapsed", () => {
    let now = 1_000;
    const recover = vi.fn();
    const handleWake = createDisplayWakeDebouncer(recover, {
      now: () => now,
      debounceMs: 300,
    });

    handleWake();
    now = 1_400;
    handleWake();

    // A genuinely separate wake past the window triggers a second recovery.
    expect(recover).toHaveBeenCalledTimes(2);
  });
});
