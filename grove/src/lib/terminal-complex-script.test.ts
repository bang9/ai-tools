import { describe, expect, it } from "vitest";
import { terminalOutputContainsAtlasRiskGlyph } from "./terminal-complex-script";

describe("terminalOutputContainsAtlasRiskGlyph", () => {
  it("flags CJK Han/kana and fullwidth output", () => {
    expect(terminalOutputContainsAtlasRiskGlyph("直接接请求本地 /api/mcp")).toBe(true);
    expect(terminalOutputContainsAtlasRiskGlyph("Japanese: ターミナル")).toBe(true);
    expect(terminalOutputContainsAtlasRiskGlyph("Fullwidth: ＡＢＣ１２３")).toBe(true);
  });

  it("does NOT flag plain Hangul (write-path scope: the user types Korean constantly)", () => {
    // FIX 1: Hangul syllables/jamo are plain wide glyphs with no ZWJ/shaping
    // atlas risk. Flagging them would fire a recurring clearTextureAtlas+refresh
    // on every Korean echo — a standing flicker regression. Excluded on the
    // write path. Covers syllables, compat jamo, jamo, and jamo ext-A.
    expect(terminalOutputContainsAtlasRiskGlyph("Korean: 터미널")).toBe(false);
    expect(terminalOutputContainsAtlasRiskGlyph("안녕하세요 반갑습니다")).toBe(false);
    expect(terminalOutputContainsAtlasRiskGlyph("compat jamo: ㄱㄴㄷ ㅏㅑ")).toBe(false);
    expect(terminalOutputContainsAtlasRiskGlyph("conjoining jamo: 가")).toBe(false);
    expect(terminalOutputContainsAtlasRiskGlyph("jamo ext-A: ꥠ")).toBe(false);
  });

  it("flags Hangul mixed with emoji/ZWJ (the non-Hangul code point still trips)", () => {
    // Korean text alongside an emoji or a variation selector still needs a
    // rebuild — the emoji/ZWJ/VS16 code point flags even though the Hangul does not.
    expect(terminalOutputContainsAtlasRiskGlyph("완료 🚀")).toBe(true);
    expect(terminalOutputContainsAtlasRiskGlyph("개발자 👩‍💻")).toBe(true);
    expect(terminalOutputContainsAtlasRiskGlyph("하트 ♥️")).toBe(true);
  });

  it("flags RTL scripts that need browser text shaping/order", () => {
    expect(terminalOutputContainsAtlasRiskGlyph("Arabic: السلام عليكم")).toBe(true);
    expect(terminalOutputContainsAtlasRiskGlyph("Hebrew: שלום")).toBe(true);
  });

  it("flags emoji and variation/ZWJ sequences", () => {
    expect(terminalOutputContainsAtlasRiskGlyph("status 🚀")).toBe(true);
    expect(terminalOutputContainsAtlasRiskGlyph("developer 👩‍💻")).toBe(true);
    expect(terminalOutputContainsAtlasRiskGlyph("heart ♥️")).toBe(true);
  });

  it("flags the replacement character", () => {
    expect(terminalOutputContainsAtlasRiskGlyph("bad replacement �")).toBe(true);
  });

  it("flags supplementary-plane complex-script ranges", () => {
    expect(terminalOutputContainsAtlasRiskGlyph("Adlam: 𞤀")).toBe(true);
    expect(terminalOutputContainsAtlasRiskGlyph("Medefaidrin: 𐻀")).toBe(true);
  });

  it("flags split surrogate halves so a chunk boundary never drops recovery", () => {
    const [high, low] = Array.from("🚀")[0].split("");
    expect(terminalOutputContainsAtlasRiskGlyph(high)).toBe(true);
    expect(terminalOutputContainsAtlasRiskGlyph(low)).toBe(true);
  });

  it("does not flag plain ASCII or terminal drawing glyphs kept on WebGL", () => {
    expect(terminalOutputContainsAtlasRiskGlyph("abc 123 ✓")).toBe(false);
    expect(terminalOutputContainsAtlasRiskGlyph("⠋ Working")).toBe(false);
    expect(terminalOutputContainsAtlasRiskGlyph("├─ file.ts")).toBe(false);
    expect(terminalOutputContainsAtlasRiskGlyph("█ progress")).toBe(false);
    expect(terminalOutputContainsAtlasRiskGlyph("◆ status")).toBe(false);
    expect(terminalOutputContainsAtlasRiskGlyph(" prompt")).toBe(false);
  });

  it("does not flag ASCII ANSI control sequences (never recover on plain ASCII)", () => {
    // Deviation from orca's terminalOutputPrefersRenderRefresh: atlas recovery
    // is a wide-glyph concern, so ASCII background-SGR fills are NOT flagged.
    expect(terminalOutputContainsAtlasRiskGlyph("\x1b[48;2;12;34;56m codex input \x1b[0m")).toBe(
      false,
    );
    expect(terminalOutputContainsAtlasRiskGlyph("\x1b[44m selected block \x1b[0m")).toBe(false);
    expect(terminalOutputContainsAtlasRiskGlyph("\x1b[32mplain green\x1b[0m")).toBe(false);
  });
});
