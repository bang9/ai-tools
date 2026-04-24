import { describe, expect, it } from "vitest";
import type { DiffContextGap } from "./context-gaps";
import {
  advanceGapLoadCount,
  createLoadedContextLines,
  EMPTY_GAP_STATE,
  getGapRemainingCount,
  getNextGapLoadCount,
  mergeGapLines,
  planGapMiddleLoad,
  planGapLoad,
} from "./context-loading";

const sampleGap: DiffContextGap = {
  slot: 1,
  count: 12,
  displayStart: 20,
  oldStart: 20,
  newStart: 20,
};

describe("context-loading", () => {
  it("blocks overlapping loads while a gap request is in flight", () => {
    const plan = planGapLoad(
      sampleGap,
      {
        ...EMPTY_GAP_STATE,
        loadingHead: true,
      },
      "head",
    );

    expect(plan).toBeNull();
  });

  it("plans tail loads from the remaining hidden range", () => {
    const tailPlan = planGapLoad(
      sampleGap,
      {
        ...EMPTY_GAP_STATE,
        headLines: createLoadedContextLines(sampleGap, 0, ["a", "b"]),
        headLoadedCount: 2,
      },
      "tail",
    );

    expect(tailPlan).toEqual({
      startOffset: 7,
      requestedCount: 5,
      loadingKey: "loadingTail",
    });
  });

  it("plans middle loads symmetrically without overlap", () => {
    const middlePlan = planGapMiddleLoad(
      sampleGap,
      {
        ...EMPTY_GAP_STATE,
        headLines: createLoadedContextLines(sampleGap, 0, ["a", "b"]),
        tailLines: createLoadedContextLines(sampleGap, 9, ["j", "k", "l"]),
        headLoadedCount: 2,
        tailLoadedCount: 3,
      },
    );

    expect(middlePlan).toEqual({
      head: {
        startOffset: 2,
        requestedCount: 4,
        loadingKey: "loadingHead",
      },
      tail: {
        startOffset: 6,
        requestedCount: 3,
        loadingKey: "loadingTail",
      },
    });
  });

  it("dedupes merged rows when an overlapping payload slips through", () => {
    const existing = createLoadedContextLines(sampleGap, 0, ["line 1", "line 2"]);
    const overlapping = createLoadedContextLines(sampleGap, 1, ["line 2", "line 3"]);

    const merged = mergeGapLines(
      {
        ...EMPTY_GAP_STATE,
        headLines: existing,
        headLoadedCount: existing.length,
      },
      sampleGap,
      "head",
      overlapping,
    );

    expect(merged.headLines.map((line) => line.key)).toEqual(["1-0", "1-1", "1-2"]);
    expect(merged.headLines.map((line) => line.content)).toEqual(["line 1", "line 2", "line 3"]);
    expect(merged.headLoadedCount).toBe(3);
  });

  it("uses tracked boundary counts instead of raw line-array lengths", () => {
    const state = {
      ...EMPTY_GAP_STATE,
      headLines: createLoadedContextLines(sampleGap, 0, ["a", "b", "c", "d", "e", "f", "g"]),
      tailLines: createLoadedContextLines(sampleGap, 7, ["h", "i", "j", "k", "l"]),
      headLoadedCount: 7,
      tailLoadedCount: 4,
    };

    expect(getGapRemainingCount(sampleGap, state)).toBe(1);
    expect(planGapLoad(sampleGap, state, "tail")).toEqual({
      startOffset: 7,
      requestedCount: 1,
      loadingKey: "loadingTail",
    });
  });

  it("continues planning loads after an initial middle expansion", () => {
    const middlePlan = planGapMiddleLoad(sampleGap, EMPTY_GAP_STATE);
    expect(middlePlan).not.toBeNull();

    let state = mergeGapLines(
      EMPTY_GAP_STATE,
      sampleGap,
      "head",
      createLoadedContextLines(sampleGap, middlePlan!.head!.startOffset, ["a", "b", "c", "d", "e"]),
    );
    state = mergeGapLines(
      state,
      sampleGap,
      "tail",
      createLoadedContextLines(sampleGap, middlePlan!.tail!.startOffset, ["h", "i", "j", "k", "l"]),
    );

    expect(getGapRemainingCount(sampleGap, state)).toBe(2);
    state = advanceGapLoadCount(state);

    expect(getNextGapLoadCount(state)).toBe(7);
    expect(planGapLoad(sampleGap, state, "head")).toEqual({
      startOffset: 5,
      requestedCount: 2,
      loadingKey: "loadingHead",
    });
  });

  it("grows the next load count from the previous two successful steps", () => {
    let state = EMPTY_GAP_STATE;
    const sequence = [getNextGapLoadCount(state)];

    for (let index = 0; index < 4; index += 1) {
      state = advanceGapLoadCount(state);
      sequence.push(getNextGapLoadCount(state));
    }

    expect(sequence).toEqual([5, 7, 12, 19, 31]);
  });
});
