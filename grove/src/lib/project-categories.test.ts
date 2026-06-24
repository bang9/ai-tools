import { afterEach, describe, expect, it, vi } from "vitest";
import { getRandomProjectCategoryColor, reorderProjectCategories } from "./project-categories";
import type { ProjectCategory } from "../types";

function cat(id: string): ProjectCategory {
  return { id, name: id, color: "#000000", icon: { type: "lucide", value: "folder" } };
}

describe("reorderProjectCategories", () => {
  const cats = [cat("a"), cat("b"), cat("c")];

  it("moves an item from one index to another", () => {
    const next = reorderProjectCategories(cats, "a", "c");
    expect(next.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  it("returns the same order when active equals over", () => {
    const next = reorderProjectCategories(cats, "b", "b");
    expect(next.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("returns the original array when an id is missing", () => {
    const next = reorderProjectCategories(cats, "a", "z");
    expect(next).toBe(cats);
  });
});

describe("getRandomProjectCategoryColor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a six-digit hex color", () => {
    const color = getRandomProjectCategoryColor([]);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("retries when the first random color is blocked", () => {
    const blockedSequence = [0, 0, 0];
    const nextSequence = [0.5, 0.5, 0.5];
    const randomSpy = vi.spyOn(Math, "random");

    for (const value of [...blockedSequence, ...blockedSequence, ...nextSequence]) {
      randomSpy.mockReturnValueOnce(value);
    }

    const blockedColor = getRandomProjectCategoryColor([]);
    const nextColor = getRandomProjectCategoryColor([blockedColor], [blockedColor]);

    expect(nextColor).not.toBe(blockedColor);
    expect(nextColor).toMatch(/^#[0-9a-f]{6}$/);
  });
});
