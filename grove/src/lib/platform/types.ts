export type UnlistenFn = () => void;

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

export interface Platform {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T = unknown>(
    event: string,
    handler: (payload: T) => void,
  ): Promise<UnlistenFn>;
  isFullscreen(): Promise<boolean>;
  onResized(handler: () => void): Promise<UnlistenFn>;
}
