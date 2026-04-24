import { describe, expect, it } from "vitest";
import type { DiffContextGap } from "./context-gaps";
import {
  createLoadedContextLines,
  EMPTY_GAP_STATE,
  mergeGapLines,
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
      "all",
      20,
    );

    expect(plan).toBeNull();
  });

  it("plans tail loads from the remaining hidden range", () => {
    const tailPlan = planGapLoad(
      sampleGap,
      {
        ...EMPTY_GAP_STATE,
        headLines: createLoadedContextLines(sampleGap, 0, ["a", "b"]),
      },
      "tail",
      4,
    );

    expect(tailPlan).toEqual({
      startOffset: 8,
      requestedCount: 4,
      loadingKey: "loadingTail",
    });
  });

  it("dedupes merged rows when an overlapping payload slips through", () => {
    const existing = createLoadedContextLines(sampleGap, 0, ["line 1", "line 2"]);
    const overlapping = createLoadedContextLines(sampleGap, 1, ["line 2", "line 3"]);

    const merged = mergeGapLines(
      {
        ...EMPTY_GAP_STATE,
        headLines: existing,
      },
      "head",
      overlapping,
    );

    expect(merged.headLines.map((line) => line.key)).toEqual(["1-0", "1-1", "1-2"]);
    expect(merged.headLines.map((line) => line.content)).toEqual(["line 1", "line 2", "line 3"]);
  });
});
