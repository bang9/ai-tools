const STORAGE_KEY = "grove.browser.recentUrls";
export const MAX_RECENT_URLS = 50;

/** Prepend a URL to an MRU list: dedupe, cap at `max`. */
export function pushRecentUrl(list: string[], url: string, max = MAX_RECENT_URLS): string[] {
  const next = [url, ...list.filter((item) => item !== url)];
  return next.length > max ? next.slice(0, max) : next;
}

/** Case-insensitive substring filter over an MRU list, most recent first. */
export function filterUrlSuggestions(list: string[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  const matched = q ? list.filter((url) => url.toLowerCase().includes(q)) : list;
  return matched.slice(0, limit);
}

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Drop a leading "scheme://" so matching is scheme-insensitive. */
function stripScheme(value: string): string {
  return value.replace(SCHEME_PATTERN, "");
}

export interface UrlCompletion {
  /** The real, navigable URL from history (what Enter must load). */
  url: string;
  /** The remaining text to append after the typed prefix and select. */
  completion: string;
}

/**
 * Find the best omnibox-style inline completion for `typed` against an MRU
 * list. Matching is scheme-insensitive: both the typed text and each history
 * entry have their "scheme://" stripped before comparison, so typing "loc"
 * completes from "http://localhost:3000/". The most recent match wins.
 *
 * Returns the real URL to navigate to plus the remainder text to append after
 * the typed prefix (its case comes from the history entry), or null when there
 * is nothing to complete (empty input, no prefix match, or an exact match with
 * no remainder). The displayed value is always `typed + completion`, so `typed`
 * stays a literal prefix and can be used directly as the selection start.
 */
export function findUrlCompletion(list: string[], typed: string): UrlCompletion | null {
  if (!typed) return null;
  const strippedTyped = stripScheme(typed);
  const needle = strippedTyped.toLowerCase();
  for (const url of list) {
    const stripped = stripScheme(url);
    if (stripped.length > strippedTyped.length && stripped.toLowerCase().startsWith(needle)) {
      return { url, completion: stripped.slice(strippedTyped.length) };
    }
  }
  return null;
}

export function loadRecentUrls(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function saveRecentUrls(list: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable — history simply won't persist
  }
}
