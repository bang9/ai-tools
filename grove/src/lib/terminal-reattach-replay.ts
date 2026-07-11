import { deriveKittyReArmBytes } from "./terminal-kitty-replay";
import type { TerminalInitialContentSource } from "./terminal-runtime";

// Full-screen clear + scrollback clear + home. Written before a daemon-snapshot
// payload so a stale pre-disconnect screen already in xterm cannot double up
// with the replayed one.
export const REATTACH_CLEAR = "\x1b[2J\x1b[3J\x1b[H";

// Renderer-owned state cleanup written AFTER a daemon-snapshot payload. A live
// reattach keeps the session running, so this deliberately avoids the broader
// mode reset and only drops state that must not leak from replay bytes into the
// restored renderer terminal:
//   0 q                 — DECSCUSR cursor style/blink reset
//   <99u =0u            — kitty keyboard flags (pop the stack, then set 0)
//   ?25h                — DECTCEM cursor visibility (payload may end hidden)
//   ?9/1000/1002/1003l  — mouse reporting protocols
//   ?1006/1016l         — SGR mouse encodings
//   ?1004l              — focus event reporting
export const POST_REPLAY_REATTACH_RESET =
  "\x1b[0 q\x1b[<99u\x1b[=0u\x1b[?25h\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?1004l";

// Focus-in report sent to the PTY (not xterm) after a focused reattach so a
// live agent that parks its cursor off the input caret moves it back.
export const TERMINAL_FOCUS_IN = "\x1b[I";

/**
 * Whether the replay payload leaves focus-event reporting (DECSET ?1004) armed:
 * true iff its last `?1004h` is not followed by a `?1004l`. Gates the focus-in
 * so a bare shell never receives a stray `\x1b[I`.
 */
export function payloadHasFocusReporting(payload: string): boolean {
  const enable = payload.lastIndexOf("\x1b[?1004h");
  if (enable === -1) {
    return false;
  }
  return enable > payload.lastIndexOf("\x1b[?1004l");
}

// An ordered replay step. `xtermResize` retimes xterm's grid only (the PTY
// forward is suppressed); `termWrite` bytes go to xterm; `focusIn` and
// `ackColdRestore` fire once the last write is parsed. `focusIn` targets the
// PTY transport, `ackColdRestore` the daemon.
export type HydrationReplayStep =
  | { readonly kind: "xtermResize"; readonly cols: number; readonly rows: number }
  | { readonly kind: "termWrite"; readonly data: string }
  | { readonly kind: "focusIn" }
  | { readonly kind: "ackColdRestore" };

export interface HydrationReplayInput {
  source: TerminalInitialContentSource | undefined;
  payload: string;
  currentCols: number;
  currentRows: number;
  snapshotCols?: number;
  snapshotRows?: number;
  pendingEscapeTailAnsi?: string;
  kittyKeyboardFlags?: number;
  isColdRestore?: boolean;
  focused: boolean;
}

function isFinitePositive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Build the ordered replay for a runtime's initial hydration.
 *
 * For every non-`daemonSnapshot` source (tmux capture, snapshot fallback, or
 * none) this is intentionally the pre-daemon behavior: a single scrollback
 * write, or nothing when the payload is empty — NO clear, reset bundle, resize,
 * kitty re-arm, or focus-in. That byte-identity is the P6 merge gate.
 *
 * For `daemonSnapshot` it ports orca's reattach replay order (pty-connection.ts
 * ~6540): xterm-only resize to the snapshot's dims (rewrap bug #7279) → clear →
 * payload → reset bundle → kitty re-arm (grove-specific, see terminal-kitty-
 * replay.ts) → pending escape tail LAST (completes a dangling ESC, #7329) →
 * focus-in → cold-restore ack.
 */
export function planHydrationReplay(input: HydrationReplayInput): HydrationReplayStep[] {
  if (input.source !== "daemonSnapshot") {
    return input.payload.length > 0 ? [{ kind: "termWrite", data: input.payload }] : [];
  }

  const steps: HydrationReplayStep[] = [];

  // (1) Replay at the snapshot's own grid so soft-wrapped rows do not rewrap a
  // cell early/late; the PTY forward is suppressed by the runtime so this
  // layout-only resize never SIGWINCHes the live session.
  if (
    isFinitePositive(input.snapshotCols) &&
    isFinitePositive(input.snapshotRows) &&
    (input.snapshotCols !== input.currentCols || input.snapshotRows !== input.currentRows)
  ) {
    steps.push({ kind: "xtermResize", cols: input.snapshotCols, rows: input.snapshotRows });
  }

  // (2) clear.
  steps.push({ kind: "termWrite", data: REATTACH_CLEAR });

  // (4) payload (empty writes are skipped).
  if (input.payload.length > 0) {
    steps.push({ kind: "termWrite", data: input.payload });
  }

  // (5) renderer-state reset bundle.
  steps.push({ kind: "termWrite", data: POST_REPLAY_REATTACH_RESET });

  // (3→post-reset) kitty re-arm: the reset just zeroed kitty, so re-arm the
  // live session's authoritative flags here — after the reset — so they survive.
  const kittyReArm = deriveKittyReArmBytes(input.payload, input.kittyKeyboardFlags);
  if (kittyReArm.length > 0) {
    steps.push({ kind: "termWrite", data: kittyReArm });
  }

  // (6) pending escape tail LAST among term writes.
  if (input.pendingEscapeTailAnsi && input.pendingEscapeTailAnsi.length > 0) {
    steps.push({ kind: "termWrite", data: input.pendingEscapeTailAnsi });
  }

  // (7) focus-in only when focused and the payload left ?1004 armed.
  if (input.focused && payloadHasFocusReporting(input.payload)) {
    steps.push({ kind: "focusIn" });
  }

  // (8) ack a cold-restore payload so the daemon stops redelivering it.
  if (input.isColdRestore) {
    steps.push({ kind: "ackColdRestore" });
  }

  return steps;
}
