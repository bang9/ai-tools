export const DEFAULT_TERMINAL_FONT_FAMILY = [
  '"SF Mono"',
  '"Monaco"',
  '"Menlo"',
  '"Consolas"',
  '"Liberation Mono"',
  '"DejaVu Sans Mono"',
  '"Noto Sans Mono CJK KR"',
  '"Noto Sans Mono CJK SC"',
  '"Noto Sans Mono CJK TC"',
  '"Noto Sans Mono CJK JP"',
  "monospace",
].join(", ");

const LEGACY_DEFAULT_FONT_FAMILIES = new Set(["Menlo, monospace"]);

export function resolveTerminalFontFamily(fontFamily: string | null | undefined): string {
  const normalized = fontFamily?.trim();
  if (!normalized || LEGACY_DEFAULT_FONT_FAMILIES.has(normalized)) {
    return DEFAULT_TERMINAL_FONT_FAMILY;
  }
  return normalized;
}
