// Post-fit / post-spawn PTY size verification against what tmux ACTUALLY applied.
//
// grove's resize pipeline (terminal-runtime.ts) dedupes against what it SENT
// (shouldSendResize): once a fit forwards a grid it trusts the resize landed.
// But a resize can be dropped or CLAMPED by tmux — the window-size policy, or a
// second attached client (the broadcast Mirror) coercing the pane to a smaller
// grid. This module closes the loop on what tmux applied:
//
//  • createPtySizeReassertion — after a fit settles / on reveal, read the
//    applied grid and re-forward ONLY on true drift vs the fitted grid.
//  • reconcilePtySizeAcrossFrames — a bounded post-spawn cross-frame loop that
//    corrects the 80x24 spawn grid once the (possibly hidden/unsettled) pane
//    lays out, verifying via the same applied-size readback before handing off
//    to the live ResizeObserver/layout-sync path.
//
// Both share decideDriftReassert, whose NON-CONVERGENCE GUARD is the hard
// requirement: if tmux returns the SAME clamped size twice in a row for the
// same request, the clamp is adopted as authoritative and we STOP re-forwarding
// — no re-fit oscillation, no flicker loop.

import { nextFitStability, type FitStabilityState } from "./terminal-fit-stability";

export type PtySizeDimensions = { cols: number; rows: number };

function sizesEqual(a: PtySizeDimensions | null, b: PtySizeDimensions | null): boolean {
  return a !== null && b !== null && a.cols === b.cols && a.rows === b.rows;
}

function dimensionsAreUsable(dimensions: PtySizeDimensions): boolean {
  return dimensions.cols > 0 && dimensions.rows > 0;
}

// Clamp-tracking state for the non-convergence guard. `requested` is the grid we
// last asked tmux for; `clamped` is the applied grid we observed back that
// differed from it. `adopted` flips true once the same clamp is seen twice and
// we give up re-forwarding — informational, the logic keys off requested/clamped.
export interface ClampTrackerState {
  requested: PtySizeDimensions | null;
  clamped: PtySizeDimensions | null;
  adopted: boolean;
}

export const INITIAL_CLAMP_STATE: ClampTrackerState = {
  requested: null,
  clamped: null,
  adopted: false,
};

export type DriftAction =
  | { kind: "none" }
  | { kind: "forward"; cols: number; rows: number }
  | { kind: "adopt"; cols: number; rows: number };

/**
 * Pure decision for the drift/clamp loop. Given the grid we want (`target`) and
 * the grid tmux reports it APPLIED (`applied`, non-null — callers handle an
 * unavailable readback themselves, since the reassertion and the reconcile want
 * opposite behavior there):
 *
 *  • applied == target            → converged; do nothing, reset tracking.
 *  • first drift for this target  → forward target once (a dropped/racey resize
 *                                   is healed by a single re-send).
 *  • SAME clamp seen again for the
 *    same target                  → adopt the clamp; STOP forwarding. This is
 *                                   the non-convergence guard: a window-size
 *                                   policy or a second client is coercing the
 *                                   pane, so re-forwarding only oscillates.
 *
 * The adopt branch is idempotent — a persistent clamp keeps returning `adopt`
 * (never `forward`), so exactly one corrective resize is emitted per target.
 */
export function decideDriftReassert(
  prev: ClampTrackerState,
  target: PtySizeDimensions,
  applied: PtySizeDimensions,
): { action: DriftAction; state: ClampTrackerState } {
  if (sizesEqual(applied, target)) {
    return { action: { kind: "none" }, state: INITIAL_CLAMP_STATE };
  }

  // Same clamp twice in a row for the same request → adopt and stop.
  if (
    sizesEqual(prev.requested, target) &&
    prev.clamped !== null &&
    sizesEqual(prev.clamped, applied)
  ) {
    return {
      action: { kind: "adopt", cols: applied.cols, rows: applied.rows },
      state: { requested: { ...target }, clamped: { ...applied }, adopted: true },
    };
  }

  // First drift for this target (or the clamp value changed) → one corrective
  // forward, and record the clamp so a repeat trips the guard above.
  return {
    action: { kind: "forward", cols: target.cols, rows: target.rows },
    state: { requested: { ...target }, clamped: { ...applied }, adopted: false },
  };
}

export interface PtySizeReassertionOptions {
  isDisposed: () => boolean;
  getPtyId: () => string | null;
  // grove PTYs are always local; kept injectable so the gate is testable and
  // mirrors orca's remote-runtime skip.
  isRemotePtyId: (ptyId: string) => boolean;
  // True while the PTY resize must not be touched (e.g. a sash-drag hold).
  shouldSuppressDesktopResize: () => boolean;
  fit: () => void;
  getTerminalDimensions: () => PtySizeDimensions;
  getAppliedSize: (ptyId: string) => Promise<PtySizeDimensions | null>;
  // True while a PTY resize the runtime issued is still converging. Reading the
  // applied size then races that resize — the backend may still report the
  // PRE-resize grid, which would be misread as drift. When set, the readback is
  // deferred; the caller re-requests once the resize resolves.
  hasInFlightResize?: () => boolean;
  forwardResize: (cols: number, rows: number) => void;
  // Called when a persistent clamp is adopted (non-convergence). Observability
  // only — the runtime must NOT re-fit here (that would reopen the oscillation).
  onAdoptClamp?: (cols: number, rows: number) => void;
}

export type PtySizeReassertion = {
  request: (requestOptions?: { fit?: boolean }) => void;
  dispose: () => void;
};

export function createPtySizeReassertion(options: PtySizeReassertionOptions): PtySizeReassertion {
  let disposed = false;
  let inFlight = false;
  let pending = false;
  let pendingFit = false;
  let clampState: ClampTrackerState = INITIAL_CLAMP_STATE;

  const canQuery = (ptyId: string | null): ptyId is string => {
    if (disposed || options.isDisposed() || !ptyId) {
      return false;
    }
    return !options.isRemotePtyId(ptyId) && !options.shouldSuppressDesktopResize();
  };

  const run = (shouldFit: boolean): void => {
    const ptyId = options.getPtyId();
    if (!canQuery(ptyId)) {
      return;
    }
    // Defer while a PTY resize is in flight: a readback now can return the
    // pre-resize grid and be misread as drift. The caller re-requests once the
    // resize resolves. Don't fit mid-resize either.
    if (options.hasInFlightResize?.()) {
      return;
    }
    if (shouldFit) {
      options.fit();
    }
    const target = options.getTerminalDimensions();
    if (!dimensionsAreUsable(target)) {
      return;
    }
    inFlight = true;

    const decide = (applied: PtySizeDimensions | null): void => {
      if (options.getPtyId() !== ptyId || !canQuery(ptyId)) {
        return;
      }
      // Why: a queued request means a newer layout observation should re-measure
      // before we act on this older target.
      if (pending) {
        return;
      }
      if (applied === null) {
        // Why: readback unavailable — one guarded resize is safer than leaving
        // the visible pane at an unverified PTY size. Record the request but no
        // clamp, so a later confirmed drift still trips the guard.
        options.forwardResize(target.cols, target.rows);
        clampState = { requested: { ...target }, clamped: null, adopted: false };
        return;
      }
      const { action, state } = decideDriftReassert(clampState, target, applied);
      clampState = state;
      if (action.kind === "forward") {
        options.forwardResize(action.cols, action.rows);
      } else if (action.kind === "adopt") {
        options.onAdoptClamp?.(action.cols, action.rows);
      }
    };

    void options
      .getAppliedSize(ptyId)
      .then(decide, () => decide(null))
      .finally(() => {
        inFlight = false;
        if (pending && !disposed) {
          const shouldFitPending = pendingFit;
          pending = false;
          pendingFit = false;
          run(shouldFitPending);
        }
      });
  };

  return {
    request: (requestOptions) => {
      if (disposed || options.isDisposed()) {
        return;
      }
      const shouldFit = requestOptions?.fit !== false;
      if (inFlight) {
        pending = true;
        pendingFit ||= shouldFit;
        return;
      }
      run(shouldFit);
    },
    dispose: () => {
      disposed = true;
      pending = false;
      pendingFit = false;
      clampState = INITIAL_CLAMP_STATE;
    },
  };
}

export type PtySizeReconcileOptions = {
  /** Grid the PTY was spawned at — the size it currently believes it is. */
  spawnCols: number;
  spawnRows: number;
  /** True while this reconcile still owns a live PTY (not disposed / not rebound). */
  isAlive: () => boolean;
  /**
   * True while a sash-drag resize hold is active. Such frames are skipped —
   * neither fit nor forwarded — so the reconcile never fights the hold, but they
   * still count toward the hard cap so a stuck hold cannot loop forever.
   */
  isHeld: () => boolean;
  /**
   * True once the live onResize/ResizeObserver path forwards future resizes
   * itself (i.e. the pane is visible). The reconcile only needs to run while
   * this is false (the hidden mount window); once true and the grid is stable it
   * hands off.
   */
  isAuthoritative: () => boolean;
  /**
   * Return the pane's currently PROPOSED grid WITHOUT side effects (no fit), or
   * null when it is not yet measurable. A proposal that differs from what the
   * PTY was last told is gated through nextFitStability and only committed via
   * {@link resize} once it holds for FIT_STABLE_FRAMES (or hits the cap); a
   * matching proposal counts toward the settle window. Keeping the fit out of
   * measure is what stops a per-frame reflow during the spawn window.
   */
  measure: () => PtySizeDimensions | null;
  /**
   * Commit a settled grid: fit the pane (the single reflow) and forward it to
   * the PTY (authoritative — bypasses dedupe). Called only after the proposal
   * clears the fit-stability gate, mirroring the live fit path.
   */
  resize: (cols: number, rows: number) => void;
  /**
   * Read the grid the PTY has ACTUALLY applied (vs what this loop last sent).
   * Before handing off, the loop reads this once; on drift it re-forwards and
   * keeps converging until the non-convergence guard adopts a persistent clamp.
   * Returns null when the applied size cannot be confirmed (treated as
   * "synced enough to hand off").
   */
  getAppliedSize?: () => Promise<PtySizeDimensions | null>;
  /** Called when a persistent clamp is adopted (non-convergence). Observability only. */
  onAdoptClamp?: (cols: number, rows: number) => void;
  /** Schedule the next frame; mirrors requestAnimationFrame's id contract. */
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
};

export type PtySizeReconcileHandle = { cancel: () => void };

// Hand off (stop) once the grid has held steady for SETTLE_FRAMES observed
// *while authoritative*: while hidden the live onResize is dropped so the
// reconcile is the sole corrector and must keep watching; once visible+stable
// the live path owns further reflows. MAX_FRAMES (~3s at 60fps) guarantees
// termination for a pane that never becomes authoritative or never stabilizes.
const POST_SPAWN_RECONCILE_SETTLE_FRAMES = 8;
const POST_SPAWN_RECONCILE_MAX_FRAMES = 180;

export function reconcilePtySizeAcrossFrames(
  options: PtySizeReconcileOptions,
): PtySizeReconcileHandle {
  let frame = 0;
  let authoritativeStableFrames = 0;
  let lastSentCols = options.spawnCols;
  let lastSentRows = options.spawnRows;
  // Per-frame fit-stability gate for the spawn window: a changing proposal only
  // commits (fit + forward) once it holds for FIT_STABLE_FRAMES, so an unsettled
  // pane doesn't reflow + SIGWINCH every frame (mirrors the live fit path).
  let fitStability: FitStabilityState | null = null;
  let pendingFrame: number | null = null;
  let cancelled = false;
  // One-shot applied-size verification before handoff. `verifyInFlight` prevents
  // re-issuing the async read every frame; `appliedVerified` is the terminal
  // flag that lets the loop stop. `verifyClamp` drives the non-convergence guard.
  let verifyInFlight = false;
  let appliedVerified = options.getAppliedSize === undefined;
  let verifyClamp: ClampTrackerState = INITIAL_CLAMP_STATE;

  const tick = (): void => {
    pendingFrame = null;
    if (cancelled || !options.isAlive()) {
      return;
    }
    frame += 1;
    if (!options.isHeld()) {
      const measured = options.measure();
      if (measured && measured.cols > 0 && measured.rows > 0) {
        if (measured.cols !== lastSentCols || measured.rows !== lastSentRows) {
          // A changed proposal: gate it through the SAME fit-stability logic as
          // the live path so a grid still moving during the spawn window does not
          // fit + forward every frame. Commit only once it holds (or hits the cap).
          const gate = nextFitStability(fitStability, measured);
          fitStability = gate.state;
          if (gate.shouldFit) {
            // Authoritative spawn-time correction. A real change resets the
            // stability window and the verify tracking so we re-confirm the new size.
            options.resize(measured.cols, measured.rows);
            lastSentCols = measured.cols;
            lastSentRows = measured.rows;
            authoritativeStableFrames = 0;
            appliedVerified = options.getAppliedSize === undefined;
            verifyClamp = INITIAL_CLAMP_STATE;
            fitStability = null;
          }
        } else {
          // Proposal matches what we last forwarded: the gate is settled.
          fitStability = null;
          if (options.isAuthoritative()) {
            // Only stability seen *under authority* counts toward handoff.
            authoritativeStableFrames += 1;
          }
        }
      }
      // A null/zero measurement makes no stability progress: layout isn't ready.
    }
    const gridStable = authoritativeStableFrames >= POST_SPAWN_RECONCILE_SETTLE_FRAMES;
    // Verify what the PTY APPLIED before handing off (grid-stable only proves
    // what we SENT held steady). Skip while held: a paused loop must not verify.
    if (
      gridStable &&
      !appliedVerified &&
      !verifyInFlight &&
      !options.isHeld() &&
      options.getAppliedSize
    ) {
      verifyInFlight = true;
      const target: PtySizeDimensions = { cols: lastSentCols, rows: lastSentRows };
      void options
        .getAppliedSize()
        .then((applied) => {
          if (cancelled || !options.isAlive()) {
            return;
          }
          // Why: a hold can engage while this async read is in flight; re-check
          // so a paused loop never re-forwards mid-hold.
          if (options.isHeld()) {
            return;
          }
          if (applied === null) {
            // Cannot confirm → safe to hand off (don't wedge to the cap).
            appliedVerified = true;
            return;
          }
          const { action, state } = decideDriftReassert(verifyClamp, target, applied);
          verifyClamp = state;
          if (action.kind === "forward") {
            // The PTY dropped our size — re-forward and keep converging.
            options.resize(target.cols, target.rows);
            authoritativeStableFrames = 0;
          } else {
            // Applied matches (none), or a persistent clamp was adopted → hand off.
            if (action.kind === "adopt") {
              options.onAdoptClamp?.(target.cols, target.rows);
            }
            appliedVerified = true;
          }
        })
        .catch(() => {
          // A failed read must not wedge the loop until MAX_FRAMES.
          appliedVerified = true;
        })
        .finally(() => {
          verifyInFlight = false;
        });
    }
    const settled = gridStable && appliedVerified;
    if (!settled && frame < POST_SPAWN_RECONCILE_MAX_FRAMES) {
      pendingFrame = options.requestFrame(tick);
    }
    // Note: grove deliberately omits orca's 0x0 white-screen fallback — grove
    // spawns at a usable 80x24, so a pane that never measures stays at that
    // usable grid and the live onResize corrects it once it lays out.
  };

  pendingFrame = options.requestFrame(tick);

  return {
    cancel: () => {
      cancelled = true;
      if (pendingFrame !== null) {
        options.cancelFrame(pendingFrame);
        pendingFrame = null;
      }
    },
  };
}
