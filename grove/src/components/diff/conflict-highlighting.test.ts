import { describe, expect, it } from "vitest";
import type { DiffLine } from "../../types";
import { buildConflictHighlightedGroups } from "./conflict-highlighting";

describe("conflict highlighting", () => {
  it("groups conflict marker sections into diff-like visual blocks", () => {
    const groups = buildConflictHighlightedGroups([
      line(0, "before"),
      line(1, "<<<<<<< HEAD"),
      line(2, "ours"),
      line(3, "======="),
      line(4, "theirs"),
      line(5, ">>>>>>> feature"),
      line(6, "after"),
    ]);

    expect(groups.map((group) => group.type)).toEqual([
      "context",
      "conflict-marker",
      "remove",
      "conflict-marker",
      "add",
      "conflict-marker",
      "context",
    ]);
    expect(groups[2].lines.map((item) => item.line.content)).toEqual(["ours"]);
    expect(groups[4].lines.map((item) => item.line.content)).toEqual(["theirs"]);
    expect(groups[1].lines[0].segments[0].text).toBe("<<<<<<< HEAD");
    expect(groups[3].lines[0].segments[0].text).toBe("=======");
    expect(groups[5].lines[0].segments[0].text).toBe(">>>>>>> feature");
  });

  it("keeps diff3 base sections as neutral context", () => {
    const groups = buildConflictHighlightedGroups([
      line(0, "<<<<<<< HEAD"),
      line(1, "ours"),
      line(2, "||||||| base"),
      line(3, "base"),
      line(4, "======="),
      line(5, "theirs"),
      line(6, ">>>>>>> feature"),
    ]);

    expect(groups.map((group) => group.type)).toEqual([
      "conflict-marker",
      "remove",
      "conflict-marker",
      "context",
      "conflict-marker",
      "add",
      "conflict-marker",
    ]);
    expect(groups[3].lines.map((item) => item.line.content)).toEqual(["base"]);
  });
});

function line(index: number, content: string): DiffLine {
  const lineNumber = index + 1;
  return {
    type: "context",
    content,
    oldLineNumber: lineNumber,
    newLineNumber: lineNumber,
    index,
  };
}
