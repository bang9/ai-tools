const STORAGE_KEY = "grove.browser.history";
/** Pre-frecency MRU list (bare URL strings); migrated on first load. */
const LEGACY_STORAGE_KEY = "grove.browser.recentUrls";
export const MAX_HISTORY_ENTRIES = 200;

/**
 * One visited page in the browser history. Beyond a bare URL this carries the
 * title, favicon, visit count and last-visit time so the address bar can rank
 * suggestions by frecency (frequency + recency) instead of plain recency.
 */
export interface BrowserHistoryEntry {
  /** The full, navigable URL as last visited. */
  url: string;
  /** Dedup key: scheme+host lowercased, hash dropped, single trailing "/" trimmed. */
  normalizedUrl: string;
  /** Best-known page title ("" until the page reports one). */
  title: string;
  /** Favicon URL the page advertised, if any. */
  faviconUrl?: string;
  /** Epoch ms of the most recent visit. */
  lastVisitedAt: number;
  /** Number of recorded visits (distinct commits, not per title update). */
  visitCount: number;
}

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Drop a leading "scheme://" so matching is scheme-insensitive. */
function stripScheme(value: string): string {
  return value.replace(SCHEME_PATTERN, "");
}

/** True for URLs that should never enter history (blank/new-tab placeholders). */
function isRecordableUrl(url: string): boolean {
  const t = url.trim();
  return t.length > 0 && t !== "about:blank";
}

/**
 * Dedup key for a URL: lowercase scheme+host, drop the fragment, and trim a
 * single trailing slash on the path. So "http://Localhost:3000/" and
 * "http://localhost:3000" collapse to one entry.
 */
export function normalizeHistoryUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const u = new URL(trimmed);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return `${u.protocol}//${u.host}${path}${u.search}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * Record a page visit. Existing entry (matched by normalized URL) is refreshed
 * and moved to the front; `incrementVisit` bumps its visit count (pass false
 * for follow-up title/favicon updates of a page already counted). A new entry
 * starts at visitCount 1. The list is capped at {@link MAX_HISTORY_ENTRIES},
 * evicting the least-recently-visited.
 */
export function upsertHistory(
  list: BrowserHistoryEntry[],
  url: string,
  title: string,
  now: number,
  incrementVisit: boolean,
  faviconUrl?: string,
): BrowserHistoryEntry[] {
  if (!isRecordableUrl(url)) return list;
  const normalizedUrl = normalizeHistoryUrl(url);
  const existing = list.find((e) => e.normalizedUrl === normalizedUrl);
  let next: BrowserHistoryEntry[];
  if (existing) {
    const updated: BrowserHistoryEntry = {
      ...existing,
      url,
      title: title || existing.title,
      faviconUrl: faviconUrl ?? existing.faviconUrl,
      lastVisitedAt: now,
      visitCount: existing.visitCount + (incrementVisit ? 1 : 0),
    };
    next = [updated, ...list.filter((e) => e !== existing)];
  } else {
    next = [
      { url, normalizedUrl, title: title ?? "", faviconUrl, lastVisitedAt: now, visitCount: 1 },
      ...list,
    ];
  }
  if (next.length > MAX_HISTORY_ENTRIES) {
    next = [...next]
      .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
      .slice(0, MAX_HISTORY_ENTRIES);
  }
  return next;
}

/**
 * Attach a favicon to the history entry matching `url`, without touching its
 * visit count or recency. Returns the same list reference when nothing changed.
 */
export function recordFavicon(
  list: BrowserHistoryEntry[],
  url: string,
  faviconUrl: string,
): BrowserHistoryEntry[] {
  const normalizedUrl = normalizeHistoryUrl(url);
  let changed = false;
  const next = list.map((e) => {
    if (e.normalizedUrl === normalizedUrl && e.faviconUrl !== faviconUrl) {
      changed = true;
      return { ...e, faviconUrl };
    }
    return e;
  });
  return changed ? next : list;
}

/**
 * Frecency score of a history entry for a query. Returns -1 when the query is
 * not a substring of the URL or title (filtered out). Otherwise: a strong
 * prefix boost, plus visit frequency (capped), plus a recency bonus that
 * decays to zero over 24h — mirroring a browser omnibox.
 */
export function scoreEntry(entry: BrowserHistoryEntry, query: string, now: number): number {
  const q = query.trim().toLowerCase();
  if (!q) return entry.lastVisitedAt;
  const url = entry.url.toLowerCase();
  const title = entry.title.toLowerCase();
  if (!url.includes(q) && !title.includes(q)) return -1;
  let score = 0;
  const strippedUrl = stripScheme(url);
  if (url.startsWith(q) || strippedUrl.startsWith(q)) score += 100;
  score += Math.min(entry.visitCount, 50);
  const ageHours = (now - entry.lastVisitedAt) / 3_600_000;
  score += Math.max(0, 24 - ageHours);
  return score;
}

/**
 * Ranked address-bar suggestions for a query. Empty query → most-recent
 * entries. Non-empty → frecency-ranked matches. Capped at `limit`.
 */
export function buildSuggestions(
  list: BrowserHistoryEntry[],
  query: string,
  now: number,
  limit = 8,
): BrowserHistoryEntry[] {
  if (!query.trim()) {
    return [...list].sort((a, b) => b.lastVisitedAt - a.lastVisitedAt).slice(0, limit);
  }
  return list
    .map((entry) => ({ entry, score: scoreEntry(entry, query, now) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.entry);
}

export interface UrlCompletion {
  /** The real, navigable URL from history (what Enter must load). */
  url: string;
  /** The remaining text to append after the typed prefix and select. */
  completion: string;
}

/**
 * Best omnibox-style inline completion for `typed` against history. Matching is
 * scheme-insensitive (both sides have "scheme://" stripped), so typing "loc"
 * completes from "http://localhost:3000/". Among prefix matches the highest
 * frecency wins (not merely the most recent).
 *
 * Returns the real URL to navigate to plus the remainder text to append after
 * the typed prefix, or null when there is nothing to complete.
 */
export function findInlineCompletion(
  list: BrowserHistoryEntry[],
  typed: string,
  now: number,
): UrlCompletion | null {
  if (!typed) return null;
  const strippedTyped = stripScheme(typed);
  const needle = strippedTyped.toLowerCase();
  let best: { url: string; completion: string; score: number } | null = null;
  for (const entry of list) {
    const stripped = stripScheme(entry.url);
    if (stripped.length > strippedTyped.length && stripped.toLowerCase().startsWith(needle)) {
      const score = scoreEntry(entry, typed, now);
      if (!best || score > best.score) {
        best = { url: entry.url, completion: stripped.slice(strippedTyped.length), score };
      }
    }
  }
  return best ? { url: best.url, completion: best.completion } : null;
}

function isHistoryEntry(value: unknown): value is BrowserHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.url === "string" &&
    typeof e.normalizedUrl === "string" &&
    typeof e.lastVisitedAt === "number" &&
    typeof e.visitCount === "number"
  );
}

/** Load history, migrating the legacy MRU string[] list on first run. */
export function loadHistory(now: number = Date.now()): BrowserHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(isHistoryEntry);
    }
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacy: unknown = JSON.parse(legacyRaw);
      if (Array.isArray(legacy)) {
        // Preserve MRU order via a descending synthetic timestamp.
        return legacy
          .filter((item): item is string => typeof item === "string")
          .map((url, i) => ({
            url,
            normalizedUrl: normalizeHistoryUrl(url),
            title: "",
            lastVisitedAt: now - i,
            visitCount: 1,
          }));
      }
    }
  } catch {
    // Storage unavailable / corrupt — start empty.
  }
  return [];
}

export function saveHistory(list: BrowserHistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable — history simply won't persist.
  }
}
