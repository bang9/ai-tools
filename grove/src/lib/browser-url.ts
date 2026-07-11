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
