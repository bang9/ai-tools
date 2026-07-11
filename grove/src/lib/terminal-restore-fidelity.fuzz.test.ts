import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";

// Seeded ANSI capture+restore fidelity fuzz for grove's raw-tail scrollback
// restore path. Grove's Rust core keeps a raw-byte scrollback ring capped at
// MAX_SCROLLBACK_BYTES (grove-core/src/pty.rs); on reveal/rehydrate the renderer
// replays those raw tail bytes into a fresh xterm (startHydration in
// terminal-runtime.ts). Restore therefore has NO mode/preamble rehydration
// (unlike orca's snapshot rehydrateSequences) — the fidelity of the restored
// screen rests entirely on the raw tail bytes.
//
// The fidelity risk this suite pins: when the ring is truncated, the tail is
// cut at an arbitrary byte offset that can fall mid-escape-sequence or
// mid-UTF-8 (the ring drains oldest bytes with no boundary alignment, and the
// bytes reach the renderer via String::from_utf8_lossy — U+FFFD for broken
// leads). This suite feeds a full seeded agent-TUI stream S to a reference
// headless terminal, feeds tail(S, CAP) to a second terminal, and compares the
// final visible screens.
//
// The op mix is ported from orca's shared/agent-tui-ansi-fuzz-stream.ts (plain
// text incl. CJK/emoji, SGR runs, cursor moves, wrapped long lines, scroll
// regions, alt-screen enter/exit, CR status redraws, DEC 2026 sync frames,
// saved-cursor detours) so the streams model real Claude Code / Codex output.
//
// Runtime knobs (match orca conventions):
//   FUZZ_ITERATIONS=5000  deep/nightly corpus (default 40, runs in CI)
//   FUZZ_SEED=1234        re-run exactly one seed (repro from a failure log)

// ── Seeded PRNG + op mix (ported from orca) ──────────────────────────────────

/** Same seeded PRNG as orca's fuzz stream generator. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Dims = { cols: number; rows: number };

function int(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

const WORDS = [
  "reading",
  "src/lib/terminal-runtime.ts",
  "tokens 12.4k",
  "esc to interrupt",
  "Thinking…",
  "bash: pnpm test",
  "+142 -37",
  "PASS pty.test",
  "waiting for approval",
  "diff --git a/pty.rs",
] as const;

const WIDE_RUNS = [
  "你好世界",
  "터미널 상태 확인",
  "進捗を表示中",
  "🟢 working",
  "🤖 codex",
  "✅ done ✨",
  // ZWJ emoji join — the exact width divergence a unicode11 provider exists for.
  "👨‍👩‍👧‍👦 team",
  "🇰🇷 locale",
] as const;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;

function sgr(rng: () => number): string {
  const roll = rng();
  if (roll < 0.2) {
    return `\x1b[${pick(rng, ["0", "1", "2", "3", "4", "7", "9", "22", "24", "39", "49"])}m`;
  }
  if (roll < 0.55) {
    return `\x1b[${int(rng, 30, 37) + (rng() < 0.3 ? 60 : 0)}m`;
  }
  if (roll < 0.8) {
    return `\x1b[38;5;${int(rng, 0, 255)}m`;
  }
  return `\x1b[38;2;${int(rng, 0, 255)};${int(rng, 0, 255)};${int(rng, 0, 255)}m`;
}

function textRun(rng: () => number): string {
  const parts: string[] = [];
  const count = int(rng, 1, 3);
  for (let i = 0; i < count; i++) {
    parts.push(rng() < 0.25 ? pick(rng, WIDE_RUNS) : pick(rng, WORDS));
  }
  return parts.join(" ");
}

function styledLine(rng: () => number): string {
  return `${sgr(rng)}${textRun(rng)}\x1b[0m\r\n`;
}

function panelRedraw(rng: () => number, dims: Dims): string {
  const height = int(rng, 1, Math.min(6, dims.rows - 2));
  const lines: string[] = [`\x1b[${height}A\r`];
  if (rng() < 0.5) {
    lines.push("\x1b[0J");
  }
  for (let i = 0; i < height; i++) {
    lines.push(`\x1b[2K${sgr(rng)}│ ${textRun(rng)}\x1b[0m\r\n`);
  }
  return lines.join("");
}

function statusLineRewrite(rng: () => number): string {
  return `\r\x1b[2K${sgr(rng)}${pick(rng, SPINNER)} ${textRun(rng)}\x1b[0m`;
}

function cursorMotion(rng: () => number, dims: Dims): string {
  const roll = rng();
  if (roll < 0.4) {
    return `\x1b[${int(rng, 1, dims.rows)};${int(rng, 1, dims.cols)}H`;
  }
  if (roll < 0.55) {
    return `\x1b[${int(rng, 1, dims.cols)}G`;
  }
  return `\x1b[${int(rng, 1, 4)}${pick(rng, ["A", "B", "C", "D"] as const)}`;
}

function eraseOp(rng: () => number): string {
  return pick(rng, ["\x1b[K", "\x1b[1K", "\x1b[2K", "\x1b[0J", "\x1b[1J"] as const);
}

function wrappedLongLine(rng: () => number, dims: Dims): string {
  const unit = `${textRun(rng)} `;
  const repeats = Math.ceil((dims.cols * int(rng, 1, 3)) / Math.max(unit.length, 1)) + 1;
  return `${sgr(rng)}${unit.repeat(repeats)}\x1b[0m\r\n`;
}

function scrollRegionBurst(rng: () => number, dims: Dims): string {
  const top = int(rng, 1, Math.max(1, dims.rows - 4));
  const bottom = int(rng, top + 1, dims.rows);
  const body: string[] = [`\x1b[${top};${bottom}r`, `\x1b[${bottom};1H`];
  for (let i = 0; i < int(rng, 1, 4); i++) {
    body.push(`${textRun(rng)}\r\n`);
  }
  body.push("\x1b[r");
  return body.join("");
}

function altScreenFrame(rng: () => number, dims: Dims): string {
  const rows = int(rng, 2, Math.min(8, dims.rows));
  const body: string[] = ["\x1b[?1049h", "\x1b[2J\x1b[H", "\x1b[?25l"];
  for (let i = 0; i < rows; i++) {
    body.push(`${sgr(rng)}│ ${textRun(rng)}\x1b[0m${i === rows - 1 ? "" : "\r\n"}`);
  }
  body.push(`\x1b[${int(rng, 1, dims.rows)};${int(rng, 1, dims.cols)}H\x1b[?25h`);
  if (rng() < 0.5) {
    body.push("\x1b[?1049l");
  }
  return body.join("");
}

function synchronizedFrame(rng: () => number, dims: Dims): string {
  return `\x1b[?2026h${rng() < 0.5 ? panelRedraw(rng, dims) : statusLineRewrite(rng)}\x1b[?2026l`;
}

function savedCursorDetour(rng: () => number, dims: Dims): string {
  return `\x1b7${cursorMotion(rng, dims)}${sgr(rng)}${textRun(rng)}\x1b[0m\x1b8`;
}

/** One seeded agent-TUI-shaped op. Weights favor the redraw ops that produce
 *  the redraw churn most likely to be truncated mid-sequence in the ring. */
function nextOp(rng: () => number, dims: Dims): string {
  const roll = rng();
  if (roll < 0.18) {
    return styledLine(rng);
  }
  if (roll < 0.32) {
    return statusLineRewrite(rng);
  }
  if (roll < 0.46) {
    return panelRedraw(rng, dims);
  }
  if (roll < 0.54) {
    return synchronizedFrame(rng, dims);
  }
  if (roll < 0.62) {
    return wrappedLongLine(rng, dims);
  }
  if (roll < 0.7) {
    return cursorMotion(rng, dims) + eraseOp(rng);
  }
  if (roll < 0.78) {
    return altScreenFrame(rng, dims);
  }
  if (roll < 0.88) {
    return scrollRegionBurst(rng, dims);
  }
  return savedCursorDetour(rng, dims);
}

function buildStream(seed: number, dims: Dims, opCount: number): string {
  const rng = mulberry32(seed);
  let stream = "";
  for (let i = 0; i < opCount; i++) {
    stream += nextOp(rng, dims);
  }
  return stream;
}

// ── Headless terminal + raw-tail restore model ───────────────────────────────

const encoder = new TextEncoder();
// Non-fatal decoder (default) mirrors Rust String::from_utf8_lossy: a broken
// leading multibyte sequence becomes U+FFFD rather than throwing.
const decoder = new TextDecoder();

function makeTerminal(dims: Dims): Terminal {
  return new Terminal({
    cols: dims.cols,
    rows: dims.rows,
    allowProposedApi: true,
    scrollback: 5000,
  });
}

function writeToTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

/** Final visible viewport rows (what the user sees after reveal). */
function visibleRows(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let i = 0; i < term.rows; i++) {
    rows.push(buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? "");
  }
  return rows;
}

/** Models the Rust scrollback ring on restore: keep only the trailing `capBytes`
 *  UTF-8 bytes (oldest drained, no boundary alignment) and lossy-decode them —
 *  exactly what a truncated ring hands the renderer to replay. */
function restoreTail(stream: string, capBytes: number): string {
  const bytes = encoder.encode(stream);
  if (bytes.length < capBytes) {
    return stream;
  }
  // Why: an exactly-full ring still round-trips encode→subarray→decode, so
  // the cap === byteLength case exercises the real restore path instead of
  // short-circuiting to the input string.
  return decoder.decode(bytes.subarray(bytes.length - capBytes));
}

async function replay(dims: Dims, data: string): Promise<string[]> {
  const term = makeTerminal(dims);
  try {
    await writeToTerminal(term, data);
    return visibleRows(term);
  } finally {
    term.dispose();
  }
}

// ── Runtime knobs ────────────────────────────────────────────────────────────

const DEFAULT_ITERATIONS = 40;

function readPositiveIntEnv(name: string): number | null {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
}

const FIXED_SEED = readPositiveIntEnv("FUZZ_SEED");
const ITERATIONS =
  FIXED_SEED !== null ? 1 : (readPositiveIntEnv("FUZZ_ITERATIONS") ?? DEFAULT_ITERATIONS);

const DIMS: readonly Dims[] = [
  { cols: 80, rows: 24 },
  { cols: 100, rows: 30 },
  { cols: 120, rows: 40 },
];

// Truncating caps: small enough to force the ring to drain the seeded streams
// at arbitrary byte offsets. The drain math is identical to the 256KB
// production cap, so small caps exercise the same mid-sequence boundary path.
const TRUNCATING_CAPS = [128, 512, 2048] as const;

describe("terminal raw-tail restore fidelity fuzz", () => {
  it(`never throws replaying a truncated tail across ${ITERATIONS} seeded agent-TUI streams`, async () => {
    // Property that HOLDS: replaying a ring tail cut at ANY byte offset —
    // including deliberately mid-escape and mid-UTF-8 — must not throw. xterm's
    // parser resynchronizes on the next valid sequence; a broken lead is at
    // worst rendered as stray glyphs, never a crash.
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = FIXED_SEED ?? 1 + i;
      const rng = mulberry32(seed);
      const dims = DIMS[Math.floor(rng() * DIMS.length)]!;
      const stream = buildStream(seed, dims, int(rng, 12, 40));
      const byteLength = encoder.encode(stream).length;

      // A spread of caps plus two adversarial offsets guaranteed to land inside
      // a sequence: -1 byte (mid last codepoint) and a prime-ish offset.
      const caps = [
        ...TRUNCATING_CAPS,
        Math.max(1, byteLength - 1),
        Math.max(1, Math.floor(byteLength * 0.37) + 1),
      ];
      for (const cap of caps) {
        const tail = restoreTail(stream, cap);
        await expect(replay(dims, tail)).resolves.toBeDefined();
      }
    }
  });

  it(`restores the exact visible screen when the ring is not truncated (${ITERATIONS} seeds)`, async () => {
    // Property that HOLDS: whenever the ring stays within budget (cap >= stream
    // bytes — the common case for most sessions well under MAX_SCROLLBACK_BYTES),
    // the tail IS the full stream, so raw-tail replay reproduces the live
    // visible screen byte-for-byte. This pins that restore is lossless under
    // budget and only the truncation boundary is at risk.
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = FIXED_SEED ?? 1 + i;
      const rng = mulberry32(seed);
      const dims = DIMS[Math.floor(rng() * DIMS.length)]!;
      const stream = buildStream(seed, dims, int(rng, 12, 40));

      const reference = await replay(dims, stream);
      // Exactly-full ring: forces the encode→subarray→decode restore path
      // (see restoreTail) rather than the under-budget early return.
      const fullRingTail = restoreTail(stream, encoder.encode(stream).length);
      const restored = await replay(dims, fullRingTail);
      expect(restored, `seed ${seed}: full-ring restore must match live screen`).toEqual(reference);
    }
  });

  it("restores the exact visible screen when a truncated tail is cut cleanly after a full-screen repaint", async () => {
    // Property that HOLDS: when the ring truncation happens to land at a clean
    // boundary that begins a full-screen repaint (ESC[2J ESC[H + fresh frame) —
    // which agent TUIs emit constantly — the dropped scrollback is irrelevant
    // and the restored viewport matches exactly. Deterministic anchor for the
    // "truncation CAN be lossless" side of the contract.
    const dims: Dims = { cols: 40, rows: 6 };
    const frame = "\x1b[2J\x1b[HFRAME line 1\r\nFRAME line 2\r\nFRAME line 3";
    const stream = "old scrollback line xyz\r\n".repeat(200) + frame;
    const cap = encoder.encode(frame).length;

    const reference = await replay(dims, stream);
    const restored = await replay(dims, restoreTail(stream, cap));
    expect(restored).toEqual(reference);
  });

  // ── Known garble today: tail cut mid-escape/mid-UTF-8 (test.fails) ──────────
  // These document the fidelity gap the current raw-tail restore CANNOT close:
  // when truncation lands inside a sequence AND the corrupted lead stays inside
  // the visible viewport (short trailing frame), the restored screen diverges.
  // Roadmap fix (Phase: snapshot/preamble rehydrate on restore — port orca's
  // getSnapshot rehydrateSequences so reveal replays a normalized frame instead
  // of trusting raw ring-tail byte integrity). Do NOT fix product code here;
  // unskip → flip these to `it(...)` once restore no longer depends on the cut
  // landing on a clean boundary.

  it.fails("GARBLE (roadmap: restore preamble rehydrate) — mid-UTF-8 cut corrupts the visible screen", async () => {
    const dims: Dims = { cols: 40, rows: 6 };
    // Short frame: the corrupted lead cannot scroll out of view.
    const stream = "你好世界 hello\r\nsecond line here";
    const reference = await replay(dims, stream);
    // Drop the first byte of the leading 3-byte CJK codepoint.
    const restored = await replay(dims, restoreTail(stream, encoder.encode(stream).length - 1));
    // Fails today: row 0 leads with U+FFFD instead of 你.
    expect(restored).toEqual(reference);
  });

  it.fails("GARBLE (roadmap: restore preamble rehydrate) — mid-escape cut prints stray control bytes", async () => {
    const dims: Dims = { cols: 40, rows: 6 };
    // Leading CSI sets a scroll region; cutting into it leaves ";5r" as text.
    const stream = "\x1b[2;5r\x1b[2;1Hline\r\nmore text after region";
    const reference = await replay(dims, stream);
    const restored = await replay(dims, restoreTail(stream, encoder.encode(stream).length - 3));
    // Fails today: the broken CSI tail ";5r" renders as literal glyphs.
    expect(restored).toEqual(reference);
  });
});
