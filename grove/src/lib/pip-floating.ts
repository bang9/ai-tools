export const MIN_PIP_WIDTH = 280;
export const MAX_PIP_WIDTH = 960;
export const PIP_ASPECT_RATIO = 9 / 16;
export const PIP_MARGIN = 12;
export const PIP_PEEK_WIDTH = 28;
export const PIP_HIDE_THRESHOLD = 72;

export type PipDockSide = "left" | "right";

export interface PipViewport {
  width: number;
  height: number;
}

export interface PipPosition {
  x: number;
  y: number;
}

export interface PipFrame extends PipPosition {
  width: number;
  height: number;
}

export interface PipPresentationState {
  dockSide: PipDockSide;
  hidden: boolean;
  requestedWidth: number;
  y: number | null;
}

export const DEFAULT_PIP_PRESENTATION: PipPresentationState = {
  dockSide: "right",
  hidden: true,
  requestedWidth: MAX_PIP_WIDTH,
  y: null,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampRequestedPipWidth(requestedWidth: number): number {
  if (Number.isNaN(requestedWidth)) {
    return MIN_PIP_WIDTH;
  }
  return clamp(requestedWidth, MIN_PIP_WIDTH, MAX_PIP_WIDTH);
}

export function getPipDimensions(
  viewport: PipViewport,
  requestedWidth: number,
): Pick<PipFrame, "width" | "height"> {
  const requested = clampRequestedPipWidth(requestedWidth);
  const maxWidth = viewport.width > 0
    ? Math.max(PIP_PEEK_WIDTH * 2, viewport.width - (PIP_MARGIN * 2))
    : requested;
  const width = Math.min(requested, maxWidth);
  return {
    width,
    height: Math.round(width * PIP_ASPECT_RATIO),
  };
}

export function clampPipY(
  y: number | null,
  viewport: PipViewport,
  height: number,
): number {
  const maxY = Math.max(PIP_MARGIN, viewport.height - height - PIP_MARGIN);
  if (y === null || Number.isNaN(y)) {
    return maxY;
  }
  return clamp(y, PIP_MARGIN, maxY);
}

export function getVisiblePipX(
  viewportWidth: number,
  width: number,
  dockSide: PipDockSide,
): number {
  const rightX = Math.max(PIP_MARGIN, viewportWidth - width - PIP_MARGIN);
  return dockSide === "left" ? PIP_MARGIN : rightX;
}

export function getHiddenPipX(
  viewportWidth: number,
  width: number,
  dockSide: PipDockSide,
): number {
  return dockSide === "left"
    ? -(width - PIP_PEEK_WIDTH)
    : viewportWidth - PIP_PEEK_WIDTH;
}

export function resolvePipDockSide(
  x: number,
  width: number,
  viewportWidth: number,
): PipDockSide {
  return x + (width / 2) <= viewportWidth / 2 ? "left" : "right";
}

export function clampDraggingPipPosition(
  position: PipPosition,
  viewport: PipViewport,
  requestedWidth: number,
): PipPosition {
  const { width, height } = getPipDimensions(viewport, requestedWidth);
  return {
    x: clamp(
      position.x,
      getHiddenPipX(viewport.width, width, "left"),
      getHiddenPipX(viewport.width, width, "right"),
    ),
    y: clampPipY(position.y, viewport, height),
  };
}

export function resolvePipPresentationAfterDrag(
  position: PipPosition,
  viewport: PipViewport,
  requestedWidth: number,
): PipPresentationState {
  const { width, height } = getPipDimensions(viewport, requestedWidth);
  const next = clampDraggingPipPosition(position, viewport, requestedWidth);
  const dockSide = resolvePipDockSide(next.x, width, viewport.width);
  const visibleX = getVisiblePipX(viewport.width, width, dockSide);
  const hidden = dockSide === "left"
    ? next.x <= visibleX - PIP_HIDE_THRESHOLD
    : next.x >= visibleX + PIP_HIDE_THRESHOLD;

  return {
    dockSide,
    hidden,
    requestedWidth: clampRequestedPipWidth(requestedWidth),
    y: clampPipY(next.y, viewport, height),
  };
}

export function resolvePipFrame(
  viewport: PipViewport,
  presentation: PipPresentationState,
): PipFrame {
  const { width, height } = getPipDimensions(viewport, presentation.requestedWidth);
  const y = clampPipY(presentation.y, viewport, height);
  const x = presentation.hidden
    ? getHiddenPipX(viewport.width, width, presentation.dockSide)
    : getVisiblePipX(viewport.width, width, presentation.dockSide);

  return { x, y, width, height };
}
