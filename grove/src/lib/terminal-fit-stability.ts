// Pure fit-stability gate, shared by the live layout-sync path
// (terminal-runtime) and the post-spawn reconcile (terminal-pty-reassert).
//
// Divider drags — and an unsettled pane laying out during the spawn window —
// propose a new grid nearly every frame, and every applied fit runs xterm's
// renderer clear + scrollback reflow (and forwards a SIGWINCH). Per-frame fits
// read as visible blinking and make TUIs redraw-thrash. Apply a proposal only
// once it has held for FIT_STABLE_FRAMES consecutive frames;
// FIT_MAX_STABILITY_FRAMES bounds the wait so a long continuous change still
// tracks the pane instead of freezing.

export const FIT_STABLE_FRAMES = 2;
export const FIT_MAX_STABILITY_FRAMES = 8;

export interface FitStabilityState {
  cols: number;
  rows: number;
  matchedFrames: number;
  totalFrames: number;
}

export function nextFitStability(
  prev: FitStabilityState | null,
  proposed: { cols: number; rows: number },
): { state: FitStabilityState; shouldFit: boolean } {
  const matchedFrames =
    prev && prev.cols === proposed.cols && prev.rows === proposed.rows ? prev.matchedFrames + 1 : 1;
  const totalFrames = (prev?.totalFrames ?? 0) + 1;
  const state = { cols: proposed.cols, rows: proposed.rows, matchedFrames, totalFrames };
  return {
    state,
    shouldFit: matchedFrames >= FIT_STABLE_FRAMES || totalFrames >= FIT_MAX_STABILITY_FRAMES,
  };
}
