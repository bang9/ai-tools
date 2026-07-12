//! Daemon-side VT emulator (design §3, P5): a `vt100::Parser` wrapped by the
//! `ModeState` tracker + primary-freeze-on-alt + a saved-cursor mirror, plus the
//! S6/S9 snapshot serializer.
//!
//! Why vt100 (verified in `notes/vt-crate-verification.md`): it is the only
//! candidate crate with a built-in screen→ANSI serializer (`contents_formatted`)
//! — the reattach primitive that replaces `tmux capture-pane`. Its three gaps
//! (no inactive-buffer read while in alt, no saved-cursor getter, no focus/pixels/
//! kitty modes) are all closed OUTSIDE the emulator, here:
//!  1. `ModeState` (mode_state.rs) tracks focus/pixels/kitty/title/cwd from the
//!     teed byte stream and drives the rehydrate preamble.
//!  2. Primary-freeze-on-alt: at an alt-screen entry the primary buffer (still
//!     active in vt100) is serialized once and frozen until alt exits (S8).
//!  3. Saved-cursor mirror: the byte scanner marks each DECSC/SCOSC, and vt100's
//!     cursor is read at that split point — the value vt100 saved but hides (S6).
//!
//! Serialization split (design S8/S9/S15): the warm payload is
//! `scrollback_ansi ++ rehydrate_sequences ++ snapshot_ansi`, where the body is
//! vt100's **mode-neutral** `contents_formatted()` and the ENTIRE mode preamble
//! is rebuilt from `ModeState` + vt100's own DECSET readers, so a mode is emitted
//! exactly once (invariant #10). `scrollback_ansi` is the normal buffer (live
//! when non-alt, the frozen snapshot when alt); `snapshot_ansi` is the alt body,
//! present only in alt.

use vt100::{MouseProtocolEncoding, MouseProtocolMode, Parser};

use crate::mode_state::{ModeState, Split};

/// Default per-session scrollback, in LINES (vt100 counts lines, not bytes). The
/// design's ring is a 256 KiB byte budget; this is the emulator's own visible+
/// history grid and is made config-driven in a later phase (§8.X).
pub const DEFAULT_SCROLLBACK_LINES: usize = 2000;

/// Toggles the S6 absolute-cursor tail (saved-cursor DECSC injection + trailing
/// absolute CUP). **Off by default (v2 verdict fix / design 4d): trust vt100's
/// own cursor emission.** The machinery is fully implemented and unit-tested so
/// the P6 golden-corpus differential can flip it on iff vt100's emission is
/// proven wrong for some case.
///
/// Why the saved-cursor register is NOT re-armed in the default rehydrate
/// preamble (design FIX 7 limitation): a `DECRC`/`SCORC` restore issued by the
/// program AFTER a warm reattach restores to the *restore terminal's* saved
/// register (home by default), not the value the program `DECSC`-saved before
/// detach. We mirror that saved cursor (`saved_cursor`) and CAN re-inject it via
/// the `absolute_cursor_tail` path, but with the tail off (the default) a
/// save-held-across-reattach program lands its restore at home. Tracked by the
/// P6 golden fixture `save-cursor-held-across-reattach`; flipping the tail on is
/// the escape hatch if the corpus proves it matters.
#[derive(Debug, Clone, Copy, Default)]
pub struct SnapshotOptions {
    pub absolute_cursor_tail: bool,
}

/// A serialized warm-reattach snapshot (design S15). Byte fields, not strings:
/// vt100 output is valid UTF-8 but the pending tail and future fields may not be,
/// and the wire unit is BYTES (OVERLAY 2.5).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DaemonSnapshot {
    /// Normal-buffer body (live serialization when non-alt, the frozen primary
    /// snapshot when alt). First segment of the concatenated payload.
    pub scrollback_ansi: Vec<u8>,
    /// Full mode preamble rebuilt from ModeState (S9). Written BETWEEN the
    /// normal-buffer scrollback and the alt body.
    pub rehydrate_sequences: Vec<u8>,
    /// Alt-buffer body, present only when in alt-screen (empty otherwise).
    pub snapshot_ansi: Vec<u8>,
    /// The parked incomplete escape (S7). The restorer writes this LAST.
    pub pending_escape_tail: Vec<u8>,
    pub cols: u16,
    pub rows: u16,
    pub is_alternate_screen: bool,
    /// Rides BESIDE the payload; the renderer's reset stays authoritative (S9).
    pub kitty_keyboard_flags: u32,
    pub cwd: Option<String>,
    pub title: Option<String>,
    /// Absolute ingest sequence stamped by the Session (design S3, BYTES).
    pub output_sequence: u64,
}

impl DaemonSnapshot {
    /// The concatenated warm-reattach payload (design S15):
    /// `scrollback_ansi ++ rehydrate_sequences ++ snapshot_ansi`. The pending
    /// escape tail is deliberately NOT included — the restorer appends it last,
    /// after its own reset bundle, so a dangling ESC isn't aborted.
    pub fn warm_payload(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            self.scrollback_ansi.len() + self.rehydrate_sequences.len() + self.snapshot_ansi.len(),
        );
        out.extend_from_slice(&self.scrollback_ansi);
        out.extend_from_slice(&self.rehydrate_sequences);
        out.extend_from_slice(&self.snapshot_ansi);
        out
    }
}

pub struct DaemonEmulator {
    parser: Parser,
    modes: ModeState,
    /// Primary buffer serialized at the last non-alt→alt entry; the primary is
    /// frozen during alt so this stays exact until `?1049l` (design S8).
    primary_frozen: Option<Vec<u8>>,
    /// Saved-cursor register (row, col) reconstructed from the byte stream, since
    /// vt100 has no getter (design S6). Raw/unclamped; the serializer clamps.
    saved_cursor: Option<(u16, u16)>,
}

impl DaemonEmulator {
    pub fn new(rows: u16, cols: u16, scrollback_lines: usize) -> Self {
        Self {
            parser: Parser::new(rows, cols, scrollback_lines),
            modes: ModeState::new(),
            primary_frozen: None,
            saved_cursor: None,
        }
    }

    /// Feed one raw PTY chunk. The chunk is scanned first (pure, no vt100) for
    /// mode updates + split points, then fed to vt100 in segments so the primary
    /// buffer can be frozen at alt entry and the saved cursor read at DECSC/SCOSC.
    pub fn process(&mut self, chunk: &[u8]) {
        let scan = self.modes.scan(chunk);
        if scan.splits.is_empty() {
            self.parser.process(chunk);
            self.reconcile_alt();
            return;
        }
        let mut cursor = 0usize;
        for (offset, action) in scan.splits {
            let offset = offset.min(chunk.len());
            if offset > cursor {
                self.parser.process(&chunk[cursor..offset]);
                cursor = offset;
            }
            match action {
                Split::SnapshotPrimary => {
                    // vt100 has not yet seen the alt-enter escape → still primary.
                    if !self.parser.screen().alternate_screen() {
                        self.primary_frozen = Some(self.parser.screen().contents_formatted());
                    }
                }
                Split::CaptureSavedCursor => {
                    // vt100 has processed through the save → its cursor is the
                    // value it saved (DECSC/SCOSC do not move the cursor).
                    self.saved_cursor = Some(self.parser.screen().cursor_position());
                }
            }
        }
        if cursor < chunk.len() {
            self.parser.process(&chunk[cursor..]);
        }
        self.reconcile_alt();
    }

    /// Drop the frozen primary once vt100 leaves alt-screen — the live normal
    /// buffer is authoritative again.
    fn reconcile_alt(&mut self) {
        if !self.parser.screen().alternate_screen() {
            self.primary_frozen = None;
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        // vt100 truncates/pads (no reflow — verified); acceptable for an
        // alt-screen TUI and corrected by the shell's next repaint for normal.
        self.parser.screen_mut().set_size(rows, cols);
    }

    /// Reset the scrollback view for a `clearHistory` (design item 4, tmux
    /// `clear-history` replacement). vt100 0.16 exposes NO public API to drop
    /// scrollback rows (`set_scrollback` only moves the display offset, and ED-3 is
    /// not handled), and the warm-reattach body is `contents_formatted()` — a single
    /// visible screenful, not the scrollback rows — so the byte-exact history the
    /// daemon actually replays lives in the session ring + on-disk log, both cleared
    /// by `Session::clear_history`. This only pins the scroll position back to the
    /// live screen so a subsequent snapshot never serializes from a scrolled-up view.
    pub fn clear_scrollback(&mut self) {
        self.parser.screen_mut().set_scrollback(0);
    }

    /// The dims vt100 currently holds (design G8). Advanced by `resize` BEFORE
    /// the caller resizes the subprocess, so this is an accurate proxy for the
    /// size the child took (orca getAppliedSize ordering).
    pub fn applied_size(&self) -> (u16, u16) {
        let (rows, cols) = self.parser.screen().size();
        (cols, rows)
    }

    pub fn is_alternate_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    pub fn cwd(&self) -> Option<String> {
        self.modes.cwd().map(str::to_string)
    }

    pub fn title(&self) -> Option<String> {
        self.modes.title().map(str::to_string)
    }

    pub fn kitty_flags(&self) -> u32 {
        self.modes.kitty_flags()
    }

    /// Drain the ground-BEL count accumulated by `process` (design G9). The
    /// session reads this right after feeding a chunk and flips its per-poll bell
    /// flag; drained here so the emulator never double-reports a bell.
    pub fn take_bells(&mut self) -> u32 {
        self.modes.take_bells()
    }

    /// Serialize the current VT state into a warm-reattach snapshot (S6/S9/S15).
    /// `output_sequence` is stamped by the caller (Session owns the counter).
    pub fn snapshot(&self, opts: SnapshotOptions, output_sequence: u64) -> DaemonSnapshot {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let is_alt = screen.alternate_screen();

        let body = self.serialize_body(opts);
        let (scrollback_ansi, snapshot_ansi) = if is_alt {
            // Alt: normal buffer is the frozen snapshot; alt grid is the body.
            (self.primary_frozen.clone().unwrap_or_default(), body)
        } else {
            // Normal: live body is the normal buffer; no alt segment.
            (body, Vec::new())
        };

        DaemonSnapshot {
            scrollback_ansi,
            rehydrate_sequences: self.rehydrate_preamble(),
            snapshot_ansi,
            pending_escape_tail: self.modes.partial_escape_tail().to_vec(),
            cols,
            rows,
            is_alternate_screen: is_alt,
            kitty_keyboard_flags: self.modes.kitty_flags(),
            cwd: self.cwd(),
            title: self.title(),
            output_sequence,
        }
    }

    /// The mode-neutral body (S9): vt100's `contents_formatted()`, which emits
    /// only `\e[?25l\e[m\e[H\e[J` + content and leaves the cursor correctly
    /// placed. The optional S6 tail (off by default) re-establishes the DECSC
    /// register and appends an absolute CUP when vt100's own emission is proven
    /// insufficient.
    fn serialize_body(&self, opts: SnapshotOptions) -> Vec<u8> {
        let screen = self.parser.screen();
        let mut out = screen.contents_formatted();
        if !opts.absolute_cursor_tail {
            return out; // trust vt100's built-in cursor emission (design 4d).
        }
        let (rows, cols) = screen.size();
        let (row, col) = screen.cursor_position();
        // Skip wrap-pending (col == cols) and out-of-bounds: plain replay already
        // reproduces those, and an absolute CUP would clamp and clear pending.
        if col >= cols || row >= rows {
            return out;
        }
        if let Some(inj) = saved_cursor_injection(self.saved_cursor, cols, rows) {
            out.extend_from_slice(&inj);
        }
        out.extend_from_slice(format!("\x1b[{};{}H", row + 1, col + 1).as_bytes());
        out
    }

    /// Build the full rehydrate preamble (design S9), reading vt100's DECSET
    /// accessors for the modes it exposes and `ModeState` for the three it does
    /// not (focus/pixels; kitty is deliberately omitted — the renderer's reset
    /// stays authoritative). Order is load-bearing.
    fn rehydrate_preamble(&self) -> Vec<u8> {
        let screen = self.parser.screen();
        let mut p: Vec<u8> = Vec::new();
        if screen.alternate_screen() {
            // Reset the pen first: normal-buffer serialization may leave it
            // active, while the alt body assumes a default-SGR start.
            p.extend_from_slice(b"\x1b[0m\x1b[?1049h");
        }
        if screen.bracketed_paste() {
            p.extend_from_slice(b"\x1b[?2004h");
        }
        if screen.application_cursor() {
            p.extend_from_slice(b"\x1b[?1h");
        }
        if screen.application_keypad() {
            p.extend_from_slice(b"\x1b=");
        }
        match screen.mouse_protocol_mode() {
            MouseProtocolMode::None => {}
            MouseProtocolMode::Press => p.extend_from_slice(b"\x1b[?9h"),
            MouseProtocolMode::PressRelease => p.extend_from_slice(b"\x1b[?1000h"),
            MouseProtocolMode::ButtonMotion => p.extend_from_slice(b"\x1b[?1002h"),
            MouseProtocolMode::AnyMotion => p.extend_from_slice(b"\x1b[?1003h"),
        }
        // Encoding is independent of reporting: preserve it even when mouse off.
        if self.modes.sgr_pixels() {
            p.extend_from_slice(b"\x1b[?1016h");
        } else if screen.mouse_protocol_encoding() == MouseProtocolEncoding::Sgr {
            p.extend_from_slice(b"\x1b[?1006h");
        }
        if self.modes.focus() {
            p.extend_from_slice(b"\x1b[?1004h");
        }
        // DECSTBM re-arm LAST (design FIX 3 / orca rehydrate ordering: the body
        // paints first, then the region arms). In the non-alt case this preamble
        // follows the normal-buffer body, so the region is established only after
        // the content is painted. It is never emitted in alt (ModeState resets the
        // region on any alt switch). vt100's DECSTBM moves the cursor to the region
        // home, so restore the real cursor afterwards to keep the body's placement
        // byte-exact (preserves the serialize→fresh→serialize fixed point).
        if let Some((top, bottom)) = self.modes.scroll_region() {
            p.extend_from_slice(format!("\x1b[{top};{bottom}r").as_bytes());
            let (row, col) = screen.cursor_position();
            p.extend_from_slice(format!("\x1b[{};{}H", row + 1, col + 1).as_bytes());
        }
        p
    }
}

/// Build the S6 saved-cursor injection (`CUP to saved ; ESC 7`) with orca's
/// home-skip + clamps. Returns `None` when there is no saved cursor or it is the
/// never-saved home default. Emitted only on the absolute-cursor-tail path, and
/// always followed by an absolute CUP back to the real cursor (the caller).
pub fn saved_cursor_injection(
    saved: Option<(u16, u16)>,
    cols: u16,
    rows: u16,
) -> Option<Vec<u8>> {
    let (row, col) = saved?;
    // Clamp savedY to the last row and savedX==cols (DECSC during wrap-pending)
    // to the last column — CUP cannot recreate pending-wrap.
    let y = row.min(rows.saturating_sub(1));
    let x = col.min(cols.saturating_sub(1));
    // Home is xterm's never-saved default: injecting ESC 7 at home would clobber
    // the restore terminal's default saved SGR/charset (design 4c / orca).
    if x == 0 && y == 0 {
        return None;
    }
    Some(format!("\x1b[{};{}H\x1b7", y + 1, x + 1).into_bytes())
}

impl DaemonEmulator {
    /// Plain-text screen contents (rows joined by `\n`) — a test-only readback so
    /// scroll-region assertions can inspect per-row state without re-parsing the
    /// serialized bytes.
    #[cfg(test)]
    pub fn screen_contents(&self) -> String {
        self.parser.screen().contents()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn emu() -> DaemonEmulator {
        DaemonEmulator::new(24, 80, DEFAULT_SCROLLBACK_LINES)
    }

    fn snap(e: &DaemonEmulator) -> DaemonSnapshot {
        e.snapshot(SnapshotOptions::default(), 0)
    }

    fn preamble(e: &DaemonEmulator) -> String {
        String::from_utf8_lossy(&snap(e).rehydrate_sequences).into_owned()
    }

    #[test]
    fn plain_text_round_trips_through_fresh_emulator() {
        let mut a = emu();
        a.process(b"hello world\r\nsecond line");
        let s1 = snap(&a);

        // Feed the serialized payload into a FRESH emulator; its serialize must
        // equal the original (fixed point / design P5 round-trip property).
        let mut b = emu();
        b.process(&s1.warm_payload());
        let s2 = snap(&b);
        assert_eq!(s1.scrollback_ansi, s2.scrollback_ansi);
        assert_eq!(s1.snapshot_ansi, s2.snapshot_ansi);
        assert_eq!(s1.rehydrate_sequences, s2.rehydrate_sequences);
    }

    #[test]
    fn cjk_and_emoji_round_trip() {
        let mut a = emu();
        a.process("你好 世界 🌍 café".as_bytes());
        let s1 = snap(&a);
        let mut b = emu();
        b.process(&s1.warm_payload());
        assert_eq!(s1.scrollback_ansi, snap(&b).scrollback_ansi);
    }

    #[test]
    fn sgr_runs_round_trip() {
        let mut a = emu();
        a.process(b"\x1b[1;31mred bold\x1b[0m normal \x1b[4;32mgreen underline\x1b[0m");
        let s1 = snap(&a);
        let mut b = emu();
        b.process(&s1.warm_payload());
        assert_eq!(s1.scrollback_ansi, snap(&b).scrollback_ansi);
    }

    #[test]
    fn scroll_region_round_trips() {
        let mut a = emu();
        a.process(b"\x1b[5;15r"); // DECSTBM scroll region
        a.process(b"\x1b[10Hline in region\r\nnext");
        let s1 = snap(&a);
        let mut b = emu();
        b.process(&s1.warm_payload());
        assert_eq!(s1.scrollback_ansi, snap(&b).scrollback_ansi);
    }

    #[test]
    fn alt_screen_enter_freezes_primary_and_serializes_alt() {
        let mut e = emu();
        e.process(b"PRIMARY-CONTENT\r\nline2");
        e.process(b"\x1b[?1049h"); // enter alt
        e.process(b"\x1b[HALT-TUI-BODY");
        let s = snap(&e);
        assert!(s.is_alternate_screen);
        // scrollback = frozen primary; must carry the primary text.
        let sb = String::from_utf8_lossy(&s.scrollback_ansi);
        assert!(sb.contains("PRIMARY-CONTENT"), "frozen primary missing: {sb:?}");
        // alt body carries the TUI text; rehydrate re-arms alt.
        let alt = String::from_utf8_lossy(&s.snapshot_ansi);
        assert!(alt.contains("ALT-TUI-BODY"), "alt body missing: {alt:?}");
        let re = String::from_utf8_lossy(&s.rehydrate_sequences);
        assert!(re.contains("?1049h"), "alt not re-armed: {re:?}");
    }

    #[test]
    fn alt_exit_restores_live_normal_buffer() {
        let mut e = emu();
        e.process(b"PRIMARY");
        e.process(b"\x1b[?1049h\x1b[HALT");
        assert!(e.is_alternate_screen());
        e.process(b"\x1b[?1049l"); // exit alt
        assert!(!e.is_alternate_screen());
        let s = snap(&e);
        assert!(!s.is_alternate_screen);
        assert!(s.snapshot_ansi.is_empty());
        assert!(String::from_utf8_lossy(&s.scrollback_ansi).contains("PRIMARY"));
    }

    #[test]
    fn alt_screen_pre_alt_scrollback_preserved_when_split_mid_chunk() {
        // The alt-enter escape rides in the SAME chunk as prior primary content;
        // the split must freeze the primary before vt100 switches buffers.
        let mut e = emu();
        e.process(b"KEEP-ME\x1b[?1049h\x1b[Halt");
        let s = snap(&e);
        assert!(s.is_alternate_screen);
        assert!(
            String::from_utf8_lossy(&s.scrollback_ansi).contains("KEEP-ME"),
            "pre-alt primary lost on same-chunk alt entry"
        );
    }

    #[test]
    fn decstbm_region_round_trips_scroll_behavior() {
        // Design FIX 3: a scroll region active at snapshot must survive a fresh
        // emulator round-trip so subsequent output scrolls ONLY within the region.
        let mut a = emu();
        a.process(b"\x1b[3;5r"); // DECSTBM region = rows 3..5 (1-based)
        // Distinct token per row: 1,2 above region; 3,4,5 inside; 6 below.
        a.process(b"\x1b[1;1HAAA\x1b[2;1HBBB\x1b[3;1HCCC");
        a.process(b"\x1b[4;1HDDD\x1b[5;1HEEE\x1b[6;1HFFF");
        let s = a.snapshot(SnapshotOptions::default(), 0);
        assert!(
            String::from_utf8_lossy(&s.rehydrate_sequences).contains("3;5r"),
            "rehydrate must re-arm the DECSTBM region"
        );

        // Round-trip into a fresh emulator via the warm payload.
        let mut b = emu();
        b.process(&s.warm_payload());

        // Scroll the region up by one: park the cursor at the region bottom
        // (row 5) and emit a linefeed. With the region armed, only rows 3..5 move.
        b.process(b"\x1b[5;1H\n");
        let contents = b.screen_contents();
        // Region top (CCC) rolled out and is discarded (not saved to scrollback
        // while a region is active); DDD shifted up into row 3.
        assert!(!contents.contains("CCC"), "region top must scroll out: {contents:?}");
        assert!(contents.contains("DDD"), "region content must remain: {contents:?}");
        // Rows outside the region are untouched.
        assert!(contents.contains("AAA"), "above-region row must not scroll: {contents:?}");
        assert!(contents.contains("BBB"), "above-region row must not scroll: {contents:?}");
        assert!(contents.contains("FFF"), "below-region row must not scroll: {contents:?}");
    }

    #[test]
    fn alt_enter_after_can_aborted_csi_preserves_prealt_scrollback() {
        // Reviewer's exact repro (design FIX 1): an incomplete CSI aborted by CAN
        // rides in the same chunk as the alt-enter. Before the fix, ModeState's
        // parse_csi swallowed the CAN + the real `\x1b[?1049h`, so SnapshotPrimary
        // never fired and the frozen primary (pre-alt scrollback) was lost — even
        // though vt100 itself still switched to alt.
        let mut e = emu();
        e.process(b"PRIMARY\x1b[?10\x18\x1b[?1049h\x1b[HALT");
        let s = snap(&e);
        assert!(s.is_alternate_screen, "vt100 must be in alt after the alt-enter");
        assert!(
            !s.scrollback_ansi.is_empty(),
            "pre-alt scrollback must be preserved (frozen primary), got empty"
        );
        assert!(
            String::from_utf8_lossy(&s.scrollback_ansi).contains("PRIMARY"),
            "frozen primary must carry the pre-alt content"
        );
    }

    #[test]
    fn mouse_modes_in_preamble() {
        let mut e = emu();
        e.process(b"\x1b[?1002h\x1b[?1006h"); // button-motion + SGR encoding
        let re = preamble(&e);
        assert!(re.contains("?1002h"), "mouse mode missing: {re:?}");
        assert!(re.contains("?1006h"), "sgr encoding missing: {re:?}");
    }

    #[test]
    fn sgr_pixels_encoding_preferred_over_sgr() {
        let mut e = emu();
        e.process(b"\x1b[?1003h\x1b[?1016h"); // any-motion + pixels
        let re = preamble(&e);
        assert!(re.contains("?1016h"));
        assert!(!re.contains("?1006h"));
    }

    #[test]
    fn bracketed_paste_and_focus_in_preamble() {
        let mut e = emu();
        e.process(b"\x1b[?2004h\x1b[?1004h");
        let re = preamble(&e);
        assert!(re.contains("?2004h"));
        assert!(re.contains("?1004h"));
    }

    #[test]
    fn kitty_flags_ride_beside_not_in_preamble() {
        let mut e = emu();
        e.process(b"\x1b[>15u");
        let s = snap(&e);
        assert_eq!(s.kitty_keyboard_flags, 15);
        // Kitty is deliberately omitted from rehydrate (design S9).
        assert!(!String::from_utf8_lossy(&s.rehydrate_sequences).contains("15u"));
    }

    #[test]
    fn cwd_and_title_from_osc() {
        let mut e = emu();
        e.process(b"\x1b]7;file://host/tmp/work\x07\x1b]2;My Title\x07");
        let s = snap(&e);
        assert_eq!(s.cwd.as_deref(), Some("/tmp/work"));
        assert_eq!(s.title.as_deref(), Some("My Title"));
    }

    #[test]
    fn saved_cursor_home_is_skipped() {
        // Home (0,0) → no injection (never-saved default).
        assert_eq!(saved_cursor_injection(Some((0, 0)), 80, 24), None);
        assert_eq!(saved_cursor_injection(None, 80, 24), None);
    }

    #[test]
    fn saved_cursor_injection_clamps() {
        // savedX == cols clamps to cols-1; savedY beyond rows clamps to rows-1.
        let inj = saved_cursor_injection(Some((99, 80)), 80, 24).unwrap();
        // CUP to (row=24, col=80) 1-based after clamp to (23,79)+1, then ESC 7.
        assert_eq!(inj, b"\x1b[24;80H\x1b7");
    }

    #[test]
    fn saved_cursor_captured_from_stream() {
        let mut e = emu();
        e.process(b"\x1b[3;5H"); // move to row3 col5 (0-based 2,4)
        e.process(b"\x1b7"); // DECSC
        assert_eq!(e.saved_cursor, Some((2, 4)));
    }

    #[test]
    fn absolute_cursor_tail_off_by_default() {
        let mut e = emu();
        e.process(b"\x1b[3;5Hx\x1b7\x1b[1;1H");
        let default_body = snap(&e).scrollback_ansi;
        let with_tail = e
            .snapshot(SnapshotOptions { absolute_cursor_tail: true }, 0)
            .scrollback_ansi;
        // The gated path must differ (it appends the saved-cursor injection + CUP).
        assert_ne!(default_body, with_tail);
        // And the injection must be present on the gated path.
        assert!(with_tail.windows(2).any(|w| w == b"\x1b7"));
    }

    #[test]
    fn applied_size_tracks_resize() {
        let mut e = emu();
        assert_eq!(e.applied_size(), (80, 24));
        e.resize(120, 40);
        assert_eq!(e.applied_size(), (120, 40));
    }

    #[test]
    fn resize_mid_stream_round_trips() {
        let mut a = emu();
        a.process(b"before resize\r\n");
        a.resize(100, 30);
        a.process(b"after resize");
        let s1 = a.snapshot(SnapshotOptions::default(), 0);
        assert_eq!(s1.cols, 100);
        assert_eq!(s1.rows, 30);
        let mut b = DaemonEmulator::new(30, 100, DEFAULT_SCROLLBACK_LINES);
        b.process(&s1.warm_payload());
        assert_eq!(a.snapshot(SnapshotOptions::default(), 0).scrollback_ansi, snap(&b).scrollback_ansi);
    }

    #[test]
    fn partial_escape_split_byte_by_byte_equals_whole() {
        let stream = b"text\x1b[1;32mgreen\x1b[0m\x1b[?1049h\x1b[Halt\x1b[?1004h";
        let mut whole = emu();
        whole.process(stream);
        let sw = whole.snapshot(SnapshotOptions::default(), 0);

        let mut piece = emu();
        for b in stream {
            piece.process(&[*b]);
        }
        let sp = piece.snapshot(SnapshotOptions::default(), 0);
        assert_eq!(sw.scrollback_ansi, sp.scrollback_ansi, "scrollback differs");
        assert_eq!(sw.snapshot_ansi, sp.snapshot_ansi, "alt body differs");
        assert_eq!(sw.rehydrate_sequences, sp.rehydrate_sequences, "preamble differs");
        assert_eq!(sw.is_alternate_screen, sp.is_alternate_screen);
    }

    #[test]
    fn pending_escape_tail_exposed_in_snapshot() {
        let mut e = emu();
        e.process(b"done\x1b[?100"); // ends mid-CSI
        let s = snap(&e);
        assert_eq!(s.pending_escape_tail, b"\x1b[?100");
    }

    #[test]
    fn round_trip_fuzz_over_op_mix() {
        // Seeded xorshift fuzz mirroring the JS harness op set: text, SGR, moves,
        // alt enter/exit, mouse/paste modes, resize. The round-trip property must
        // hold at every iteration: serialize → fresh emulator → serialize equal.
        let mut rng = 0x1234_5678u32;
        let xs = |rng: &mut u32| {
            *rng ^= *rng << 13;
            *rng ^= *rng >> 17;
            *rng ^= *rng << 5;
            *rng
        };
        let mut e = emu();
        for _ in 0..400 {
            match xs(&mut rng) % 9 {
                0 => e.process(b"lorem ipsum "),
                1 => e.process("emoji 🚀 CJK 漢字 ".as_bytes()),
                2 => e.process(b"\x1b[1;33mSGR\x1b[0m"),
                3 => e.process(b"\x1b[2;3H"),
                4 => e.process(b"\x1b[?1049h\x1b[Halt"),
                5 => e.process(b"\x1b[?1049l"),
                6 => e.process(b"\x1b[?1002h\x1b[?1006h"),
                7 => e.process(b"\x1b[?2004h"),
                _ => e.resize(60 + (xs(&mut rng) % 60) as u16, 20 + (xs(&mut rng) % 20) as u16),
            }
            let s1 = e.snapshot(SnapshotOptions::default(), 0);
            let mut fresh = DaemonEmulator::new(s1.rows, s1.cols, DEFAULT_SCROLLBACK_LINES);
            fresh.process(&s1.warm_payload());
            let s2 = fresh.snapshot(SnapshotOptions::default(), 0);
            assert_eq!(s1.scrollback_ansi, s2.scrollback_ansi, "fixed-point broke");
            assert_eq!(s1.snapshot_ansi, s2.snapshot_ansi, "alt fixed-point broke");
        }
    }

    // ── P6 golden-corpus differential fixtures (design R2 gate) ────────────────
    //
    // These fixtures are the CROSS-LANGUAGE half of the R2 gate: this Rust test
    // is the GENERATOR (feed a crafted byte stream through the same emulator +
    // mode_state tee pipeline `Session` uses, serialize via `warm_payload()`),
    // and `src/lib/terminal-daemon-snapshot-golden.test.ts` is the CONSUMER
    // (replays the serialized payload into @xterm/headless and asserts it
    // reproduces the same terminal as feeding the original input bytes).
    //
    // Behavior: with `GROVE_REGEN_GOLDEN=1` the committed JSON files are
    // (re)written; otherwise the test asserts the committed bytes EXACTLY match
    // a fresh regeneration (a stale fixture = a serializer change and MUST be
    // re-reviewed against the JS differential before re-committing).

    fn b64(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// One generation step: PTY output bytes fed through the emulator, or an
    /// out-of-band resize (advances vt100 dims without contributing input bytes —
    /// mirrors `Session::resize`, which never feeds the SIGWINCH into the stream).
    enum GoldenStep {
        Feed(Vec<u8>),
        Resize(u16, u16),
    }

    struct GoldenCase {
        name: &'static str,
        /// Initial dims (rows, cols) the session's emulator opens at.
        rows: u16,
        cols: u16,
        steps: Vec<GoldenStep>,
    }

    #[derive(serde::Serialize)]
    struct GoldenFixture {
        name: String,
        cols: u16,
        rows: u16,
        input_b64: String,
        payload_b64: String,
        pending_tail_b64: String,
        is_alternate_screen: bool,
        kitty_flags: u32,
        output_sequence: u64,
    }

    fn generate_fixture(case: &GoldenCase) -> GoldenFixture {
        // Mimic the Session pipeline: emulator + mode_state tee. The ingestion
        // counter (Session::output_sequence) is the total byte count fed to the
        // emulator; a resize contributes no bytes. We stamp the snapshot with it
        // exactly as `Session::snapshot` stamps from `ingest_seq`.
        let mut emu = DaemonEmulator::new(case.rows, case.cols, DEFAULT_SCROLLBACK_LINES);
        let mut input: Vec<u8> = Vec::new();
        for step in &case.steps {
            match step {
                GoldenStep::Feed(bytes) => {
                    emu.process(bytes);
                    input.extend_from_slice(bytes);
                }
                GoldenStep::Resize(cols, rows) => emu.resize(*cols, *rows),
            }
        }
        let seq = input.len() as u64;
        let snap = emu.snapshot(SnapshotOptions::default(), seq);
        GoldenFixture {
            name: case.name.to_string(),
            cols: snap.cols,
            rows: snap.rows,
            input_b64: b64(&input),
            payload_b64: b64(&snap.warm_payload()),
            pending_tail_b64: b64(&snap.pending_escape_tail),
            is_alternate_screen: snap.is_alternate_screen,
            kitty_flags: snap.kitty_keyboard_flags,
            output_sequence: snap.output_sequence,
        }
    }

    fn feed(s: &str) -> GoldenStep {
        GoldenStep::Feed(s.as_bytes().to_vec())
    }
    fn feed_bytes(b: &[u8]) -> GoldenStep {
        GoldenStep::Feed(b.to_vec())
    }

    fn golden_cases() -> Vec<GoldenCase> {
        let mut cases = Vec::new();

        // 1. plain-text-scroll: 200 lines force the grid past 24 rows so the
        //    serialized viewport is the scrolled tail, not the first lines.
        {
            let mut body = String::new();
            for i in 1..=200 {
                body.push_str(&format!("line {i:03} lorem ipsum dolor sit amet\r\n"));
            }
            cases.push(GoldenCase {
                name: "plain-text-scroll",
                rows: 24,
                cols: 80,
                steps: vec![feed(&body)],
            });
        }

        // 2. cjk-emoji-wide: Korean + ZWJ emoji + wide chars parked AT the line
        //    edge (col 79/80) so any vt100↔xterm width disagreement surfaces.
        {
            let mut body = String::new();
            body.push_str("한국어 터미널 상태 확인 진행중\r\n");
            body.push_str("wide 你好世界 mix 漢字テスト end\r\n");
            body.push_str("emoji 🌍 🚀 ✅ 🤖 family 👨‍👩‍👧‍👦 flag 🇰🇷\r\n");
            // Push a wide glyph so its first cell lands at column 79 (0-based 78)
            // and its second cell would fall in the last column.
            body.push_str(&format!("{}가", "x".repeat(78)));
            cases.push(GoldenCase {
                name: "cjk-emoji-wide",
                rows: 24,
                cols: 80,
                steps: vec![feed(&body)],
            });
        }

        // 3. sgr-styling: 256-color + truecolor + bold/italic/underline spans.
        {
            let body = concat!(
                "\x1b[1mBOLD\x1b[0m \x1b[3mITALIC\x1b[0m \x1b[4mUNDERLINE\x1b[0m\r\n",
                "\x1b[1;3;4mALL-THREE\x1b[0m normal\r\n",
                "\x1b[38;5;196m256-red\x1b[0m \x1b[48;5;21m256-bg-blue\x1b[0m\r\n",
                "\x1b[38;2;255;128;0mtruecolor-orange\x1b[0m ",
                "\x1b[48;2;0;64;128mtc-bg\x1b[0m\r\n",
                "\x1b[7mREVERSE\x1b[0m \x1b[9mSTRIKE\x1b[0m tail",
            );
            cases.push(GoldenCase {
                name: "sgr-styling",
                rows: 24,
                cols: 80,
                steps: vec![feed(body)],
            });
        }

        // 4. scroll-region: DECSTBM region armed, content scrolled INSIDE it so
        //    the region must survive the round-trip (design FIX 3).
        {
            let body = concat!(
                "\x1b[1;1Htop line outside region\r\n",
                "\x1b[3;8r",                    // region rows 3..8
                "\x1b[3;1Hregion A\r\nregion B\r\nregion C\r\nregion D\r\nregion E",
                "\x1b[8;1H\n\n\nscrolled inside region", // linefeeds scroll only 3..8
                "\x1b[10;1Hbottom line outside region",
            );
            cases.push(GoldenCase {
                name: "scroll-region",
                rows: 24,
                cols: 80,
                steps: vec![feed(body)],
            });
        }

        // 5. alt-enter-vim-like: normal output, then alt-enter + a full-screen
        //    redraw with absolute cursor positioning (a vim/htop-shaped frame).
        {
            let body = concat!(
                "normal shell output before the editor\r\n",
                "$ vim file.txt\r\n",
                "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l",
                "\x1b[1;1H  1 fn main() {\r\n",
                "\x1b[2;1H  2     println!(\"hi\");\r\n",
                "\x1b[3;1H  3 }\r\n",
                "\x1b[24;1H\x1b[7m-- INSERT --\x1b[0m",
                "\x1b[2;20H\x1b[?25h", // park cursor mid-screen, show it
            );
            cases.push(GoldenCase {
                name: "alt-enter-vim-like",
                rows: 24,
                cols: 80,
                steps: vec![feed(body)],
            });
        }

        // 6. mouse-modes: press-release + button-motion + SGR encoding armed.
        {
            let body = "app with mouse\r\nclick to interact\x1b[?1000h\x1b[?1002h\x1b[?1006h";
            cases.push(GoldenCase {
                name: "mouse-modes",
                rows: 24,
                cols: 80,
                steps: vec![feed(body)],
            });
        }

        // 7. bracketed-focus: bracketed-paste + focus-reporting armed.
        {
            let body = "prompt> \x1b[?2004h\x1b[?1004h";
            cases.push(GoldenCase {
                name: "bracketed-focus",
                rows: 24,
                cols: 80,
                steps: vec![feed(body)],
            });
        }

        // 8. kitty-flags: CSI > 1 u push. Rides BESIDE the payload; the preamble
        //    deliberately omits it (renderer reset stays authoritative).
        {
            let body = "kitty keyboard app\r\nline two\x1b[>1u";
            cases.push(GoldenCase {
                name: "kitty-flags",
                rows: 24,
                cols: 80,
                steps: vec![feed(body)],
            });
        }

        // 9. cwd-title: OSC 7 (cwd) + OSC 0 (icon+title) + visible text.
        {
            let body =
                "\x1b]7;file://host/Users/me/project\x07\x1b]0;my-shell — project\x07working directory set";
            cases.push(GoldenCase {
                name: "cwd-title",
                rows: 24,
                cols: 80,
                steps: vec![feed(body)],
            });
        }

        // 10. saved-cursor: DECSC mid-screen, then more output moves the cursor.
        {
            let body = concat!(
                "line one\r\nline two\r\n",
                "\x1b[5;10H",   // park at row5 col10
                "\x1b7",        // DECSC (save)
                "\x1b[10;1Hmore output after save\r\ntrailing",
            );
            cases.push(GoldenCase {
                name: "saved-cursor",
                rows: 24,
                cols: 80,
                steps: vec![feed(body)],
            });
        }

        // 11. saved-cursor-at-home: DECSC at 1;1 (the never-saved default → the
        //     injection is skipped; design 4c home-skip).
        {
            let body = "\x1b[1;1H\x1b7content written after home save\r\nsecond row";
            cases.push(GoldenCase {
                name: "saved-cursor-at-home",
                rows: 24,
                cols: 80,
                steps: vec![feed(body)],
            });
        }

        // 12. wrap-pending-at-col: exactly `cols` chars written into a row leave
        //     the cursor in the deferred-wrap state (col == cols).
        {
            cases.push(GoldenCase {
                name: "wrap-pending-at-col",
                rows: 4,
                cols: 10,
                steps: vec![feed("0123456789")], // 10 chars into a 10-col row
            });
        }

        // 13. partial-escape-split: the stream ends mid-CSI, so the pending
        //     escape tail is non-empty and the restorer must write it LAST.
        {
            cases.push(GoldenCase {
                name: "partial-escape-split",
                rows: 24,
                cols: 80,
                steps: vec![feed("visible text done\x1b[?100")],
            });
        }

        // 14. post-resize: feed at the opening dims, resize the emulator, feed
        //     more. Content that wrapped at the narrow width is NOT reflowed by
        //     vt100 (design §3.4 / D6 "resize = truncate/pad, NO reflow").
        {
            let long = "A".repeat(100); // wraps at 80, would fit on one row at 120
            cases.push(GoldenCase {
                name: "post-resize",
                rows: 24,
                cols: 80,
                steps: vec![
                    feed(&format!("{long}\r\nafter first line\r\n")),
                    GoldenStep::Resize(120, 30),
                    feed("appended after resize at wider dims"),
                ],
            });
        }

        // 15. scrollback-then-alt: long primary history, THEN alt-screen entry —
        //     exercises the frozen-primary path (design S8): scrollback_ansi is
        //     the frozen primary, snapshot_ansi is the live alt body.
        {
            let mut body = String::new();
            for i in 1..=120 {
                body.push_str(&format!("history {i:03} scrollback content here\r\n"));
            }
            body.push_str("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l");
            body.push_str("\x1b[1;1HALT SCREEN TUI TOP\r\n");
            body.push_str("\x1b[12;30Hcentered alt content\r\n");
            body.push_str("\x1b[24;1Hstatus bar bottom\x1b[?25h");
            cases.push(GoldenCase {
                name: "scrollback-then-alt",
                rows: 24,
                cols: 80,
                steps: vec![feed_bytes(body.as_bytes())],
            });
        }

        cases
    }

    #[test]
    fn golden_corpus_fixtures_match_committed() {
        let dir = format!("{}/fixtures/golden", env!("CARGO_MANIFEST_DIR"));
        let regen = std::env::var("GROVE_REGEN_GOLDEN").as_deref() == Ok("1");
        if regen {
            std::fs::create_dir_all(&dir).expect("create golden fixture dir");
        }
        for case in golden_cases() {
            let fixture = generate_fixture(&case);
            // Pretty + trailing newline: deterministic, diff-friendly, and the
            // exact bytes the JS consumer reads with readFileSync.
            let json = format!(
                "{}\n",
                serde_json::to_string_pretty(&fixture).expect("serialize fixture")
            );
            let path = format!("{dir}/{}.json", fixture.name);
            if regen {
                std::fs::write(&path, json.as_bytes()).expect("write golden fixture");
            } else {
                let committed = std::fs::read_to_string(&path).unwrap_or_else(|e| {
                    panic!(
                        "missing golden fixture {path}: {e}\n\
                         hint: re-run with GROVE_REGEN_GOLDEN=1 to (re)generate the corpus"
                    )
                });
                assert_eq!(
                    committed, json,
                    "stale golden fixture {path}: the serializer output changed.\n\
                     hint: verify the JS differential still passes, then re-run with \
                     GROVE_REGEN_GOLDEN=1 to regenerate"
                );
            }
        }
    }
}
