import { describe, expect, it } from "vitest";
import { buildContextGapSlots } from "./context-gaps";

describe("buildContextGapSlots", () => {
  it("builds leading, middle, and trailing gaps from hunk ranges", () => {
    const gaps = buildContextGapSlots({
      path: "src/app.ts",
      status: "modified",
      displayLineCount: 30,
      hunks: [
        {
          header: "@@ -5,4 +5,4 @@",
          oldStart: 5,
          oldCount: 4,
          newStart: 5,
          newCount: 4,
          lines: [],
        },
        {
          header: "@@ -20,3 +20,3 @@",
          oldStart: 20,
          oldCount: 3,
          newStart: 20,
          newCount: 3,
          lines: [],
        },
      ],
    });

    expect(gaps).toEqual([
      {
        slot: 0,
        count: 4,
        displayStart: 1,
        oldStart: 1,
        newStart: 1,
      },
      {
        slot: 1,
        count: 11,
        displayStart: 9,
        oldStart: 9,
        newStart: 9,
      },
      {
        slot: 2,
        count: 8,
        displayStart: 23,
        oldStart: 23,
        newStart: 23,
      },
    ]);
  });

  it("returns null slots for added files with no shared context", () => {
    const gaps = buildContextGapSlots({
      path: "src/new.ts",
      status: "added",
      displayLineCount: 10,
      hunks: [
        {
          header: "@@ -0,0 +1,10 @@",
          oldStart: 0,
          oldCount: 0,
          newStart: 1,
          newCount: 10,
          lines: [],
        },
      ],
    });

    expect(gaps).toEqual([null, null]);
  });

  it("returns no slots when a diff has no hunks", () => {
    const gaps = buildContextGapSlots({
      path: "src/empty.ts",
      status: "modified",
      displayLineCount: 0,
      hunks: [],
    });

    expect(gaps).toEqual([]);
  });

  it("returns null slots for deleted files", () => {
    const gaps = buildContextGapSlots({
      path: "src/old.ts",
      status: "deleted",
      displayLineCount: 0,
      hunks: [
        {
          header: "@@ -1,4 +0,0 @@",
          oldStart: 1,
          oldCount: 4,
          newStart: 0,
          newCount: 0,
          lines: [],
        },
      ],
    });

    expect(gaps).toEqual([null, null]);
  });

  it("uses the shared portion when old and new gaps are asymmetric", () => {
    const gaps = buildContextGapSlots({
      path: "src/shifted.ts",
      status: "modified",
      displayLineCount: 18,
      hunks: [
        {
          header: "@@ -3,2 +3,2 @@",
          oldStart: 3,
          oldCount: 2,
          newStart: 3,
          newCount: 2,
          lines: [],
        },
        {
          header: "@@ -10,2 +12,2 @@",
          oldStart: 10,
          oldCount: 2,
          newStart: 12,
          newCount: 2,
          lines: [],
        },
      ],
    });

    expect(gaps).toEqual([
      {
        slot: 0,
        count: 2,
        displayStart: 1,
        oldStart: 1,
        newStart: 1,
      },
      {
        slot: 1,
        count: 5,
        displayStart: 5,
        oldStart: 5,
        newStart: 5,
      },
      {
        slot: 2,
        count: 5,
        displayStart: 14,
        oldStart: 12,
        newStart: 14,
      },
    ]);
  });
});
