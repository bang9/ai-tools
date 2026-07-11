# Terminal Resize Pipeline

How a pane size change becomes an xterm grid change, and how the pipeline
avoids visible flicker while it happens. (Design ported from orca's
fit-stability + scroll-intent architecture.)

## Pipeline

```
Allotment sash drag ──► SplitContainer onLayout ─┐
Window/panel resize ──► ResizeObserver (runtime) ─┼─► requestTerminalLayoutSync
Attach / tab activate / theme / broadcast ────────┘          │
                                                             ▼
                                     TerminalPaneRuntime.scheduleLayoutSync
                                       (one rAF per runtime, cancel+reschedule)
                                                             │
                                          proposeFit() — measurable? ──► no: retry
                                                             │              until 1.5s deadline
                                          proposed == current grid?
                                            ├─ yes: skip fit entirely; finish
                                            │       reveal work + PTY reconcile
                                            └─ no: fit-stability loop
                                                             │
                                          nextFitStability(prev, proposed)
                                            ├─ waiting: re-arm next frame
                                            └─ stable (2 frames) or cap (8 frames):
                                                 fitAddon.fit() with viewport
                                                 preservation, then syncPtySize()
```

## Why the stability loop exists

`FitAddon.fit()` on a grid change runs xterm's `renderService.clear()` plus a
full scrollback reflow. A divider drag crosses cell boundaries nearly every
frame; fitting each frame repeats that clear+reflow, which reads as blinking
and makes TUIs (Claude Code, Codex) redraw-thrash via a SIGWINCH stream.

`nextFitStability` (`src/lib/terminal-runtime.ts`) only applies a proposal
after it holds for `FIT_STABLE_FRAMES = 2` consecutive frames. So mid-drag the
terminal content stays put (the letterbox gap that opens up is masked — see
CSS below) and one reflow lands right after the divider settles.
`FIT_MAX_STABILITY_FRAMES = 8` force-fits during a long continuous drag so the
pane still tracks the divider instead of freezing.

## Viewport preservation

Reflow moves buffer lines, so the pre-fit viewport points at different content
afterwards. `fitTerminal` snapshots the viewport before `fit()` and re-pins
explicitly after (`resolvePostFitViewport`):

- pinned to bottom (`isViewportAtBottom`, 1-row tolerance) → `scrollToBottom()`
  — a resize never strands a following terminal mid-scrollback
- reading scrollback → keep `viewportY`, clamped to the post-reflow `baseY`
- alternate screen (TUIs) → no scroll enforcement; the app owns its viewport

## PTY resize dedupe + drag hold

`syncPtySize` only reaches the backend when the target differs from the
in-flight/applied size (`shouldSendResize`), so no-op fits never emit
SIGWINCH. The no-change branch of the layout sync still calls `syncPtySize`
to re-converge after a `setPtyId` swap resets the tracked sizes.

During a sash drag, PTY resizes are held entirely (`holdPanePtyResizes` +
`usePtyResizeHold`, wired through `ResizablePanelGroup.onDragStateChange` in
`SplitContainer`, `Layout`, and `AppTabContent`): the shell/TUI receives
exactly one resize when the drag ends. Without the hold, mid-drag
stability-cap fits stream SIGWINCH into TUIs (Claude Code, Codex), which
redraw-thrash and visibly tremble vertically.

The hold also defers **cols-changing fits** to the release (`pendingHeldFit`):
a cols change re-wraps the entire scrollback, which reads as left-right
trembling when applied mid-drag. Rows-only fits stay live during the drag
because they never reflow text horizontally. So mid-drag the canvas tracks
height changes, holds its width (letterbox/clip masked by the theme-colored
pane), and snaps once — fit + single SIGWINCH — on release. Window-edge
resizes are not held — they flow through the stability loop like orca's,
which is the accepted behavior.

## CSS flicker masks

- `.terminal-pane` gets `backgroundColor: theme.background` inline
  (`TerminalInstance.tsx`), so the sub-cell letterbox between the xterm canvas
  and the padded container is invisible, including during the stability-loop
  lag.
- `.terminal-instance .xterm .xterm-viewport` overrides xterm.css's opaque
  `#000` viewport to `transparent` (`App.css`) — during resize the viewport
  div tracks the container a frame ahead of the canvas repaint, and the strip
  it exposes must show the theme background, not black.

## Applied-size verification (what tmux actually applied)

`shouldSendResize` dedupes against what grove **sent**. But a resize can be
dropped or **clamped** by tmux — the window-size policy, or a second attached
client (the broadcast Mirror) coercing the pane to a smaller grid. Two
mechanisms in `src/lib/terminal-pty-reassert.ts` close the loop on what tmux
**applied** (read back via the `applied_pty_size` command):

- **Reassertion** (`createPtySizeReassertion`) — after a fit settles (in
  `scheduleLayoutSync`'s fit branch) and on reveal (its no-fit reveal branch),
  read the applied grid and re-forward the fitted grid **only on true drift**.
  It forwards through `forwardReconcileResize` (authoritative — bypasses
  `shouldSendResize`, since drift is already confirmed) and is suppressed while
  a drag hold is active.
- **Post-spawn reconcile** (`reconcilePtySizeAcrossFrames`) — grove spawns every
  PTY at 80x24. A pane mounting hidden/unsettled can strand there, so after the
  runtime learns a fresh ptyId + attaches, a bounded cross-frame loop fits and
  forwards the real grid, verifies via `applied_pty_size`, then hands off to the
  live ResizeObserver/layout-sync path once visible + stable (or after 180
  frames). It **pauses** (skips, does not cancel) while a hold is active so it
  never fights the hold or the fit-stability loop, and runs once per ptyId. grove
  deliberately omits orca's 0x0 white-screen fallback (80x24 is already usable).

**Non-convergence guard** (`decideDriftReassert`): if tmux returns the SAME
clamped size twice in a row for the same request, the clamp is **adopted as
authoritative and the loop STOPS** — no re-fit oscillation, no flicker loop.
Exactly one corrective resize is emitted per target; a persistent clamp
(window-size policy, or the Mirror's second client) is accepted rather than
fought. xterm's grid is never resized to the clamp (that would just re-propose
the container grid and oscillate).

## Regression checklist

Automated: `pnpm test` covers `nextFitStability` (hold/confirm/restart/cap),
`resolvePostFitViewport` (bottom-pin, reading position, clamp), `shouldSendResize`
dedupe, and (`terminal-pty-reassert.test.ts`) the reassertion drift/adopt guard
and the post-spawn reconcile (spawn-hidden reveal, persistent-clamp bounded stop,
hold-pause). Run `pnpm lint && pnpm test` plus `tsc -b` before touching this path.

Manual sweep after changing anything in the pipeline (use a worktree with a
split layout, one pane running `claude` or another TUI, one plain shell with
long scrollback):

1. Drag the split sash continuously — content must not blink or tremble in
   either axis; text never re-wraps mid-drag (cols deferred), a TUI pane
   redraws exactly once when the sash is released (no mid-drag SIGWINCH),
   and the grid snaps right after the sash settles.
2. Resize the window edge quickly — same expectation.
3. Scroll a shell pane to the bottom, resize — it stays pinned to the bottom.
4. Scroll up into scrollback, resize — the reading position holds (clamped
   when width growth shrinks the scroll range).
5. TUI pane (alternate screen) during drag — no viewport jumping; the TUI
   redraws once after the sash settles.
6. Switch worktrees / global-terminal tabs during and after a resize — the
   revealed pane paints its current buffer, not blank/stale frames
   (`refreshAfterReveal` still runs on the no-fit path).
7. Flip a split orientation (Allotment remount) — panes reattach at the right
   size.
8. Change the terminal theme — colors apply without a stuck letterbox tint.
9. Open a new worktree whose layout mounts with a split/side panel already on,
   so a pane spawns hidden/wide — the TUI must end up sized to the settled pane
   grid, not stranded at the 80x24 spawn or the wide mount width.
10. Mirror a pane (broadcast), which attaches a second tmux client that resizes
    the session — the source pane must not enter a re-fit oscillation/flicker
    loop; a persistent Mirror-induced clamp is adopted and settles (see
    `docs/terminal-broadcast.md`).
