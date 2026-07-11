import { describe, expect, it } from "vitest";
import {
  nextFitStability,
  resolvePostFitViewport,
  shouldDetachTerminalContainer,
  shouldLoadWebglAddon,
  shouldSendResize,
  shouldSuspendWebglAddon,
} from "./terminal-runtime";
import type { FitStabilityState } from "./terminal-runtime";

describe("shouldDetachTerminalContainer", () => {
  it("allows unconditional detach when no owner container is provided", () => {
    expect(shouldDetachTerminalContainer({} as HTMLDivElement)).toBe(true);
  });

  it("allows detach when the runtime is still attached to the owner's container", () => {
    const container = {} as HTMLDivElement;

    expect(shouldDetachTerminalContainer(container, container)).toBe(true);
  });

  it("blocks stale cleanup from detaching a runtime reattached elsewhere", () => {
    const previousContainer = {} as HTMLDivElement;
    const nextContainer = {} as HTMLDivElement;

    expect(shouldDetachTerminalContainer(nextContainer, previousContainer)).toBe(false);
  });
});

describe("shouldSendResize", () => {
  it("sends when the target differs from applied and nothing is in flight", () => {
    expect(shouldSendResize({ cols: 80, rows: 24 }, { cols: 0, rows: 0 }, null)).toBe(true);
  });

  it("skips when the target matches the already-applied size", () => {
    expect(shouldSendResize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }, null)).toBe(false);
  });

  it("skips when the target matches a resize already in flight", () => {
    expect(
      shouldSendResize({ cols: 100, rows: 40 }, { cols: 80, rows: 24 }, { cols: 100, rows: 40 }),
    ).toBe(false);
  });

  it("sends a distinct size even while another resize is in flight", () => {
    expect(
      shouldSendResize({ cols: 120, rows: 50 }, { cols: 80, rows: 24 }, { cols: 100, rows: 40 }),
    ).toBe(true);
  });

  it("sends a revert to the applied size while a different resize is in flight", () => {
    // Oscillating resize: applied is 80x24, a 100x40 resize is in flight, and
    // the fit reverts to 80x24 before 100x40 confirms. The PTY is heading to
    // 100x40, so the revert must still be sent or the backend lands on 100x40
    // while xterm renders 80x24.
    expect(
      shouldSendResize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }, { cols: 100, rows: 40 }),
    ).toBe(true);
  });
});

describe("nextFitStability", () => {
  it("holds a fresh proposal for a second confirming frame", () => {
    const { state, shouldFit } = nextFitStability(null, { cols: 100, rows: 40 });

    expect(shouldFit).toBe(false);
    expect(state).toEqual({ cols: 100, rows: 40, matchedFrames: 1, totalFrames: 1 });
  });

  it("fits once the same proposal holds for two consecutive frames", () => {
    const first = nextFitStability(null, { cols: 100, rows: 40 });
    const second = nextFitStability(first.state, { cols: 100, rows: 40 });

    expect(second.shouldFit).toBe(true);
  });

  it("restarts the match count when the proposal keeps moving", () => {
    const first = nextFitStability(null, { cols: 100, rows: 40 });
    const second = nextFitStability(first.state, { cols: 101, rows: 40 });

    expect(second.shouldFit).toBe(false);
    expect(second.state.matchedFrames).toBe(1);
    expect(second.state.totalFrames).toBe(2);
  });

  it("force-fits after the frame cap so a continuous drag still tracks", () => {
    // A drag that crosses a cell boundary every frame never yields two
    // matching frames; the cap keeps the pane following the divider.
    let state: FitStabilityState | null = null;
    let fits = 0;
    for (let frame = 0; frame < 8; frame++) {
      const result = nextFitStability(state, { cols: 100 + frame, rows: 40 });
      state = result.state;
      if (result.shouldFit) {
        fits += 1;
      }
    }

    expect(fits).toBe(1);
    expect(state?.totalFrames).toBe(8);
  });
});

describe("resolvePostFitViewport", () => {
  it("keeps a bottom-pinned terminal pinned to the bottom", () => {
    expect(resolvePostFitViewport({ wasAtBottom: true, viewportY: 120 }, 90)).toBe("bottom");
  });

  it("keeps the scrollback reading position when not at the bottom", () => {
    expect(resolvePostFitViewport({ wasAtBottom: false, viewportY: 40 }, 90)).toBe(40);
  });

  it("clamps the reading position to the post-reflow scroll range", () => {
    // Widening the pane re-wraps lines and shrinks the scroll range; the old
    // viewport line may no longer exist.
    expect(resolvePostFitViewport({ wasAtBottom: false, viewportY: 120 }, 90)).toBe(90);
  });
});

describe("shouldLoadWebglAddon", () => {
  it("loads when the pane is visible and has no addon yet", () => {
    expect(shouldLoadWebglAddon(false, true)).toBe(true);
  });

  it("does not double-load when an addon is already present", () => {
    // A reveal re-runs the layout-sync path; an addon that is already loaded
    // must not be added a second time.
    expect(shouldLoadWebglAddon(true, true)).toBe(false);
  });

  it("does not load while the pane is hidden", () => {
    expect(shouldLoadWebglAddon(false, false)).toBe(false);
  });
});

describe("shouldSuspendWebglAddon", () => {
  it("suspends a loaded context on a non-focused pane", () => {
    expect(shouldSuspendWebglAddon(true, false)).toBe(true);
  });

  it("never suspends the focused pane", () => {
    expect(shouldSuspendWebglAddon(true, true)).toBe(false);
  });

  it("does nothing when no context is loaded", () => {
    expect(shouldSuspendWebglAddon(false, false)).toBe(false);
  });
});
