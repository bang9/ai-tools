// Pure content-detection helpers ported from orca's terminal-complex-script.
// Why: after an in-place TUI redraw paints CJK / emoji / RTL / fullwidth /
// replacement glyphs, the WebGL glyph atlas can retain a stale or wrong wide
// glyph with no repaint. Detecting these "renderer-risk" code points lets the
// runtime schedule a throttled atlas rebuild. Only the text classification is
// ported here — none of orca's pty-connection or renderer-selection logic.

// Emoji (including ZWJ sequences and variation-selector presentation) render
// through the browser's shaping path, where a single-cell atlas glyph can go
// stale after an in-place rewrite.
const EMOJI_PRESENTATION_PATTERN = /\p{Emoji_Presentation}/u;

function isInRange(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

// Code points whose glyphs the WebGL atlas can render wrong/stale after an
// in-place redraw: RTL scripts (browser shaping/order), ZWJ, CJK Han/kana +
// compat, fullwidth/halfwidth forms, variation selectors, the replacement
// character, lone surrogates (split chunk halves), and the supplementary
// CJK/emoji planes. Kept deliberately broad so a targeted refresh — never a
// renderer switch — can react to the content.
//
// Why Hangul is EXCLUDED (write-path scope only): this predicate runs on the
// WRITE path (every decoded output chunk → maybeScheduleAtlasRecovery). The
// primary user types Korean constantly, so flagging Hangul here would fire a
// throttled-but-recurring clearTextureAtlas()+refresh on every Korean echo — a
// standing flicker/perf regression. Hangul syllables are plain wide glyphs with
// no ZWJ/shaping/variation-selector atlas risk, so every Hangul block is left
// out: jamo (0x1100-0x11FF), compat jamo (0x3130-0x318F), jamo ext-A
// (0xA960-0xA97F), syllables (0xAC00-0xD7AF), jamo ext-B (0xD7B0-0xD7FF). The
// CJK range is therefore split around compat jamo (0x2E80-0x312F, 0x3190-0x9FFF)
// so Han/kana still flag. Korean mixed with an emoji/ZWJ/VS16 still flags via
// those code points (and the emoji regex).
function isRendererRiskCodePoint(value: number): boolean {
  return (
    isInRange(value, 0x0590, 0x08ff) ||
    value === 0x200d ||
    isInRange(value, 0x2e80, 0x312f) ||
    isInRange(value, 0x3190, 0x9fff) ||
    isInRange(value, 0xd800, 0xdfff) ||
    isInRange(value, 0xf900, 0xfaff) ||
    isInRange(value, 0xfe10, 0xfe1f) ||
    isInRange(value, 0xfe30, 0xfe4f) ||
    isInRange(value, 0xfb1d, 0xfdff) ||
    isInRange(value, 0xfe00, 0xfe0f) ||
    isInRange(value, 0xfe70, 0xfeff) ||
    isInRange(value, 0xff00, 0xffef) ||
    value === 0xfffd ||
    isInRange(value, 0x10ec0, 0x10eff) ||
    isInRange(value, 0x1e900, 0x1e95f) ||
    isInRange(value, 0x20000, 0x2fa1f) ||
    isInRange(value, 0x30000, 0x3134f) ||
    isInRange(value, 0xe0100, 0xe01ef)
  );
}

/**
 * Whether a decoded terminal output chunk carries a glyph that can leave the
 * WebGL texture atlas stale after an in-place redraw. Plain ASCII (the hot
 * path) returns false without touching the Unicode regex or code-point walk.
 * Box-drawing, braille, block, and powerline glyphs are intentionally NOT
 * flagged — they render correctly on WebGL, matching orca's classification.
 */
export function terminalOutputContainsAtlasRiskGlyph(data: string): boolean {
  let hasNonAscii = false;
  for (let i = 0; i < data.length; i += 1) {
    if (data.charCodeAt(i) > 0x7f) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) {
    // Why: ASCII-only redraws (Codex-style, plain shells) never carry a
    // wide/complex glyph, so skip the emoji regex and code-point walk on the
    // hottest output path.
    return false;
  }

  if (EMOJI_PRESENTATION_PATTERN.test(data)) {
    return true;
  }
  for (let i = 0; i < data.length; i += 1) {
    const codePoint = data.codePointAt(i);
    if (codePoint === undefined) {
      continue;
    }
    if (isRendererRiskCodePoint(codePoint)) {
      return true;
    }
    if (codePoint > 0xffff) {
      i += 1;
    }
  }
  return false;
}
