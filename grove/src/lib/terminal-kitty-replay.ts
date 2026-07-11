// Minimal, pure derivation of the kitty keyboard protocol flags implied by a
// daemon-snapshot reattach payload, plus the bytes needed to re-arm xterm to
// that state after the POST_REPLAY_REATTACH_RESET bundle has zeroed it.
//
// Why grove diverges from orca here: orca keeps a persistent per-pane
// TerminalKittyKeyboardModeTracker mirror and, on reattach, only *updates the
// mirror* (scanReplay) while leaving xterm's kitty flags cleared by the reset
// bundle. grove's daemon snapshot instead carries the live session's
// authoritative flags beside the payload (snapshotKittyKeyboardFlags). With no
// mirror to fall back on, grove re-arms xterm directly from that authoritative
// value AFTER the reset so a live agent (e.g. Codex) keeps its kitty-encoded
// Option chords across a window reload — without reintroducing the stale-CSI-u
// bug the reset guards against, because the value is the daemon's current
// negotiated state, not an untrusted replayed push.

// Mirrors xterm's InputHandler stack cap so a runaway payload cannot grow the
// scanned stack unboundedly.
const KITTY_STACK_LIMIT = 16;

/**
 * Derive the effective kitty keyboard flags implied by replaying `payload`,
 * starting from an inactive (0) protocol state. Replay semantics (matching
 * orca's TerminalKittyKeyboardModeTracker.scanReplay): a `CSI > N u` push
 * applies as an idempotent SET rather than a stack push, because a retained
 * window can redeliver the application's one-time push and stacking it would
 * leave the eventual single pop on a stale frame. Pops (`CSI < N u`), the
 * set/or/and forms (`CSI = flags ; mode u`), the 47/1047/1049 screen-flag swap,
 * RIS (`ESC c`), and DECSTR (`CSI ! p`) are all honored so the derived value
 * matches what the application actually negotiated.
 *
 * Pure: no terminal, no side effects — the whole payload is available at once,
 * so no cross-chunk tail buffering is needed.
 */
export function scanKittyReplayFlags(payload: string): number {
  let currentFlags = 0;
  let mainFlags = 0;
  let altFlags = 0;
  const mainStack: number[] = [];
  const altStack: number[] = [];
  let alternateScreenActive = false;

  // oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
  const kittyModeRe = /\x1bc|(?:\x1b\[|\x9b)(?:!p|\?([0-9;]+)([hl])|([<>=])([0-9;]*)u)/g;
  let match: RegExpExecArray | null;
  while ((match = kittyModeRe.exec(payload)) !== null) {
    if (match[0] === "\x1bc") {
      // RIS resets kitty state and returns to the main screen.
      currentFlags = 0;
      mainFlags = 0;
      altFlags = 0;
      mainStack.length = 0;
      altStack.length = 0;
      alternateScreenActive = false;
      continue;
    }
    if (match[0].endsWith("!p")) {
      // DECSTR (soft reset) wipes kitty flags and stacks for both screens
      // without switching buffers.
      currentFlags = 0;
      mainFlags = 0;
      altFlags = 0;
      mainStack.length = 0;
      altStack.length = 0;
      continue;
    }
    if (match[1] !== undefined) {
      for (const rawParam of match[1].split(";")) {
        const param = Number(rawParam);
        if (param !== 47 && param !== 1047 && param !== 1049) {
          continue;
        }
        // xterm swaps the active flags with the inactive screen's slot on every
        // 47/1047/1049 transition, without an already-active guard.
        if (match[2] === "h") {
          mainFlags = currentFlags;
          currentFlags = altFlags;
          alternateScreenActive = true;
        } else {
          altFlags = currentFlags;
          currentFlags = mainFlags;
          alternateScreenActive = false;
        }
      }
      continue;
    }

    const prefix = match[3];
    const params = match[4] ?? "";
    const parsed = params.split(";").map((entry) => Number(entry));
    const stack = alternateScreenActive ? altStack : mainStack;
    if (prefix === ">") {
      // Replay semantics: apply the push as an idempotent set (do not stack).
      if (stack.length >= KITTY_STACK_LIMIT) {
        stack.shift();
      }
      currentFlags = parsed[0] || 0;
      continue;
    }
    if (prefix === "<") {
      const count = Math.max(1, parsed[0] || 1);
      for (let i = 0; i < count && stack.length > 0; i++) {
        currentFlags = stack.pop() as number;
      }
      if (stack.length === 0) {
        currentFlags = 0;
      }
      continue;
    }
    const flags = parsed[0] || 0;
    const mode = parsed.length > 1 && parsed[1] ? parsed[1] : 1;
    if (mode === 1) {
      currentFlags = flags;
    } else if (mode === 2) {
      currentFlags |= flags;
    } else if (mode === 3) {
      currentFlags &= ~flags;
    }
  }

  return currentFlags;
}

/**
 * Resolve the final kitty keyboard flags for a reattach: the daemon's
 * authoritative snapshot flags win when present (they are the live session's
 * current negotiated state), otherwise fall back to scanning the payload for a
 * push the daemon could not report (degraded emulator). A non-finite or
 * negative value is treated as absent.
 */
export function deriveKittyReplayFlags(
  payload: string,
  snapshotKittyKeyboardFlags?: number,
): number {
  if (
    typeof snapshotKittyKeyboardFlags === "number" &&
    Number.isFinite(snapshotKittyKeyboardFlags) &&
    snapshotKittyKeyboardFlags > 0
  ) {
    return Math.floor(snapshotKittyKeyboardFlags);
  }
  if (snapshotKittyKeyboardFlags === 0) {
    // The daemon explicitly reports kitty inactive — trust it over the payload.
    return 0;
  }
  return scanKittyReplayFlags(payload);
}

/**
 * The bytes to re-arm xterm's kitty keyboard protocol to the reattach's final
 * flags, or "" when the protocol should stay inactive (the reset bundle already
 * left it at 0). `CSI = flags u` sets all flags (mode 1).
 */
export function deriveKittyReArmBytes(
  payload: string,
  snapshotKittyKeyboardFlags?: number,
): string {
  const flags = deriveKittyReplayFlags(payload, snapshotKittyKeyboardFlags);
  return flags > 0 ? `\x1b[=${flags}u` : "";
}
