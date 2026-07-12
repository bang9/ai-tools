import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";

// ── P6 golden-corpus CROSS-LANGUAGE differential (design R2 gate) ─────────────
//
// This is the CONSUMER half of the R2 gate. The PRODUCER is the Rust test
// `golden_corpus_fixtures_match_committed` in grove-daemon/src/emulator.rs: it
// feeds a crafted byte stream through the same emulator + mode_state tee
// pipeline `Session` uses, serializes via `DaemonSnapshot::warm_payload()`, and
// commits grove-daemon/fixtures/golden/<name>.json (regenerate with
// `GROVE_REGEN_GOLDEN=1 cargo test -p grove-daemon`).
//
// The property under test (design R2): replaying the daemon's serialized
// snapshot payload into @xterm/headless must reproduce the SAME visible terminal
// as feeding the original input bytes directly. If a fixture's `payload_b64`
// (fed into a fresh xterm following the S16 replay order) renders a different
// screen than `input_b64` (fed into a reference xterm), the daemon serializer
// would garble a warm reattach — exactly the R2 failure mode.
//
// The S16 replay order below is INDEPENDENTLY REIMPLEMENTED from the design
// (§S16 / line-item S16 in notes/daemon-design.md), NOT imported from
// terminal-runtime.ts, so the two implementations cross-check each other.
//
// Scrollback scope (design §3.4 / S12 / D6): the warm payload is deliberately
// VIEWPORT-ONLY — vt100's `contents_formatted()` serializes only the visible
// grid, never scrollback history (empirically verified: plain-text-scroll's
// payload begins at "line 178", not "line 001"). History is kept byte-exact by
// the raw ring / disk log and restored by the COLD path, not the warm snapshot.
// So this differential compares the restored VIEWPORT (what warm reattach
// actually reproduces) and pins the viewport-only contract for the two
// history-heavy fixtures, rather than comparing scrollback lines the warm path
// never carries.

// The renderer's post-replay reset bundle (design S16 step 5), reimplemented
// verbatim from the design. Order: cursor-style reset, kitty pop-all + flags=0,
// show cursor, then every mouse-reporting + encoding mode OFF, then focus off.
// This bundle is authoritative for mouse / focus / kitty state (design S9 omits
// kitty from the rehydrate preamble; S16 clears mouse+focus) — the renderer's
// reset always wins, so those modes are asserted in their RESET state below even
// when the fixture armed them.
const POST_REPLAY_REATTACH_RESET =
  "\x1b[0 q\x1b[<99u\x1b[=0u\x1b[?25h\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l\x1b[?1004l";

interface GoldenFixture {
  name: string;
  cols: number;
  rows: number;
  input_b64: string;
  payload_b64: string;
  pending_tail_b64: string;
  is_alternate_screen: boolean;
  kitty_flags: number;
  output_sequence: number;
}

function loadFixture(name: string): GoldenFixture {
  const url = new URL(`../../grove-daemon/fixtures/golden/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as GoldenFixture;
}

function bytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function writeChunk(term: Terminal, data: Uint8Array | string): Promise<void> {
  // xterm.write accepts a Uint8Array (raw bytes) or a string; the daemon wire
  // unit is BYTES (design OVERLAY 2.5), so payload/input/tail are written as
  // decoded bytes and the reset bundle as an ASCII string.
  return new Promise((resolve) => term.write(data, resolve));
}

function makeTerminal(cols: number, rows: number): Terminal {
  return new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
}

/** Visible viewport rows, trailing space trimmed (design: `translateToString(true)`
 *  used consistently so wide-char trailing-space normalization can't mask a real
 *  difference — a divergence would still show in the trimmed glyphs). */
function visibleRows(term: Terminal): string[] {
  const buf = term.buffer.active;
  const rows: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    rows.push(buf.getLine(buf.baseY + i)?.translateToString(true) ?? "");
  }
  return rows;
}

interface Rendered {
  rows: string[];
  cursorX: number;
  cursorY: number;
  bufferType: "normal" | "alternate";
  mouseTrackingMode: string;
  bracketedPasteMode: boolean;
  applicationCursorKeysMode: boolean;
  sendFocusMode: boolean;
}

function snapshotState(term: Terminal): Rendered {
  const buf = term.buffer.active;
  return {
    rows: visibleRows(term),
    cursorX: buf.cursorX,
    cursorY: buf.cursorY,
    bufferType: buf.type,
    mouseTrackingMode: term.modes.mouseTrackingMode,
    bracketedPasteMode: term.modes.bracketedPasteMode,
    applicationCursorKeysMode: term.modes.applicationCursorKeysMode,
    sendFocusMode: term.modes.sendFocusMode,
  };
}

/** REFERENCE terminal: feed the original input bytes directly at the fixture's
 *  (final) dims. */
async function renderReference(fx: GoldenFixture): Promise<Rendered> {
  const term = makeTerminal(fx.cols, fx.rows);
  try {
    await writeChunk(term, bytes(fx.input_b64));
    return snapshotState(term);
  } finally {
    term.dispose();
  }
}

/** RESTORED terminal: apply the S16 warm-reattach replay order (independently
 *  reimplemented from the design). The terminal is already at fixture dims
 *  (design S16 step 1 is a no-op here — no dims mismatch to resize away). */
async function renderRestored(fx: GoldenFixture): Promise<Rendered> {
  const term = makeTerminal(fx.cols, fx.rows);
  try {
    // S16 step 2: clear screen + scrollback + home.
    await writeChunk(term, "\x1b[2J\x1b[3J\x1b[H");
    // S16 step 4: the warm payload (scrollback ++ rehydrate preamble ++ alt body).
    await writeChunk(term, bytes(fx.payload_b64));
    // S16 step 5: the renderer reset bundle (authoritative for mouse/focus/kitty).
    await writeChunk(term, POST_REPLAY_REATTACH_RESET);
    // S16 step 6: the parked partial escape LAST, after the reset, so a dangling
    // ESC is never aborted by the bundle.
    await writeChunk(term, bytes(fx.pending_tail_b64));
    return snapshotState(term);
  } finally {
    term.dispose();
  }
}

/** Assert the restored VIEWPORT matches the reference viewport: visible rows,
 *  cursor, and active buffer type. Modes are asserted separately per fixture
 *  (some are deliberately reset by the S16 bundle). */
function expectViewportMatches(name: string, restored: Rendered, reference: Rendered) {
  expect(restored.rows, `${name}: visible rows diverge`).toEqual(reference.rows);
  expect(restored.cursorX, `${name}: cursorX diverges`).toBe(reference.cursorX);
  expect(restored.cursorY, `${name}: cursorY diverges`).toBe(reference.cursorY);
  expect(restored.bufferType, `${name}: active buffer type diverges`).toBe(reference.bufferType);
}

describe("daemon snapshot golden differential (R2): warm payload replay == direct input", () => {
  // Fixtures whose viewport + cursor + buffer type must replay identically.
  const VIEWPORT_IDENTICAL = [
    "plain-text-scroll",
    "cjk-emoji-wide",
    "sgr-styling",
    "scroll-region",
    "alt-enter-vim-like",
    "kitty-flags",
    "cwd-title",
    "saved-cursor",
    "saved-cursor-at-home",
    "wrap-pending-at-col",
    "partial-escape-split",
    "scrollback-then-alt",
  ] as const;

  for (const name of VIEWPORT_IDENTICAL) {
    it(`${name}: restored viewport equals direct-input viewport`, async () => {
      const fx = loadFixture(name);
      const [restored, reference] = await Promise.all([renderRestored(fx), renderReference(fx)]);
      expectViewportMatches(name, restored, reference);
      // The active buffer type must also match the daemon's own alt flag.
      expect(restored.bufferType).toBe(fx.is_alternate_screen ? "alternate" : "normal");
      // applicationCursorKeysMode (?1h) is NOT cleared by the reset bundle and is
      // re-armed by the rehydrate preamble, so it must equal the reference.
      expect(
        restored.applicationCursorKeysMode,
        `${name}: applicationCursorKeysMode must survive the reset bundle`,
      ).toBe(reference.applicationCursorKeysMode);
    });
  }

  it("mouse-modes: viewport matches, but mouse tracking is RESET (renderer reset wins, S9/S16)", async () => {
    const fx = loadFixture("mouse-modes");
    const [restored, reference] = await Promise.all([renderRestored(fx), renderReference(fx)]);
    expectViewportMatches("mouse-modes", restored, reference);
    // The reference armed press-release + button-motion → xterm reports 'drag'.
    expect(reference.mouseTrackingMode).toBe("drag");
    // The daemon rehydrate preamble RE-ARMS mouse, but the S16 reset bundle
    // clears every mouse-reporting mode LAST, so the renderer reset is
    // authoritative: the restored terminal reports 'none'. This is by design
    // (S9 body is mode-neutral; S16 step 5 clears mouse) — a live-agent that
    // still wants mouse re-emits it on its next repaint.
    expect(restored.mouseTrackingMode, "S16 reset bundle must clear mouse tracking").toBe("none");
  });

  it("bracketed-focus: bracketed-paste survives, focus reporting is RESET (S16 clears ?1004 only)", async () => {
    const fx = loadFixture("bracketed-focus");
    const [restored, reference] = await Promise.all([renderRestored(fx), renderReference(fx)]);
    expectViewportMatches("bracketed-focus", restored, reference);
    // Bracketed paste (?2004) is re-armed by rehydrate and is NOT in the reset
    // bundle → it must survive and match the reference.
    expect(reference.bracketedPasteMode).toBe(true);
    expect(
      restored.bracketedPasteMode,
      "bracketed paste must survive the reset bundle (not cleared by S16)",
    ).toBe(true);
    // Focus reporting (?1004) IS cleared by the S16 reset bundle (?1004l), so
    // the renderer reset wins even though the reference armed it.
    expect(reference.sendFocusMode).toBe(true);
    expect(restored.sendFocusMode, "S16 reset bundle must clear focus reporting").toBe(false);
  });

  // ── Scrollback scope: the warm payload is viewport-only (design §3.4/S12/D6) ──
  // History is NOT carried by the warm snapshot — vt100's contents_formatted
  // serializes only the visible grid. These two assertions PIN that contract so
  // a future change that started dumping scrollback into the warm payload (which
  // would then diverge from the reference's own scrollback) is caught here.

  it("plain-text-scroll: warm payload carries NO scrollback history (viewport-only, §3.4)", () => {
    const fx = loadFixture("plain-text-scroll");
    const payload = Buffer.from(fx.payload_b64, "base64").toString("utf8");
    // The 200-line input scrolled lines 1..~176 into history; the warm payload
    // holds only the visible tail, so early history is absent by design.
    expect(payload).not.toContain("line 001");
    expect(payload).toContain("line 200");
  });

  it("scrollback-then-alt: frozen-primary + alt body, no pre-history in the payload (§3.4/S8)", () => {
    const fx = loadFixture("scrollback-then-alt");
    const payload = Buffer.from(fx.payload_b64, "base64").toString("utf8");
    expect(fx.is_alternate_screen).toBe(true);
    // Frozen-primary segment carries only the visible primary tail (not line 001).
    expect(payload).not.toContain("history 001");
    // Rehydrate re-arms alt; the alt body follows.
    expect(payload).toContain("\x1b[?1049h");
    expect(payload).toContain("ALT SCREEN TUI TOP");
  });

  // ── Known divergence (documented design trade-off) ───────────────────────────
  // post-resize: the emulator was fed a 100-char line at 80 cols (wrapping to
  // two rows), then resized to 120. vt100 does NOT reflow on resize — it
  // truncates/pads — so `contents_formatted()` serializes the OLD wrapping (an
  // 80-char row + a 20-char row joined by a hard newline). Replayed into a
  // 120-col xterm that stays two rows, while the REFERENCE (fed the raw 100-char
  // line at 120 cols) fits it on ONE row. The viewport therefore diverges.
  //
  // This is the design's explicitly-NOT-claimed reflow trade-off:
  //   - §3.4 / table row "resize = reflow?" → "truncate/pad, NO reflow"
  //   - D6 / §3.4: "A session resized narrower/wider mid-run will show divergent
  //     wrapping in the reconstructed screen because vt100 does not reflow — this
  //     is display-only, corrected by the shell's next repaint, and is explicitly
  //     NOT claimed as tmux-parity reflow."
  // The warm path accepts this; the shell's next repaint corrects it live.
  it.fails("post-resize: reflow divergence is EXPECTED (vt100 no-reflow trade-off, design §3.4/D6)", async () => {
    const fx = loadFixture("post-resize");
    const [restored, reference] = await Promise.all([renderRestored(fx), renderReference(fx)]);
    // Fails by design: restored keeps the 80/20 pre-resize wrap; the reference
    // reflows the 100-char line onto one 120-col row.
    expectViewportMatches("post-resize", restored, reference);
  });

  it("post-resize: the divergence is ONLY the un-reflowed wrap (verifies it is the trade-off, not a bug)", async () => {
    // Guards the it.fails above against masking a real serializer bug: the
    // divergence must be exactly the no-reflow wrapping and nothing else. The
    // restored screen must still carry the same GLYPHS (all 100 'A's + both
    // trailing lines), just wrapped at the pre-resize width.
    const fx = loadFixture("post-resize");
    const restored = await renderRestored(fx);
    const joined = restored.rows.join("");
    // All 100 'A's are present (wrapped as 80 + 20), plus both later lines.
    expect(joined).toContain("A".repeat(80));
    expect(joined.replace(/[^A]/g, "").length).toBe(100);
    expect(joined).toContain("after first line");
    expect(joined).toContain("appended after resize at wider dims");
    // Confirm the un-reflowed shape: an 80-char row followed by a 20-char row.
    const aRows = restored.rows.filter((r) => /^A+$/.test(r));
    expect(aRows).toContain("A".repeat(80));
    expect(aRows).toContain("A".repeat(20));
  });
});

// Why: a reattached agent's restored scrollback contains the device queries it
// emitted at startup (OSC 10/11 colour probes, DSR/CPR). Replaying those bytes
// makes xterm ANSWER them via onData — a stale duplicate that terminal-runtime
// must NOT forward to the PTY (it garbles the command line and interrupts a live
// agent). This proves the hazard is real: xterm does answer a query embedded in
// replayed bytes, so the `replayingScrollback` guard on onData is load-bearing.
describe("device queries embedded in replayed scrollback", () => {
  it("make xterm emit a response on onData (which the replay guard must drop)", async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const emitted: string[] = [];
    term.onData((d) => emitted.push(d));

    // DSR 6 (cursor position) + DA (device attributes) — device queries of the
    // same class as the OSC 10/11 colour probes seen leaking onto the prompt after
    // a reattach. (Headless has no palette so it cannot answer OSC 11, but a real
    // browser xterm answers that too; the cursor/DA replies prove the mechanism.)
    await new Promise<void>((resolve) => term.write("\x1b[6n\x1b[c", () => resolve()));

    const joined = emitted.join("");
    // eslint-disable-next-line no-control-regex -- matching the raw ESC reply
    expect(joined).toMatch(/\x1b\[\d+;\d+R/); // the cursor-position report (CPR)
    expect(joined).toContain("\x1b[?"); // the device-attributes reply (DA)
    expect(joined.length).toBeGreaterThan(0); // xterm DID answer — so the guard matters
    term.dispose();
  });
});
