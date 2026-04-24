import { ChevronDown, ChevronRight, ChevronUp, ChevronsUpDown, Copy } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileDiff } from "../../types";
import DiffHunk from "./DiffHunk";
import { cn } from "../../lib/cn";
import { useDiffStore } from "../../store/diff";
import { useToast } from "../../store/toast";
import { useLineSelection } from "../../hooks/useLineSelection";
import { runCommandSafely } from "../../lib/command";
import { getCommitDiffContext, getWorkingDiffContext } from "../../lib/platform";
import { buildContextGapSlots, type DiffContextGap } from "./context-gaps";
import {
  advanceGapLoadCount,
  clearGapLoading,
  createLoadedContextLines,
  getGapRemainingCount,
  getNextGapLoadCount,
  getGapState,
  isGapLoading,
  markGapLoading,
  mergeGapLines,
  planGapMiddleLoad,
  planGapLoad,
  type GapLoadDirection,
  type GapLoadState,
  type LoadedContextLine,
} from "./context-loading";

const EMPTY_SET = new Set<number>();
const GITHUB_DIFF_HEADER_BG = "var(--diff-hunk-bg)";
const GITHUB_DIFF_BORDER = "var(--color-border-light)";
const GITHUB_DIFF_MUTED = "var(--color-text-secondary)";
const GITHUB_DIFF_FOREGROUND = "var(--color-text)";
const GITHUB_DIFF_BUTTON_HOVER = "rgba(0, 0, 0, 0.045)";
const CONTEXT_GUIDE_BORDER = "2px solid transparent";
const CONTEXT_ROW_BACKGROUND = "transparent";
const CONTEXT_GUTTER_LINE_CLASS = "w-[32px] text-right pr-1.5 text-[11px] select-none";
const CONTEXT_GUTTER_MARKER_CLASS = "w-[18px] text-center select-none font-medium";
const CONTEXT_EXPAND_ROW_BACKGROUND = "rgba(9, 105, 218, 0.08)";
const MemoDiffHunk = memo(DiffHunk);

interface Props {
  diffs: FileDiff[];
  isStaged: boolean;
  isCommitView?: boolean;
  commitHash?: string;
}

export default function DiffViewer({ diffs, isStaged, isCommitView, commitHash }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedLines = useDiffStore((s) => s.selectedLines);
  const stageLines = useDiffStore((s) => s.stageLines);
  const unstageLines = useDiffStore((s) => s.unstageLines);
  const clearSelection = useDiffStore((s) => s.clearSelection);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        // Find first file with selected lines and act on those
        for (const diff of diffs) {
          const fileLines = selectedLines.get(diff.path);
          if (fileLines && fileLines.size > 0) {
            const linesByHunk = new Map<number, number[]>();
            for (const lineIdx of fileLines) {
              for (let hi = 0; hi < diff.hunks.length; hi++) {
                if (diff.hunks[hi].lines.some((l) => l.index === lineIdx)) {
                  const arr = linesByHunk.get(hi) ?? [];
                  arr.push(lineIdx);
                  linesByHunk.set(hi, arr);
                  break;
                }
              }
            }
            const action = isStaged ? unstageLines : stageLines;
            for (const [hunkIdx, lines] of linesByHunk) {
              action(diff.path, hunkIdx, lines);
            }
            break;
          }
        }
      }
      if (e.key === "Escape") {
        clearSelection();
      }
    },
    [diffs, selectedLines, isStaged, stageLines, unstageLines, clearSelection],
  );

  if (diffs.length === 0) {
    return (
      <div className={cn("flex items-center justify-center h-full")}>
        <span className={cn("text-sm text-muted-foreground")}>Select files to view diff</span>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn("h-full overflow-y-auto outline-none")}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        // Click on empty space (not on a gutter line or button) clears line selection
        if (!(e.target as HTMLElement).closest("[data-gutter-line]")) {
          clearSelection();
        }
      }}
    >
      {diffs.map((diff, fi) => (
        <FileDiffSection
          key={diff.path}
          diff={diff}
          isFirst={fi === 0}
          isStaged={isStaged}
          isCommitView={isCommitView}
          commitHash={commitHash}
          selectedLines={selectedLines.get(diff.path) ?? EMPTY_SET}
          containerRef={containerRef}
        />
      ))}
    </div>
  );
}

function FileDiffSection({
  diff,
  isFirst,
  isStaged,
  isCommitView,
  commitHash,
  selectedLines,
  containerRef,
}: {
  diff: FileDiff;
  isFirst: boolean;
  isStaged: boolean;
  isCommitView?: boolean;
  commitHash?: string;
  selectedLines: Set<number>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { handleGutterClick: rawGutterClick, handleGutterMouseDown, handleGutterMouseEnter, handleGutterMouseUp } =
    useLineSelection(diff.path);

  const handleGutterClick = useCallback(
    (lineIndex: number, shiftKey: boolean) => {
      rawGutterClick(lineIndex, shiftKey);
      containerRef.current?.focus();
    },
    [rawGutterClick, containerRef],
  );

  const worktreePath = useDiffStore((s) => s.worktreePath);
  const { toast } = useToast();
  const gapSlots = useMemo(() => buildContextGapSlots(diff), [diff]);
  const [gapStates, setGapStates] = useState<Record<number, GapLoadState>>({});
  const gapStatesRef = useRef<Record<number, GapLoadState>>({});
  const [collapsed, setCollapsed] = useState(false);
  const gapStateIdentity = useMemo(
    () =>
      JSON.stringify({
        path: diff.path,
        oldPath: diff.oldPath ?? null,
        status: diff.status,
        displayLineCount: diff.displayLineCount,
        isCommitView: Boolean(isCommitView),
        isStaged,
        commitHash: commitHash ?? null,
        gaps: gapSlots.map((gap) =>
          gap ? [gap.slot, gap.count, gap.displayStart, gap.oldStart, gap.newStart] : null,
        ),
      }),
    [commitHash, diff.displayLineCount, diff.oldPath, diff.path, diff.status, gapSlots, isCommitView, isStaged],
  );
  const gapStateIdentityRef = useRef(gapStateIdentity);

  useEffect(() => {
    if (gapStateIdentityRef.current === gapStateIdentity) {
      return;
    }
    gapStateIdentityRef.current = gapStateIdentity;
    gapStatesRef.current = {};
    setGapStates({});
  }, [gapStateIdentity]);

  const updateGapStates = useCallback((updater: (prev: Record<number, GapLoadState>) => Record<number, GapLoadState>) => {
    const next = updater(gapStatesRef.current);
    gapStatesRef.current = next;
    setGapStates(next);
  }, []);

  const fetchGapLines = useCallback(
    (startLine: number, count: number) => {
      if (!worktreePath) {
        return Promise.resolve<string[]>([]);
      }

      if (isCommitView) {
        if (!commitHash) {
          return Promise.resolve<string[]>([]);
        }
        return getCommitDiffContext(worktreePath, commitHash, diff.path, diff.oldPath ?? null, startLine, count);
      }

      return getWorkingDiffContext(worktreePath, isStaged ? `staged:${diff.path}` : diff.path, startLine, count);
    },
    [commitHash, diff.oldPath, diff.path, isCommitView, isStaged, worktreePath],
  );

  const loadGapContext = useCallback(
    async (gap: DiffContextGap, direction: GapLoadDirection) => {
      if (!worktreePath) {
        return;
      }

      const currentState = getGapState(gapStatesRef.current, gap.slot);
      const requestPlan = planGapLoad(gap, currentState, direction);
      if (!requestPlan) {
        return;
      }

      updateGapStates((prev) => ({
        ...prev,
        [gap.slot]: markGapLoading(getGapState(prev, gap.slot), requestPlan),
      }));

      const startLine = gap.displayStart + requestPlan.startOffset;
      const loaded = await runCommandSafely(() => fetchGapLines(startLine, requestPlan.requestedCount), {
        errorToast: "Failed to load diff context",
      });

      updateGapStates((prev) => {
        const nextState = getGapState(prev, gap.slot);
        if (!loaded) {
          return {
            ...prev,
            [gap.slot]: clearGapLoading(nextState),
          };
        }

        return {
          ...prev,
          [gap.slot]: advanceGapLoadCount(
            mergeGapLines(
              nextState,
              gap,
              direction,
              createLoadedContextLines(gap, requestPlan.startOffset, loaded),
            ),
          ),
        };
      });
    },
    [fetchGapLines, updateGapStates, worktreePath],
  );

  const loadGapContextAround = useCallback(
    async (gap: DiffContextGap) => {
      if (!worktreePath) {
        return;
      }

      const currentState = getGapState(gapStatesRef.current, gap.slot);
      const requestPlan = planGapMiddleLoad(gap, currentState);
      if (!requestPlan) {
        return;
      }

      updateGapStates((prev) => ({
        ...prev,
        [gap.slot]: {
          ...getGapState(prev, gap.slot),
          loadingHead: Boolean(requestPlan.head),
          loadingTail: Boolean(requestPlan.tail),
        },
      }));

      const [loadedHead, loadedTail] = await Promise.all([
        requestPlan.head
          ? runCommandSafely(
              () => fetchGapLines(gap.displayStart + requestPlan.head!.startOffset, requestPlan.head!.requestedCount),
              { errorToast: "Failed to load diff context" },
            )
          : Promise.resolve(null),
        requestPlan.tail
          ? runCommandSafely(
              () => fetchGapLines(gap.displayStart + requestPlan.tail!.startOffset, requestPlan.tail!.requestedCount),
              { errorToast: "Failed to load diff context" },
            )
          : Promise.resolve(null),
      ]);

      updateGapStates((prev) => {
        const currentState = getGapState(prev, gap.slot);
        let nextState = currentState;
        const loadedAny = loadedHead !== null || loadedTail !== null;

        if (requestPlan.head && loadedHead) {
          nextState = mergeGapLines(
            nextState,
            gap,
            "head",
            createLoadedContextLines(gap, requestPlan.head.startOffset, loadedHead),
          );
        }

        if (requestPlan.tail && loadedTail) {
          nextState = mergeGapLines(
            nextState,
            gap,
            "tail",
            createLoadedContextLines(gap, requestPlan.tail.startOffset, loadedTail),
          );
        }

        return {
          ...prev,
          [gap.slot]: clearGapLoading(loadedAny ? advanceGapLoadCount(nextState) : nextState),
        };
      });
    },
    [fetchGapLines, updateGapStates, worktreePath],
  );

  const added = diff.hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === "add").length, 0);
  const removed = diff.hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === "remove").length, 0);
  const diffStatSquares = useMemo(() => buildDiffStatSquares(added, removed), [added, removed]);

  const handleCopyPath = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();

      if (!navigator.clipboard) {
        toast("error", "Clipboard is unavailable");
        return;
      }

      try {
        await navigator.clipboard.writeText(diff.path);
        toast("success", "Copied file path");
      } catch {
        toast("error", "Failed to copy file path");
      }
    },
    [diff.path, toast],
  );

  return (
    <div
      className={cn({ "mt-2": !isFirst })}
      style={{ border: `1px solid ${GITHUB_DIFF_BORDER}` }}
    >
      <div
        className={cn("sticky top-0 z-10 flex items-center gap-3 px-2 py-1.5")}
        style={{
          background: GITHUB_DIFF_HEADER_BG,
          borderBottom: collapsed ? "none" : `1px solid ${GITHUB_DIFF_BORDER}`,
        }}
      >
        <button
          type="button"
          className={cn("flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-sm transition-colors cursor-pointer")}
          style={{ color: GITHUB_DIFF_MUTED }}
          onClick={() => setCollapsed((prev) => !prev)}
          aria-label={collapsed ? "Expand file" : "Collapse file"}
          onMouseEnter={(event) => {
            event.currentTarget.style.backgroundColor = GITHUB_DIFF_BUTTON_HOVER;
            event.currentTarget.style.color = GITHUB_DIFF_FOREGROUND;
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.backgroundColor = "transparent";
            event.currentTarget.style.color = GITHUB_DIFF_MUTED;
          }}
        >
          {collapsed ? <ChevronRight size={15} strokeWidth={2.2} /> : <ChevronDown size={15} strokeWidth={2.2} />}
        </button>

        <div className={cn("min-w-0 flex flex-1 items-center gap-1 overflow-hidden")}>
          <h3 className={cn("min-w-0 flex-1 truncate")}>
            <code className={cn("block truncate font-mono text-[11px]")} style={{ color: GITHUB_DIFF_FOREGROUND }}>
              {diff.path}
            </code>
          </h3>
          <button
            type="button"
            className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm transition-colors cursor-pointer")}
            style={{ color: GITHUB_DIFF_MUTED }}
            onClick={handleCopyPath}
            aria-label="Copy file path"
            onMouseEnter={(event) => {
              event.currentTarget.style.backgroundColor = GITHUB_DIFF_BUTTON_HOVER;
              event.currentTarget.style.color = GITHUB_DIFF_FOREGROUND;
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.backgroundColor = "transparent";
              event.currentTarget.style.color = GITHUB_DIFF_MUTED;
            }}
          >
            <Copy size={13} strokeWidth={2} />
          </button>
        </div>

        <div className={cn("ml-auto flex shrink-0 items-center gap-2")}>
          <div className={cn("flex items-center gap-1.5")}>
            <span className={cn("text-[11px] font-semibold tabular-nums")} style={{ color: "rgba(63, 185, 80, 0.95)" }}>
              +{added}
            </span>
            <span className={cn("text-[11px] font-semibold tabular-nums")} style={{ color: "rgba(248, 81, 73, 0.95)" }}>
              -{removed}
            </span>
          </div>
          <div className={cn("flex items-center gap-0.5")}>
            {diffStatSquares.map((kind, index) => (
              <span
                key={`${kind}-${index}`}
                className={cn("h-[8px] w-[8px] rounded-[2px]")}
                style={{
                  backgroundColor: getDiffStatSquareColor(kind),
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {!collapsed &&
        diff.hunks.map((hunk, i) => {
          const gap = gapSlots[i];

          return (
            <Fragment key={`${diff.path}-${i}`}>
              {gap && (
                <ContextGapSection
                  gap={gap}
                  state={getGapState(gapStates, i)}
                  maxSlot={gapSlots.length - 1}
                  label={diff.hunks[i]?.header}
                  onLoadHead={() => loadGapContext(gap, "head")}
                  onLoadTail={() => loadGapContext(gap, "tail")}
                  onLoadMiddle={() => loadGapContextAround(gap)}
                />
              )}
              <MemoDiffHunk
                key={`${hunk.header}-${i}`}
                hunk={hunk}
                isFirst={false}
                isConflicted={diff.status === "conflicted"}
                selectedLines={selectedLines}
                onGutterClick={handleGutterClick}
                onGutterMouseDown={handleGutterMouseDown}
                onGutterMouseEnter={handleGutterMouseEnter}
                onGutterMouseUp={handleGutterMouseUp}
              />
            </Fragment>
          );
        })}
      {!collapsed && gapSlots[diff.hunks.length] && (
        <ContextGapSection
          gap={gapSlots[diff.hunks.length] as DiffContextGap}
          state={getGapState(gapStates, diff.hunks.length)}
          maxSlot={gapSlots.length - 1}
          onLoadHead={() => loadGapContext(gapSlots[diff.hunks.length] as DiffContextGap, "head")}
          onLoadTail={() => loadGapContext(gapSlots[diff.hunks.length] as DiffContextGap, "tail")}
          onLoadMiddle={() => loadGapContextAround(gapSlots[diff.hunks.length] as DiffContextGap)}
        />
      )}
    </div>
  );
}

function ContextGapSection({
  gap,
  state,
  maxSlot,
  label,
  onLoadHead,
  onLoadTail,
  onLoadMiddle,
}: {
  gap: DiffContextGap;
  state: GapLoadState;
  maxSlot: number;
  label?: string;
  onLoadHead: () => void;
  onLoadTail: () => void;
  onLoadMiddle: () => void;
}) {
  const isLeading = gap.slot === 0;
  const isTrailing = gap.slot === maxSlot;
  const remainingCount = getGapRemainingCount(gap, state);
  const loading = isGapLoading(state);
  const hasRemaining = remainingCount > 0;
  const isMiddle = !isLeading && !isTrailing;
  const hasPartialMiddleContext = state.headLines.length > 0 || state.tailLines.length > 0;
  const nextLoadCount = Math.min(getNextGapLoadCount(state), remainingCount);

  if (isLeading) {
    return (
      <div>
        {hasRemaining && (
          <ContextExpandRow
            direction="up"
            label={label}
            loadCount={nextLoadCount}
            onClick={onLoadTail}
            disabled={loading}
          />
        )}
        {state.tailLines.length > 0 && <ContextRows lines={state.tailLines} />}
      </div>
    );
  }

  if (isTrailing) {
    return (
      <div>
        {state.headLines.length > 0 && <ContextRows lines={state.headLines} />}
        {hasRemaining && (
          <ContextExpandRow direction="down" loadCount={nextLoadCount} onClick={onLoadHead} disabled={loading} />
        )}
      </div>
    );
  }

  return (
    <div>
      {state.headLines.length > 0 && <ContextRows lines={state.headLines} />}
      {isMiddle && hasRemaining && !hasPartialMiddleContext && (
        <ContextExpandRow
          direction="middle"
          label={label}
          loadCount={nextLoadCount}
          onClick={onLoadMiddle}
          disabled={loading}
        />
      )}
      {isMiddle && hasRemaining && hasPartialMiddleContext && (
        <ContextExpandRow
          direction="down"
          label={label}
          loadCount={nextLoadCount}
          onClick={onLoadHead}
          disabled={loading}
        />
      )}
      {isMiddle && hasRemaining && hasPartialMiddleContext && state.tailLines.length > 0 && (
        <ContextExpandRow direction="up" loadCount={nextLoadCount} onClick={onLoadTail} disabled={loading} />
      )}
      {state.tailLines.length > 0 && <ContextRows lines={state.tailLines} />}
    </div>
  );
}

function ContextExpandRow({
  direction,
  label,
  loadCount,
  onClick,
  disabled,
}: {
  direction: "up" | "down" | "middle";
  label?: string;
  loadCount: number;
  onClick: () => void;
  disabled?: boolean;
}) {
  let Icon = ChevronsUpDown;
  let ariaLabel = `Load ${loadCount} more lines above and below`;

  if (direction === "up") {
    Icon = ChevronUp;
    ariaLabel = `Load ${loadCount} more lines above`;
  } else if (direction === "down") {
    Icon = ChevronDown;
    ariaLabel = `Load ${loadCount} more lines below`;
  }

  return (
    <div
      className={cn("flex items-center gap-2 px-3 py-1.5 select-none")}
      style={{
        background: CONTEXT_EXPAND_ROW_BACKGROUND,
      }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        className={cn(
          "flex items-center justify-center w-[18px] h-[18px] shrink-0 rounded-sm",
          "transition-colors",
          "disabled:opacity-45 disabled:cursor-default cursor-pointer",
        )}
        style={{ color: GITHUB_DIFF_MUTED }}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        disabled={disabled}
        onMouseEnter={(event) => {
          event.currentTarget.style.backgroundColor = GITHUB_DIFF_BUTTON_HOVER;
          event.currentTarget.style.color = GITHUB_DIFF_FOREGROUND;
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.backgroundColor = "transparent";
          event.currentTarget.style.color = GITHUB_DIFF_MUTED;
        }}
      >
        <Icon size={14} strokeWidth={2} />
      </button>
      <span className={cn("min-w-0 flex-1 truncate font-mono text-[11px]")} style={{ color: GITHUB_DIFF_MUTED }}>
        {label}
      </span>
    </div>
  );
}

function ContextRows({ lines }: { lines: LoadedContextLine[] }) {
  return (
    <div className="flex" style={{ backgroundColor: CONTEXT_ROW_BACKGROUND }}>
      <div className="shrink-0" style={{ borderLeft: CONTEXT_GUIDE_BORDER }}>
        {lines.map((line) => (
          <div
            key={line.key}
            className={cn("flex min-h-[20px] leading-[20px] font-mono text-[12px]")}
            style={{ backgroundColor: CONTEXT_ROW_BACKGROUND }}
          >
            <span
              className={cn(CONTEXT_GUTTER_LINE_CLASS)}
              style={{ color: "rgba(139, 148, 158, 0.72)" }}
            >
              {line.oldLineNumber}
            </span>
            <span
              className={cn(CONTEXT_GUTTER_LINE_CLASS)}
              style={{ color: "rgba(139, 148, 158, 0.72)" }}
            >
              {line.newLineNumber}
            </span>
            <span
              className={cn(CONTEXT_GUTTER_MARKER_CLASS)}
              style={{ color: "rgba(139, 148, 158, 0.5)" }}
            >
              {" "}
            </span>
          </div>
        ))}
      </div>
      <div className={cn("flex-1 overflow-x-auto overflow-y-hidden diff-line-content")}>
        <div className={cn("min-w-full w-max")} style={{ backgroundColor: CONTEXT_ROW_BACKGROUND }}>
          {lines.map((line) => (
            <div
              key={line.key}
              className={cn("min-h-[20px] w-full leading-[20px] font-mono text-[12px] whitespace-pre pr-3")}
              style={{ color: GITHUB_DIFF_FOREGROUND }}
            >
              {line.content}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type DiffStatSquareKind = "add" | "remove" | "neutral";

function buildDiffStatSquares(added: number, removed: number): DiffStatSquareKind[] {
  const total = added + removed;
  const squareCount = 5;

  if (total <= 0) {
    return Array.from({ length: squareCount }, () => "neutral");
  }

  let addSquares = Math.round((added / total) * squareCount);
  let removeSquares = Math.round((removed / total) * squareCount);

  if (added > 0 && addSquares === 0) {
    addSquares = 1;
  }
  if (removed > 0 && removeSquares === 0) {
    removeSquares = 1;
  }

  while (addSquares + removeSquares > squareCount) {
    if (addSquares >= removeSquares && addSquares > 1) {
      addSquares -= 1;
      continue;
    }
    if (removeSquares > 1) {
      removeSquares -= 1;
      continue;
    }
    break;
  }

  const neutralSquares = Math.max(0, squareCount - addSquares - removeSquares);

  return [
    ...Array.from({ length: addSquares }, () => "add" as const),
    ...Array.from({ length: removeSquares }, () => "remove" as const),
    ...Array.from({ length: neutralSquares }, () => "neutral" as const),
  ];
}

function getDiffStatSquareColor(kind: DiffStatSquareKind): string {
  if (kind === "add") {
    return "rgba(63, 185, 80, 0.95)";
  }
  if (kind === "remove") {
    return "rgba(248, 81, 73, 0.9)";
  }
  return "rgba(255, 255, 255, 0.12)";
}
