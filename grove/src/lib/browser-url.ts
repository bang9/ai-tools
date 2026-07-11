const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalize address-bar input into a loadable URL.
 * Bare hosts ("localhost:3000", "example.com/path") get an http:// prefix.
 * `file://` URLs pass through for local HTML previews.
 * Returns null when the input is empty or cannot form a valid URL.
 */
export function normalizeBrowserUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const candidate = SCHEME_PATTERN.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (url.protocol === "file:") {
      return url.pathname && url.pathname !== "/" ? url.toString() : null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** A URL "host.tld" or "host.tld/path" — a bare host that should navigate. */
const LOOKS_LIKE_URL_PATTERN = /^[^\s]+\.[a-z]{2,}(?:[/:?#].*)?$/i;

/**
 * Decide whether address-bar input is a search query rather than a URL, the way
 * a browser omnibox does: whitespace → search; an explicit scheme or a
 * host.tld / dotted / port-bearing token → URL; anything else → search.
 */
export function looksLikeSearchQuery(input: string): boolean {
  const t = input.trim();
  if (!t) return false;
  if (/\s/.test(t)) return true;
  if (SCHEME_PATTERN.test(t)) return false;
  if (LOOKS_LIKE_URL_PATTERN.test(t)) return false;
  if (t.includes(".") || t.includes(":")) return false;
  return true;
}

export type SearchEngine = "google" | "duckduckgo" | "bing";

const SEARCH_ENGINES: Record<SearchEngine, (q: string) => string> = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
};

export const DEFAULT_SEARCH_ENGINE: SearchEngine = "google";

/** Build a search-results URL for `query` on the given engine. */
export function buildSearchUrl(
  query: string,
  engine: SearchEngine = DEFAULT_SEARCH_ENGINE,
): string {
  return (SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.google)(query.trim());
}

/**
 * Resolve raw address-bar input to a loadable URL: a search query becomes a
 * search URL, a bare host/URL is normalized, and input that can't form a URL
 * falls back to search. Returns null only for empty input.
 */
export function resolveAddressInput(
  input: string,
  engine: SearchEngine = DEFAULT_SEARCH_ENGINE,
): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (looksLikeSearchQuery(trimmed)) return buildSearchUrl(trimmed, engine);
  return normalizeBrowserUrl(trimmed) ?? buildSearchUrl(trimmed, engine);
}

/** How trustworthy a loaded URL is, for the address-bar security indicator. */
export type UrlSecurity = "secure" | "insecure" | "file" | "none";

/** Classify a URL's transport for the address-bar leading icon. */
export function urlSecurity(url: string | null): UrlSecurity {
  if (!url) return "none";
  try {
    const { protocol } = new URL(url);
    if (protocol === "https:") return "secure";
    if (protocol === "http:") return "insecure";
    if (protocol === "file:") return "file";
    return "none";
  } catch {
    return "none";
  }
}

/** Short label for a browser tab title, e.g. "localhost:3000" or "index.html". */
export function browserTabTitle(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") {
      const segments = parsed.pathname.split("/").filter(Boolean);
      const name = segments[segments.length - 1];
      return name ? decodeURIComponent(name) : "File";
    }
    return parsed.host || "Browser";
  } catch {
    return "Browser";
  }
}
