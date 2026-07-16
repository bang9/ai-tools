import { describe, expect, it } from "vitest";
import { isFiniteRect, rectIsUsableOnDisplays, type Rect } from "./window-state-bounds";

const MAIN_DISPLAY: Rect = { x: 0, y: 25, width: 1728, height: 1054 };
const SIDE_DISPLAY: Rect = { x: 1728, y: 0, width: 2560, height: 1440 };

describe("rectIsUsableOnDisplays", () => {
  it("accepts a rect fully inside a display", () => {
    const rect: Rect = { x: 100, y: 100, width: 1200, height: 800 };
    expect(rectIsUsableOnDisplays(rect, [MAIN_DISPLAY])).toBe(true);
  });

  it("accepts a rect on a secondary display", () => {
    const rect: Rect = { x: 2000, y: 200, width: 1440, height: 960 };
    expect(rectIsUsableOnDisplays(rect, [MAIN_DISPLAY, SIDE_DISPLAY])).toBe(true);
  });

  it("rejects a rect stranded on an unplugged display", () => {
    const rect: Rect = { x: 2000, y: 200, width: 1440, height: 960 };
    expect(rectIsUsableOnDisplays(rect, [MAIN_DISPLAY])).toBe(false);
  });

  it("rejects a rect with only a sliver of overlap", () => {
    // 40px of horizontal overlap — not enough to grab the titlebar.
    const rect: Rect = { x: -1160, y: 100, width: 1200, height: 800 };
    expect(rectIsUsableOnDisplays(rect, [MAIN_DISPLAY])).toBe(false);
  });

  it("accepts a partially offscreen rect with a usable strip", () => {
    const rect: Rect = { x: -400, y: 100, width: 1200, height: 800 };
    expect(rectIsUsableOnDisplays(rect, [MAIN_DISPLAY])).toBe(true);
  });

  it("rejects everything when no displays are connected", () => {
    const rect: Rect = { x: 100, y: 100, width: 1200, height: 800 };
    expect(rectIsUsableOnDisplays(rect, [])).toBe(false);
  });
});

describe("isFiniteRect", () => {
  it("accepts a plain finite rect", () => {
    expect(isFiniteRect({ x: 0, y: 0, width: 1200, height: 800 })).toBe(true);
  });

  it("rejects undefined, partial, and non-finite rects", () => {
    expect(isFiniteRect(undefined)).toBe(false);
    expect(isFiniteRect({ x: 0, y: 0, width: 1200 })).toBe(false);
    expect(isFiniteRect({ x: NaN, y: 0, width: 1200, height: 800 })).toBe(false);
    expect(isFiniteRect({ x: 0, y: 0, width: 0, height: 800 })).toBe(false);
  });
});
