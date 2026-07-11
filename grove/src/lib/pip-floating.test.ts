import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIP_PRESENTATION,
  MAX_PIP_WIDTH,
  MIN_PIP_WIDTH,
  clampDraggingPipPosition,
  getPipDimensions,
  getVisiblePipX,
  resolvePipFrame,
  resolvePipPresentationAfterDrag,
  type PipPresentationState,
  type PipViewport,
} from "./pip-floating";

const VIEWPORT: PipViewport = { width: 1400, height: 900 };

describe("pip floating geometry", () => {
  it("defaults PiP presentation to hidden and expanded on the right edge", () => {
    expect(DEFAULT_PIP_PRESENTATION).toEqual({
      dockSide: "right",
      hidden: true,
      requestedWidth: MAX_PIP_WIDTH,
      y: null,
    });

    expect(resolvePipFrame(VIEWPORT, DEFAULT_PIP_PRESENTATION)).toEqual({
      x: 1372,
      y: 348,
      width: 960,
      height: 540,
    });
  });

  it("defaults a visible PiP to the docked bottom-right position", () => {
    const state: PipPresentationState = {
      dockSide: "right",
      hidden: false,
      requestedWidth: MIN_PIP_WIDTH,
      y: null,
    };

    expect(resolvePipFrame(VIEWPORT, state)).toEqual({
      x: 1108,
      y: 730,
      width: 280,
      height: 158,
    });
  });

  it("hides the PiP when dragged far enough past the left edge", () => {
    expect(resolvePipPresentationAfterDrag({ x: -120, y: 300 }, VIEWPORT, MIN_PIP_WIDTH)).toEqual({
      dockSide: "left",
      hidden: true,
      requestedWidth: MIN_PIP_WIDTH,
      y: 300,
    });
  });

  it("snaps to the nearest visible edge when the drag stays in bounds", () => {
    expect(resolvePipPresentationAfterDrag({ x: 900, y: 240 }, VIEWPORT, MIN_PIP_WIDTH)).toEqual({
      dockSide: "right",
      hidden: false,
      requestedWidth: MIN_PIP_WIDTH,
      y: 240,
    });
  });

  it("clamps dragging to the hidden edge range and visible vertical range", () => {
    expect(clampDraggingPipPosition({ x: 9999, y: 9999 }, VIEWPORT, MIN_PIP_WIDTH)).toEqual({
      x: 1372,
      y: 730,
    });
  });

  it("shrinks oversized expanded width to fit the current viewport", () => {
    const smallViewport: PipViewport = { width: 640, height: 480 };
    const { width, height } = getPipDimensions(smallViewport, MAX_PIP_WIDTH);

    expect(width).toBe(616);
    expect(height).toBe(Math.round(616 * (9 / 16)));
    expect(getVisiblePipX(smallViewport.width, width, "right")).toBe(12);
  });
});
