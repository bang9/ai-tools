import { describe, expect, it, vi } from "vitest";
import {
  createPtySizeReassertion,
  decideDriftReassert,
  INITIAL_CLAMP_STATE,
  reconcilePtySizeAcrossFrames,
  type PtySizeDimensions,
  type PtySizeReconcileOptions,
} from "./terminal-pty-reassert";

async function flushAsyncTicks(count = 3): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

describe("decideDriftReassert (non-convergence guard)", () => {
  it("does nothing when tmux already applied the target", () => {
    const { action } = decideDriftReassert(
      INITIAL_CLAMP_STATE,
      { cols: 82, rows: 30 },
      { cols: 82, rows: 30 },
    );
    expect(action).toEqual({ kind: "none" });
  });

  it("forwards the target on first drift", () => {
    const { action, state } = decideDriftReassert(
      INITIAL_CLAMP_STATE,
      { cols: 82, rows: 30 },
      { cols: 120, rows: 30 },
    );
    expect(action).toEqual({ kind: "forward", cols: 82, rows: 30 });
    expect(state.clamped).toEqual({ cols: 120, rows: 30 });
    expect(state.adopted).toBe(false);
  });

  it("adopts the clamp when the same clamp is seen twice for the same target", () => {
    const target = { cols: 82, rows: 30 };
    const clamp = { cols: 120, rows: 30 };
    const first = decideDriftReassert(INITIAL_CLAMP_STATE, target, clamp);
    expect(first.action.kind).toBe("forward");

    const second = decideDriftReassert(first.state, target, clamp);
    expect(second.action).toEqual({ kind: "adopt", cols: 120, rows: 30 });
    expect(second.state.adopted).toBe(true);

    // Idempotent: a persistent clamp keeps adopting, never re-forwards.
    const third = decideDriftReassert(second.state, target, clamp);
    expect(third.action).toEqual({ kind: "adopt", cols: 120, rows: 30 });
  });

  it("re-forwards once when the target changes (adoption is per-target)", () => {
    const clamp = { cols: 120, rows: 30 };
    const adopted = decideDriftReassert(
      { requested: { cols: 82, rows: 30 }, clamped: clamp, adopted: true },
      { cols: 90, rows: 40 },
      clamp,
    );
    expect(adopted.action).toEqual({ kind: "forward", cols: 90, rows: 40 });
  });
});

describe("createPtySizeReassertion", () => {
  function baseOptions(overrides: Partial<Parameters<typeof createPtySizeReassertion>[0]> = {}) {
    return {
      isDisposed: () => false,
      getPtyId: () => "pty-1",
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => false,
      fit: vi.fn(),
      getTerminalDimensions: () => ({ cols: 82, rows: 30 }),
      getAppliedSize: vi.fn(async () => ({ cols: 82, rows: 30 })),
      forwardResize: vi.fn(),
      ...overrides,
    };
  }

  it("forwards exactly one corrective resize on true drift", async () => {
    const forwardResize = vi.fn();
    const reassertion = createPtySizeReassertion(
      baseOptions({
        getAppliedSize: vi.fn(async () => ({ cols: 120, rows: 30 })),
        forwardResize,
      }),
    );

    reassertion.request({ fit: false });
    await flushAsyncTicks();

    expect(forwardResize).toHaveBeenCalledTimes(1);
    expect(forwardResize).toHaveBeenCalledWith(82, 30);
  });

  it("does not forward when the applied PTY size already matches", async () => {
    const forwardResize = vi.fn();
    const reassertion = createPtySizeReassertion(baseOptions({ forwardResize }));

    reassertion.request({ fit: false });
    await flushAsyncTicks();

    expect(forwardResize).not.toHaveBeenCalled();
  });

  it("adopts a persistent clamp: one re-forward then stop, no oscillation", async () => {
    const forwardResize = vi.fn();
    const onAdoptClamp = vi.fn();
    // tmux always reports the clamped wide grid, never the requested 82.
    const reassertion = createPtySizeReassertion(
      baseOptions({
        getAppliedSize: vi.fn(async () => ({ cols: 120, rows: 30 })),
        forwardResize,
        onAdoptClamp,
      }),
    );

    // Repeated reassert cycles (e.g. successive layout-syncs) must NOT keep
    // re-forwarding — after the first corrective resize the clamp is adopted.
    for (let i = 0; i < 6; i += 1) {
      reassertion.request({ fit: false });
      await flushAsyncTicks();
    }

    expect(forwardResize).toHaveBeenCalledTimes(1);
    expect(forwardResize).toHaveBeenCalledWith(82, 30);
    expect(onAdoptClamp).toHaveBeenCalledWith(120, 30);
  });

  it("forwards one guarded resize when the applied-size readback fails", async () => {
    const forwardResize = vi.fn();
    const reassertion = createPtySizeReassertion(
      baseOptions({
        getAppliedSize: vi.fn(async () => {
          throw new Error("unavailable");
        }),
        forwardResize,
      }),
    );

    reassertion.request({ fit: false });
    await flushAsyncTicks();

    expect(forwardResize).toHaveBeenCalledTimes(1);
    expect(forwardResize).toHaveBeenCalledWith(82, 30);
  });

  it("skips remote and hold-suppressed PTYs", async () => {
    const getAppliedSize = vi.fn(async () => ({ cols: 120, rows: 30 }));
    const remote = createPtySizeReassertion(
      baseOptions({ getPtyId: () => "remote:1", isRemotePtyId: () => true, getAppliedSize }),
    );
    const suppressed = createPtySizeReassertion(
      baseOptions({ shouldSuppressDesktopResize: () => true, getAppliedSize }),
    );

    remote.request({ fit: false });
    suppressed.request({ fit: false });
    await flushAsyncTicks();

    expect(getAppliedSize).not.toHaveBeenCalled();
  });

  it("defers the readback while a PTY resize is in flight, then reads once it resolves", async () => {
    // FIX 4: reading right after syncPtySize races the resize — the backend may
    // still report the pre-resize grid, misread as drift. Skip the readback while
    // a resize is in flight; the runtime re-requests once it resolves.
    let inFlight = true;
    const getAppliedSize = vi.fn(async () => ({ cols: 82, rows: 30 }));
    const forwardResize = vi.fn();
    const reassertion = createPtySizeReassertion(
      baseOptions({ hasInFlightResize: () => inFlight, getAppliedSize, forwardResize }),
    );

    reassertion.request({ fit: false });
    await flushAsyncTicks();
    // Deferred: no readback, no forward while the resize is converging.
    expect(getAppliedSize).not.toHaveBeenCalled();
    expect(forwardResize).not.toHaveBeenCalled();

    // The resize resolves and the runtime re-requests → the readback runs once.
    inFlight = false;
    reassertion.request({ fit: false });
    await flushAsyncTicks();
    expect(getAppliedSize).toHaveBeenCalledTimes(1);
  });

  it("coalesces overlapping requests into a single readback then re-runs", async () => {
    let resolveFirst: (value: PtySizeDimensions) => void = () => {};
    const getAppliedSize = vi
      .fn<() => Promise<PtySizeDimensions | null>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ cols: 120, rows: 30 });
    const forwardResize = vi.fn();
    const reassertion = createPtySizeReassertion(baseOptions({ getAppliedSize, forwardResize }));

    reassertion.request({ fit: false });
    reassertion.request({ fit: false });
    reassertion.request({ fit: false });
    expect(getAppliedSize).toHaveBeenCalledTimes(1);

    resolveFirst({ cols: 120, rows: 30 });
    await flushAsyncTicks();

    expect(getAppliedSize).toHaveBeenCalledTimes(2);
    expect(forwardResize).toHaveBeenCalledTimes(1);
  });

  it("does not forward a stale target when a newer request is pending", async () => {
    let targetCols = 100;
    let resolveFirst: (value: PtySizeDimensions) => void = () => {};
    const getAppliedSize = vi
      .fn<() => Promise<PtySizeDimensions | null>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ cols: 90, rows: 40 });
    const forwardResize = vi.fn();
    const reassertion = createPtySizeReassertion(
      baseOptions({
        getTerminalDimensions: () => ({ cols: targetCols, rows: 40 }),
        getAppliedSize,
        forwardResize,
      }),
    );

    reassertion.request({ fit: false });
    targetCols = 120;
    reassertion.request({ fit: false });
    resolveFirst({ cols: 120, rows: 40 });
    await flushAsyncTicks();

    expect(forwardResize).toHaveBeenCalledTimes(1);
    expect(forwardResize).toHaveBeenCalledWith(120, 40);
    expect(forwardResize).not.toHaveBeenCalledWith(100, 40);
  });
});

/** A deterministic frame scheduler: callbacks queue, then run() drains them. */
function createFrameScheduler() {
  const queue = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    requestFrame: (callback: () => void): number => {
      const handle = nextHandle++;
      queue.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle: number): void => {
      queue.delete(handle);
    },
    run(maxFrames = 1000): number {
      let ran = 0;
      while (queue.size > 0 && ran < maxFrames) {
        const [handle, callback] = queue.entries().next().value as [number, () => void];
        queue.delete(handle);
        callback();
        ran += 1;
      }
      return ran;
    },
    pending: () => queue.size,
  };
}

function createTimelinePane(timeline: (frame: number) => PtySizeDimensions | null) {
  let frame = 0;
  return {
    measure: vi.fn((): PtySizeDimensions | null => {
      const dims = timeline(frame);
      frame += 1;
      return dims;
    }),
  };
}

function runReconcile(
  overrides: Partial<PtySizeReconcileOptions> & Pick<PtySizeReconcileOptions, "measure">,
  maxFrames = 1000,
): { resize: ReturnType<typeof vi.fn>; framesRun: number } {
  const scheduler = createFrameScheduler();
  const resize = vi.fn();
  reconcilePtySizeAcrossFrames({
    spawnCols: 80,
    spawnRows: 24,
    isAlive: () => true,
    isHeld: () => false,
    isAuthoritative: () => true,
    resize,
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
    ...overrides,
  });
  const framesRun = scheduler.run(maxFrames);
  return { resize, framesRun };
}

describe("reconcilePtySizeAcrossFrames", () => {
  it("forwards the real grid then hands off once visible + stable", () => {
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }));
    const { resize, framesRun } = runReconcile({ measure: pane.measure });
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenLastCalledWith(79, 50);
    // Frame 1 holds the proposal (fit-stability gate), frame 2 commits the
    // forward, frames 3..10 are authoritative+stable → settle at 10.
    expect(framesRun).toBe(10);
  });

  it("gates a changing grid through fit-stability: no forward until it holds", () => {
    // A grid that moves every frame (an unsettled pane still laying out during
    // the spawn window) must NOT fit + forward per frame; it commits once the
    // fit-stability cap is hit, exactly like the live layout-sync path.
    const scheduler = createFrameScheduler();
    const resize = vi.fn();
    const pane = createTimelinePane((frame) => ({ cols: 100 + frame, rows: 40 }));
    reconcilePtySizeAcrossFrames({
      spawnCols: 80,
      spawnRows: 24,
      isAlive: () => true,
      isHeld: () => false,
      isAuthoritative: () => true,
      measure: pane.measure,
      resize,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    // Seven frames of an ever-changing proposal → no commit yet.
    scheduler.run(7);
    expect(resize).not.toHaveBeenCalled();
    // Frame 8 hits FIT_MAX_STABILITY_FRAMES → exactly one forced forward.
    scheduler.run(1);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenLastCalledWith(107, 40);
  });

  it("forwards nothing when the seeded (already-applied) grid matches the measured grid", () => {
    // FIX 5: startPtySizeReconcile seeds lastSent from the runtime's current
    // applied size, so a pane that spawns already correctly sized re-measures the
    // same grid and sends no redundant first resize.
    const scheduler = createFrameScheduler();
    const resize = vi.fn();
    const pane = createTimelinePane(() => ({ cols: 120, rows: 40 }));
    reconcilePtySizeAcrossFrames({
      // Seeded from the applied size (not the 80x24 spawn) → measured == seed.
      spawnCols: 120,
      spawnRows: 40,
      isAlive: () => true,
      isHeld: () => false,
      isAuthoritative: () => true,
      measure: pane.measure,
      resize,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    scheduler.run();
    expect(resize).not.toHaveBeenCalled();
  });

  it("forwards no resize when the settled grid never changes from the spawn dims", () => {
    const pane = createTimelinePane(() => ({ cols: 80, rows: 24 }));
    const { resize } = runReconcile({ measure: pane.measure });
    expect(resize).not.toHaveBeenCalled();
  });

  it("forwards a late narrow settle that lands while hidden (mount desync)", () => {
    const NARROW_AT = 40;
    const pane = createTimelinePane((frame) =>
      frame < NARROW_AT ? { cols: 203, rows: 50 } : { cols: 79, rows: 50 },
    );
    const { resize } = runReconcile({ measure: pane.measure, isAuthoritative: () => false });
    expect(resize).toHaveBeenCalled();
    expect(resize).toHaveBeenLastCalledWith(79, 50);
  });

  it("spawn-hidden-then-reveal: forwards the real size then verifies it applied", async () => {
    const scheduler = createFrameScheduler();
    const resize = vi.fn();
    const REVEAL_AT = 5;
    let frameSeen = 0;
    let applied = { cols: 80, rows: 24 };
    const pane = createTimelinePane((frame) => {
      frameSeen = frame;
      return { cols: 79, rows: 50 };
    });
    reconcilePtySizeAcrossFrames({
      spawnCols: 80,
      spawnRows: 24,
      isAlive: () => true,
      isHeld: () => false,
      isAuthoritative: () => frameSeen >= REVEAL_AT,
      measure: pane.measure,
      resize: vi.fn((cols, rows) => {
        resize(cols, rows);
        applied = { cols, rows };
      }),
      getAppliedSize: async () => applied,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    let ran = 0;
    while (scheduler.pending() > 0 && ran < 400) {
      scheduler.run(1);
      ran += 1;
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(resize).toHaveBeenCalledWith(79, 50);
    expect(scheduler.pending()).toBe(0);
  });

  it("persistent clamp: bounded stop at the clamped size, no oscillation", async () => {
    const scheduler = createFrameScheduler();
    const resize = vi.fn();
    const onAdoptClamp = vi.fn();
    // xterm settles narrow immediately; the PTY never applies it (window-size
    // policy / second client always clamps back to the wide spawn width).
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }));
    reconcilePtySizeAcrossFrames({
      spawnCols: 203,
      spawnRows: 50,
      isAlive: () => true,
      isHeld: () => false,
      isAuthoritative: () => true,
      measure: pane.measure,
      resize,
      getAppliedSize: async () => ({ cols: 203, rows: 50 }),
      onAdoptClamp,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    let ran = 0;
    while (scheduler.pending() > 0 && ran < 10_000) {
      scheduler.run(1);
      ran += 1;
      await Promise.resolve();
      await Promise.resolve();
    }

    // Bounded: the initial settle forward + exactly one verify-driven re-forward,
    // then the clamp is adopted and the loop STOPS well short of the hard cap.
    const narrowForwards = resize.mock.calls.filter((c) => c[0] === 79 && c[1] === 50);
    expect(narrowForwards.length).toBe(2);
    expect(onAdoptClamp).toHaveBeenCalledWith(79, 50);
    expect(scheduler.pending()).toBe(0);
    expect(ran).toBeLessThan(180);
  });

  it("hands off once the applied size matches the forwarded grid", async () => {
    const scheduler = createFrameScheduler();
    const resize = vi.fn();
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }));
    let applied = { cols: 203, rows: 50 };
    reconcilePtySizeAcrossFrames({
      spawnCols: 203,
      spawnRows: 50,
      isAlive: () => true,
      isHeld: () => false,
      isAuthoritative: () => true,
      measure: pane.measure,
      resize: vi.fn((cols, rows) => {
        resize(cols, rows);
        applied = { cols, rows };
      }),
      getAppliedSize: async () => applied,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    let ran = 0;
    while (scheduler.pending() > 0 && ran < 400) {
      scheduler.run(1);
      ran += 1;
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(resize).toHaveBeenLastCalledWith(79, 50);
    expect(scheduler.pending()).toBe(0);
  });

  it("hands off when the applied size cannot be confirmed (null read)", async () => {
    const scheduler = createFrameScheduler();
    const resize = vi.fn();
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }));
    reconcilePtySizeAcrossFrames({
      spawnCols: 80,
      spawnRows: 24,
      isAlive: () => true,
      isHeld: () => false,
      isAuthoritative: () => true,
      measure: pane.measure,
      resize,
      getAppliedSize: async () => null,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    let ran = 0;
    while (scheduler.pending() > 0 && ran < 400) {
      scheduler.run(1);
      ran += 1;
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(scheduler.pending()).toBe(0);
  });

  it("pauses while a hold is active: no measure, no forward during the hold", () => {
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }));
    const { resize, framesRun } = runReconcile({ measure: pane.measure, isHeld: () => true });
    expect(resize).not.toHaveBeenCalled();
    expect(pane.measure).not.toHaveBeenCalled();
    // Held frames still count toward the cap so a stuck hold cannot loop forever.
    expect(framesRun).toBe(180);
  });

  it("resumes and converges after a transient hold during mount", () => {
    const HELD_UNTIL = 10;
    let frameSeen = 0;
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }));
    const scheduler = createFrameScheduler();
    const resize = vi.fn();
    reconcilePtySizeAcrossFrames({
      spawnCols: 80,
      spawnRows: 24,
      isAlive: () => true,
      isHeld: () => frameSeen++ < HELD_UNTIL,
      isAuthoritative: () => true,
      measure: pane.measure,
      resize,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    scheduler.run();
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenLastCalledWith(79, 50);
  });

  it("does not loop forever — terminates within the hard frame cap", () => {
    // A strictly monotonic grid never repeats the last-forwarded value, so it
    // never settles (each stability-cap forward advances lastSent past every
    // future measurement) → the loop terminates at the hard frame cap.
    const pane = createTimelinePane((frame) => ({ cols: 100 + frame, rows: 30 }));
    const { framesRun } = runReconcile({ measure: pane.measure }, 10_000);
    expect(framesRun).toBe(180);
  });

  it("stops promptly once cancelled (pane disposed mid-reconcile)", () => {
    const scheduler = createFrameScheduler();
    const resize = vi.fn();
    const pane = createTimelinePane((frame) =>
      frame < 30 ? { cols: 203, rows: 50 } : { cols: 79, rows: 50 },
    );
    const handle = reconcilePtySizeAcrossFrames({
      spawnCols: 80,
      spawnRows: 24,
      isAlive: () => true,
      isHeld: () => false,
      isAuthoritative: () => true,
      measure: pane.measure,
      resize,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    scheduler.run(3);
    handle.cancel();
    expect(scheduler.pending()).toBe(0);
    const measuredBefore = pane.measure.mock.calls.length;
    scheduler.run(100);
    expect(pane.measure.mock.calls.length).toBe(measuredBefore);
  });

  it("stops when the PTY is no longer alive (rebound / disposed)", () => {
    const scheduler = createFrameScheduler();
    const resize = vi.fn();
    let alive = true;
    const pane = createTimelinePane(() => ({ cols: 79, rows: 50 }));
    reconcilePtySizeAcrossFrames({
      spawnCols: 80,
      spawnRows: 24,
      isAlive: () => alive,
      isHeld: () => false,
      isAuthoritative: () => true,
      measure: pane.measure,
      resize,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    scheduler.run(2);
    const callsBefore = resize.mock.calls.length;
    alive = false;
    scheduler.run(100);
    expect(resize.mock.calls.length).toBe(callsBefore);
    expect(scheduler.pending()).toBe(0);
  });
});
