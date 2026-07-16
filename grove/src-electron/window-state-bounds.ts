// Pure geometry helpers for window-state restore. Kept free of electron
// imports so they stay unit-testable under vitest's node environment.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Minimum overlap (px) between the saved window rect and a display work area
 * for the saved position to still be considered reachable by the user.
 */
const MIN_VISIBLE = 100;

/**
 * Whether a saved window rect still lands usably on one of the connected
 * displays. Guards against restoring a window offscreen after a monitor is
 * unplugged or rearranged.
 */
export function rectIsUsableOnDisplays(rect: Rect, displayWorkAreas: Rect[]): boolean {
  return displayWorkAreas.some((area) => {
    const overlapX = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
    const overlapY =
      Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
}

export function isFiniteRect(rect: Partial<Rect> | undefined): rect is Rect {
  return (
    !!rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    (rect.width as number) > 0 &&
    (rect.height as number) > 0
  );
}
