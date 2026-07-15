import { describe, expect, it, vi } from "vitest";
import {
  createDisplayWakeDebouncer,
  recoverTerminalsForWake,
  type TerminalWakeTarget,
} from "./terminal-display-wake";

function makeTarget(visible: boolean, hasWebgl = true) {
  const resetWebglLatch = vi.fn();
  const clearGlyphAtlas = vi.fn(() => hasWebgl);
  const refreshViewport = vi.fn();
  const target: TerminalWakeTarget = {
    isVisible: () => visible,
    resetWebglLatch,
    clearGlyphAtlas,
    refreshViewport,
  };
  return { target, resetWebglLatch, clearGlyphAtlas, refreshViewport };
}

describe("recoverTerminalsForWake", () => {
  it("resets the latch and repaints a visible pane", () => {
    const { target, resetWebglLatch, clearGlyphAtlas, refreshViewport } = makeTarget(true);

    recoverTerminalsForWake([target]);

    expect(resetWebglLatch).toHaveBeenCalledTimes(1);
    expect(clearGlyphAtlas).toHaveBeenCalledTimes(1);
    expect(refreshViewport).toHaveBeenCalledTimes(1);
  });

  it("resets the latch on a hidden pane but does not touch its atlas or repaint", () => {
    const { target, resetWebglLatch, clearGlyphAtlas, refreshViewport } = makeTarget(false);

    recoverTerminalsForWake([target]);

    // Hidden panes still clear the latch so they retry WebGL on next reveal.
    expect(resetWebglLatch).toHaveBeenCalledTimes(1);
    // No immediate atlas rebuild / repaint on a pane the user cannot see.
    expect(clearGlyphAtlas).not.toHaveBeenCalled();
    expect(refreshViewport).not.toHaveBeenCalled();
  });

  it("clears the shared atlas exactly once, then repaints every visible pane", () => {
    // Regression: the glyph atlas is shared across same-config terminals. The
    // old per-pane clear+refresh loop cleared it once per visible pane, so each
    // later clear invalidated the glyph coordinates the previous pane had just
    // repainted — every pane except the last rendered scattered glyph
    // fragments after a wake.
    const visibleA = makeTarget(true);
    const hidden = makeTarget(false);
    const visibleB = makeTarget(true);

    recoverTerminalsForWake([visibleA.target, hidden.target, visibleB.target]);

    const totalClears =
      visibleA.clearGlyphAtlas.mock.calls.length +
      hidden.clearGlyphAtlas.mock.calls.length +
      visibleB.clearGlyphAtlas.mock.calls.length;
    expect(totalClears).toBe(1);
    // Every visible pane repaints AFTER the single clear.
    expect(visibleA.refreshViewport).toHaveBeenCalledTimes(1);
    expect(visibleB.refreshViewport).toHaveBeenCalledTimes(1);
    expect(hidden.refreshViewport).not.toHaveBeenCalled();
    // Every pane, visible or not, clears its latch.
    expect(visibleA.resetWebglLatch).toHaveBeenCalledTimes(1);
    expect(hidden.resetWebglLatch).toHaveBeenCalledTimes(1);
    expect(visibleB.resetWebglLatch).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next visible pane when one has no WebGL renderer", () => {
    const domLatched = makeTarget(true, false);
    const webglPane = makeTarget(true);

    recoverTerminalsForWake([domLatched.target, webglPane.target]);

    // The DOM-latched pane cannot clear (returns false), so the next visible
    // WebGL pane performs the single shared-atlas clear.
    expect(domLatched.clearGlyphAtlas).toHaveBeenCalledTimes(1);
    expect(webglPane.clearGlyphAtlas).toHaveBeenCalledTimes(1);
    expect(domLatched.refreshViewport).toHaveBeenCalledTimes(1);
    expect(webglPane.refreshViewport).toHaveBeenCalledTimes(1);
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
