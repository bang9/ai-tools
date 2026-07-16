import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import type { MouseEvent, ReactNode } from "react";
import { Allotment, type AllotmentHandle, type AllotmentProps } from "allotment";
import "allotment/dist/style.css";
import { cn } from "../../lib/cn";

type ResizablePanelGroupProps = Omit<
  AllotmentProps,
  | "children"
  | "className"
  | "defaultSizes"
  | "onChange"
  | "onDragStart"
  | "onDragEnd"
  | "onReset"
  | "sizes"
> & {
  children: ReactNode;
  className?: string;
  allotmentClassName?: string;
  ratios?: number[];
  onLayout?: (ratios: number[]) => void;
  onCommit?: (ratios: number[]) => void;
  /** Fires with `true` when a sash drag begins and `false` when it ends. */
  onDragStateChange?: (dragging: boolean) => void;
};

function toRatios(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total > 0 ? sizes.map((size) => size / total) : sizes;
}

function serializeRatios(ratios: number[] | undefined): string {
  return ratios?.map((ratio) => ratio.toFixed(6)).join(":") ?? "";
}

function toAllotmentSizes(ratios: number[] | undefined): number[] | undefined {
  return ratios?.length ? ratios.map((ratio) => ratio * 1000) : undefined;
}

const ResizablePanelGroupBase = forwardRef<AllotmentHandle, ResizablePanelGroupProps>(
  function ResizablePanelGroup(
    {
      children,
      className,
      allotmentClassName,
      ratios,
      onLayout,
      onCommit,
      onDragStateChange,
      ...props
    },
    ref,
  ) {
    const allotmentRef = useRef<AllotmentHandle | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const isDraggingRef = useRef(false);
    const pendingRatiosRef = useRef<number[] | null>(null);
    const resetPendingRef = useRef(false);
    const resetClearTimerRef = useRef<number | null>(null);
    const appliedRatiosRef = useRef("");
    const ratioSignature = serializeRatios(ratios);
    const defaultSizes = toAllotmentSizes(ratios);

    useImperativeHandle(
      ref,
      () => ({
        reset: () => {
          allotmentRef.current?.reset();
        },
        resize: (sizes) => {
          allotmentRef.current?.resize(sizes);
        },
      }),
      [],
    );

    const defaultSizesRef = useRef<number[] | undefined>(defaultSizes);

    useLayoutEffect(() => {
      defaultSizesRef.current = defaultSizes;
    }, [defaultSizes]);

    useLayoutEffect(() => {
      if (isDraggingRef.current || !allotmentRef.current) return;
      if (!defaultSizes || defaultSizes.length === 0) return;
      if (appliedRatiosRef.current === ratioSignature) return;

      allotmentRef.current.resize(defaultSizes);
      appliedRatiosRef.current = ratioSignature;
    }, [defaultSizes, ratioSignature]);

    // Re-apply the committed ratios whenever the container itself is resized
    // (window resize, fullscreen toggle, neighboring panel collapse). Allotment
    // clamps panes to their px minSize when the container is small, and its
    // proportional relayout carries that clamped distribution forward even
    // after space frees up — without this, ratios saved in a large window never
    // reappear once the group has mounted in a small one.
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      let frame: number | null = null;
      const observer = new ResizeObserver(() => {
        if (frame !== null) return;
        // rAF so the re-apply runs after Allotment's own proportional relayout
        // for the same resize, and so a continuous window drag coalesces.
        frame = requestAnimationFrame(() => {
          frame = null;
          if (isDraggingRef.current) return;
          const sizes = defaultSizesRef.current;
          if (!sizes || sizes.length === 0) return;
          allotmentRef.current?.resize(sizes);
        });
      });
      observer.observe(container);

      return () => {
        observer.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
      };
    }, []);

    const clearResetPending = useCallback(() => {
      if (resetClearTimerRef.current !== null) {
        window.clearTimeout(resetClearTimerRef.current);
        resetClearTimerRef.current = null;
      }
      resetPendingRef.current = false;
    }, []);

    useEffect(() => clearResetPending, [clearResetPending]);

    const commitRatios = useCallback(
      (nextRatios: number[]) => {
        appliedRatiosRef.current = serializeRatios(nextRatios);
        onCommit?.(nextRatios);
      },
      [onCommit],
    );

    const handleDragStart = useCallback(() => {
      isDraggingRef.current = true;
      pendingRatiosRef.current = null;
      clearResetPending();
      onDragStateChange?.(true);
    }, [clearResetPending, onDragStateChange]);

    const handleSashDoubleClickCapture = useCallback(
      (event: MouseEvent<HTMLDivElement>) => {
        if (!(event.target instanceof Element) || !event.target.closest("[data-testid='sash']")) {
          return;
        }

        // The current Allotment build treats onReset like an override, so we
        // detect sash double-clicks before the library performs its default reset.
        clearResetPending();
        resetPendingRef.current = true;
        resetClearTimerRef.current = window.setTimeout(() => {
          resetPendingRef.current = false;
          resetClearTimerRef.current = null;
        }, 0);
      },
      [clearResetPending],
    );

    const handleChange = useCallback(
      (sizes: number[]) => {
        if (sizes.length === 0) return;

        const nextRatios = toRatios(sizes);
        const signature = serializeRatios(nextRatios);
        if (signature === appliedRatiosRef.current) {
          return;
        }

        onLayout?.(nextRatios);

        if (isDraggingRef.current) {
          appliedRatiosRef.current = signature;
          pendingRatiosRef.current = nextRatios;
          return;
        }

        if (!resetPendingRef.current) {
          return;
        }

        clearResetPending();
        commitRatios(nextRatios);
      },
      [clearResetPending, commitRatios, onLayout],
    );

    const handleDragEnd = useCallback(
      (sizes: number[]) => {
        isDraggingRef.current = false;

        const finalRatios = sizes.length > 0 ? toRatios(sizes) : pendingRatiosRef.current;
        pendingRatiosRef.current = null;
        if (finalRatios && finalRatios.length > 0) {
          commitRatios(finalRatios);
        }
        clearResetPending();
        onDragStateChange?.(false);
      },
      [clearResetPending, commitRatios, onDragStateChange],
    );

    return (
      <div
        ref={containerRef}
        className={cn("h-full w-full", className)}
        onDoubleClickCapture={handleSashDoubleClickCapture}
      >
        <Allotment
          // Allotment fixes its SplitView orientation at construction; flipping
          // `vertical` on a live instance leaves views styled for the old axis
          // (zero-sized panes), so remount when the orientation changes.
          key={props.vertical ? "vertical" : "horizontal"}
          ref={allotmentRef}
          className={cn(allotmentClassName)}
          defaultSizes={defaultSizes}
          onDragStart={handleDragStart}
          onChange={handleChange}
          onDragEnd={handleDragEnd}
          {...props}
        >
          {children}
        </Allotment>
      </div>
    );
  },
);

export const ResizablePanelGroup = Object.assign(ResizablePanelGroupBase, {
  Pane: Allotment.Pane,
});

export default ResizablePanelGroup;
