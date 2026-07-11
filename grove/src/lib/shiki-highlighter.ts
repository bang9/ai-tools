import type { BundledLanguage, BundledTheme, Highlighter, ThemedToken } from "shiki";

export const SHIKI_DARK_THEME: BundledTheme = "github-dark-default";
export const SHIKI_LIGHT_THEME: BundledTheme = "github-light-default";

// Hard caps: past these sizes shiki tokenization gets slow enough to jank the
// UI, so we render plain text instead.
const MAX_HIGHLIGHT_CHARS = 1_000_000;
const MAX_HIGHLIGHT_LINES = 20_000;

let highlighterPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    // Dynamic import keeps shiki (and its wasm) out of the initial bundle; it's
    // only pulled in the first time a text file is highlighted.
    highlighterPromise = import("shiki").then(({ createHighlighter }) =>
      createHighlighter({
        themes: [SHIKI_DARK_THEME, SHIKI_LIGHT_THEME],
        langs: [],
      }),
    );
  }
  return highlighterPromise;
}

function exceedsLineCap(code: string): boolean {
  let lineCount = 1;
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) === 10) {
      lineCount += 1;
      if (lineCount > MAX_HIGHLIGHT_LINES) return true;
    }
  }
  return false;
}

/**
 * Tokenize `code` with shiki for the given language. Returns per-line token
 * arrays, or null when the language is unknown or the file is too large to
 * highlight without janking (caller renders plain text in that case).
 */
export async function highlightLines(
  code: string,
  lang: string,
  isDark: boolean,
): Promise<ThemedToken[][] | null> {
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  if (exceedsLineCap(code)) return null;

  const { bundledLanguages } = await import("shiki");
  if (!(lang in bundledLanguages)) return null;

  const highlighter = await getHighlighter();
  if (!loadedLangs.has(lang)) {
    await highlighter.loadLanguage(lang as BundledLanguage);
    loadedLangs.add(lang);
  }

  return highlighter.codeToTokensBase(code, {
    lang: lang as BundledLanguage,
    theme: isDark ? SHIKI_DARK_THEME : SHIKI_LIGHT_THEME,
  });
}
