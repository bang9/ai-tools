export type UnlistenFn = () => void;

/**
 * How a platform delivers PTY output to the frontend.
 * - `globalEvent`: Electron's shared `pty-output` event carrying `{ id, data }`.
 * - `channel`: Tauri's per-PTY `tauri::ipc::Channel` (raw ArrayBuffer, no id).
 */
export type PtyOutputTransport = "globalEvent" | "channel";

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserNavEvent {
  tabId: string;
  url: string;
  title: string | null;
  loading: boolean;
  canGoBack: boolean | null;
  canGoForward: boolean | null;
}

export interface BrowserNewWindowEvent {
  openerTabId: string;
  url: string;
}

/** A picked element delivered by grab mode; `data` is raw JSON the UI parses. */
export interface BrowserGrabEvent {
  tabId: string;
  data: string;
}

/**
 * A find-in-page result for a browser tab. `active` is the 1-based ordinal of
 * the current match (0 when there are none); `total` is the match count.
 */
export interface BrowserFindEvent {
  tabId: string;
  active: number;
  total: number;
}

/** A browser Grove can import cookies from (from grove-core detection). */
export interface DetectedBrowser {
  family: string;
  label: string;
  available: boolean;
}

export interface Platform {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T = unknown>(event: string, handler: (payload: T) => void): Promise<UnlistenFn>;
  isFullscreen(): Promise<boolean>;
  onResized(handler: () => void): Promise<UnlistenFn>;
}
