import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import type { WorkspaceFileContent } from "../../types";
import { cn } from "../../lib/cn";
import { IconButton } from "../ui/button";
import { formatFileSize } from "../../lib/format-size";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, var(--muted) 25%, transparent 25%), " +
    "linear-gradient(-45deg, var(--muted) 25%, transparent 25%), " +
    "linear-gradient(45deg, transparent 75%, var(--muted) 75%), " +
    "linear-gradient(-45deg, transparent 75%, var(--muted) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
};

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

interface ImageViewerProps {
  data: WorkspaceFileContent;
  name: string;
}

function ImageViewer({ data, name }: ImageViewerProps) {
  const dataUrl = useMemo(
    () => `data:${data.mimeType ?? "application/octet-stream"};base64,${data.content}`,
    [data.content, data.mimeType],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // null means "fit to window" — the effective zoom tracks the container size.
  const [zoom, setZoom] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const fitZoom = useMemo(() => {
    if (!natural || containerSize.w === 0 || containerSize.h === 0) return 1;
    // Leave a little breathing room, and never scale a small image up past 1:1.
    const scale = Math.min(containerSize.w / natural.w, containerSize.h / natural.h) * 0.98;
    return clampZoom(Math.min(scale, 1));
  }, [natural, containerSize]);

  const effectiveZoom = zoom ?? fitZoom;

  const zoomBy = useCallback(
    (factor: number) => {
      setZoom((current) => clampZoom((current ?? fitZoom) * factor));
    },
    [fitZoom],
  );

  // ctrl/cmd + wheel zooms. Registered as a non-passive listener so
  // preventDefault stops the page/pinch-zoom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setZoom((current) => clampZoom((current ?? fitZoom) * factor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fitZoom]);

  const dragRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
    };
    setDragging(true);
    el.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    const start = dragRef.current;
    if (!el || !start) return;
    el.scrollLeft = start.left - (event.clientX - start.x);
    el.scrollTop = start.top - (event.clientY - start.y);
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    setDragging(false);
    containerRef.current?.releasePointerCapture(event.pointerId);
  }, []);

  const displayWidth = natural ? Math.round(natural.w * effectiveZoom) : undefined;
  const displayHeight = natural ? Math.round(natural.h * effectiveZoom) : undefined;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col")}>
      <div
        className={cn(
          "flex h-8 shrink-0 items-center gap-1 border-b border-border bg-sidebar px-2",
        )}
      >
        <IconButton onClick={() => zoomBy(1 / ZOOM_STEP)} title="Zoom out" aria-label="Zoom out">
          <ZoomOut className={cn("size-3")} />
        </IconButton>
        <IconButton onClick={() => zoomBy(ZOOM_STEP)} title="Zoom in" aria-label="Zoom in">
          <ZoomIn className={cn("size-3")} />
        </IconButton>
        <button
          type="button"
          onClick={() => setZoom(null)}
          title="Fit to window"
          className={cn(
            "flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground",
            "transition-colors hover:bg-accent/10 hover:text-foreground",
            { "bg-accent/10 text-foreground": zoom === null },
          )}
        >
          <Maximize2 className={cn("size-3")} />
          Fit
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          title="Actual size"
          className={cn(
            "flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground",
            "transition-colors hover:bg-accent/10 hover:text-foreground",
            { "bg-accent/10 text-foreground": zoom === 1 },
          )}
        >
          1:1
        </button>
      </div>

      <div
        ref={containerRef}
        className={cn("min-h-0 flex-1 overflow-auto", {
          "cursor-grabbing": dragging,
          "cursor-grab": !dragging,
        })}
        style={CHECKER_STYLE}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className={cn("flex min-h-full min-w-full items-center justify-center")}>
          <img
            src={dataUrl}
            alt={name}
            draggable={false}
            onLoad={(event) => {
              const img = event.currentTarget;
              setNatural({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            style={{ width: displayWidth, height: displayHeight, maxWidth: "none" }}
          />
        </div>
      </div>

      <div
        className={cn(
          "flex h-6 shrink-0 items-center gap-1.5 border-t border-border px-3 text-xs text-muted-foreground",
        )}
      >
        {natural && (
          <>
            <span>
              {natural.w} × {natural.h} px
            </span>
            <span>·</span>
          </>
        )}
        <span>{formatFileSize(data.size)}</span>
        <span>·</span>
        <span>{Math.round(effectiveZoom * 100)}%</span>
      </div>
    </div>
  );
}

export default ImageViewer;
