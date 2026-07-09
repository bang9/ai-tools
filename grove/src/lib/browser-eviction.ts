/**
 * Pure idle-eviction policy for native browser webviews.
 *
 * This module holds NO platform imports and NO side effects — it is a
 * decision function over per-tab visibility bookkeeping. The lifecycle layer
 * (`browser-webview.ts`) owns the actual bookkeeping, scheduling, and the
 * close/suspend side effects; it feeds a snapshot in here and acts on the
 * returned tabIds.
 */

/** Per-webview visibility bookkeeping for one alive native webview. */
export interface WebviewVisibility {
  /** Whether the tab's native webview is currently visible on screen. */
  visible: boolean;
  /**
   * Timestamp (ms) at which the webview most recently became hidden, or null
   * while it is visible. This is preserved across repeated hidden signals so
   * it measures *continuous* hidden duration, and it doubles as the
   * "least-recently-visible" ordering key for the concurrency cap.
   */
  hiddenSince: number | null;
}

export interface EvictionLimits {
  /** Continuous-hidden duration (ms) after which a webview is evicted. */
  ttlMs: number;
  /** Maximum number of concurrently-alive webviews. */
  maxAlive: number;
}

/** Default: evict webviews hidden continuously for longer than 10 minutes. */
export const EVICTION_TTL_MS = 10 * 60 * 1000;

/** Default: keep at most 5 native webviews alive at once. */
export const EVICTION_MAX_ALIVE = 5;

export const DEFAULT_EVICTION_LIMITS: EvictionLimits = {
  ttlMs: EVICTION_TTL_MS,
  maxAlive: EVICTION_MAX_ALIVE,
};

/**
 * Decide which alive webviews to evict.
 *
 * `records` maps tabId -> visibility bookkeeping for every currently-alive
 * webview. Rules:
 *  1. TTL — any webview hidden continuously for longer than `ttlMs` is evicted.
 *  2. Cap — if more than `maxAlive` webviews remain alive, evict the
 *     least-recently-visible HIDDEN webviews (smallest `hiddenSince` first)
 *     until the count is back at the cap.
 * A currently-visible webview is never evicted.
 */
export function selectEvictions(
  records: Record<string, WebviewVisibility>,
  now: number,
  limits: EvictionLimits = DEFAULT_EVICTION_LIMITS,
): string[] {
  const entries = Object.entries(records);
  const evict = new Set<string>();

  // Hidden candidates, least-recently-visible first (oldest hiddenSince). Only
  // hidden webviews with a known hiddenSince are eligible for eviction.
  const hidden = entries
    .filter(
      (entry): entry is [string, WebviewVisibility & { hiddenSince: number }] =>
        !entry[1].visible && entry[1].hiddenSince !== null,
    )
    .sort((a, b) => a[1].hiddenSince - b[1].hiddenSince);

  // 1. TTL: continuously hidden longer than the TTL.
  for (const [tabId, record] of hidden) {
    if (now - record.hiddenSince > limits.ttlMs) evict.add(tabId);
  }

  // 2. Cap: reduce the alive count to maxAlive by evicting the
  //    least-recently-visible remaining hidden webviews.
  let aliveCount = entries.length - evict.size;
  if (aliveCount > limits.maxAlive) {
    for (const [tabId] of hidden) {
      if (aliveCount <= limits.maxAlive) break;
      if (evict.has(tabId)) continue;
      evict.add(tabId);
      aliveCount -= 1;
    }
  }

  return [...evict];
}
