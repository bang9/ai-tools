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
  /** Clears the WebGL glyph atlas; returns false when the pane has no live WebGL renderer. */
  clearGlyphAtlas(): boolean;
  refreshViewport(): void;
}

/**
 * Pure multi-pane wake recovery (no DOM/GPU) so the wake contract stays
 * unit-testable. Every pane's DOM-latch resets (a hidden pane retries WebGL on
 * its next reveal). A wake can leave the live glyph atlas stale/corrupt, so it
 * is rebuilt — but the atlas is SHARED across every same-config terminal
 * (xterm's module-level CharAtlasCache), so it must be cleared exactly once
 * and then every visible pane repainted. The old per-pane clear+refresh loop
 * garbled the panes recovered earlier in the loop: each later clear
 * invalidated the glyph coordinates the previous pane had just repainted.
 */
export function recoverTerminalsForWake(targets: readonly TerminalWakeTarget[]): void {
  for (const target of targets) {
    target.resetWebglLatch();
  }
  let cleared = false;
  for (const target of targets) {
    if (cleared) {
      break;
    }
    if (target.isVisible()) {
      cleared = target.clearGlyphAtlas();
    }
  }
  for (const target of targets) {
    if (target.isVisible()) {
      target.refreshViewport();
    }
  }
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
