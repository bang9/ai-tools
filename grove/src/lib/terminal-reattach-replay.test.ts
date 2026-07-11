import { describe, expect, it } from "vitest";
import {
  planHydrationReplay,
  payloadHasFocusReporting,
  POST_REPLAY_REATTACH_RESET,
  REATTACH_CLEAR,
  type HydrationReplayInput,
  type HydrationReplayStep,
} from "./terminal-reattach-replay";

function baseInput(overrides: Partial<HydrationReplayInput>): HydrationReplayInput {
  return {
    source: "daemonSnapshot",
    payload: "",
    currentCols: 80,
    currentRows: 24,
    focused: false,
    ...overrides,
  };
}

// R2-TMUX BYTE-IDENTITY (P6 merge gate): the tmux capture, snapshot fallback,
// and undefined sources must plan EXACTLY one scrollback write (or nothing) —
// no clear, reset bundle, resize, kitty re-arm, or focus-in. This is the
// pre-daemon hydration sequence, unchanged.
describe("planHydrationReplay — non-daemon sources stay byte-identical to pre-P6", () => {
  for (const source of ["tmuxCapture", "snapshotFallback", undefined] as const) {
    it(`writes only the scrollback for source=${String(source)}`, () => {
      const steps = planHydrationReplay(
        baseInput({
          source,
          payload: "restored scrollback\r\n",
          // Even with daemon metadata present, a non-daemon source must ignore it.
          snapshotCols: 120,
          snapshotRows: 40,
          pendingEscapeTailAnsi: "\x1b[38;2",
          kittyKeyboardFlags: 5,
          isColdRestore: true,
          focused: true,
        }),
      );
      expect(steps).toEqual<HydrationReplayStep[]>([
        { kind: "termWrite", data: "restored scrollback\r\n" },
      ]);
    });

    it(`plans nothing for an empty payload with source=${String(source)}`, () => {
      expect(planHydrationReplay(baseInput({ source, payload: "" }))).toEqual([]);
    });
  }
});

describe("planHydrationReplay — daemonSnapshot replay order", () => {
  it("emits resize → clear → payload → reset → kitty → tail → focusIn → ack in order", () => {
    const payload = "\x1b[?1004h screenful";
    const steps = planHydrationReplay(
      baseInput({
        payload,
        currentCols: 80,
        currentRows: 24,
        snapshotCols: 120,
        snapshotRows: 40,
        pendingEscapeTailAnsi: "\x1b[38;2",
        kittyKeyboardFlags: 5,
        isColdRestore: true,
        focused: true,
      }),
    );

    expect(steps).toEqual<HydrationReplayStep[]>([
      { kind: "xtermResize", cols: 120, rows: 40 },
      { kind: "termWrite", data: REATTACH_CLEAR },
      { kind: "termWrite", data: payload },
      { kind: "termWrite", data: POST_REPLAY_REATTACH_RESET },
      { kind: "termWrite", data: "\x1b[=5u" },
      { kind: "termWrite", data: "\x1b[38;2" },
      { kind: "focusIn" },
      { kind: "ackColdRestore" },
    ]);
  });

  it("resizes xterm only — the plan carries NO PTY/transport resize step", () => {
    const steps = planHydrationReplay(
      baseInput({ payload: "x", snapshotCols: 120, snapshotRows: 40 }),
    );
    const resizeSteps = steps.filter((step) => step.kind === "xtermResize");
    expect(resizeSteps).toEqual([{ kind: "xtermResize", cols: 120, rows: 40 }]);
    // No other step kind implies a PTY resize; xtermResize is layout-only and the
    // runtime suppresses the SIGWINCH forward around it.
    expect(steps.some((step) => step.kind === "termWrite")).toBe(true);
  });

  it("skips the resize when snapshot dims match the current grid", () => {
    const steps = planHydrationReplay(
      baseInput({ payload: "x", snapshotCols: 80, snapshotRows: 24 }),
    );
    expect(steps.some((step) => step.kind === "xtermResize")).toBe(false);
  });

  it("skips the resize when snapshot dims are missing or non-positive", () => {
    expect(
      planHydrationReplay(baseInput({ payload: "x" })).some((s) => s.kind === "xtermResize"),
    ).toBe(false);
    expect(
      planHydrationReplay(baseInput({ payload: "x", snapshotCols: 0, snapshotRows: 40 })).some(
        (s) => s.kind === "xtermResize",
      ),
    ).toBe(false);
  });

  it("always writes the clear and the exact reset bundle", () => {
    const steps = planHydrationReplay(baseInput({ payload: "x" }));
    const writes = steps.filter((s) => s.kind === "termWrite").map((s) => s.data);
    expect(writes[0]).toBe(REATTACH_CLEAR);
    expect(writes).toContain(POST_REPLAY_REATTACH_RESET);
  });

  it("writes the pending escape tail as the LAST term write (after the reset)", () => {
    const steps = planHydrationReplay(
      baseInput({ payload: "body", pendingEscapeTailAnsi: "\x1b[38;2" }),
    );
    const writes = steps.filter((s) => s.kind === "termWrite");
    expect(writes[writes.length - 1]).toEqual({ kind: "termWrite", data: "\x1b[38;2" });
    // The reset must precede the tail so the tail's dangling ESC survives.
    const resetIndex = writes.findIndex((s) => s.data === POST_REPLAY_REATTACH_RESET);
    expect(resetIndex).toBeLessThan(writes.length - 1);
  });

  it("omits the kitty re-arm when the protocol is inactive", () => {
    const steps = planHydrationReplay(baseInput({ payload: "body", kittyKeyboardFlags: 0 }));
    expect(steps.some((s) => s.kind === "termWrite" && s.data.startsWith("\x1b[="))).toBe(false);
  });

  it("emits the focus-in only when focused AND the payload armed ?1004h", () => {
    const armed = "\x1b[?1004h body";
    expect(
      planHydrationReplay(baseInput({ payload: armed, focused: true })).some(
        (s) => s.kind === "focusIn",
      ),
    ).toBe(true);
    expect(
      planHydrationReplay(baseInput({ payload: armed, focused: false })).some(
        (s) => s.kind === "focusIn",
      ),
    ).toBe(false);
    expect(
      planHydrationReplay(baseInput({ payload: "no focus mode", focused: true })).some(
        (s) => s.kind === "focusIn",
      ),
    ).toBe(false);
  });

  it("acks only when the payload was a cold restore", () => {
    expect(
      planHydrationReplay(baseInput({ payload: "x", isColdRestore: true })).some(
        (s) => s.kind === "ackColdRestore",
      ),
    ).toBe(true);
    expect(
      planHydrationReplay(baseInput({ payload: "x", isColdRestore: false })).some(
        (s) => s.kind === "ackColdRestore",
      ),
    ).toBe(false);
  });

  it("still emits clear + reset for an empty daemon payload", () => {
    const steps = planHydrationReplay(baseInput({ payload: "" }));
    expect(steps).toEqual<HydrationReplayStep[]>([
      { kind: "termWrite", data: REATTACH_CLEAR },
      { kind: "termWrite", data: POST_REPLAY_REATTACH_RESET },
    ]);
  });
});

describe("payloadHasFocusReporting", () => {
  it("is true when ?1004h is armed and not later disabled", () => {
    expect(payloadHasFocusReporting("\x1b[?1004h")).toBe(true);
  });

  it("is false when a later ?1004l disables it", () => {
    expect(payloadHasFocusReporting("\x1b[?1004h ... \x1b[?1004l")).toBe(false);
  });

  it("is true when re-armed after a disable", () => {
    expect(payloadHasFocusReporting("\x1b[?1004h\x1b[?1004l\x1b[?1004h")).toBe(true);
  });

  it("is false when never armed", () => {
    expect(payloadHasFocusReporting("plain")).toBe(false);
  });
});
