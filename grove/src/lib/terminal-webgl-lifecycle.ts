import type { WebglAddon } from "@xterm/addon-webgl";
import { log } from "./logger";

// A single transient WebGL context loss is recovered by re-adding the addon
// (today's behavior). A SECOND loss inside this window signals a persistent GPU
// failure, so the pane latches to the DOM renderer for the rest of the session
// instead of busy-looping context create/destroy. A display-wake boundary
// clears the latch (see WebglRenderLatch.resetForWake).
export const WEBGL_CONTEXT_LOSS_LATCH_WINDOW_MS = 60_000;
// Cool-down after a failed WebglAddon construction (getContext threw): every
// reveal/resize/theme tick calls loadWebglAddon, so without this a persistently
// failing GPU would reconstruct a canvas + failed getContext on each frame.
export const WEBGL_CONSTRUCTION_COOLDOWN_MS = 2_000;
// Breadcrumbs are devtools-only and rate-limited per event so a context-loss
// storm cannot flood the console.
const WEBGL_BREADCRUMB_MIN_INTERVAL_MS = 1_000;

/**
 * Per-runtime WebGL renderer failure policy. Pure and clock-injected so the
 * latch/backoff decisions are testable without a live GPU context.
 */
export class WebglRenderLatch {
  private domLatched = false;
  private lastContextLossAt: number | null = null;
  private lastFailedConstructionAt: number | null = null;

  isDomLatched(): boolean {
    return this.domLatched;
  }

  /**
   * Record a context loss. Returns `latched: true` when this is the second loss
   * within the window — the caller must then keep the pane on the DOM renderer
   * and NOT reschedule a WebGL load. The first loss (or one after the window
   * elapsed) returns `latched: false`, preserving today's auto-recovery.
   */
  recordContextLoss(now: number): { latched: boolean } {
    const secondWithinWindow =
      this.lastContextLossAt !== null &&
      now - this.lastContextLossAt <= WEBGL_CONTEXT_LOSS_LATCH_WINDOW_MS;
    this.lastContextLossAt = now;
    if (secondWithinWindow) {
      this.domLatched = true;
    }
    return { latched: secondWithinWindow };
  }

  /** Whether a new WebglAddon may be constructed now. */
  canConstruct(now: number): boolean {
    if (this.domLatched) {
      return false;
    }
    if (
      this.lastFailedConstructionAt !== null &&
      now - this.lastFailedConstructionAt < WEBGL_CONSTRUCTION_COOLDOWN_MS
    ) {
      return false;
    }
    return true;
  }

  recordConstructionFailure(now: number): void {
    this.lastFailedConstructionAt = now;
  }

  recordConstructionSuccess(): void {
    this.lastFailedConstructionAt = null;
  }

  /**
   * Display-wake boundary: clear the DOM latch and construction cool-down so
   * WebGL may be retried after the GPU context pool recovers on wake.
   */
  resetForWake(): void {
    this.domLatched = false;
    this.lastContextLossAt = null;
    this.lastFailedConstructionAt = null;
  }
}

type ReleasableWebglContext = {
  getExtension(name: "WEBGL_lose_context"): WEBGL_lose_context | null;
};

type XtermWebglAddonInternals = {
  _renderer?: {
    _gl?: ReleasableWebglContext;
    _canvas?: HTMLCanvasElement;
  };
};

/**
 * Explicitly free the GPU context backing a WebglAddon before dropping it. xterm
 * removes the canvas on dispose, but the driver can keep the context alive long
 * enough for rapid pane suspend/dispose to exhaust the browser's active WebGL
 * context budget. loseContext() releases it deterministically; dropping the
 * canvas dimensions drops the last strong ref to the backing buffer.
 */
export function releaseXtermWebglContext(addon: WebglAddon | null): void {
  try {
    const renderer = (addon as unknown as XtermWebglAddonInternals | null)?._renderer;
    renderer?._gl?.getExtension("WEBGL_lose_context")?.loseContext();
    if (renderer?._canvas) {
      renderer._canvas.width = 0;
      renderer._canvas.height = 0;
    }
  } catch {
    // WebGL teardown must never block the fallback to the DOM renderer.
  }
}

// Structural view of the parts of xterm's Terminal the text-snapshot fallback
// needs, so the rasterizer stays unit-testable without a live Terminal.
interface TextSnapshotBufferLine {
  translateToString(trimRight?: boolean): string;
}

export interface TextSnapshotTerminal {
  element?: { clientWidth: number; clientHeight: number } | null;
  rows: number;
  options: {
    theme?: { background?: string; foreground?: string } | undefined;
    fontSize?: number;
    fontFamily?: string;
  };
  buffer: {
    active: {
      viewportY: number;
      getLine(index: number): TextSnapshotBufferLine | undefined;
    };
  };
}

type CanvasDocument = Pick<Document, "createElement">;

/**
 * Rasterize the visible viewport text into a frozen-frame PNG data URL. Used as
 * the snapshot fallback for DOM-rendered panes (WebGL latched or never loaded),
 * where there are no canvas layers to composite. Keeps the snapshot contract a
 * usable `<img src>` value instead of null. Colors approximate the terminal
 * theme's foreground on background.
 */
export function captureTerminalTextSnapshot(
  term: TextSnapshotTerminal,
  doc: CanvasDocument = typeof document !== "undefined" ? document : (null as never),
): string | null {
  const element = term.element;
  if (!element || !doc) {
    return null;
  }

  const width = element.clientWidth;
  const height = element.clientHeight;
  if (!width || !height || term.rows <= 0) {
    return null;
  }

  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  const canvas = doc.createElement("canvas") as HTMLCanvasElement;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }

  ctx.scale(dpr, dpr);
  const background = term.options.theme?.background ?? "#000000";
  const foreground = term.options.theme?.foreground ?? "#ffffff";
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  const fontSize = term.options.fontSize ?? 13;
  const fontFamily = term.options.fontFamily ?? "monospace";
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = foreground;

  const cellHeight = height / term.rows;
  const active = term.buffer.active;
  for (let y = 0; y < term.rows; y++) {
    const line = active.getLine(active.viewportY + y);
    if (!line) {
      continue;
    }
    const text = line.translateToString(true);
    if (text.length > 0) {
      ctx.fillText(text, 0, y * cellHeight);
    }
  }

  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

const lastBreadcrumbAt = new Map<string, number>();

/**
 * Devtools-only, rate-limited breadcrumb for WebGL lifecycle events
 * (context loss, DOM latch, recovery, wake reset). Routes through the
 * DEBUG-gated logger so production builds stay silent; no UI.
 */
export function recordWebglBreadcrumb(
  event: string,
  detail?: Record<string, string | number | boolean | null>,
): void {
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const last = lastBreadcrumbAt.get(event) ?? Number.NEGATIVE_INFINITY;
  if (now - last < WEBGL_BREADCRUMB_MIN_INTERVAL_MS) {
    return;
  }
  lastBreadcrumbAt.set(event, now);
  log("webgl", event, detail ?? {});
}
