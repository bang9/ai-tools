import { Fragment, memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileDiff } from "../../types";
import DiffHunk from "./DiffHunk";
import { cn } from "../../lib/cn";
import { useDiffStore } from "../../store/diff";
import { useLineSelection } from "../../hooks/useLineSelection";
import { runCommandSafely } from "../../lib/command";
import { getCommitDiffContext, getWorkingDiffContext } from "../../lib/platform";
import { buildContextGapSlots, type DiffContextGap } from "./context-gaps";
import {
  clearGapLoading,
  createLoadedContextLines,
  getGapRemainingCount,
  getGapState,
  isGapLoading,
  markGapLoading,
  mergeGapLines,
  planGapLoad,
  type GapLoadDirection,
  type GapLoadPlan,
  type GapLoadState,
  type LoadedContextLine,
} from "./context-loading";

const EMPTY_SET = new Set<number>();
const CONTEXT_LOAD_STEP = 20;
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

  const stageHunk = useDiffStore((s) => s.stageHunk);
  const unstageHunk = useDiffStore((s) => s.unstageHunk);
  const discardHunk = useDiffStore((s) => s.discardHunk);
  const stageLines = useDiffStore((s) => s.stageLines);
  const unstageLines = useDiffStore((s) => s.unstageLines);
  const worktreePath = useDiffStore((s) => s.worktreePath);
  const gapSlots = useMemo(() => buildContextGapSlots(diff), [diff]);
  const [gapStates, setGapStates] = useState<Record<number, GapLoadState>>({});
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
    setGapStates({});
  }, [gapStateIdentity]);

  const loadGapContext = useCallback(
    async (gap: DiffContextGap, direction: GapLoadDirection) => {
      if (!worktreePath) {
        return;
      }

      const planRef: { current: GapLoadPlan | null } = { current: null };
      setGapStates((prev) => {
        const currentState = getGapState(prev, gap.slot);
        planRef.current = planGapLoad(gap, currentState, direction, CONTEXT_LOAD_STEP);
        if (!planRef.current) {
          return prev;
        }
        return {
          ...prev,
          [gap.slot]: markGapLoading(currentState, planRef.current),
        };
      });

      const requestPlan = planRef.current;
      if (!requestPlan) {
        return;
      }
      const startLine = gap.displayStart + requestPlan.startOffset;

      const fetchLines = isCommitView
        ? () => {
            if (!commitHash) {
              return Promise.resolve<string[]>([]);
            }
            return getCommitDiffContext(
              worktreePath,
              commitHash,
              diff.path,
              diff.oldPath ?? null,
              startLine,
              requestPlan.requestedCount,
            );
          }
        : () =>
            getWorkingDiffContext(
              worktreePath,
              isStaged ? `staged:${diff.path}` : diff.path,
              startLine,
              requestPlan.requestedCount,
            );

      const loaded = await runCommandSafely(fetchLines, {
        errorToast: "Failed to load diff context",
      });

      setGapStates((prev) => {
        const nextState = getGapState(prev, gap.slot);
        if (!loaded) {
          return {
            ...prev,
            [gap.slot]: clearGapLoading(nextState),
          };
        }

        return {
            ...prev,
            [gap.slot]: mergeGapLines(
              nextState,
              direction,
              createLoadedContextLines(gap, requestPlan.startOffset, loaded),
            ),
          };
        });
    },
    [commitHash, diff.oldPath, diff.path, isCommitView, isStaged, worktreePath],
  );

  const added = diff.hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === "add").length, 0);
  const removed = diff.hunks.reduce((s, h) => s + h.lines.filter((l) => l.type === "remove").length, 0);

  const statusColor: Record<string, string> = {
    modified: "rgba(234, 179, 8, 0.7)",
    added: "rgba(63, 185, 80, 0.7)",
    deleted: "rgba(248, 81, 73, 0.7)",
    renamed: "rgba(99, 163, 255, 0.7)",
    untracked: "rgba(63, 185, 80, 0.7)",
  };

  return (
    <div className={cn({ "mt-2": !isFirst })}>
      {/* File header */}
      <div
        className={cn("flex items-center gap-1.5 px-3 py-1.5 sticky top-0 z-10")}
        style={{ background: "rgba(99, 163, 255, 0.06)", borderBottom: "1px solid rgba(255, 255, 255, 0.06)" }}
      >
        <span
          className={cn("text-[10px] font-semibold uppercase")}
          style={{ color: statusColor[diff.status] ?? "rgba(255, 255, 255, 0.4)" }}
        >
          {diff.status[0]}
        </span>
        <span className={cn("text-[11px] text-muted-foreground truncate flex-1 font-sans")}>
          {diff.path}
        </span>
        <span className={cn("text-[10px] text-muted-foreground/40 shrink-0")}>
          {added > 0 && `+${added}`}{added > 0 && removed > 0 && " "}{removed > 0 && `-${removed}`}
        </span>
      </div>

      {/* Hunks */}
      {diff.hunks.map((hunk, i) => {
        const gap = gapSlots[i];

        return (
          <Fragment key={`${diff.path}-${i}`}>
            {gap && (
              <ContextGapSection
                gap={gap}
                state={getGapState(gapStates, i)}
                maxSlot={gapSlots.length - 1}
                onLoadHead={() => loadGapContext(gap, "head")}
                onLoadTail={() => loadGapContext(gap, "tail")}
                onLoadAll={() => loadGapContext(gap, "all")}
              />
            )}
            <MemoDiffHunk
              key={`${hunk.header}-${i}`}
              hunk={hunk}
              hunkIndex={i}
              filePath={diff.path}
              isFirst={false}
              selectedLines={selectedLines}
              isStaged={isStaged}
              onStageHunk={isCommitView ? undefined : stageHunk}
              onUnstageHunk={isCommitView ? undefined : unstageHunk}
              onDiscardHunk={isCommitView ? undefined : discardHunk}
              onStageLines={isCommitView ? undefined : stageLines}
              onUnstageLines={isCommitView ? undefined : unstageLines}
              onGutterClick={handleGutterClick}
              onGutterMouseDown={handleGutterMouseDown}
              onGutterMouseEnter={handleGutterMouseEnter}
              onGutterMouseUp={handleGutterMouseUp}
            />
          </Fragment>
        );
      })}
      {gapSlots[diff.hunks.length] && (
        <ContextGapSection
          gap={gapSlots[diff.hunks.length] as DiffContextGap}
          state={getGapState(gapStates, diff.hunks.length)}
          maxSlot={gapSlots.length - 1}
          onLoadHead={() => loadGapContext(gapSlots[diff.hunks.length] as DiffContextGap, "head")}
          onLoadTail={() => loadGapContext(gapSlots[diff.hunks.length] as DiffContextGap, "tail")}
          onLoadAll={() => loadGapContext(gapSlots[diff.hunks.length] as DiffContextGap, "all")}
        />
      )}
    </div>
  );
}

function ContextGapSection({
  gap,
  state,
  maxSlot,
  onLoadHead,
  onLoadTail,
  onLoadAll,
}: {
  gap: DiffContextGap;
  state: GapLoadState;
  maxSlot: number;
  onLoadHead: () => void;
  onLoadTail: () => void;
  onLoadAll: () => void;
}) {
  const isLeading = gap.slot === 0;
  const isTrailing = gap.slot === maxSlot;
  const remainingCount = getGapRemainingCount(gap, state);
  const buttonCount = Math.min(CONTEXT_LOAD_STEP, remainingCount);
  const showLoadAll = remainingCount > buttonCount;
  const loading = isGapLoading(state);
  let controls: ReactNode;
  if (isLeading) {
    controls = (
      <ContextButton
        onClick={onLoadTail}
        disabled={loading}
        label={`Load ${buttonCount} lines above`}
      />
    );
  } else if (isTrailing) {
    controls = (
      <ContextButton
        onClick={onLoadHead}
        disabled={loading}
        label={`Load ${buttonCount} lines below`}
      />
    );
  } else {
    controls = (
      <>
        <ContextButton
          onClick={onLoadHead}
          disabled={loading}
          label={`Load ${buttonCount} below`}
        />
        {showLoadAll && (
          <ContextButton
            onClick={onLoadAll}
            disabled={loading}
            label={`Load all ${remainingCount} lines`}
          />
        )}
        <ContextButton
          onClick={onLoadTail}
          disabled={loading}
          label={`Load ${buttonCount} above`}
        />
      </>
    );
  }

  return (
    <div className={cn("border-t border-border/40")}>
      {state.headLines.length > 0 && <ContextRows lines={state.headLines} />}
      {remainingCount > 0 && (
        <div
          className={cn("flex items-center justify-center gap-2 px-3 py-2 text-[11px]")}
          style={{ background: "rgba(99, 163, 255, 0.03)" }}
        >
          {controls}
          {(isLeading || isTrailing) && showLoadAll && (
            <ContextButton
              onClick={onLoadAll}
              disabled={loading}
              label={`Load all ${remainingCount} lines`}
            />
          )}
        </div>
      )}
      {state.tailLines.length > 0 && <ContextRows lines={state.tailLines} />}
    </div>
  );
}

function ContextButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        "px-2 py-1 rounded border border-border bg-secondary/40 text-muted-foreground",
        "hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-default cursor-pointer",
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </button>
  );
}

function ContextRows({ lines }: { lines: LoadedContextLine[] }) {
  return (
    <div className="flex" style={{ backgroundColor: "rgba(99, 163, 255, 0.02)" }}>
      <div className="shrink-0" style={{ borderLeft: "2px solid rgba(99, 163, 255, 0.18)" }}>
        {lines.map((line) => (
          <div
            key={line.key}
            className={cn("flex min-h-[20px] leading-[20px] font-mono text-[12px]")}
            style={{ backgroundColor: "rgba(99, 163, 255, 0.02)" }}
          >
            <span
              className={cn("w-[32px] text-right pr-1.5 text-[11px] select-none")}
              style={{ color: "rgba(255, 255, 255, 0.15)" }}
            >
              {line.oldLineNumber}
            </span>
            <span
              className={cn("w-[32px] text-right pr-1.5 text-[11px] select-none")}
              style={{ color: "rgba(255, 255, 255, 0.15)" }}
            >
              {line.newLineNumber}
            </span>
            <span
              className={cn("w-[18px] text-center select-none font-medium")}
              style={{ color: "rgba(255, 255, 255, 0.12)" }}
            >
              {" "}
            </span>
          </div>
        ))}
      </div>
      <div className={cn("flex-1 overflow-x-auto overflow-y-hidden diff-line-content")}>
        <div style={{ backgroundColor: "rgba(99, 163, 255, 0.02)" }}>
          {lines.map((line) => (
            <div
              key={line.key}
              className={cn("min-h-[20px] leading-[20px] font-mono text-[12px] whitespace-pre pr-3 text-foreground/75")}
            >
              {line.content}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
