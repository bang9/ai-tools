export type TerminalLayoutSyncSource =
  | "attach"
  | "broadcast"
  | "globalTerminal"
  | "panelResize"
  | "resizeObserver"
  | "tabSwitch"
  | "theme"
  | "manual";

export interface TerminalLayoutSyncRequest {
  paneId?: string;
  paneIds?: string[];
  source: TerminalLayoutSyncSource;
}

const listeners = new Set<(request: TerminalLayoutSyncRequest) => void>();

export function requestTerminalLayoutSync(request: TerminalLayoutSyncRequest) {
  for (const listener of listeners) {
    listener(request);
  }
}

export function subscribeTerminalLayoutSync(
  listener: (request: TerminalLayoutSyncRequest) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
