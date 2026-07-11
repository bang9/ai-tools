import { openExternal, platform } from "./platform";
import { log } from "./logger";
import { usePreferencesStore } from "../store/preferences";

export function isSafeExternalUrl(uri: string): boolean {
  try {
    const { protocol } = new URL(uri);
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

function isLocalhostUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

/** Open a URL with preference-based routing. */
export function openUrl(url: string) {
  const mode = usePreferencesStore.getState().terminalLinkOpenMode;

  const useInternal =
    mode === "internal" || (mode === "external-with-localhost-internal" && isLocalhostUrl(url));

  if (useInternal) {
    // TODO: open in Grove browser tab
    log("url-open", "internal (not implemented):", url);
  }

  openExternal(url).catch(() => {});
}

/** Listen for URL open requests from the Grove backend (via open-url socket). */
export async function initUrlOpenPipe(): Promise<(() => void) | undefined> {
  const unlisten = await platform.listen<string>("grove:open-url", (url) => {
    log("url-open", "received:", url);
    openUrl(url);
  });
  return unlisten;
}
