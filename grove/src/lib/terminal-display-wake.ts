import { platform } from "./platform";
import { recordWebglBreadcrumb } from "./terminal-webgl-lifecycle";

// Emitted once by the shell (Electron powerMonitor 'resume' / Tauri NSWorkspace
// didWake) on real display sleep/wake or OS resume — never on window focus or
// visibilitychange, which fire far more often and must not wipe the glyph atlas.
export const DISPLAY_WAKE_EVENT = "grove:display-wake";
export const DISPLAY_WAKE_DEBOUNCE_MS = 300;

export interface TerminalWakeTarget {
  isVisible(): boolean;
  resetWebglLatch(): void;
  clearGlyphAtlas(): void;
  refreshViewport(): void;
}

/**
 * Pure per-pane wake recovery (no DOM/GPU) so the "reset the DOM latch on every
 * pane, but only rebuild the atlas + repaint a visible pane" contract stays
 * unit-testable. A hidden pane's latch reset lets it retry WebGL on its next
 * reveal; a visible pane also repaints now because a wake can leave the live
 * atlas stale/corrupt and the buffer would otherwise show garbled glyphs until
 * the next output frame.
 */
export function recoverTerminalForWake(target: TerminalWakeTarget): void {
  target.resetWebglLatch();
  if (!target.isVisible()) {
    return;
  }
  target.clearGlyphAtlas();
  target.refreshViewport();
}

export interface DisplayWakeDebounceOptions {
  now?: () => number;
  debounceMs?: number;
}

/**
 * Leading-edge debounce: a wake is a single instant, but 'resume' can fire more
 * than once (or alongside a relay), so collapse a burst into one recovery pass.
 */
export function createDisplayWakeDebouncer(
  recover: () => void,
  options: DisplayWakeDebounceOptions = {},
): () => void {
  const now = options.now ?? (() => performance.now());
  const debounceMs = options.debounceMs ?? DISPLAY_WAKE_DEBOUNCE_MS;
  let lastRunAt: number | null = null;
  return () => {
    const at = now();
    if (lastRunAt !== null && at - lastRunAt < debounceMs) {
      return;
    }
    lastRunAt = at;
    recover();
  };
}

/**
 * The single platform-agnostic subscription to the shell's display-wake signal.
 * `recover` is injected (wired to the terminal runtime by the caller) so this
 * module carries no dependency back into terminal-runtime. Returns an unlisten
 * function.
 */
export async function initDisplayWakeRecovery(
  recover: () => void,
  options: DisplayWakeDebounceOptions = {},
): Promise<(() => void) | undefined> {
  const handleWake = createDisplayWakeDebouncer(recover, options);
  return platform.listen(DISPLAY_WAKE_EVENT, () => {
    recordWebglBreadcrumb("display-wake");
    handleWake();
  });
}
