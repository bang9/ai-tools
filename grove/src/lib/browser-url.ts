const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalize address-bar input into a loadable URL.
 * Bare hosts ("localhost:3000", "example.com/path") get an http:// prefix.
 * Returns null when the input is empty or cannot form a valid URL.
 */
export function normalizeBrowserUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const candidate = SCHEME_PATTERN.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Short label for a browser tab title, e.g. "localhost:3000". */
export function browserTabTitle(url: string): string {
  try {
    return new URL(url).host || "Browser";
  } catch {
    return "Browser";
  }
}
