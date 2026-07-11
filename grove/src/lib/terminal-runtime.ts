import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { TerminalTheme } from "../types";
import { subscribeTerminalLayoutSync } from "./terminal-layout-sync";
import { clearPtyScrollback, platform, ptyOutputTransport, resizePty, writePty } from "./platform";
import { useTerminalStore } from "../store/terminal";
import { isSafeExternalUrl, openUrl } from "./url-open";
import { PtyInputQueue } from "./terminal-input-queue";
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

export type TerminalInitialContentSource = "snapshotFallback" | "tmuxCapture";

export interface TerminalPaneSeed {
  initialScrollback?: string;
  initialScrollbackSource?: TerminalInitialContentSource;
  launchCwd?: string;
  ptyId?: string;
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

function toXtermTheme(theme: TerminalTheme | null) {
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
 * A WebGL addon should be (re)loaded only when the pane has none yet and is
 * currently visible. Keeping this a pure predicate makes the "don't double-load
 * on repeated reveals" contract testable without a live GPU context.
 */
export function shouldLoadWebglAddon(hasLoadedWebgl: boolean, visible: boolean): boolean {
  return !hasLoadedWebgl && visible;
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

// Divider drags propose a new grid nearly every frame, and every applied fit
// runs xterm's renderer clear + scrollback reflow — per-frame fits read as
// visible blinking. Apply a proposal only once it has held for
// FIT_STABLE_FRAMES consecutive frames; FIT_MAX_STABILITY_FRAMES bounds the
// wait so a long continuous drag still tracks the pane instead of freezing.
const FIT_STABLE_FRAMES = 2;
const FIT_MAX_STABILITY_FRAMES = 8;

export interface FitStabilityState {
  cols: number;
  rows: number;
  matchedFrames: number;
  totalFrames: number;
}

export function nextFitStability(
  prev: FitStabilityState | null,
  proposed: ResizeTarget,
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

export interface PreFitViewport {
  wasAtBottom: boolean;
  viewportY: number;
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
  paneSeeds.set(paneId, {
    ...existing,
    ...seed,
    initialScrollback: seed.initialScrollback ?? existing?.initialScrollback,
    initialScrollbackSource:
      seed.initialScrollback !== undefined
        ? seed.initialScrollbackSource
        : existing?.initialScrollbackSource,
  });
}

export function acquireTerminalRuntime(paneId: string, theme: TerminalTheme | null) {
  ensurePtyOutputListener();
  let runtime = runtimes.get(paneId);
  if (!runtime) {
    runtime = new TerminalPaneRuntime(paneId, paneSeeds.get(paneId), theme);
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

export function captureRuntimeSnapshot(paneId: string): string | null {
  const runtime = runtimes.get(paneId);
  if (!runtime?.term.element) return null;
  const canvases = runtime.term.element.querySelectorAll("canvas");
  if (canvases.length === 0) return null;
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
  // Off-screen panes suspend their WebGL context; term.write keeps flowing into
  // xterm's DOM renderer fallback so scrollback stays current while hidden.
  private visible = true;
  private suspendTimer: number | null = null;
  private pendingRevealRefresh = false;
  private appliedSize: ResizeTarget = { cols: 0, rows: 0 };
  private inFlightSize: ResizeTarget | null = null;
  private fitStability: FitStabilityState | null = null;
  private layoutSyncSuppressed = false;
  private initialScrollback = "";
  private initialScrollbackSource: TerminalInitialContentSource | undefined;
  private hydrationStarted = false;
  private hydrated = false;
  private pendingOutput: Uint8Array[] = [];
  private disposed = false;
  private lastError: string | null = null;

  private onTrackpadMouseDown: (() => void) | null = null;
  private onTrackpadMouseUp: (() => void) | null = null;
  private onTrackpadMouseMoveCapture: ((event: MouseEvent) => void) | null = null;
  private onFocusIn: (() => void) | null = null;
  private searchHandler: (() => void) | null = null;
  private ownerDocument: Document | null = null;
  private readonly unlistenLayoutSync: () => void;
  private readonly dataDisposable: { dispose(): void };
  private readonly bellDisposable: { dispose(): void };
  // Stable identity so the output router can drop this runtime's route only
  // while it is still the owner (see clearPtyOutputHandler).
  private readonly boundHandlePtyOutput = (data: Uint8Array) => {
    this.handlePtyOutput(data);
  };
  // Coalesces dense input bursts into fewer backend writes; flushes to the
  // current ptyId on a microtask boundary so query replies are never delayed.
  private readonly inputQueue = new PtyInputQueue({
    flush: (data) => {
      if (this.disposed || !this.ptyId) {
        return;
      }
      writePty(this.ptyId, data).catch((error) => {
        console.error("writePty failed:", error);
      });
    },
  });

  constructor(paneId: string, seed: TerminalPaneSeed | undefined, theme: TerminalTheme | null) {
    this.paneId = paneId;
    this.ptyId = seed?.ptyId ?? "";
    this.launchCwd = seed?.launchCwd;
    this.initialScrollback = seed?.initialScrollback ?? "";
    this.initialScrollbackSource = seed?.initialScrollbackSource;
    this.hydrated = this.initialScrollback.length === 0;
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

    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      if (!isSafeExternalUrl(uri)) return;
      // Claude Code fullscreen handles link clicks via the open wrapper,
      // so skip the addon handler to avoid duplicate opens.
      const session = useTerminalStore.getState().aiSessions[this.ptyId];
      if (session?.tool === "claude") return;
      openUrl(uri);
    });
    this.term.loadAddon(webLinksAddon);

    this.searchAddon = new SearchAddon();
    this.term.loadAddon(this.searchAddon);

    this.dataDisposable = this.term.onData((data) => {
      if (!this.ptyId) {
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
    this.syncPtyOutputRoute("", this.ptyId);
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
      this.hydrated = this.initialScrollback.length === 0;
    }
  }

  setPtyId(ptyId: string) {
    if (this.ptyId === ptyId) {
      return;
    }

    const previousPtyId = this.ptyId;
    this.ptyId = ptyId;
    // A swapped-in PTY starts at an unknown backend size, so clear the tracked
    // sizes; otherwise a fit that happens to match the previous PTY's applied
    // size would skip the new PTY's initial resize and leave it mis-sized.
    this.appliedSize = { cols: 0, rows: 0 };
    this.inFlightSize = null;
    this.syncPtyOutputRoute(previousPtyId, ptyId);
  }

  getPtyId() {
    return this.ptyId;
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
    this.term.options.theme = toXtermTheme(theme);
    if (theme) {
      this.term.options.fontFamily = theme.fontFamily;
      this.term.options.fontSize = theme.fontSize;
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

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.onFocusIn) {
      this.container.removeEventListener("focusin", this.onFocusIn);
      this.onFocusIn = null;
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
        this.syncPtySize();
        this.refreshAfterReveal();
        if (loadedWebgl) {
          this.scheduleLayoutSync(deadline);
        }
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
    });
  }

  private refreshAfterReveal() {
    if (!this.pendingRevealRefresh) {
      return;
    }

    this.pendingRevealRefresh = false;
    // A suspended context drops its glyph atlas; rebuild it and force a repaint
    // so the newly revealed pane paints its current buffer instead of a blank
    // or stale first frame.
    this.webglAddon?.clearTextureAtlas();
    this.term.refresh(0, Math.max(0, this.term.rows - 1));
  }

  private ensureTerminalHost() {
    if (!this.container) {
      return;
    }

    if (!this.term.element) {
      this.term.open(this.container);
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
    if (!shouldLoadWebglAddon(this.hasLoadedWebgl, this.visible)) {
      return false;
    }

    try {
      const webglAddon = new WebglAddon(true);
      webglAddon.onContextLoss(() => {
        // Recover instead of dropping to the DOM renderer forever: dispose the
        // lost context and reschedule a load, which is gated behind layout
        // dimensions (and visibility), so it only re-adds once the pane is shown.
        webglAddon.dispose();
        if (this.webglAddon === webglAddon) {
          this.webglAddon = null;
        }
        this.hasLoadedWebgl = false;
        this.scheduleLayoutSync();
      });
      this.term.loadAddon(webglAddon);
      this.webglAddon = webglAddon;
      this.hasLoadedWebgl = true;
      return true;
    } catch {
      // Canvas renderer fallback
      return false;
    }
  }

  private fitTerminal() {
    try {
      const buffer = this.term.buffer.active;
      const isAlternate = buffer.type === "alternate";
      const before: PreFitViewport = {
        wasAtBottom: buffer.viewportY >= buffer.baseY,
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
      this.syncPtySize();
    } catch {
      // ignore fit errors if the host is not ready yet
    }
  }

  private syncPtySize() {
    const { cols, rows } = this.term;
    if (!cols || !rows || !this.ptyId) {
      return;
    }

    const target: ResizeTarget = { cols, rows };
    if (!shouldSendResize(target, this.appliedSize, this.inFlightSize)) {
      return;
    }

    const ptyId = this.ptyId;
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
        }
      });
  }

  private startHydration() {
    if (this.hydrationStarted) {
      return;
    }

    this.hydrationStarted = true;
    if (!this.initialScrollback) {
      this.finishInitialHydration();
      this.flushPendingOutput();
      return;
    }

    this.term.write(this.initialScrollback, () => {
      this.finishInitialHydration();
      this.flushPendingOutput();
    });
  }

  private flushPendingOutput() {
    const chunk = this.pendingOutput.shift();
    if (!chunk) {
      this.hydrated = true;
      return;
    }

    this.term.write(chunk, () => {
      this.flushPendingOutput();
    });
  }

  private finishInitialHydration() {
    const source = this.initialScrollbackSource;
    this.initialScrollback = "";
    this.initialScrollbackSource = undefined;
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
    if (this.suspendTimer !== null) {
      window.clearTimeout(this.suspendTimer);
      this.suspendTimer = null;
    }
    this.detach();
    this.dataDisposable.dispose();
    this.bellDisposable.dispose();
    this.unlistenLayoutSync();
    this.syncPtyOutputRoute(this.ptyId, "");
    this.term.dispose();
    paneSeeds.delete(this.paneId);
    runtimes.delete(this.paneId);
  }
}
