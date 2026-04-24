import type { FileDiff } from "../../types";

export interface DiffContextGap {
  slot: number;
  count: number;
  displayStart: number;
  oldStart: number;
  newStart: number;
}

export function buildContextGapSlots(diff: FileDiff): Array<DiffContextGap | null> {
  if (diff.hunks.length === 0) {
    return [];
  }

  const slots = Array.from({ length: diff.hunks.length + 1 }, () => null as DiffContextGap | null);
  if (diff.status === "added" || diff.status === "deleted") {
    return slots;
  }

  const firstHunk = diff.hunks[0];
  const leadingCount = sharedGapCount(firstHunk.oldStart - 1, firstHunk.newStart - 1);
  if (leadingCount > 0) {
    slots[0] = {
      slot: 0,
      count: leadingCount,
      displayStart: 1,
      oldStart: 1,
      newStart: 1,
    };
  }

  for (let index = 0; index < diff.hunks.length - 1; index += 1) {
    const current = diff.hunks[index];
    const next = diff.hunks[index + 1];
    const oldStart = current.oldStart + current.oldCount;
    const newStart = current.newStart + current.newCount;
    const gapCount = sharedGapCount(next.oldStart - oldStart, next.newStart - newStart);

    if (gapCount > 0) {
      slots[index + 1] = {
        slot: index + 1,
        count: gapCount,
        displayStart: newStart,
        oldStart,
        newStart,
      };
    }
  }

  const lastHunk = diff.hunks[diff.hunks.length - 1];
  const displayEnd = lastHunk.newStart + lastHunk.newCount - 1;
  const trailingCount = Math.max(diff.displayLineCount - displayEnd, 0);
  if (trailingCount > 0) {
    slots[diff.hunks.length] = {
      slot: diff.hunks.length,
      count: trailingCount,
      displayStart: displayEnd + 1,
      oldStart: lastHunk.oldStart + lastHunk.oldCount,
      newStart: lastHunk.newStart + lastHunk.newCount,
    };
  }

  return slots;
}

function sharedGapCount(oldGapCount: number, newGapCount: number): number {
  if (oldGapCount <= 0 || newGapCount <= 0) {
    return 0;
  }

  return Math.min(oldGapCount, newGapCount);
}
