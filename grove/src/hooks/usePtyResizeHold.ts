import { useCallback, useEffect, useRef } from "react";
import { holdPanePtyResizes } from "../lib/terminal-runtime";

/**
 * Wire a ResizablePanelGroup's onDragStateChange to a PTY resize hold: while
 * the sash is dragging, xterm keeps refitting locally but the PTY receives a
 * single resize at drag end, so TUIs redraw once instead of trembling through
 * a mid-drag SIGWINCH stream. Holds the given panes, or every pane when the
 * sash resizes terminal regions indirectly (main layout, global terminal).
 */
export function usePtyResizeHold(paneIds?: string[]) {
  const releaseRef = useRef<(() => void) | null>(null);
  const paneIdsRef = useRef(paneIds);
  paneIdsRef.current = paneIds;

  useEffect(() => {
    // Release on unmount so a pane closed mid-drag never strands a hold.
    return () => {
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, []);

  return useCallback((dragging: boolean) => {
    releaseRef.current?.();
    releaseRef.current = dragging ? holdPanePtyResizes(paneIdsRef.current) : null;
  }, []);
}
