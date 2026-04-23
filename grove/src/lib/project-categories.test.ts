import { afterEach, describe, expect, it, vi } from "vitest";
import { getRandomProjectCategoryColor } from "./project-categories";

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
