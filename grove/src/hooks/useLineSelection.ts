import { useCallback, useRef } from "react";
import { useDiffStore } from "../store/diff";

export function useLineSelection(filePath: string) {
  const selectLine = useDiffStore((s) => s.selectLine);
  const selectLineRange = useDiffStore((s) => s.selectLineRange);
  const clearSelection = useDiffStore((s) => s.clearSelection);
  const lastClickedRef = useRef<number | null>(null);
  const dragStartRef = useRef<number | null>(null);

  const handleGutterClick = useCallback(
    (lineIndex: number, shiftKey: boolean) => {
      if (shiftKey && lastClickedRef.current !== null) {
        selectLineRange(filePath, lastClickedRef.current, lineIndex);
      } else {
        selectLine(filePath, lineIndex);
      }
      lastClickedRef.current = lineIndex;
    },
    [filePath, selectLine, selectLineRange],
  );

  const handleGutterMouseDown = useCallback((lineIndex: number) => {
    dragStartRef.current = lineIndex;
  }, []);

  const handleGutterMouseEnter = useCallback(
    (lineIndex: number, buttons: number) => {
      if (buttons === 1 && dragStartRef.current !== null) {
        selectLineRange(filePath, dragStartRef.current, lineIndex);
      }
    },
    [filePath, selectLineRange],
  );

  const handleGutterMouseUp = useCallback(() => {
    dragStartRef.current = null;
  }, []);

  return {
    handleGutterClick,
    handleGutterMouseDown,
    handleGutterMouseEnter,
    handleGutterMouseUp,
    clearSelection,
  };
}
