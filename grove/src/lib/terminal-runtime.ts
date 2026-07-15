import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import type { TerminalTheme } from "../types";
import { subscribeTerminalLayoutSync } from "./terminal-layout-sync";
import {
  ackColdRestore,
  appliedPtySize,
  clearPtyScrollback,
  platform,
  ptyOutputTransport,
  resizePty,
  writePty,
} from "./platform";
import {
  planHydrationReplay,
  TERMINAL_FOCUS_IN,
  type HydrationReplayStep,
} from "./terminal-reattach-replay";
import {
  createPtySizeReassertion,
  reconcilePtySizeAcrossFrames,
  type PtySizeReassertion,
  type PtySizeReconcileHandle,
} from "./terminal-pty-reassert";
import { useTerminalStore } from "../store/terminal";
import { isSafeExternalUrl, openUrl } from "./url-open";
import { PtyInputQueue } from "./terminal-input-queue";
import { runGuardedWriteCompletionStep } from "./terminal-write-callback-guard";
import {
  clearPtyOutputHandler,
  routePtyOutput,
  setPtyOutputHandler,
} from "./terminal-output-router";

import {
  getMacShortcutSequence,
  isMacClearTerminalShortcut,
  isTerminalCompositionEvent,
} from "./terminal-input";
import {
  captureTerminalTextSnapshot,
  recordWebglBreadcrumb,
  releaseXtermWebglContext,
  WebglRenderLatch,
} from "./terminal-webgl-lifecycle";
import { recoverTerminalsForWake, type TerminalWakeTarget } from "./terminal-display-wake";
import { nextFitStability, type FitStabilityState } from "./terminal-fit-stability";
import {
  installTerminalImeCompositionTracker,
  type TerminalImeCompositionTracker,
} from "./terminal-ime-composition";
import { installBracketedPasteSanitizer } from "./terminal-bracketed-paste";
import { parseOsc7Cwd } from "./terminal-osc7";
import { handleOsc52ClipboardRequest } from "./terminal-osc52-clipboard";
import {
  colorSchemeModeForBackground,
  csiParamsIncludeMode2031,
  decideColorSchemeThemePush,
  decideMode2031Csi,
  INITIAL_MODE_2031_STATE,
  type Mode2031SubscriptionState,
  type TerminalColorSchemeMode,
} from "./terminal-color-scheme";
import { log } from "./logger";

export type TerminalInitialContentSource = "snapshotFallback" | "tmuxCapture" | "daemonSnapshot";

export interface TerminalPaneSeed {
  initialScrollback?: string;
  initialScrollbackSource?: TerminalInitialContentSource;
  launchCwd?: string;
  ptyId?: string;
  // Daemon-snapshot reattach metadata (source === "daemonSnapshot"); ignored for
  // every other source. See terminal-reattach-replay.ts for how they order the
  // replay.
  snapshotCols?: number;
  snapshotRows?: number;
  isAlternateScreen?: boolean;
  pendingEscapeTailAnsi?: string;
  kittyKeyboardFlags?: number;
  isColdRestore?: boolean;
}

export interface TerminalRuntimeOptions {
  /**
   * Keep this pane on xterm's DOM renderer instead of loading the WebGL addon.
   * Used by the global terminal: its canvas lives inside a CSS-transformed
   * slide container, and WKWebView composites a WebGL canvas under a transform
   * unreliably (gradual glyph corruption while the pane just sits there).
   * Ignored when the pane's runtime already exists (options only apply at
   * construction).
   */
  disableWebgl?: boolean;
}

type FocusHandler = (ptyId: string) => void;
type ErrorHandler = (message: string | null) => void;
type BellHandler = (ptyId: string) => void;
type ActivitySource = "output" | "tmuxCapture";

export interface TerminalPaneActivity {
  paneId: string;
  ptyId: string;
  source: ActivitySource;
}

function toXtermTheme(theme: TerminalTheme | null): ITheme | undefined {
  if (!theme) {
    return undefined;
  }

  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    black: theme.black,
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.blue,
    magenta: theme.magenta,
    cyan: theme.cyan,
    white: theme.white,
    brightBlack: theme.brightBlack,
    brightRed: theme.brightRed,
    brightGreen: theme.brightGreen,
    brightYellow: theme.brightYellow,
    brightBlue: theme.brightBlue,
    brightMagenta: theme.brightMagenta,
    brightCyan: theme.brightCyan,
    brightWhite: theme.brightWhite,
  };
}

/**
 * Value equality over two composed xterm themes (grove's flat string color
 * slots). Used to gate the per-runtime `options.theme` write: xterm's
 * ThemeService rebuilds its palette on every `options.theme` assignment by
 * object identity, discarding OSC 4/10/11/12 colors a TUI set at runtime. A
 * fresh-but-identical theme (re-applied on every acquireTerminalRuntime) must
 * therefore skip the write so the live TUI palette — and xterm's own OSC
 * color-query replies that read it — stay intact.
 */
export function composedXtermThemesEqual(a: ITheme | undefined, b: ITheme | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key as keyof ITheme] !== b[key as keyof ITheme]) {
      return false;
    }
  }
  return true;
}

// Why a rejected promise on missing API: keeps the OSC 52 handler's error path
// (devtools log) uniform whether the clipboard is absent (insecure context) or
// the write is gesture-gated (WKWebView).
function writeHostClipboardText(text: string): Promise<void> {
  const writeText = navigator.clipboard?.writeText;
  if (!writeText) {
    return Promise.reject(new Error("clipboard unavailable"));
  }
  return writeText.call(navigator.clipboard, text);
}

const paneSeeds = new Map<string, TerminalPaneSeed>();
const runtimes = new Map<string, TerminalPaneRuntime>();
const activityListeners = new Set<(activity: TerminalPaneActivity) => void>();
// Bridge a genuinely slow mount without an unbounded loop: keep rescheduling the
// fit until the grid is measurable or this wall-clock deadline (from the first
// attempt) passes. The ResizeObserver/layout-sync bus catch any later change.
const LAYOUT_SYNC_RECONCILE_DEADLINE_MS = 1500;
// Minimum usable box + grid before committing a fit, so a mid-animation or
// barely-laid-out container never fits the PTY to a garbled sub-grid.
const MIN_FIT_WIDTH_PX = 48;
const MIN_FIT_HEIGHT_PX = 24;
const MIN_FIT_COLS = 8;
const MIN_FIT_ROWS = 4;
const RUNTIME_RELEASE_GRACE_MS = 50;
// Grace before suspending a hidden pane's WebGL context, so rapid worktree/tab
// switching does not thrash the heavyweight GPU context create/destroy path.
const RUNTIME_SUSPEND_GRACE_MS = 300;
let ptyOutputListenerStarted = false;

/**
 * A WebGL addon should be (re)loaded only when the pane allows the GPU
 * renderer, has none yet, and is currently visible. Keeping this a pure
 * predicate makes the "don't double-load on repeated reveals" contract
 * testable without a live GPU context.
 */
export function shouldLoadWebglAddon(
  hasLoadedWebgl: boolean,
  visible: boolean,
  webglDisabled = false,
): boolean {
  return !webglDisabled && !hasLoadedWebgl && visible;
}

/**
 * A hidden pane's WebGL context may be freed only when one is loaded and the
 * pane is not focused — the focused pane is never suspended.
 */
export function shouldSuspendWebglAddon(hasLoadedWebgl: boolean, focused: boolean): boolean {
  return hasLoadedWebgl && !focused;
}

interface ResizeTarget {
  cols: number;
  rows: number;
}

// The grid every grove PTY is spawned at (see useTerminal / useGlobalTerminal /
// terminal-{pane,tab}-commands). The post-spawn reconcile uses this as the
// baseline the PTY believes it is until the pane lays out and forwards its real
// grid.
const PTY_SPAWN_COLS = 80;
const PTY_SPAWN_ROWS = 24;

// nextFitStability moved to terminal-fit-stability.ts so the post-spawn
// reconcile can gate its per-frame proposals through the SAME pure gate as the
// live layout-sync path (without a terminal-runtime ↔ terminal-pty-reassert
// import cycle). Re-exported here (imported above) to keep existing
// importers/tests stable.
export { nextFitStability };
export type { FitStabilityState };

export interface PreFitViewport {
  wasAtBottom: boolean;
  viewportY: number;
}

// A viewport within one row of the bottom counts as bottom-pinned: fast output
// and reflow can leave viewportY a hair behind baseY on the very frame a fit
// samples it, and treating that as "reading scrollback" freezes the terminal
// one row short of following output.
export const BOTTOM_TOLERANCE_ROWS = 1;

export function isViewportAtBottom(viewportY: number, baseY: number): boolean {
  return viewportY >= baseY - BOTTOM_TOLERANCE_ROWS;
}

/**
 * Where the viewport should land after a fit-driven reflow. A bottom-pinned
 * terminal must stay pinned — xterm's reflow can otherwise strand it mid-
 * scrollback — while a user reading scrollback keeps their viewport line,
 * clamped to the new scroll range.
 */
export function resolvePostFitViewport(
  before: PreFitViewport,
  baseYAfter: number,
): number | "bottom" {
  if (before.wasAtBottom) {
    return "bottom";
  }
  return Math.min(before.viewportY, baseYAfter);
}

/**
 * Decide whether a resize should be sent to the PTY. Rapid identical fit
 * triggers collapse to a single resizePty call.
 *
 * Dedupe against where the PTY is actually heading: while a resize is in
 * flight the backend is converging to `inFlight`, not to the (stale, not-yet-
 * advanced) `applied` size, so compare against `inFlight`. Only when nothing is
 * in flight is `applied` the current size. This is why a revert back to
 * `applied` while a *different* resize is still in flight must still be sent —
 * otherwise the backend PTY lands on the in-flight size while xterm renders the
 * reverted size, corrupting line wrapping until an unrelated refit.
 */
export function shouldSendResize(
  target: ResizeTarget,
  applied: ResizeTarget,
  inFlight: ResizeTarget | null,
): boolean {
  if (inFlight) {
    return !(target.cols === inFlight.cols && target.rows === inFlight.rows);
  }
  return !(target.cols === applied.cols && target.rows === applied.rows);
}

// xterm's observable mouse-tracking state (Terminal.modes.mouseTrackingMode).
export type XtermMouseTrackingMode = "none" | "x10" | "vt200" | "drag" | "any";

// Disable every mouse-reporting tracking mode a prior pty may have left set:
// X10 (?9), VT200 (?1000), cell-motion/drag (?1002), any-motion (?1003). With
// tracking off no reports are emitted regardless of the (unobservable) SGR
// encoding modes (1006/1016), so those need no explicit reset. Alt-screen
// (1049) is deliberately excluded — the incoming pty's replay re-enters it.
const MOUSE_REPORTING_RESET = "\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l";

export interface PtySwapResetPlan {
  // Bytes destined for the RENDERER (xterm.write) only. This plan has no PTY
  // channel by construction, so a swap can never write to the shell's stdin.
  termWrite: string | null;
}

/**
 * Decide what stale renderer-side DECSET state to clear when a runtime's xterm
 * is pointed at a different pty without a re-hydration (e.g. a restore that
 * re-primes a grace-cached pane). Only mouse-reporting modes are reset, and
 * only when xterm currently has a tracking mode set, so this is inert for the
 * initial attach (no prior pty) and for every same-pty / mirror flow (which
 * never reach a swap). Never returns anything sent to the pty.
 */
export function planPtySwapReset(input: {
  previousPtyId: string;
  mouseTrackingMode: XtermMouseTrackingMode;
}): PtySwapResetPlan {
  // No prior pty (initial attach) inherits nothing stale.
  if (!input.previousPtyId) {
    return { termWrite: null };
  }
  if (input.mouseTrackingMode === "none") {
    return { termWrite: null };
  }
  return { termWrite: MOUSE_REPORTING_RESET };
}

/**
 * Hold PTY resize propagation for the given panes (every pane when omitted)
 * while a sash drag is in progress. xterm keeps refitting locally so the
 * canvas tracks the divider, but the PTY receives a single resize when the
 * hold is released — a mid-drag SIGWINCH stream makes TUIs redraw-thrash and
 * visibly tremble. Returns an idempotent release function that flushes the
 * final size.
 */
export function holdPanePtyResizes(paneIds?: string[]): () => void {
  const held: TerminalPaneRuntime[] = [];
  for (const runtime of runtimes.values()) {
    if (!paneIds || paneIds.includes(runtime.paneId)) {
      runtime.holdPtyResize();
      held.push(runtime);
    }
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    for (const runtime of held) {
      runtime.releasePtyResize();
    }
  };
}

function emitTerminalPaneActivity(activity: TerminalPaneActivity) {
  for (const listener of activityListeners) {
    listener(activity);
  }
}

export function subscribeTerminalPaneActivity(listener: (activity: TerminalPaneActivity) => void) {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

export function primeTerminalPane(paneId: string, seed: TerminalPaneSeed) {
  const runtime = runtimes.get(paneId);
  if (runtime) {
    runtime.applySeed(seed);
    return;
  }

  const existing = paneSeeds.get(paneId);
  // The daemon-snapshot metadata describes the scrollback it shipped with, so it
  // tracks whichever seed actually supplies initialScrollback (mirrors the
  // initialScrollbackSource rule below).
  const providesScrollback = seed.initialScrollback !== undefined;
  paneSeeds.set(paneId, {
    ...existing,
    ...seed,
    initialScrollback: seed.initialScrollback ?? existing?.initialScrollback,
    initialScrollbackSource: providesScrollback
      ? seed.initialScrollbackSource
      : existing?.initialScrollbackSource,
    snapshotCols: providesScrollback ? seed.snapshotCols : existing?.snapshotCols,
    snapshotRows: providesScrollback ? seed.snapshotRows : existing?.snapshotRows,
    isAlternateScreen: providesScrollback ? seed.isAlternateScreen : existing?.isAlternateScreen,
    pendingEscapeTailAnsi: providesScrollback
      ? seed.pendingEscapeTailAnsi
      : existing?.pendingEscapeTailAnsi,
    kittyKeyboardFlags: providesScrollback ? seed.kittyKeyboardFlags : existing?.kittyKeyboardFlags,
    isColdRestore: providesScrollback ? seed.isColdRestore : existing?.isColdRestore,
  });
}

export function acquireTerminalRuntime(
  paneId: string,
  theme: TerminalTheme | null,
  options?: TerminalRuntimeOptions,
) {
  ensurePtyOutputListener();
  let runtime = runtimes.get(paneId);
  if (!runtime) {
    runtime = new TerminalPaneRuntime(paneId, paneSeeds.get(paneId), theme, options);
    paneSeeds.delete(paneId);
    runtimes.set(paneId, runtime);
  }

  runtime.retain();
  runtime.setTheme(theme);
  return runtime;
}

export function getRuntime(paneId: string) {
  return runtimes.get(paneId) ?? null;
}

/**
 * Display-wake GPU recovery: after real display sleep/wake the WebGL glyph atlas
 * can be stale/corrupt and a DOM-latched pane may be recoverable. Every
 * runtime's DOM-latch clears (so hidden panes retry WebGL on reveal); the
 * SHARED glyph atlas is rebuilt exactly once and then every visible pane
 * repaints (see recoverTerminalsForWake for why per-pane clears garble the
 * other panes). The shell's display-wake subscription invokes this (debounced)
 * so it runs once per wake.
 */
export function recoverTerminalsForDisplayWake() {
  const targets: TerminalWakeTarget[] = [];
  for (const runtime of runtimes.values()) {
    const target = runtime.wakeTarget();
    if (target) {
      targets.push(target);
    }
  }
  recoverTerminalsForWake(targets);
}

export function captureRuntimeSnapshot(paneId: string): string | null {
  const runtime = runtimes.get(paneId);
  if (!runtime?.term.element) return null;
  const canvases = runtime.term.element.querySelectorAll("canvas");
  if (canvases.length === 0) {
    // DOM renderer (WebGL latched or never loaded): no canvas layers to
    // composite, so rasterize the visible buffer text into a frozen-frame PNG
    // so the snapshot contract still yields a usable <img src> value.
    return captureTerminalTextSnapshot(runtime.term);
  }
  try {
    const first = canvases[0] as HTMLCanvasElement;
    const composite = document.createElement("canvas");
    composite.width = first.width;
    composite.height = first.height;
    const ctx = composite.getContext("2d");
    if (!ctx) return null;
    // Composite all canvas layers (background + text + cursor)
    for (const canvas of canvases) {
      ctx.drawImage(canvas as HTMLCanvasElement, 0, 0);
    }
    return composite.toDataURL("image/png");
  } catch {
    return null;
  }
}

export function getRuntimeSize(paneId: string): { cols: number; rows: number } {
  const runtime = runtimes.get(paneId);
  if (!runtime) return { cols: 80, rows: 24 };
  return { cols: runtime.term.cols, rows: runtime.term.rows };
}

export function getTerminalPaneLaunchCwd(paneId: string): string | undefined {
  return runtimes.get(paneId)?.launchCwd ?? paneSeeds.get(paneId)?.launchCwd;
}

/**
 * The live cwd a pane's shell last reported via OSC 7, looked up by its ptyId.
 * A new split/pane inherits this so it opens in the source shell's current
 * directory (standard terminal behavior); the caller falls back to the
 * worktree path when no OSC 7 has been seen for that pty yet.
 */
export function getTerminalPaneOsc7Cwd(ptyId: string): string | undefined {
  if (!ptyId) {
    return undefined;
  }
  for (const runtime of runtimes.values()) {
    if (runtime.getPtyId() === ptyId) {
      return runtime.getLiveCwd() ?? undefined;
    }
  }
  return undefined;
}

export function shouldDetachTerminalContainer(
  currentContainer: HTMLDivElement | null,
  ownerContainer?: HTMLDivElement | null,
) {
  return ownerContainer === undefined || currentContainer === ownerContainer;
}

function ensurePtyOutputListener() {
  // Tauri routes PTY output through a per-PTY tauri::ipc::Channel established in
  // createPty (raw ArrayBuffer, no global event); only Electron uses the shared
  // global `pty-output` event, so the global listener is Electron-only.
  if (ptyOutputTransport !== "globalEvent" || ptyOutputListenerStarted) {
    return;
  }

  ptyOutputListenerStarted = true;
  void platform
    .listen<{ id: string; data: Uint8Array }>("pty-output", (payload) => {
      routePtyOutput(payload.id, payload.data);
    })
    .catch((error) => {
      ptyOutputListenerStarted = false;
      console.error("pty-output listen failed:", error);
    });
}

class TerminalPaneRuntime {
  readonly paneId: string;
  readonly term: Terminal;
  readonly fitAddon: FitAddon;
  readonly searchAddon: SearchAddon;
  launchCwd?: string;

  private ptyId = "";
  private container: HTMLDivElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private focusHandler: FocusHandler | null = null;
  private errorHandler: ErrorHandler | null = null;
  private bellHandler: BellHandler | null = null;
  private releaseTimer: number | null = null;
  private frameId: number | null = null;
  private refCount = 0;
  private hasLoadedWebgl = false;
  private webglAddon: WebglAddon | null = null;
  // Panes that opt out of the GPU renderer stay on xterm's DOM renderer for
  // their lifetime (e.g. the global terminal, whose WebGL canvas sits inside a
  // transformed slide container that WKWebView composites unreliably).
  private readonly webglDisabled: boolean;
  private readonly webglLatch = new WebglRenderLatch();
  // Off-screen panes suspend their WebGL context; term.write keeps flowing into
  // xterm's DOM renderer fallback so scrollback stays current while hidden.
  private visible = true;
  private suspendTimer: number | null = null;
  private pendingRevealRefresh = false;
  private appliedSize: ResizeTarget = { cols: 0, rows: 0 };
  private inFlightSize: ResizeTarget | null = null;
  private fitStability: FitStabilityState | null = null;
  // Verifies what tmux ACTUALLY applied after a fit/reveal and re-forwards on
  // true drift (with a non-convergence guard). Created lazily once attached.
  private ptyReassert: PtySizeReassertion | null = null;
  // Set when a reassert is requested while a PTY resize is still in flight: a
  // readback then races the resize (the applied grid may still be the pre-resize
  // one, misread as drift), so it is deferred and re-fired once the resize
  // resolves (sendPtyResize's finally).
  private pendingReassertAfterResize = false;
  // Bounded post-spawn cross-frame loop that corrects the 80x24 spawn grid once
  // a hidden/unsettled pane lays out. Tracks which ptyId it is reconciling so a
  // swap restarts it.
  private ptyReconcile: PtySizeReconcileHandle | null = null;
  private reconcilePtyId = "";
  private resizeHoldDepth = 0;
  private pendingHeldFit = false;
  private layoutSyncSuppressed = false;
  private initialScrollback = "";
  private initialScrollbackSource: TerminalInitialContentSource | undefined;
  // Daemon-snapshot reattach metadata; consumed once by startHydration and only
  // meaningful when initialScrollbackSource === "daemonSnapshot".
  private snapshotCols: number | undefined;
  private snapshotRows: number | undefined;
  private pendingEscapeTailAnsi: string | undefined;
  private kittyKeyboardFlags: number | undefined;
  private isColdRestore = false;
  // Set only around the synchronous xterm-only resize in the daemon-snapshot
  // replay so that resize does not forward a SIGWINCH to the live PTY (consulted
  // by sendPtyResize). See terminal-reattach-replay.ts step (1).
  private suppressSnapshotReplayPtyResize = false;
  private hydrationStarted = false;
  private hydrated = false;
  // True only while the restored-scrollback bytes are being parsed (see
  // startHydration); scopes the DECSET 2031 replay guard.
  private replayingScrollback = false;
  private pendingOutput: Uint8Array[] = [];
  private disposed = false;
  private lastError: string | null = null;
  // Why: the shell's last OSC 7-reported cwd. Cleared on a PTY swap so a
  // reused runtime never reports the previous shell's directory.
  private lastOsc7Cwd: string | null = null;
  // OSC 7/52 + DECSET 2031 parser handlers (xterm has no built-in for these); disposed on teardown.
  private readonly oscDisposables: { dispose(): void }[] = [];
  // DECSET 2031 color-scheme subscription state + the mode derived from the
  // current theme background. Kept per-runtime so a theme flip only notifies
  // TUIs that actually subscribed on this pane.
  private mode2031: Mode2031SubscriptionState = INITIAL_MODE_2031_STATE;
  private colorSchemeMode: TerminalColorSchemeMode = "dark";

  private onTrackpadMouseDown: (() => void) | null = null;
  private onTrackpadMouseUp: (() => void) | null = null;
  private onTrackpadMouseMoveCapture: ((event: MouseEvent) => void) | null = null;
  private onFocusIn: (() => void) | null = null;
  private removePasteSanitizer: (() => void) | null = null;
  private searchHandler: (() => void) | null = null;
  private ownerDocument: Document | null = null;
  private imeCompositionTracker: TerminalImeCompositionTracker | null = null;
  private readonly unlistenLayoutSync: () => void;
  private readonly dataDisposable: { dispose(): void };
  private readonly bellDisposable: { dispose(): void };
  // Stable identity so the output router can drop this runtime's route only
  // while it is still the owner (see clearPtyOutputHandler).
  private readonly boundHandlePtyOutput = (data: Uint8Array) => {
    this.handlePtyOutput(data);
  };
  // Coalesces interactive input, chunks large pastes, and paces the chunk stream
  // on write acceptance (writePty resolves after the bytes land). Reads ptyId
  // fresh per write so a mid-drain PTY swap targets the current backend.
  private readonly inputQueue = new PtyInputQueue({
    write: (data) => {
      if (this.disposed || !this.ptyId) {
        return;
      }
      return writePty(this.ptyId, data);
    },
    onWriteError: (error) => {
      console.error("writePty failed:", error);
    },
  });

  constructor(
    paneId: string,
    seed: TerminalPaneSeed | undefined,
    theme: TerminalTheme | null,
    options?: TerminalRuntimeOptions,
  ) {
    this.paneId = paneId;
    this.webglDisabled = options?.disableWebgl ?? false;
    this.ptyId = seed?.ptyId ?? "";
    this.launchCwd = seed?.launchCwd;
    this.initialScrollback = seed?.initialScrollback ?? "";
    this.initialScrollbackSource = seed?.initialScrollbackSource;
    this.snapshotCols = seed?.snapshotCols;
    this.snapshotRows = seed?.snapshotRows;
    this.pendingEscapeTailAnsi = seed?.pendingEscapeTailAnsi;
    this.kittyKeyboardFlags = seed?.kittyKeyboardFlags;
    this.isColdRestore = seed?.isColdRestore ?? false;
    this.hydrated = this.initialScrollback.length === 0;
    this.colorSchemeMode = colorSchemeModeForBackground(theme?.background);
    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: theme?.fontFamily ?? "Menlo, monospace",
      fontSize: theme?.fontSize ?? 13,
      theme: toXtermTheme(theme),
      allowProposedApi: true,
      macOptionClickForcesSelection: true,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);

    this.unlistenLayoutSync = subscribeTerminalLayoutSync((request) => {
      if (request.paneId) {
        // Requests aimed at a specific pane always refit that pane, even while
        // suppressed (e.g. a global terminal tab's on-activate refit).
        if (request.paneId !== this.paneId) {
          return;
        }
      } else if (request.paneIds) {
        if (!request.paneIds.includes(this.paneId)) {
          return;
        }
        if (this.layoutSyncSuppressed) {
          return;
        }
      } else if (this.layoutSyncSuppressed) {
        // Truly global broadcast, but this runtime is an offscreen/inactive
        // global terminal tab — skip the per-frame fit until it is shown.
        return;
      }

      this.scheduleLayoutSync();
    });

    const unicode11 = new Unicode11Addon();
    this.term.loadAddon(unicode11);
    this.term.unicode.activeVersion = "11";

    const webLinksAddon = new WebLinksAddon((_event, uri) => this.handleLinkActivate(uri));
    this.term.loadAddon(webLinksAddon);

    // Why: xterm parses OSC 8 hyperlinks natively but only makes them clickable
    // when a linkHandler is set. Route OSC 8 activation through the same gate as
    // regex-detected WebLinks so click UX (modifier semantics handled by xterm
    // core) and the isSafeExternalUrl / claude-skip policy are identical.
    this.term.options.linkHandler = {
      activate: (_event, text) => this.handleLinkActivate(text),
    };

    // OSC 7 (cwd tracking) + OSC 52 (clipboard write) — xterm implements neither.
    this.oscDisposables.push(
      this.term.parser.registerOscHandler(7, (data) => {
        const cwd = parseOsc7Cwd(data);
        if (cwd) {
          this.lastOsc7Cwd = cwd;
        }
        return true;
      }),
      this.term.parser.registerOscHandler(52, (data) =>
        handleOsc52ClipboardRequest(data, {
          writeClipboardText: (text) => writeHostClipboardText(text),
          // Why: OSC 52 arrives from PTY output, not a user gesture, so a
          // WKWebView (Tauri) clipboard write may reject the gesture gate.
          // Swallow to a devtools log rather than surfacing an error.
          onWriteError: (error) => log("terminal", "OSC 52 clipboard write failed:", error),
        }),
      ),
      // DECSET 2031 (color-scheme change notification) subscribe/unsubscribe.
      // Return false so xterm's own DEC private-mode handler still runs — we
      // only observe the 2031 bit to know which panes to notify on a theme flip.
      this.term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
        this.handleMode2031Csi(params, true);
        return false;
      }),
      this.term.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
        this.handleMode2031Csi(params, false);
        return false;
      }),
    );

    this.searchAddon = new SearchAddon();
    this.term.loadAddon(this.searchAddon);

    this.dataDisposable = this.term.onData((data) => {
      if (!this.ptyId) {
        return;
      }

      // While replaying restored scrollback, xterm answers any device queries
      // embedded in the replayed bytes (a reattached agent's startup OSC 10/11
      // colour probes, DSR/CPR, DA). Those answers are STALE DUPLICATES — the
      // live process already got them the first time — and `onData` cannot tell
      // them from a keystroke. Forwarding them injects `ESC]11;rgb:…`, `ESC[…R`,
      // `ESC[O` into the running program (it garbles the command line and can
      // interrupt a live agent), so drop everything xterm emits during the
      // replay window. Live output (pendingOutput, drained after the flag
      // clears) is NOT gated: a query there is from a live process and its
      // answer must reach the PTY.
      if (this.replayingScrollback) {
        return;
      }

      this.writeInput(new TextEncoder().encode(data));
    });

    this.term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (isTerminalCompositionEvent(event)) return true;

      if (event.metaKey && event.key === "f") {
        event.preventDefault();
        event.stopPropagation();
        this.searchHandler?.();
        return false;
      }

      if (isMacClearTerminalShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        const ptyId = this.ptyId;
        if (ptyId) {
          // Send Ctrl+L (form feed) so the shell redraws the prompt at the top,
          // then clear the scrollback buffer to mimic macOS Terminal Cmd+K.
          this.writeInput(new TextEncoder().encode("\x0c"));
          setTimeout(() => {
            this.term.clear();
            clearPtyScrollback(ptyId).catch(() => {});
          }, 50);
        }
        return false;
      }

      const sequence = getMacShortcutSequence(event);
      if (!sequence) {
        return true;
      }

      event.preventDefault();
      event.stopPropagation();

      if (!this.ptyId) {
        return false;
      }

      this.writeInput(new TextEncoder().encode(sequence));
      return false;
    });

    this.bellDisposable = this.term.onBell(() => {
      if (this.ptyId) {
        this.bellHandler?.(this.ptyId);
      }
    });

    // Closes the loop on what tmux APPLIED after a fit/reveal. grove PTYs are
    // always local (isRemotePtyId → false); a sash-drag hold suppresses it so it
    // never fights the hold. Requested with fit:false because the runtime has
    // already fitted by the time it reasserts.
    this.ptyReassert = createPtySizeReassertion({
      isDisposed: () => this.disposed,
      getPtyId: () => this.ptyId || null,
      isRemotePtyId: () => false,
      shouldSuppressDesktopResize: () => this.resizeHoldDepth > 0,
      fit: () => this.fitTerminal(),
      getTerminalDimensions: () => ({ cols: this.term.cols, rows: this.term.rows }),
      getAppliedSize: (ptyId) => appliedPtySize(ptyId),
      // Defense against the readback racing an in-flight PTY resize (the applied
      // grid may still be the pre-resize one). The runtime also gates this in
      // requestPtyReassert and re-fires on resolve.
      hasInFlightResize: () => this.inFlightSize !== null,
      forwardResize: (cols, rows) => this.forwardReconcileResize(cols, rows),
      onAdoptClamp: (cols, rows) =>
        log("terminal", "adopted pty size clamp", { paneId: this.paneId, cols, rows }),
    });

    this.syncPtyOutputRoute("", this.ptyId);
  }

  // Why: re-verify what tmux applied after a fit settles or on reveal. Guarded
  // internally (no-pty / remote / hold) and coalesced, so callers can fire it
  // freely. fit:false — the runtime already fitted before reasserting.
  private requestPtyReassert() {
    if (this.disposed || this.resizeHoldDepth > 0 || !this.ptyId) {
      return;
    }
    if (this.inFlightSize !== null) {
      // A PTY resize is still converging; a readback now can return the
      // pre-resize grid and be misread as drift. Latch and re-fire once the
      // resize resolves (sendPtyResize's finally).
      this.pendingReassertAfterResize = true;
      return;
    }
    this.ptyReassert?.request({ fit: false });
  }

  retain() {
    this.refCount += 1;
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
  }

  release() {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount > 0 || this.releaseTimer !== null) {
      return;
    }

    // Split collapse can unmount and remount the surviving pane in quick succession.
    // Keep the runtime alive briefly so xterm DOM can be reattached instead of torn down.
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = null;
      if (this.refCount === 0) {
        this.dispose();
      }
    }, RUNTIME_RELEASE_GRACE_MS);
  }

  applySeed(seed: TerminalPaneSeed) {
    if (seed.ptyId) {
      this.setPtyId(seed.ptyId);
    }
    this.launchCwd = seed.launchCwd ?? this.launchCwd;
    if (!this.hydrationStarted && seed.initialScrollback !== undefined) {
      this.initialScrollback = seed.initialScrollback;
      this.initialScrollbackSource = seed.initialScrollbackSource;
      this.snapshotCols = seed.snapshotCols;
      this.snapshotRows = seed.snapshotRows;
      this.pendingEscapeTailAnsi = seed.pendingEscapeTailAnsi;
      this.kittyKeyboardFlags = seed.kittyKeyboardFlags;
      this.isColdRestore = seed.isColdRestore ?? false;
      this.hydrated = this.initialScrollback.length === 0;
    }
  }

  // Audit — setPtyId swap paths (mouse/private-mode state on pty swap):
  //   • Same ptyId → early-return below (mirror + global-terminal-tab reuse
  //     always re-set the SAME source/tab pty, so those never swap live state).
  //   • Empty→pty (initial attach via constructor seed / first applySeed) →
  //     previousPtyId is "", so the reset planner is inert.
  //   • pty A→pty B on an already-hydrated runtime → the only such caller is
  //     primeTerminalPane→applySeed during layout restore that re-primes a
  //     still-cached (RUNTIME_RELEASE_GRACE_MS) pane. That path does NOT
  //     re-hydrate (hydrationStarted stays true, so startHydration no-ops), so
  //     the incoming pty's tmux capture is NOT replayed here and pty A's DECSET
  //     mouse-reporting modes stay live. Reset them in the renderer only.
  // The reset goes through this.term.write, NEVER writeInput/writePty — escape
  // bytes on the shell's stdin corrupt the prompt. Regression-pinned by the
  // planPtySwapReset tests (plan has no pty channel by construction).
  setPtyId(ptyId: string) {
    if (this.disposed || this.ptyId === ptyId) {
      return;
    }

    const previousPtyId = this.ptyId;
    this.ptyId = ptyId;
    // A swapped-in PTY starts at an unknown backend size, so clear the tracked
    // sizes; otherwise a fit that happens to match the previous PTY's applied
    // size would skip the new PTY's initial resize and leave it mis-sized.
    this.appliedSize = { cols: 0, rows: 0 };
    this.inFlightSize = null;
    // A different shell has its own cwd; drop the previous OSC 7 report.
    this.lastOsc7Cwd = null;
    // Clear stale mouse-reporting DECSET state, gated on xterm actually having a
    // tracking mode set, so a swapped-in shell never gets stray SGR mouse
    // reports before its own replay re-establishes the modes it wants.
    const resetPlan = planPtySwapReset({
      previousPtyId,
      mouseTrackingMode: this.term.modes.mouseTrackingMode,
    });
    if (resetPlan.termWrite) {
      this.term.write(resetPlan.termWrite);
    }
    this.syncPtyOutputRoute(previousPtyId, ptyId);
    // A swapped-in PTY spawned fresh at 80x24 — run the spawn correction for it.
    // No-ops until the runtime is attached (startPtySizeReconcile guards on it).
    this.startPtySizeReconcile();
  }

  getPtyId() {
    return this.ptyId;
  }

  // Why: authoritative "is an IME composition live?" for this pane's host,
  // for IME-sensitive paths that run outside a keydown. Observation only.
  isComposing(): boolean {
    return this.imeCompositionTracker?.isActive() ?? false;
  }

  // Why: the shell's last OSC 7-reported cwd, consumed by getTerminalPaneOsc7Cwd
  // so a new split inherits the source shell's current directory.
  getLiveCwd(): string | null {
    return this.lastOsc7Cwd;
  }

  // Shared activation gate for OSC 8 hyperlinks and regex-detected WebLinks so
  // both honor the same safe-URL check and Claude fullscreen skip.
  private handleLinkActivate(uri: string) {
    if (!isSafeExternalUrl(uri)) return;
    // Claude Code fullscreen handles link clicks via the open wrapper, so skip
    // to avoid duplicate opens.
    const session = useTerminalStore.getState().aiSessions[this.ptyId];
    if (session?.tool === "claude") return;
    openUrl(uri);
  }

  handlePtyOutput(data: Uint8Array) {
    if (this.disposed) {
      return;
    }

    // Bytes cross IPC pre-decoded (Electron: structured-clone Uint8Array;
    // Tauri: per-PTY channel ArrayBuffer), so write straight to xterm with no
    // base64/atob and no per-byte charCodeAt loop on the main thread.
    if (this.hydrated) {
      this.term.write(data);
    } else {
      this.pendingOutput.push(data);
    }
    this.reportActivity("output");
  }

  setTheme(theme: TerminalTheme | null) {
    // Why value-gated: acquireTerminalRuntime re-applies the same theme on every
    // retain, and each assignment makes xterm's ThemeService rebuild its palette
    // by identity, discarding OSC 4/10/11/12 colors a TUI set at runtime. Assign
    // only on a real value change so live TUI color mutations survive.
    const next = toXtermTheme(theme);
    if (!composedXtermThemesEqual(this.term.options.theme, next)) {
      this.term.options.theme = next;
    }
    if (theme) {
      this.term.options.fontFamily = theme.fontFamily;
      this.term.options.fontSize = theme.fontSize;
    }

    // DECSET 2031: after the value-gated theme write, notify a subscribed TUI
    // when the derived color-scheme mode actually changed so 2031-aware apps
    // (fish, neovim, Claude Code) repaint their palette. The mode-change check
    // (last pushed mode) is the near-threshold flapping guard. A null theme is
    // a transient reset, not a real background flip — never push on it (the
    // classifier would coerce it to dark and flip a light TUI spuriously).
    if (theme) {
      this.colorSchemeMode = colorSchemeModeForBackground(theme.background);
      const push = decideColorSchemeThemePush(this.mode2031, {
        hydrated: this.hydrated,
        hasPtyId: Boolean(this.ptyId),
        newMode: this.colorSchemeMode,
      });
      this.mode2031 = push.state;
      if (push.emit) {
        this.writeInput(new TextEncoder().encode(push.emit));
      }
    }

    this.scheduleLayoutSync();
  }

  setFocusHandler(handler: FocusHandler | null) {
    this.focusHandler = handler;
  }

  setErrorHandler(handler: ErrorHandler | null) {
    this.errorHandler = handler;
    this.errorHandler?.(this.lastError);
  }

  setBellHandler(handler: BellHandler | null) {
    this.bellHandler = handler;
  }

  setSearchHandler(handler: (() => void) | null) {
    this.searchHandler = handler;
  }

  /**
   * Gate this runtime against non-targeted (paneless/paneIds) layout-sync
   * broadcasts. Used for inactive global terminal tabs, which stay mounted and
   * full-size (translated offscreen) but must not run a per-frame fit while
   * hidden. Targeted paneId requests (attach/on-activate) still refit.
   */
  setLayoutSyncSuppressed(suppressed: boolean) {
    this.layoutSyncSuppressed = suppressed;
  }

  /**
   * Visibility is pushed explicitly by the owning component (worktree pane's
   * active state, global terminal tab's isActive) rather than inferred from
   * rects — translateX-hidden tabs still report non-zero dimensions. On hide we
   * free the GPU context after a grace; on reveal we reload it and force a
   * repaint so the first shown frame is not blank/stale.
   */
  setVisible(visible: boolean) {
    if (this.visible === visible) {
      return;
    }

    this.visible = visible;
    if (this.suspendTimer !== null) {
      window.clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }

    if (visible) {
      this.pendingRevealRefresh = true;
      // Reload via layout-sync, which already waits for real dimensions before
      // (re)adding the addon; the atlas rebuild + refresh runs after the fit.
      this.scheduleLayoutSync();
      return;
    }

    this.pendingRevealRefresh = false;
    this.suspendTimer = window.setTimeout(() => {
      this.suspendTimer = null;
      this.suspendWebgl();
    }, RUNTIME_SUSPEND_GRACE_MS);
  }

  private suspendWebgl() {
    const focused = useTerminalStore.getState().focusedPtyId === this.ptyId;
    if (this.disposed || !shouldSuspendWebglAddon(this.hasLoadedWebgl, focused)) {
      return;
    }

    // Release the GPU context explicitly so parking a hidden pane frees the
    // context deterministically instead of waiting on GC of the disposed addon.
    releaseXtermWebglContext(this.webglAddon);
    this.webglAddon?.dispose();
    this.webglAddon = null;
    this.hasLoadedWebgl = false;
  }

  findNext(term: string): boolean {
    return this.searchAddon.findNext(term);
  }

  findPrevious(term: string): boolean {
    return this.searchAddon.findPrevious(term);
  }

  clearSearch() {
    this.searchAddon.clearDecorations();
  }

  attach(container: HTMLDivElement) {
    if (this.disposed) {
      return;
    }

    if (this.container !== container) {
      this.detach();
      this.container = container;
      // A freshly attached container is assumed visible; an inactive global
      // terminal tab re-applies suppression after attach. This keeps a runtime
      // shared with a live worktree pane (mirror tabs) responsive.
      this.layoutSyncSuppressed = false;
      this.installContainerBindings(container);

      if (this.term.element && this.term.element.parentElement !== container) {
        container.appendChild(this.term.element);
      }

      // Now that a container exists, kick off the post-spawn reconcile for the
      // current PTY (setPtyId may have run before attach). Guarded once-per-pty.
      this.startPtySizeReconcile();
    }
  }

  detach(ownerContainer?: HTMLDivElement | null) {
    if (!shouldDetachTerminalContainer(this.container, ownerContainer) || !this.container) {
      return;
    }

    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    this.fitStability = null;
    // Stop the reconcile frames while detached, but keep reconcilePtyId so a
    // re-attach of the same (already sized) PTY does not restart the loop.
    this.ptyReconcile?.cancel();
    this.ptyReconcile = null;

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.onFocusIn) {
      this.container.removeEventListener("focusin", this.onFocusIn);
      this.onFocusIn = null;
    }

    if (this.removePasteSanitizer) {
      this.removePasteSanitizer();
      this.removePasteSanitizer = null;
    }

    if (this.onTrackpadMouseDown) {
      this.container.removeEventListener("mousedown", this.onTrackpadMouseDown, true);
      this.onTrackpadMouseDown = null;
    }

    if (this.ownerDocument && this.onTrackpadMouseUp) {
      this.ownerDocument.removeEventListener("mouseup", this.onTrackpadMouseUp, true);
      this.onTrackpadMouseUp = null;
    }

    if (this.ownerDocument && this.onTrackpadMouseMoveCapture) {
      this.ownerDocument.removeEventListener("mousemove", this.onTrackpadMouseMoveCapture, true);
      this.onTrackpadMouseMoveCapture = null;
    }

    this.ownerDocument = null;
    this.container = null;
  }

  focus() {
    this.term.focus();
  }

  private installContainerBindings(container: HTMLDivElement) {
    this.ownerDocument = container.ownerDocument;

    let awaitingPointerRelease = false;
    this.onTrackpadMouseDown = () => {
      awaitingPointerRelease = true;
    };
    this.onTrackpadMouseUp = () => {
      awaitingPointerRelease = false;
    };
    this.onTrackpadMouseMoveCapture = (event: MouseEvent) => {
      if (!awaitingPointerRelease || event.buttons !== 0) {
        return;
      }

      awaitingPointerRelease = false;
      event.stopImmediatePropagation();
      container.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 0,
          clientX: event.clientX,
          clientY: event.clientY,
        }),
      );
    };
    this.onFocusIn = () => {
      if (this.ptyId) {
        this.focusHandler?.(this.ptyId);
      }
    };

    container.addEventListener("mousedown", this.onTrackpadMouseDown, true);
    this.ownerDocument.addEventListener("mouseup", this.onTrackpadMouseUp, true);
    this.ownerDocument.addEventListener("mousemove", this.onTrackpadMouseMoveCapture, true);
    container.addEventListener("focusin", this.onFocusIn);

    // Why: capture-phase paste on the container (a strict ancestor of xterm's
    // textarea/screen paste targets) preempts xterm 6.0.0's own unsanitized
    // paste, which would let an embedded ESC[201~ in clipboard text close the
    // bracketed-paste frame early and execute the tail. All output flows through
    // the runtime's PtyInputQueue. An active IME composition defers to xterm —
    // a known residual window where xterm's unsanitized paste runs; accepted
    // because it requires the user to trigger paste mid-composition with a
    // malicious clipboard, and interleaving our injection with a pending jamo
    // commit would corrupt the composition.
    this.removePasteSanitizer = installBracketedPasteSanitizer({
      container,
      isBracketedPasteMode: () => this.term.modes.bracketedPasteMode,
      isComposing: () => this.isComposing(),
      sendInput: (text) => {
        this.writeInput(new TextEncoder().encode(text));
        // Why: xterm's own paste scrolls to the prompt via its user-input
        // trigger; the intercepted path must keep that viewport behavior.
        // The alternate buffer has no scrollback to jump.
        if (!this.term.buffer.active || this.term.buffer.active.type !== "alternate") {
          this.term.scrollToBottom();
        }
      },
    });

    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleLayoutSync();
    });
    this.resizeObserver.observe(container);
  }

  private scheduleLayoutSync(deadline?: number) {
    if (this.disposed || !this.container) {
      return;
    }

    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
    }

    this.frameId = requestAnimationFrame(() => {
      this.frameId = null;
      if (this.disposed || !this.container) {
        return;
      }

      this.ensureTerminalHost();
      const proposed = this.proposeFit();
      if (!proposed) {
        this.fitStability = null;
        const until = deadline ?? performance.now() + LAYOUT_SYNC_RECONCILE_DEADLINE_MS;
        if (performance.now() < until) {
          this.scheduleLayoutSync(until);
        }
        return;
      }

      if (proposed.cols === this.term.cols && proposed.rows === this.term.rows) {
        // Already at the proposed grid: skip fit() (renderer clear + reflow)
        // and only finish reveal/PTY reconciliation. A newly loaded WebGL
        // renderer can change cell metrics, so re-evaluate once after loading.
        this.fitStability = null;
        const loadedWebgl = this.loadWebglAddon();
        const wasReveal = this.pendingRevealRefresh;
        this.syncPtySize();
        this.refreshAfterReveal();
        // On reveal, verify tmux still matches xterm's grid (a hidden pane may
        // have been coerced by a second attached client while off screen).
        if (wasReveal) {
          this.requestPtyReassert();
        }
        if (loadedWebgl) {
          this.scheduleLayoutSync(deadline);
        }
        return;
      }

      if (this.resizeHoldDepth > 0 && proposed.cols !== this.term.cols) {
        // A cols change re-wraps the entire buffer, which reads as left-right
        // trembling when applied mid-drag. Defer it to the hold release;
        // rows-only changes stay live because they never reflow text.
        this.fitStability = null;
        this.pendingHeldFit = true;
        return;
      }

      const { state, shouldFit } = nextFitStability(this.fitStability, proposed);
      if (!shouldFit) {
        // Mid-drag: hold the reflow until the proposal stops moving.
        this.fitStability = state;
        this.scheduleLayoutSync(deadline);
        return;
      }

      this.fitStability = null;
      this.loadWebglAddon();
      this.fitTerminal();
      this.refreshAfterReveal();
      // A fit changed the grid and forwarded it; verify tmux actually applied
      // that grid and re-forward on true drift (bounded by the clamp guard).
      this.requestPtyReassert();
    });
  }

  private refreshAfterReveal() {
    if (!this.pendingRevealRefresh) {
      return;
    }

    this.pendingRevealRefresh = false;
    // Repaint so the newly revealed pane shows its current buffer instead of a
    // blank/stale first frame. NO clearTextureAtlas here: the glyph atlas is
    // shared across every same-config terminal (xterm's module-level
    // CharAtlasCache), so clearing it from one pane invalidates the glyph
    // coordinates every OTHER pane's renderer still holds — those panes render
    // scattered glyph fragments until they repaint. The atlas page canvases
    // live on the CPU and survive a suspended/recreated WebGL context, so a
    // refresh alone re-uploads correct textures; no clear is needed.
    this.term.refresh(0, Math.max(0, this.term.rows - 1));
  }

  private ensureTerminalHost() {
    if (!this.container) {
      return;
    }

    if (!this.term.element) {
      this.term.open(this.container);
      // Why: track live IME composition on the xterm host so IME-sensitive
      // paths (later: capture-phase paste sanitizer) can consult isComposing()
      // without corrupting an in-progress Hangul/CJK composition.
      this.imeCompositionTracker = installTerminalImeCompositionTracker(this.term.element);
      this.startHydration();
      return;
    }

    if (this.term.element.parentElement !== this.container) {
      this.container.appendChild(this.term.element);
    }
  }

  private proposeFit(): ResizeTarget | null {
    if (!this.container) {
      return null;
    }

    const { width, height } = this.container.getBoundingClientRect();
    if (width < MIN_FIT_WIDTH_PX || height < MIN_FIT_HEIGHT_PX) {
      return null;
    }

    try {
      const dims = this.fitAddon.proposeDimensions();
      if (
        !dims ||
        !dims.cols ||
        !dims.rows ||
        dims.cols < MIN_FIT_COLS ||
        dims.rows < MIN_FIT_ROWS
      ) {
        return null;
      }
      return { cols: dims.cols, rows: dims.rows };
    } catch {
      // proposeDimensions throws until the renderer is attached — defer.
      return null;
    }
  }

  private loadWebglAddon(): boolean {
    if (!shouldLoadWebglAddon(this.hasLoadedWebgl, this.visible, this.webglDisabled)) {
      return false;
    }

    // Skip construction while DOM-latched (persistent context loss) or during
    // the cool-down after a failed construction, so a broken GPU cannot
    // reconstruct a canvas + failed getContext on every reveal/resize tick.
    if (!this.webglLatch.canConstruct(performance.now())) {
      return false;
    }

    try {
      // preserveDrawingBuffer keeps the last frame readable for the broadcast
      // snapshot compositor (captureRuntimeSnapshot drawImage's the WebGL
      // canvas outside xterm's render callback).
      const webglAddon = new WebglAddon({ preserveDrawingBuffer: true });
      webglAddon.onContextLoss(() => {
        this.handleWebglContextLoss(webglAddon);
      });
      this.term.loadAddon(webglAddon);
      this.webglAddon = webglAddon;
      this.hasLoadedWebgl = true;
      this.webglLatch.recordConstructionSuccess();
      return true;
    } catch {
      // Canvas renderer fallback; start the cool-down before the next attempt.
      this.webglLatch.recordConstructionFailure(performance.now());
      recordWebglBreadcrumb("construct-failed", { paneId: this.paneId });
      return false;
    }
  }

  private handleWebglContextLoss(addon: WebglAddon) {
    // A stale addon's late loss event (fired after a newer addon replaced it)
    // must not mutate renderer state or feed the latch: dispose it and return.
    if (this.webglAddon !== addon) {
      try {
        addon.dispose();
      } catch {
        // A lost context can throw on dispose; nothing else to clean up.
      }
      return;
    }

    // Free the GPU context deterministically before dropping the lost addon.
    releaseXtermWebglContext(addon);
    try {
      addon.dispose();
    } catch {
      // A lost context can throw on dispose; the DOM renderer takes over regardless.
    }
    this.webglAddon = null;
    this.hasLoadedWebgl = false;

    const { latched } = this.webglLatch.recordContextLoss(performance.now());
    if (latched) {
      // A second loss within the window signals a persistent GPU failure: stay
      // on the DOM renderer for the session (no reschedule) and repaint so the
      // DOM-rendered buffer is current. A display-wake clears the latch.
      recordWebglBreadcrumb("latch-dom", { paneId: this.paneId });
      if (!this.disposed) {
        try {
          this.term.refresh(0, Math.max(0, this.term.rows - 1));
        } catch {
          // Ignore — the pane may have been disposed in the meantime.
        }
      }
      return;
    }

    // First transient loss: recover by rescheduling a load, which is gated
    // behind layout dimensions (and visibility), so it only re-adds once shown.
    recordWebglBreadcrumb("context-loss-recover", { paneId: this.paneId });
    this.scheduleLayoutSync();
  }

  /**
   * Display-wake boundary hook: clear the DOM latch and construction cool-down
   * so a pane parked on the DOM renderer after persistent context loss can
   * retry WebGL once the GPU context pool recovers. The Wake unit calls this.
   */
  resetWebglLatchForWake() {
    if (this.disposed) {
      return;
    }
    this.webglLatch.resetForWake();
    recordWebglBreadcrumb("wake-reset", { paneId: this.paneId });
    if (this.visible) {
      this.scheduleLayoutSync();
    }
  }

  /**
   * Wake-recovery adapter for the pure {@link recoverTerminalsForWake}. All
   * panes are recovered TOGETHER (see recoverTerminalsForDisplayWake): the
   * glyph atlas is shared across same-config terminals, so it must be cleared
   * once for the whole set and every visible pane repainted afterwards —
   * never cleared per pane.
   */
  wakeTarget(): TerminalWakeTarget | null {
    if (this.disposed) {
      return null;
    }
    return {
      isVisible: () => this.visible,
      resetWebglLatch: () => this.resetWebglLatchForWake(),
      clearGlyphAtlas: () => {
        if (!this.webglAddon) {
          return false;
        }
        this.webglAddon.clearTextureAtlas();
        return true;
      },
      refreshViewport: () => {
        try {
          this.term.refresh(0, Math.max(0, this.term.rows - 1));
        } catch {
          // Pane may be mid-teardown after wake; ignore.
        }
      },
    };
  }

  private fitTerminal() {
    if (this.applyFit()) {
      this.syncPtySize();
    }
  }

  // Fit xterm to its container with viewport preservation, WITHOUT forwarding to
  // the PTY. Split out so the post-spawn reconcile can fit-then-forward
  // authoritatively (bypassing shouldSendResize) while fitTerminal keeps the
  // deduped path. Returns whether a fit actually ran.
  private applyFit(): boolean {
    try {
      const buffer = this.term.buffer.active;
      const isAlternate = buffer.type === "alternate";
      const before: PreFitViewport = {
        wasAtBottom: isViewportAtBottom(buffer.viewportY, buffer.baseY),
        viewportY: buffer.viewportY,
      };
      this.fitAddon.fit();
      // Reflow moves buffer lines, so the pre-fit viewport now points at
      // different content; re-pin explicitly instead of trusting xterm's
      // implicit post-resize position. Alternate screens have no scrollback.
      if (!isAlternate) {
        const target = resolvePostFitViewport(before, this.term.buffer.active.baseY);
        if (target === "bottom") {
          this.term.scrollToBottom();
        } else {
          this.term.scrollToLine(target);
        }
      }
      return true;
    } catch {
      // ignore fit errors if the host is not ready yet
      return false;
    }
  }

  holdPtyResize() {
    this.resizeHoldDepth += 1;
  }

  releasePtyResize() {
    if (this.resizeHoldDepth === 0) {
      return;
    }

    this.resizeHoldDepth -= 1;
    if (this.resizeHoldDepth > 0 || this.disposed) {
      return;
    }

    if (this.pendingHeldFit) {
      // A cols change was deferred during the drag: run the full layout sync,
      // which fits once and forwards the final size to the PTY.
      this.pendingHeldFit = false;
      this.scheduleLayoutSync();
      return;
    }

    // Flush from the terminal's current grid: only the final size of the
    // drag matters, and shouldSendResize dedupes if it never changed.
    this.syncPtySize();
  }

  private syncPtySize() {
    if (this.resizeHoldDepth > 0) {
      return;
    }

    const { cols, rows } = this.term;
    if (!cols || !rows || !this.ptyId) {
      return;
    }

    const target: ResizeTarget = { cols, rows };
    if (!shouldSendResize(target, this.appliedSize, this.inFlightSize)) {
      return;
    }

    this.sendPtyResize(cols, rows);
  }

  // The raw resize send + applied/in-flight tracking, shared by the deduped
  // syncPtySize path and the authoritative reconcile/reassert path (which have
  // already confirmed drift, so they bypass shouldSendResize).
  private sendPtyResize(cols: number, rows: number) {
    // A daemon-snapshot replay retimes xterm to the snapshot's grid to avoid a
    // rewrap; that resize is layout-only and must NOT SIGWINCH the live PTY.
    if (this.suppressSnapshotReplayPtyResize) {
      return;
    }
    const ptyId = this.ptyId;
    if (!cols || !rows || !ptyId) {
      return;
    }

    const target: ResizeTarget = { cols, rows };
    this.inFlightSize = target;
    resizePty(ptyId, cols, rows)
      .then(() => {
        // Advance the applied size only once the PTY confirms the resize, and
        // only while this runtime still drives the same PTY — a setPtyId swap
        // clears the tracked sizes, so a late resolve for the old PTY must not
        // resurrect a stale applied size for the new one.
        if (this.ptyId === ptyId) {
          this.appliedSize = target;
        }
      })
      .catch(() => {
        // Leave appliedSize unchanged so the next fit re-sends this size.
      })
      .finally(() => {
        // Clear only if a newer resize hasn't superseded this one in flight.
        if (this.inFlightSize === target) {
          this.inFlightSize = null;
          // A reassert deferred during this resize can now read a settled grid.
          if (this.pendingReassertAfterResize && !this.disposed) {
            this.pendingReassertAfterResize = false;
            this.requestPtyReassert();
          }
        }
      });
  }

  // Authoritative correction from the reconcile/reassertion: drift is already
  // confirmed against tmux's applied grid, so bypass shouldSendResize. Still
  // respects the drag hold (both callers gate on it too).
  private forwardReconcileResize(cols: number, rows: number) {
    if (this.disposed || this.resizeHoldDepth > 0 || !this.ptyId) {
      return;
    }
    this.sendPtyResize(cols, rows);
  }

  // Return the currently PROPOSED grid without touching xterm — the reconcile
  // gates these per-frame proposals through nextFitStability and only commits
  // (fit + forward) once one holds, so an unsettled pane never reflows +
  // SIGWINCHes every frame during the spawn window. Null when not measurable or
  // a hold is active.
  private proposeFitForReconcile(): ResizeTarget | null {
    if (this.disposed || !this.container || this.resizeHoldDepth > 0) {
      return null;
    }
    return this.proposeFit();
  }

  // Commit a settled reconcile proposal: fit xterm to the container (the single
  // reflow, mirroring the live fit path) then forward authoritatively (drift is
  // already confirmed, so this bypasses shouldSendResize). Both callers gate on
  // the hold.
  private applyFitAndForwardReconcile(cols: number, rows: number) {
    if (this.disposed || this.resizeHoldDepth > 0 || !this.ptyId) {
      return;
    }
    if (cols !== this.term.cols || rows !== this.term.rows) {
      this.applyFit();
    }
    this.forwardReconcileResize(cols, rows);
  }

  // Start (or restart) the bounded post-spawn reconcile for the current PTY.
  // Corrects the 80x24 spawn grid once a pane that mounted hidden/unsettled lays
  // out, verifying via appliedPtySize before handing off to the live
  // ResizeObserver/layout-sync path. Runs once per ptyId; a swap restarts it.
  private startPtySizeReconcile() {
    if (this.disposed || !this.container || !this.ptyId) {
      return;
    }
    // Once per ptyId: a re-attach of the same PTY (already sized) leaves the
    // live ResizeObserver/reassert path in charge; only a genuinely new PTY
    // needs the spawn correction.
    if (this.reconcilePtyId === this.ptyId) {
      return;
    }
    this.ptyReconcile?.cancel();
    const ptyId = this.ptyId;
    this.reconcilePtyId = ptyId;
    // Seed lastSent from the size the PTY currently BELIEVES it is: the runtime's
    // already-applied grid when a prior fit forwarded a real size, else the 80x24
    // spawn. So an already-correctly-sized spawn re-measures the same grid and
    // forwards nothing (no redundant first resize). appliedSize is {0,0} for a
    // fresh/never-resized PTY, which stays at the spawn baseline.
    const seedCols = this.appliedSize.cols > 0 ? this.appliedSize.cols : PTY_SPAWN_COLS;
    const seedRows = this.appliedSize.rows > 0 ? this.appliedSize.rows : PTY_SPAWN_ROWS;
    this.ptyReconcile = reconcilePtySizeAcrossFrames({
      spawnCols: seedCols,
      spawnRows: seedRows,
      isAlive: () => !this.disposed && this.ptyId === ptyId && this.container !== null,
      // Pause (skip, don't cancel) while a sash drag holds resizes, so the
      // reconcile never fights the hold or the fit-stability loop.
      isHeld: () => this.resizeHoldDepth > 0,
      isAuthoritative: () => this.visible,
      measure: () => this.proposeFitForReconcile(),
      resize: (cols, rows) => this.applyFitAndForwardReconcile(cols, rows),
      getAppliedSize: () => appliedPtySize(ptyId),
      onAdoptClamp: (cols, rows) =>
        log("terminal", "adopted spawn pty size clamp", { paneId: this.paneId, cols, rows }),
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
    });
  }

  private cancelPtySizeReconcile() {
    this.ptyReconcile?.cancel();
    this.ptyReconcile = null;
    this.reconcilePtyId = "";
  }

  private startHydration() {
    if (this.hydrationStarted) {
      return;
    }

    this.hydrationStarted = true;
    // planHydrationReplay returns the pre-daemon single-write (or nothing) for
    // every non-daemonSnapshot source, so this path stays byte-identical for
    // tmux capture / snapshot fallback; only "daemonSnapshot" yields the
    // clear+reset+kitty+tail+focus order (terminal-reattach-replay.ts).
    const steps = planHydrationReplay({
      source: this.initialScrollbackSource,
      payload: this.initialScrollback,
      currentCols: this.term.cols,
      currentRows: this.term.rows,
      snapshotCols: this.snapshotCols,
      snapshotRows: this.snapshotRows,
      pendingEscapeTailAnsi: this.pendingEscapeTailAnsi,
      kittyKeyboardFlags: this.kittyKeyboardFlags,
      isColdRestore: this.isColdRestore,
      focused: useTerminalStore.getState().focusedPtyId === this.ptyId,
    });
    this.runHydrationReplay(steps);
  }

  private runHydrationReplay(steps: HydrationReplayStep[]) {
    // (1) xterm-only resize to the snapshot's grid, suppressing the PTY forward
    // so no SIGWINCH reaches the live session (resize BEFORE the clear so the
    // rewrap happens once, at the correct width).
    const resize = steps.find((step) => step.kind === "xtermResize");
    if (resize?.kind === "xtermResize") {
      this.suppressSnapshotReplayPtyResize = true;
      try {
        this.term.resize(resize.cols, resize.rows);
      } finally {
        this.suppressSnapshotReplayPtyResize = false;
      }
    }

    const writes: string[] = [];
    for (const step of steps) {
      if (step.kind === "termWrite") {
        writes.push(step.data);
      }
    }
    const postSteps = steps.filter(
      (step) => step.kind === "focusIn" || step.kind === "ackColdRestore",
    );

    const finish = () => {
      // Post-replay transport/daemon actions run before finish so a focused
      // reattach's focus-in reaches the live session as soon as the payload is
      // parsed. Guarded individually — a throw must not escape xterm's
      // WriteBuffer nor starve the finish/flush that keep output draining.
      for (const step of postSteps) {
        runGuardedWriteCompletionStep("reattach-post-replay", () => this.applyPostReplayStep(step));
      }
      runGuardedWriteCompletionStep("hydration-finish", () => this.finishInitialHydration());
      runGuardedWriteCompletionStep("hydration-flush", () => this.flushPendingOutput());
    };

    if (writes.length === 0) {
      // Empty payload, non-daemon source: same as the pre-daemon early return —
      // finish + flush directly, no replay-guard scope.
      this.finishInitialHydration();
      this.flushPendingOutput();
      return;
    }

    // Why: the 2031 replay guard must cover EXACTLY the replayed bytes.
    // pendingOutput drained after these writes is LIVE output (a real TUI
    // subscribing during startup) and must be honored, so the flag — not the
    // broader hydrated bit — scopes the guard. It clears once the LAST replay
    // write is parsed.
    this.replayingScrollback = true;
    for (let i = 0; i < writes.length - 1; i++) {
      this.term.write(writes[i]);
    }
    this.term.write(writes[writes.length - 1], () => {
      this.replayingScrollback = false;
      finish();
    });
  }

  private applyPostReplayStep(step: HydrationReplayStep) {
    if (step.kind === "focusIn") {
      // Focus-in goes to the PTY (not xterm) so the live agent moves its cursor
      // back to the input caret after a focused reattach.
      this.writeInput(new TextEncoder().encode(TERMINAL_FOCUS_IN));
      return;
    }
    if (step.kind === "ackColdRestore" && this.ptyId) {
      // The snapshot superseded the cold-restore payload; ack so the daemon does
      // not redeliver it on the next reattach.
      ackColdRestore(this.ptyId).catch(() => {});
    }
  }

  private flushPendingOutput() {
    const chunk = this.pendingOutput.shift();
    if (!chunk) {
      this.hydrated = true;
      return;
    }

    this.term.write(chunk, () => {
      // A throw here would wedge the WriteBuffer permanently; guard it so the
      // recursion degrades to a stalled drain instead of a frozen pane.
      runGuardedWriteCompletionStep("pending-output-flush", () => this.flushPendingOutput());
    });
  }

  private finishInitialHydration() {
    const source = this.initialScrollbackSource;
    this.initialScrollback = "";
    this.initialScrollbackSource = undefined;
    // Consumed once: drop the daemon-snapshot metadata so a later PTY swap into
    // this runtime never replays a stale snapshot preamble.
    this.snapshotCols = undefined;
    this.snapshotRows = undefined;
    this.pendingEscapeTailAnsi = undefined;
    this.kittyKeyboardFlags = undefined;
    this.isColdRestore = false;
    if (source === "tmuxCapture") {
      this.reportActivity("tmuxCapture");
    }
  }

  private reportActivity(source: ActivitySource) {
    if (!this.ptyId) {
      return;
    }

    emitTerminalPaneActivity({
      paneId: this.paneId,
      ptyId: this.ptyId,
      source,
    });
  }

  private writeInput(bytes: Uint8Array) {
    if (!this.ptyId) {
      return;
    }
    this.inputQueue.enqueue(bytes);
  }

  // DECSET 2031 subscribe (`h`) / unsubscribe (`l`). The replay guard lives in
  // decideMode2031Csi: a `?2031h` parsed out of the restored-scrollback replay
  // records nothing and emits nothing (echoing during replay is orca's "random
  // characters on restart" bug); a live subscribe — including one buffered in
  // pendingOutput during hydration — records the bit and seeds the mode once.
  private handleMode2031Csi(params: (number | number[])[], set: boolean) {
    if (!csiParamsIncludeMode2031(params)) {
      return;
    }
    const decision = decideMode2031Csi(this.mode2031, {
      set,
      replaying: this.replayingScrollback,
      currentMode: this.colorSchemeMode,
    });
    this.mode2031 = decision.state;
    if (decision.emit) {
      this.writeInput(new TextEncoder().encode(decision.emit));
    }
  }

  private syncPtyOutputRoute(previousPtyId: string, nextPtyId: string) {
    if (previousPtyId) {
      clearPtyOutputHandler(previousPtyId, this.boundHandlePtyOutput);
    }

    if (nextPtyId) {
      setPtyOutputHandler(nextPtyId, this.boundHandlePtyOutput);
    }
  }

  private dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.cancelPtySizeReconcile();
    this.ptyReassert?.dispose();
    this.ptyReassert = null;
    if (this.suspendTimer !== null) {
      window.clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    this.detach();
    this.imeCompositionTracker?.dispose();
    this.imeCompositionTracker = null;
    // Free the GPU context deterministically before term.dispose() tears the
    // addon down, so a suspend/park/close path releases WebGL immediately.
    releaseXtermWebglContext(this.webglAddon);
    this.webglAddon?.dispose();
    this.webglAddon = null;
    this.hasLoadedWebgl = false;
    this.dataDisposable.dispose();
    this.bellDisposable.dispose();
    for (const disposable of this.oscDisposables) {
      disposable.dispose();
    }
    this.unlistenLayoutSync();
    this.syncPtyOutputRoute(this.ptyId, "");
    this.term.dispose();
    paneSeeds.delete(this.paneId);
    runtimes.delete(this.paneId);
  }
}
