import type { DiffContextGap } from "./context-gaps";

export interface LoadedContextLine {
  key: string;
  offset: number;
  content: string;
  oldLineNumber: number;
  newLineNumber: number;
}

export interface GapLoadState {
  headLines: LoadedContextLine[];
  tailLines: LoadedContextLine[];
  headLoadedCount: number;
  tailLoadedCount: number;
  loadingHead: boolean;
  loadingTail: boolean;
}

export type GapLoadDirection = "head" | "tail";

export interface GapLoadPlan {
  startOffset: number;
  requestedCount: number;
  loadingKey: keyof Pick<GapLoadState, "loadingHead" | "loadingTail">;
}

export interface GapMiddleLoadPlan {
  head: GapLoadPlan | null;
  tail: GapLoadPlan | null;
}

export const EMPTY_GAP_STATE: GapLoadState = {
  headLines: [],
  tailLines: [],
  headLoadedCount: 0,
  tailLoadedCount: 0,
  loadingHead: false,
  loadingTail: false,
};

export function getGapState(states: Record<number, GapLoadState>, slot: number): GapLoadState {
  return states[slot] ?? EMPTY_GAP_STATE;
}

export function isGapLoading(state: GapLoadState): boolean {
  return state.loadingHead || state.loadingTail;
}

export function getGapRemainingCount(gap: DiffContextGap, state: GapLoadState): number {
  return Math.max(gap.count - Math.min(gap.count, state.headLoadedCount + state.tailLoadedCount), 0);
}

export function planGapLoad(
  gap: DiffContextGap,
  state: GapLoadState,
  direction: GapLoadDirection,
  step: number,
): GapLoadPlan | null {
  if (isGapLoading(state)) {
    return null;
  }

  const remainingCount = getGapRemainingCount(gap, state);
  if (remainingCount <= 0) {
    return null;
  }

  if (direction === "head") {
    return {
      startOffset: state.headLoadedCount,
      requestedCount: Math.min(step, remainingCount),
      loadingKey: "loadingHead",
    };
  }

  if (direction === "tail") {
    const requestedCount = Math.min(step, remainingCount);
    return {
      startOffset: gap.count - state.tailLoadedCount - requestedCount,
      requestedCount,
      loadingKey: "loadingTail",
    };
  }

  return null;
}

export function planGapMiddleLoad(gap: DiffContextGap, state: GapLoadState, step: number): GapMiddleLoadPlan | null {
  if (isGapLoading(state)) {
    return null;
  }

  const remainingCount = getGapRemainingCount(gap, state);
  if (remainingCount <= 0) {
    return null;
  }

  const [headCount, tailCount] =
    remainingCount > step * 2
      ? [step, step]
      : [Math.ceil(remainingCount / 2), Math.floor(remainingCount / 2)];

  return {
    head:
      headCount > 0
        ? {
            startOffset: state.headLoadedCount,
            requestedCount: headCount,
            loadingKey: "loadingHead",
          }
        : null,
    tail:
      tailCount > 0
        ? {
            startOffset: gap.count - state.tailLoadedCount - tailCount,
            requestedCount: tailCount,
            loadingKey: "loadingTail",
          }
        : null,
  };
}

export function markGapLoading(state: GapLoadState, plan: GapLoadPlan): GapLoadState {
  return {
    ...state,
    loadingHead: false,
    loadingTail: false,
    [plan.loadingKey]: true,
  };
}

export function clearGapLoading(state: GapLoadState): GapLoadState {
  return {
    ...state,
    loadingHead: false,
    loadingTail: false,
  };
}

export function createLoadedContextLines(
  gap: DiffContextGap,
  startOffset: number,
  lines: string[],
): LoadedContextLine[] {
  return lines.map((content, index) => {
    const offset = startOffset + index;
    return {
      key: `${gap.slot}-${offset}`,
      offset,
      content,
      oldLineNumber: gap.oldStart + offset,
      newLineNumber: gap.newStart + offset,
    };
  });
}

export function mergeGapLines(
  state: GapLoadState,
  gap: DiffContextGap,
  direction: GapLoadDirection,
  lines: LoadedContextLine[],
): GapLoadState {
  let headLines = state.headLines;
  let tailLines = state.tailLines;
  let headLoadedCount = state.headLoadedCount;
  let tailLoadedCount = state.tailLoadedCount;

  if (direction === "head") {
    headLines = dedupeLoadedLines([...state.headLines, ...lines]);
    headLoadedCount = countContiguousHeadLines(headLines);
  } else {
    tailLines = dedupeLoadedLines([...lines, ...state.tailLines]);
    tailLoadedCount = countContiguousTailLines(gap.count, tailLines);
  }

  return {
    headLines,
    tailLines,
    headLoadedCount,
    tailLoadedCount,
    loadingHead: false,
    loadingTail: false,
  };
}

function dedupeLoadedLines(lines: LoadedContextLine[]): LoadedContextLine[] {
  const dedupedByOffset = new Map<number, LoadedContextLine>();

  for (const line of lines) {
    if (dedupedByOffset.has(line.offset)) {
      continue;
    }
    dedupedByOffset.set(line.offset, line);
  }

  return Array.from(dedupedByOffset.values()).sort((left, right) => left.offset - right.offset);
}

function countContiguousHeadLines(lines: LoadedContextLine[]): number {
  let nextOffset = 0;

  for (const line of lines) {
    if (line.offset !== nextOffset) {
      break;
    }
    nextOffset += 1;
  }

  return nextOffset;
}

function countContiguousTailLines(gapCount: number, lines: LoadedContextLine[]): number {
  let nextOffset = gapCount - 1;
  let loadedCount = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].offset !== nextOffset) {
      break;
    }
    nextOffset -= 1;
    loadedCount += 1;
  }

  return loadedCount;
}
