// Trailing-edge quiet-wait debounce for WebGL glyph-atlas recovery on the
// output path.
//
// A CJK/emoji-heavy TUI stream (e.g. Claude Code) produces many risk chunks in
// quick succession. Rebuilding the atlas per chunk — or even at a fixed rate
// mid-stream — repaints the viewport and reads as flicker (STA-1365). So every
// request() clears and re-arms the timer (matching orca's
// scheduleTerminalWebglAtlasRecovery): a continuous stream keeps pushing the
// deadline out, and recovery fires exactly once, `quietMs` after output goes
// quiet — never once-per-window mid-stream. The timer is injectable so the
// debounce logic is unit-testable without wall-clock waits.

export const ATLAS_RECOVERY_QUIET_MS = 1_000;

export interface AtlasRecoveryTimer {
  set(delayMs: number, cb: () => void): number;
  clear(handle: number): void;
}

const DEFAULT_TIMER: AtlasRecoveryTimer = {
  set: (delayMs, cb) => setTimeout(cb, delayMs) as unknown as number,
  clear: (handle) => clearTimeout(handle),
};

export interface AtlasRecoveryDebounceOptions {
  quietMs?: number;
  run: () => void;
  timer?: AtlasRecoveryTimer;
}

/**
 * Trailing-edge quiet-wait debounce: every {@link request} clears any pending
 * timer and re-arms a fresh one for `quietMs`. `run` fires once — after the
 * stream has stayed quiet for the full window — then the debounce returns to
 * idle so a later burst re-arms. A continuous risk stream therefore recovers
 * exactly once on settle, never per-window mid-stream.
 */
export class AtlasRecoveryDebounce {
  private readonly quietMs: number;
  private readonly run: () => void;
  private readonly timer: AtlasRecoveryTimer;
  private handle: number | null = null;

  constructor(options: AtlasRecoveryDebounceOptions) {
    this.quietMs = options.quietMs ?? ATLAS_RECOVERY_QUIET_MS;
    this.run = options.run;
    this.timer = options.timer ?? DEFAULT_TIMER;
  }

  request(): void {
    // Re-arm: a fresh chunk pushes the recovery deadline out so the atlas clear
    // never lands mid-stream. A pause-then-resume can't leak a stale timer.
    if (this.handle !== null) {
      this.timer.clear(this.handle);
    }
    this.handle = this.timer.set(this.quietMs, () => {
      this.handle = null;
      this.run();
    });
  }

  isPending(): boolean {
    return this.handle !== null;
  }

  cancel(): void {
    if (this.handle !== null) {
      this.timer.clear(this.handle);
      this.handle = null;
    }
  }
}

/**
 * Whether a raw output chunk contains any non-ASCII byte. A UTF-8 lead/trail
 * byte for every renderer-risk glyph is >= 0x80, so a chunk with none is pure
 * ASCII and can never carry a wide/complex glyph — skip the string decode and
 * detector entirely on the hot path.
 */
export function bytesContainNonAscii(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] > 0x7f) {
      return true;
    }
  }
  return false;
}
