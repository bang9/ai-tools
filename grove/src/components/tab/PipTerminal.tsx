import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Maximize2,
  Minimize2,
  MoveDiagonal2,
} from "lucide-react";
import { useTerminalStore } from "../../store/terminal";
import { cn } from "../../lib/cn";
import {
  MAX_PIP_WIDTH,
  MIN_PIP_WIDTH,
  PIP_MARGIN,
  PIP_PEEK_WIDTH,
  clampRequestedPipWidth,
  clampDraggingPipPosition,
  resolvePipFrame,
  resolvePipPresentationAfterDrag,
  type PipPosition,
  type PipPresentationState,
  type PipViewport,
} from "../../lib/pip-floating";

interface Props {
  boundaryRef: React.RefObject<HTMLDivElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  presentation: PipPresentationState;
  onPresentationChange: (next: PipPresentationState) => void;
  onOpenTerminal: () => void;
}

interface DragSession {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPosition: PipPosition;
  requestedWidth: number;
}

interface ResizeSession {
  pointerId: number;
  startClientX: number;
  startWidth: number;
  dockSide: PipPresentationState["dockSide"];
}

function getFallbackViewport(): PipViewport {
  if (typeof window === "undefined") {
    return { width: 1400, height: 900 };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function PipTerminal({
  boundaryRef,
  containerRef,
  presentation,
  onPresentationChange,
  onOpenTerminal,
}: Props) {
  const theme = useTerminalStore((s) => s.theme);
  const [viewport, setViewport] = useState<PipViewport>(getFallbackViewport);
  const [dragPosition, setDragPosition] = useState<PipPosition | null>(null);
  const [resizeWidth, setResizeWidth] = useState<number | null>(null);
  const viewportRef = useRef(viewport);
  const dragPositionRef = useRef<PipPosition | null>(null);
  const dragSessionRef = useRef<DragSession | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const resizeWidthRef = useRef<number | null>(null);
  const resizeSessionRef = useRef<ResizeSession | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    dragPositionRef.current = dragPosition;
  }, [dragPosition]);

  useEffect(() => {
    resizeWidthRef.current = resizeWidth;
  }, [resizeWidth]);

  useEffect(() => {
    const boundary = boundaryRef.current;
    if (!boundary) {
      setViewport(getFallbackViewport());
      return;
    }

    const updateViewport = () => {
      setViewport({
        width: boundary.clientWidth,
        height: boundary.clientHeight,
      });
    };

    updateViewport();

    const observer = new ResizeObserver(updateViewport);
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [boundaryRef]);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      resizeCleanupRef.current?.();
    },
    [],
  );

  const activeRequestedWidth = resizeWidth ?? presentation.requestedWidth;
  const restingFrame = resolvePipFrame(viewport, {
    ...presentation,
    hidden: false,
    requestedWidth: activeRequestedWidth,
  });
  const visibleFrame = dragPosition
    ? { ...restingFrame, x: dragPosition.x, y: dragPosition.y }
    : restingFrame;
  const hiddenBodyX =
    presentation.dockSide === "left"
      ? -(visibleFrame.width + PIP_MARGIN)
      : viewport.width + PIP_MARGIN;
  const activeFrame = {
    ...visibleFrame,
    x: presentation.hidden ? hiddenBodyX : visibleFrame.x,
  };

  const handleRestore = useCallback(() => {
    onPresentationChange({
      ...presentation,
      hidden: false,
    });
  }, [onPresentationChange, presentation]);

  const handleHide = useCallback(() => {
    onPresentationChange({
      ...presentation,
      hidden: true,
    });
  }, [onPresentationChange, presentation]);

  const handleToggleSize = useCallback(() => {
    onPresentationChange({
      ...presentation,
      requestedWidth: presentation.requestedWidth > MIN_PIP_WIDTH ? MIN_PIP_WIDTH : MAX_PIP_WIDTH,
    });
  }, [onPresentationChange, presentation]);

  const handleDragStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) {
        return;
      }

      e.preventDefault();

      const startPosition = {
        x: restingFrame.x,
        y: restingFrame.y,
      };

      dragPositionRef.current = startPosition;
      setDragPosition(startPosition);
      dragSessionRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPosition,
        requestedWidth: activeRequestedWidth,
      };

      const handlePointerMove = (event: PointerEvent) => {
        const session = dragSessionRef.current;
        if (!session || session.pointerId !== event.pointerId) {
          return;
        }

        const next = clampDraggingPipPosition(
          {
            x: session.startPosition.x + (event.clientX - session.startClientX),
            y: session.startPosition.y + (event.clientY - session.startClientY),
          },
          viewportRef.current,
          session.requestedWidth,
        );

        dragPositionRef.current = next;
        setDragPosition(next);
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
        dragCleanupRef.current = null;
      };

      const handlePointerUp = (event: PointerEvent) => {
        const session = dragSessionRef.current;
        if (!session || session.pointerId !== event.pointerId) {
          return;
        }

        const finalPosition = dragPositionRef.current ?? startPosition;
        cleanup();
        dragSessionRef.current = null;
        dragPositionRef.current = null;
        setDragPosition(null);
        onPresentationChange(
          resolvePipPresentationAfterDrag(
            finalPosition,
            viewportRef.current,
            session.requestedWidth,
          ),
        );
      };

      dragCleanupRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [activeRequestedWidth, onPresentationChange, restingFrame.x, restingFrame.y],
  );

  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const startWidth = activeRequestedWidth;
      resizeWidthRef.current = startWidth;
      setResizeWidth(startWidth);
      resizeSessionRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startWidth,
        dockSide: presentation.dockSide,
      };

      const handlePointerMove = (event: PointerEvent) => {
        const session = resizeSessionRef.current;
        if (!session || session.pointerId !== event.pointerId) {
          return;
        }

        const deltaX = event.clientX - session.startClientX;
        const deltaY = event.clientY - e.clientY;
        const outwardDelta =
          session.dockSide === "left" ? Math.max(deltaX, deltaY) : Math.max(-deltaX, deltaY);
        const nextWidth = clampRequestedPipWidth(session.startWidth + outwardDelta);

        resizeWidthRef.current = nextWidth;
        setResizeWidth(nextWidth);
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
        resizeCleanupRef.current = null;
      };

      const handlePointerUp = (event: PointerEvent) => {
        const session = resizeSessionRef.current;
        if (!session || session.pointerId !== event.pointerId) {
          return;
        }

        const nextWidth = resizeWidthRef.current ?? session.startWidth;
        cleanup();
        resizeSessionRef.current = null;
        resizeWidthRef.current = null;
        setResizeWidth(null);
        onPresentationChange({
          ...presentation,
          requestedWidth: nextWidth,
        });
      };

      resizeCleanupRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [activeRequestedWidth, onPresentationChange, presentation],
  );

  const isDragging = dragPosition !== null;
  const isResizing = resizeWidth !== null;
  const isExpanded = activeRequestedWidth > MIN_PIP_WIDTH;
  const hideIcon = presentation.dockSide === "left" ? ChevronLeft : ChevronRight;
  const restoreIcon = presentation.dockSide === "left" ? ChevronRight : ChevronLeft;
  const ToggleSizeIcon = isExpanded ? Minimize2 : Maximize2;
  const HideIcon = hideIcon;
  const RestoreIcon = restoreIcon;
  const peekHeight = 56;
  const peekY = clamp(
    Math.round(visibleFrame.y + visibleFrame.height / 2 - peekHeight / 2),
    PIP_MARGIN,
    Math.max(PIP_MARGIN, viewport.height - peekHeight - PIP_MARGIN),
  );

  return (
    <>
      <div
        className={cn(
          "absolute left-0 top-0 z-50 rounded-xl overflow-clip",
          "border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.5)] bg-sidebar/90 backdrop-blur-sm",
          "will-change-transform",
          {
            "pointer-events-none": presentation.hidden,
            "pointer-events-auto": !presentation.hidden,
            "transition-none": isDragging || isResizing,
            "transition-[transform,width,height] duration-300 ease-out": !isDragging && !isResizing,
          },
        )}
        style={{
          width: activeFrame.width,
          height: activeFrame.height,
          transform: `translate3d(${activeFrame.x}px, ${activeFrame.y}px, 0)`,
        }}
      >
        <div className={cn("absolute inset-0 flex flex-col")}>
          <div
            className={cn(
              "flex items-center justify-between px-2.5 h-7 shrink-0 border-b border-white/10 select-none touch-none",
              "cursor-grab active:cursor-grabbing",
            )}
            onPointerDown={handleDragStart}
          >
            <span className={cn("text-xs font-medium text-muted-foreground truncate")}>
              Terminal
            </span>
            <div className={cn("flex items-center gap-1")}>
              <button
                type="button"
                onClick={onOpenTerminal}
                onPointerDown={(e) => e.stopPropagation()}
                className={cn(
                  "flex items-center justify-center size-6 rounded-sm cursor-pointer text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors",
                )}
                title="Open in Terminal tab"
              >
                <ExternalLink className={cn("size-3.5")} />
              </button>
              <button
                type="button"
                onClick={handleToggleSize}
                onPointerDown={(e) => e.stopPropagation()}
                className={cn(
                  "flex items-center justify-center size-6 rounded-sm cursor-pointer text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors",
                )}
                title={isExpanded ? "Minimize terminal" : "Expand terminal"}
              >
                <ToggleSizeIcon className={cn("size-3.5")} />
              </button>
              <button
                type="button"
                onClick={handleHide}
                onPointerDown={(e) => e.stopPropagation()}
                className={cn(
                  "flex items-center justify-center size-6 rounded-sm cursor-pointer text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors",
                )}
                title="Hide"
              >
                <HideIcon className={cn("size-4")} />
              </button>
            </div>
          </div>

          <div
            className={cn("flex-1 min-h-0 px-2")}
            style={{ backgroundColor: theme?.background ?? "#000" }}
          >
            <div ref={containerRef} className={cn("h-full w-full")} />
          </div>

          <button
            type="button"
            onPointerDown={handleResizeStart}
            className={cn(
              "absolute bottom-1 z-10 flex items-center justify-center size-7 rounded-lg touch-none select-none",
              "cursor-pointer border border-white/20 bg-white/10 text-white/60 shadow-[0_4px_10px_rgba(0,0,0,0.14)] backdrop-blur-sm",
              "hover:bg-white/20 hover:border-white/35 transition-colors",
              {
                "right-1 cursor-se-resize": presentation.dockSide === "left",
                "left-1 cursor-sw-resize": presentation.dockSide === "right",
              },
            )}
            title="Resize terminal"
          >
            <span className={cn("sr-only")}>Resize terminal</span>
            <MoveDiagonal2
              className={cn("size-4 pointer-events-none", {
                "rotate-90": presentation.dockSide === "right",
              })}
            />
          </button>
        </div>
      </div>

      {presentation.hidden && (
        <button
          type="button"
          onClick={handleRestore}
          className={cn(
            "absolute left-0 top-0 z-[60] flex items-center justify-center w-7 h-14",
            "bg-sidebar/95 border border-white/10 shadow-lg backdrop-blur-sm",
            "text-muted-foreground hover:text-foreground hover:bg-sidebar transition-[transform,colors] duration-300 ease-out",
            {
              "left-0 rounded-r-lg border-l-0": presentation.dockSide === "left",
              "rounded-l-lg border-r-0": presentation.dockSide === "right",
            },
          )}
          style={{
            transform: `translate3d(${
              presentation.dockSide === "left" ? 0 : viewport.width - PIP_PEEK_WIDTH
            }px, ${peekY}px, 0)`,
          }}
          title="Show terminal"
        >
          <RestoreIcon className={cn("size-4")} />
        </button>
      )}
    </>
  );
}
