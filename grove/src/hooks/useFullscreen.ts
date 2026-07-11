import { useState, useEffect } from "react";
import { platform } from "../lib/platform";

// onResized fires continuously during a live window drag (and throughout the
// ~1s macOS fullscreen transition). Debounce the isFullscreen() IPC so it runs
// once after the events settle instead of per raw resize event.
const FULLSCREEN_RECONCILE_DEBOUNCE_MS = 120;

export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const reconcile = () => {
      platform.isFullscreen().then((value) => {
        if (cancelled) return;
        setIsFullscreen((prev) => (prev === value ? prev : value));
      });
    };

    // Immediate initial fetch so first paint has the correct state.
    reconcile();

    const unlisten = platform.onResized(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(reconcile, FULLSCREEN_RECONCILE_DEBOUNCE_MS);
    });

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      unlisten.then((fn) => fn());
    };
  }, []);

  return isFullscreen;
}
