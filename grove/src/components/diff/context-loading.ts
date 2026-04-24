import type { DiffContextGap } from "./context-gaps";

export interface LoadedContextLine {
  key: string;
  content: string;
  oldLineNumber: number;
  newLineNumber: number;
}

export interface GapLoadState {
  headLines: LoadedContextLine[];
  tailLines: LoadedContextLine[];
  loadingHead: boolean;
  loadingTail: boolean;
  loadingAll: boolean;
}

export type GapLoadDirection = "head" | "tail" | "all";

export interface GapLoadPlan {
  startOffset: number;
  requestedCount: number;
  loadingKey: keyof Pick<GapLoadState, "loadingHead" | "loadingTail" | "loadingAll">;
}

export const EMPTY_GAP_STATE: GapLoadState = {
  headLines: [],
  tailLines: [],
  loadingHead: false,
  loadingTail: false,
  loadingAll: false,
};

export function getGapState(states: Record<number, GapLoadState>, slot: number): GapLoadState {
  return states[slot] ?? EMPTY_GAP_STATE;
}

export function isGapLoading(state: GapLoadState): boolean {
  return state.loadingHead || state.loadingTail || state.loadingAll;
}

export function getGapRemainingCount(gap: DiffContextGap, state: GapLoadState): number {
  return gap.count - state.headLines.length - state.tailLines.length;
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
      startOffset: state.headLines.length,
      requestedCount: Math.min(step, remainingCount),
      loadingKey: "loadingHead",
    };
  }

  if (direction === "tail") {
    const requestedCount = Math.min(step, remainingCount);
    return {
      startOffset: gap.count - state.tailLines.length - requestedCount,
      requestedCount,
      loadingKey: "loadingTail",
    };
  }

  return {
    startOffset: state.headLines.length,
    requestedCount: remainingCount,
    loadingKey: "loadingAll",
  };
}

export function markGapLoading(state: GapLoadState, plan: GapLoadPlan): GapLoadState {
  return {
    ...state,
    loadingHead: false,
    loadingTail: false,
    loadingAll: false,
    [plan.loadingKey]: true,
  };
}

export function clearGapLoading(state: GapLoadState): GapLoadState {
  return {
    ...state,
    loadingHead: false,
    loadingTail: false,
    loadingAll: false,
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
      content,
      oldLineNumber: gap.oldStart + offset,
      newLineNumber: gap.newStart + offset,
    };
  });
}

export function mergeGapLines(
  state: GapLoadState,
  direction: GapLoadDirection,
  lines: LoadedContextLine[],
): GapLoadState {
  let headLines = state.headLines;
  let tailLines = state.tailLines;

  if (direction === "head") {
    headLines = dedupeLoadedLines([...state.headLines, ...lines]);
  } else if (direction === "tail") {
    tailLines = dedupeLoadedLines([...lines, ...state.tailLines]);
  } else {
    headLines = dedupeLoadedLines([...state.headLines, ...lines, ...state.tailLines]);
    tailLines = [];
  }

  return {
    headLines,
    tailLines,
    loadingHead: false,
    loadingTail: false,
    loadingAll: false,
  };
}

function dedupeLoadedLines(lines: LoadedContextLine[]): LoadedContextLine[] {
  const seen = new Set<string>();
  const deduped: LoadedContextLine[] = [];

  for (const line of lines) {
    if (seen.has(line.key)) {
      continue;
    }
    seen.add(line.key);
    deduped.push(line);
  }

  return deduped;
}
