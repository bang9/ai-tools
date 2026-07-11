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

- pinned to bottom (`viewportY >= baseY`) → `scrollToBottom()` — a resize never
  strands a following terminal mid-scrollback
- reading scrollback → keep `viewportY`, clamped to the post-reflow `baseY`
- alternate screen (TUIs) → no scroll enforcement; the app owns its viewport

## PTY resize dedupe

`syncPtySize` only reaches the backend when the target differs from the
in-flight/applied size (`shouldSendResize`), so no-op fits never emit
SIGWINCH. The no-change branch of the layout sync still calls `syncPtySize`
to re-converge after a `setPtyId` swap resets the tracked sizes.

## CSS flicker masks

- `.terminal-pane` gets `backgroundColor: theme.background` inline
  (`TerminalInstance.tsx`), so the sub-cell letterbox between the xterm canvas
  and the padded container is invisible, including during the stability-loop
  lag.
- `.terminal-instance .xterm .xterm-viewport` overrides xterm.css's opaque
  `#000` viewport to `transparent` (`App.css`) — during resize the viewport
  div tracks the container a frame ahead of the canvas repaint, and the strip
  it exposes must show the theme background, not black.

## Regression checklist

Automated: `pnpm test` covers `nextFitStability` (hold/confirm/restart/cap),
`resolvePostFitViewport` (bottom-pin, reading position, clamp), and
`shouldSendResize` dedupe. Run `pnpm lint && pnpm test` plus `tsc -b` before
touching this path.

Manual sweep after changing anything in the pipeline (use a worktree with a
split layout, one pane running `claude` or another TUI, one plain shell with
long scrollback):

1. Drag the split sash continuously — content must not blink; grid snaps to
   the new size right after the sash settles, and mid-drag every ~8 frames.
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
