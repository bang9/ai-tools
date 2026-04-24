import { describe, expect, it } from "vitest";
import type { FileDiff, FileStatus } from "../types";
import {
  filterDiffsBySelectedPaths,
  firstSelectedFilePath,
  selectFilePathRange,
} from "./diff-file-selection";

const files = [
  { path: "a.ts", status: "modified", staged: false },
  { path: "b.ts", status: "added", staged: false },
  { path: "c.ts", status: "deleted", staged: false },
  { path: "d.ts", status: "modified", staged: false },
] satisfies FileStatus[];

describe("diff file selection", () => {
  it("selects an inclusive path range from the anchor to the target", () => {
    expect(selectFilePathRange(files, "b.ts", "d.ts")).toEqual(
      new Set(["b.ts", "c.ts", "d.ts"]),
    );
  });

  it("selects ranges in reverse order", () => {
    expect(selectFilePathRange(files, "d.ts", "b.ts")).toEqual(
      new Set(["b.ts", "c.ts", "d.ts"]),
    );
  });

  it("returns null when the range anchor is unavailable", () => {
    expect(selectFilePathRange(files, null, "b.ts")).toBeNull();
    expect(selectFilePathRange(files, "missing.ts", "b.ts")).toBeNull();
  });

  it("finds the first selected path in visible file order", () => {
    expect(firstSelectedFilePath(files, new Set(["d.ts", "b.ts"]))).toBe("b.ts");
  });

  it("filters commit diffs to the selected paths", () => {
    const diffs = files.map((file) => ({
      path: file.path,
      status: file.status,
      hunks: [],
      displayLineCount: 0,
    })) satisfies FileDiff[];

    expect(filterDiffsBySelectedPaths(diffs, new Set(["c.ts", "a.ts"]))).toEqual([
      diffs[0],
      diffs[2],
    ]);
  });
});
