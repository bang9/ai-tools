import { describe, expect, it } from "vitest";
import {
  composedXtermThemesEqual,
  isViewportAtBottom,
  nextFitStability,
  planPtySwapReset,
  resolvePostFitViewport,
  shouldDetachTerminalContainer,
  shouldLoadWebglAddon,
  shouldSendResize,
  shouldSuspendWebglAddon,
} from "./terminal-runtime";
import type { FitStabilityState } from "./terminal-runtime";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "@xterm/headless";

describe("composedXtermThemesEqual (setTheme value-gate)", () => {
  const base: ITheme = { background: "#101010", foreground: "#fafafa", cursor: "#fafafa" };

  it("treats two identical-valued but distinct-identity themes as equal (skip assignment)", () => {
    expect(composedXtermThemesEqual({ ...base }, { ...base })).toBe(true);
  });

  it("treats the same object reference as equal", () => {
    expect(composedXtermThemesEqual(base, base)).toBe(true);
  });

  it("detects a changed color value (assign once)", () => {
    expect(composedXtermThemesEqual(base, { ...base, background: "#000000" })).toBe(false);
  });

  it("detects an added slot", () => {
    expect(composedXtermThemesEqual(base, { ...base, red: "#ff0000" })).toBe(false);
  });

  it("treats both-undefined (null theme) as equal", () => {
    expect(composedXtermThemesEqual(undefined, undefined)).toBe(true);
  });

  it("treats one-undefined as changed", () => {
    expect(composedXtermThemesEqual(undefined, base)).toBe(false);
    expect(composedXtermThemesEqual(base, undefined)).toBe(false);
  });
});

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

describe("isViewportAtBottom", () => {
  it("treats the exact bottom as bottom", () => {
    expect(isViewportAtBottom(90, 90)).toBe(true);
  });

  it("tolerates being one row shy of the bottom", () => {
    // Fast output/reflow can leave viewportY a hair behind baseY on the frame
    // a fit samples it; that must not read as "user scrolled up".
    expect(isViewportAtBottom(89, 90)).toBe(true);
  });

  it("treats deeper scrollback positions as reading", () => {
    expect(isViewportAtBottom(88, 90)).toBe(false);
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

  it("never loads for a webgl-disabled pane, even when visible", () => {
    // The global terminal opts out of the GPU renderer (WKWebView composites a
    // WebGL canvas under its transformed slide container unreliably).
    expect(shouldLoadWebglAddon(false, true, true)).toBe(false);
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

describe("planPtySwapReset (mouse-mode state on pty swap)", () => {
  // The plan interface has exactly one output channel, `termWrite` — a renderer
  // (xterm.write) string. There is no pty field, so a swap can never, by
  // construction, emit bytes onto the shell's stdin. This is the structural
  // "zero bytes to the PTY during a swap" guarantee; setPtyId routes the plan
  // exclusively through this.term.write.
  it("emits no reset on the initial attach (no previous pty)", () => {
    expect(planPtySwapReset({ previousPtyId: "", mouseTrackingMode: "any" })).toEqual({
      termWrite: null,
    });
  });

  it("emits no reset when the previous pty had no mouse tracking set", () => {
    expect(planPtySwapReset({ previousPtyId: "pty-a", mouseTrackingMode: "none" })).toEqual({
      termWrite: null,
    });
  });

  it("plan output only ever targets the renderer, never the pty", () => {
    const plan = planPtySwapReset({ previousPtyId: "pty-a", mouseTrackingMode: "vt200" });
    // Exactly one key, and it is the renderer channel.
    expect(Object.keys(plan)).toEqual(["termWrite"]);
  });

  for (const mode of ["x10", "vt200", "drag", "any"] as const) {
    it(`disables mouse reporting on a real swap out of ${mode} tracking`, () => {
      const plan = planPtySwapReset({ previousPtyId: "pty-a", mouseTrackingMode: mode });
      expect(plan.termWrite).toBe("\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l");
    });
  }
});

describe("planPtySwapReset round-trip against a real xterm parser", () => {
  const write = (term: Terminal, data: string) =>
    new Promise<void>((resolve) => term.write(data, resolve));

  // Each enable sequence a TUI would emit, paired with xterm's reported mode.
  const trackingCases: Array<{ enable: string; mode: "x10" | "vt200" | "drag" | "any" }> = [
    { enable: "\x1b[?9h", mode: "x10" },
    { enable: "\x1b[?1000h", mode: "vt200" },
    { enable: "\x1b[?1002h", mode: "drag" },
    { enable: "\x1b[?1003h", mode: "any" },
  ];

  for (const { enable, mode } of trackingCases) {
    it(`the ${mode} reset the plan chooses actually clears mouseTrackingMode`, async () => {
      const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      await write(term, enable);
      expect(term.modes.mouseTrackingMode).toBe(mode);

      // Feed xterm's own reported state into the planner, then apply the plan.
      const plan = planPtySwapReset({
        previousPtyId: "pty-a",
        mouseTrackingMode: term.modes.mouseTrackingMode,
      });
      expect(plan.termWrite).not.toBeNull();
      await write(term, plan.termWrite as string);

      expect(term.modes.mouseTrackingMode).toBe("none");
      term.dispose();
    });
  }

  it("leaves alt-screen (1049) to the incoming pty's replay — reset never exits it", async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    await write(term, "\x1b[?1049h\x1b[?1000h");
    expect(term.buffer.active.type).toBe("alternate");

    const plan = planPtySwapReset({
      previousPtyId: "pty-a",
      mouseTrackingMode: term.modes.mouseTrackingMode,
    });
    await write(term, plan.termWrite as string);

    // Mouse reporting cleared, but the session stays in the alt buffer.
    expect(term.modes.mouseTrackingMode).toBe("none");
    expect(term.buffer.active.type).toBe("alternate");
    term.dispose();
  });
});
