import { useEffect, useRef } from "react";
import { useFullscreen } from "./useFullscreen";

/**
 * Suppress native platform behaviors that conflict with the app.
 *
 * 1. **Fullscreen ESC** — On macOS, pressing ESC in native fullscreen triggers
 *    `cancelOperation:` on NSWindow, which exits fullscreen. Both WKWebView
 *    (Tauri) and Chromium (Electron) dispatch the DOM keydown event before the
 *    native handler runs, so calling `preventDefault()` in the capture phase is
 *    enough to block the exit. xterm.js terminals and Radix overlays such as
 *    context menus / dialogs are excluded so they can keep their native ESC
 *    semantics.
 *
 * 2. **Context menu** — The WebView default context menu (Reload, Inspect, etc.)
 *    conflicts with custom Radix context menus. Suppressing the native event
 *    lets the React-level menus work without interference.
 */
export function usePreventNativeBehaviors() {
  const isFullscreen = useFullscreen();
  const ref = useRef(isFullscreen);
  ref.current = isFullscreen;

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !ref.current) return;
      const target = e.target as HTMLElement;
      if (target.closest(".xterm, [data-radix-menu-content], [data-slot='dialog-content']")) {
        return;
      }
      e.preventDefault();
    };

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    window.addEventListener("keydown", handleEscape, true);
    document.addEventListener("contextmenu", handleContextMenu);
    return () => {
      window.removeEventListener("keydown", handleEscape, true);
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);
}
