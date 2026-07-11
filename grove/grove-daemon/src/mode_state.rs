//! Pure byte-stream mode tracker (design §3.3 wrapper 1 + 3, S9/S10/S11/S6/S7).
//!
//! vt100 exposes most DECSET modes it needs (alt/hide-cursor/bracketed-paste/
//! app-cursor/app-keypad/mouse protocol+encoding), but per the verified crate
//! report (`notes/vt-crate-verification.md`) it CANNOT report three things the
//! rehydrate preamble needs — **focus-reporting (1004)**, **SGR-pixels (1016)**,
//! and **kitty keyboard flags** — nor the **OSC title/cwd** or the **DECSC saved
//! cursor**. This module scans the SAME teed byte stream vt100 sees and tracks
//! exactly that residual set.
//!
//! It is a **pure** state machine (no vt100, no IO), so it unit-tests in
//! isolation and byte-for-byte fold-safe across chunk boundaries: feeding it a
//! sequence split across two `scan()` calls yields the same final state as
//! feeding it whole. That is the S7 partial-escape-tail invariant — a chunk that
//! ends mid-escape parks the incomplete tail and resumes it on the next chunk.
//! ONE forward byte-at-a-time automaton (`walk`) is the sole source of truth
//! for both the tracked-mode transitions and the parked tail, so the two can
//! never drift under different chunkings.
//!
//! It additionally emits **split points** (design S8/S6) the emulator uses to
//! feed vt100 in segments: a `SnapshotPrimary` just before an alt-screen entry
//! (so the primary buffer can be frozen while vt100 still shows it) and a
//! `CaptureSavedCursor` just after a DECSC/SCOSC (so the emulator can read the
//! cursor vt100 just saved — vt100 has no saved-cursor getter).

/// Bound on the parked partial-escape tail (design S7 / orca
/// MAX_PARTIAL_ESCAPE_TAIL_LENGTH). An unterminated OSC/DCS would otherwise grow
/// the tail (and every snapshot) without limit; past the cap we abandon tracking
/// for that pathological stream and degrade to pre-fix behavior.
pub const MAX_PARTIAL_ESCAPE_TAIL: usize = 4096;

/// Cap on the kitty keyboard flags stack (design FIX 4 / kitty spec). A
/// protocol-conformant program never nests this deep; past the cap we ignore
/// further pushes so a runaway stream can't grow the stack (and every snapshot)
/// without bound.
pub const KITTY_STACK_CAP: usize = 16;

const ESC: u8 = 0x1b;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;
const BEL: u8 = 0x07;
const ST_FINAL: u8 = 0x5c; // ESC \ terminates OSC/DCS

/// A boundary at which the emulator must pause feeding vt100 and act.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Split {
    /// A non-alt→alt transition begins at this chunk offset. The emulator feeds
    /// bytes UP TO here, snapshots the still-active primary buffer, then feeds
    /// the alt-enter escape (design S8 primary-freeze-on-alt).
    SnapshotPrimary,
    /// A DECSC/SCOSC completes AT this chunk offset. The emulator feeds bytes UP
    /// TO here (through the save), then reads vt100's cursor — which is the value
    /// vt100 just saved but does not expose a getter for (design S6).
    CaptureSavedCursor,
}

/// Result of scanning one chunk: the split points (in CHUNK-relative byte
/// offsets, ascending) the emulator must honor while feeding vt100.
#[derive(Debug, Default, Clone)]
pub struct ScanResult {
    pub splits: Vec<(usize, Split)>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScanState {
    Ground,
    Esc,
    EscIntermediate,
    Csi,
    Osc,
    OscEsc,
    Str,
    StrEsc,
}

/// The residual mode set vt100 cannot report, tracked from the raw byte stream.
#[derive(Debug, Default)]
pub struct ModeState {
    /// Trailing incomplete escape sequence parked across chunk boundaries (S7).
    /// Also serves as the snapshot's `pending_escape_tail` (written LAST by the
    /// restorer so the next live chunk completes it instead of rendering literal).
    scan_tail: Vec<u8>,
    /// Focus-reporting mode (DECSET 1004) — vt100 has no accessor.
    focus: bool,
    /// SGR-pixels mouse encoding (DECSET 1016) — vt100 collapses this into `Sgr`.
    sgr_pixels: bool,
    /// Alt-screen tracked locally (1049/47/1047) to drive the S8 primary-freeze
    /// split; vt100's `alternate_screen()` stays authoritative for the body.
    alt: bool,
    /// Kitty keyboard flags stack (CSI > push / CSI < pop / CSI = set). Current
    /// flags = top of stack (0 when empty) — vt100 has no kitty support at all.
    kitty_stack: Vec<u32>,
    /// OSC 7 cwd and OSC 0/2 title — vt100 surfaces neither.
    cwd: Option<String>,
    title: Option<String>,
    /// Active DECSTBM scroll region as 1-based `(top, bottom)`; `None` = full
    /// screen. vt100 0.16 exposes NO public getter (verified: `grid.scroll_top`/
    /// `scroll_bottom` are private), so we track `CSI Pt;Pb r` here. Reset on RIS
    /// (`ESC c`) and any alt-buffer switch — xterm re-initializes DECSTBM per
    /// buffer (design FIX 3).
    scroll_region: Option<(u16, u16)>,
}

impl ModeState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn focus(&self) -> bool {
        self.focus
    }
    pub fn sgr_pixels(&self) -> bool {
        self.sgr_pixels
    }
    pub fn alt(&self) -> bool {
        self.alt
    }
    /// Current kitty keyboard flags (top of the push/pop stack, 0 when empty).
    pub fn kitty_flags(&self) -> u32 {
        self.kitty_stack.last().copied().unwrap_or(0)
    }
    pub fn cwd(&self) -> Option<&str> {
        self.cwd.as_deref()
    }
    pub fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }
    /// Active DECSTBM scroll region as 1-based `(top, bottom)`, `None` when full
    /// screen (design FIX 3). Re-armed in the rehydrate preamble AFTER the body.
    pub fn scroll_region(&self) -> Option<(u16, u16)> {
        self.scroll_region
    }
    /// The parked incomplete escape (design S7). Empty when the stream ended
    /// parser-clean. The restorer writes this LAST, before live chunks.
    pub fn partial_escape_tail(&self) -> &[u8] {
        &self.scan_tail
    }

    /// Ingest one chunk: update every tracked mode and return the split points
    /// the emulator must honor. Fold-safe across chunk boundaries.
    pub fn scan(&mut self, chunk: &[u8]) -> ScanResult {
        // Combine the parked tail with the new chunk; the tail is exactly the
        // still-pending sequence, so replaying it dispatches nothing and every
        // completed sequence is applied exactly once across the boundary.
        let map = ChunkMap {
            old_tail_len: self.scan_tail.len(),
            chunk_len: chunk.len(),
        };
        let mut combined = std::mem::take(&mut self.scan_tail);
        combined.extend_from_slice(chunk);

        let mut result = ScanResult::default();
        let pending_start = self.walk(&combined, map, &mut result);

        combined.drain(..pending_start);
        if combined.len() > MAX_PARTIAL_ESCAPE_TAIL {
            // Abandon tracking for a pathological unterminated stream (S7 cap).
            combined.clear();
        }
        self.scan_tail = combined;
        result
    }

    /// The single forward automaton (design S7): one byte-at-a-time VT scanner
    /// that is the SOLE source of truth for both tracked-mode transitions and
    /// the parked partial-escape tail. Returns the index at which the trailing
    /// still-pending sequence begins (== `bytes.len()` when the stream ends
    /// parser-clean); `scan()` parks exactly `bytes[returned..]`.
    ///
    /// Canonical tail semantics: the tail is exactly the bytes of the CURRENT
    /// pending sequence — a sequence aborted earlier in the chunk (e.g. an ESC
    /// whose string was aborted and restarted) contributes nothing. Whenever
    /// `seq_start` is (re)set, the machine's onward behavior depends only on
    /// the bytes from `seq_start`, so the tail is a fixed point (rescanning it
    /// from ground re-parks exactly it) and, because the automaton never looks
    /// ahead, scanning is fold-safe under ANY chunking.
    fn walk(&mut self, bytes: &[u8], map: ChunkMap, out: &mut ScanResult) -> usize {
        let mut state = ScanState::Ground;
        // Start of the current pending sequence (its opening ESC) and of the
        // CSI params / OSC payload body (just past the `[` / `]`).
        let mut seq_start = 0usize;
        let mut body_start = 0usize;

        let mut i = 0;
        while i < bytes.len() {
            if state == ScanState::Ground {
                // Fast-skip plain text: Ground transitions only on ESC, so
                // jumping to the next ESC cannot diverge from stepping.
                match bytes[i..].iter().position(|&b| b == ESC) {
                    Some(k) => {
                        i += k;
                        seq_start = i;
                        state = ScanState::Esc;
                        i += 1;
                        continue;
                    }
                    None => return bytes.len(),
                }
            }
            let code = bytes[i];
            state = match state {
                ScanState::Ground => unreachable!(),
                ScanState::Esc => {
                    self.esc_follower(code, i, &mut seq_start, &mut body_start, map, out)
                }
                ScanState::EscIntermediate => match code {
                    ESC => {
                        seq_start = i;
                        ScanState::Esc
                    }
                    CAN | SUB => ScanState::Ground,
                    // Final byte of an intermediate escape — none carry a
                    // residual mode; vt100 owns their effects.
                    0x30..=0x7e => ScanState::Ground,
                    // Executing C0s/DEL and further intermediates keep it pending.
                    _ => ScanState::EscIntermediate,
                },
                ScanState::Csi => match code {
                    ESC => {
                        // Abort: an aborted CSI is mode-neutral; the ESC opens
                        // a new sequence.
                        seq_start = i;
                        ScanState::Esc
                    }
                    CAN | SUB => ScanState::Ground,
                    0x40..=0x7e => {
                        let body = &bytes[body_start..i];
                        let (marker, params) = match body.first() {
                            Some(&m) if (0x3c..=0x3f).contains(&m) => (Some(m), &body[1..]),
                            _ => (None, body),
                        };
                        self.apply_csi(marker, params, code, map.offset(seq_start), map.offset(i + 1), out);
                        ScanState::Ground
                    }
                    _ => ScanState::Csi,
                },
                ScanState::Osc => match code {
                    BEL | CAN | SUB => {
                        self.apply_osc(&bytes[body_start..i]);
                        ScanState::Ground
                    }
                    ESC => ScanState::OscEsc,
                    _ => ScanState::Osc,
                },
                ScanState::OscEsc => {
                    // The OSC ends at the ESC (index i-1) whether ST terminates
                    // it or the ESC aborts it — the payload applies either way
                    // (an aborted title was still set; the tests rely on it).
                    self.apply_osc(&bytes[body_start..i - 1]);
                    if code == ST_FINAL {
                        ScanState::Ground
                    } else {
                        // The aborting ESC opened a new sequence; this byte is
                        // its follower.
                        seq_start = i - 1;
                        self.esc_follower(code, i, &mut seq_start, &mut body_start, map, out)
                    }
                }
                ScanState::Str => match code {
                    CAN | SUB => ScanState::Ground,
                    ESC => ScanState::StrEsc,
                    _ => ScanState::Str,
                },
                ScanState::StrEsc => {
                    if code == ST_FINAL {
                        ScanState::Ground
                    } else {
                        seq_start = i - 1;
                        self.esc_follower(code, i, &mut seq_start, &mut body_start, map, out)
                    }
                }
            };
            i += 1;
        }
        if state == ScanState::Ground {
            bytes.len()
        } else {
            seq_start
        }
    }

    /// Step the byte at `i` as the follower of a pending ESC (at `seq_start`)
    /// and return the next state. This is the ONLY classifier of ESC followers
    /// — Esc-state stepping and OscEsc/StrEsc string-abort restarts both route
    /// through it, so they cannot drift.
    fn esc_follower(
        &mut self,
        code: u8,
        i: usize,
        seq_start: &mut usize,
        body_start: &mut usize,
        map: ChunkMap,
        out: &mut ScanResult,
    ) -> ScanState {
        match code {
            ESC => {
                // Restart: this ESC aborts the pending one, and the pending
                // sequence is now exactly itself.
                *seq_start = i;
                ScanState::Esc
            }
            // Abort back to ground; the aborted ESC contributes nothing.
            CAN | SUB => ScanState::Ground,
            b'[' => {
                *body_start = i + 1;
                ScanState::Csi
            }
            b']' => {
                *body_start = i + 1;
                ScanState::Osc
            }
            // P/X/^/_ open DCS/SOS/PM/APC. Their content carries no residual
            // mode; a bare ESC inside aborts them exactly like an OSC.
            0x50 | 0x58 | 0x5e | 0x5f => ScanState::Str,
            0x20..=0x2f => ScanState::EscIntermediate,
            b'c' => {
                // RIS full reset: drop the residual modes we own. cwd/title
                // persist (a reset doesn't unset the shell's directory/title).
                self.focus = false;
                self.sgr_pixels = false;
                self.kitty_stack.clear();
                self.alt = false;
                self.scroll_region = None;
                ScanState::Ground
            }
            b'7' => {
                // DECSC — capture the saved cursor AFTER vt100 processes it.
                out.splits.push((map.offset(i + 1), Split::CaptureSavedCursor));
                ScanState::Ground
            }
            // C0 controls (and DEL) "execute" mid-escape without ending it
            // (VT500 anywhere-executes): the ESC stays pending.
            _ if code < 0x20 || code == 0x7f => ScanState::Esc,
            // ESC 8 (DECRC restore) and other 2-byte escapes: no residual mode
            // change. vt100 owns the actual cursor/charset effects.
            _ => ScanState::Ground,
        }
    }

    fn apply_csi(
        &mut self,
        marker: Option<u8>,
        params: &[u8],
        final_byte: u8,
        chunk_start: usize,
        chunk_end: usize,
        out: &mut ScanResult,
    ) {
        match (marker, final_byte) {
            (Some(b'?'), b'h') | (Some(b'?'), b'l') => {
                let enabled = final_byte == b'h';
                for p in split_params(params) {
                    match p {
                        1004 => self.focus = enabled,
                        1016 => {
                            self.sgr_pixels = enabled;
                        }
                        1049 | 47 | 1047 => {
                            if enabled && !self.alt {
                                // Non-alt→alt: freeze the primary BEFORE this
                                // escape reaches vt100 (design S8).
                                out.splits.push((chunk_start, Split::SnapshotPrimary));
                            }
                            self.alt = enabled;
                            // xterm re-initializes DECSTBM on any alt-buffer
                            // switch (design FIX 3): the region does not carry
                            // across an enter OR an exit.
                            self.scroll_region = None;
                        }
                        _ => {}
                    }
                }
            }
            (Some(b'>'), b'u') => {
                // Kitty push: new stack entry with these flags. Ignore pushes
                // past the cap (design FIX 4) so the stack stays bounded.
                let flags = split_params(params).next().unwrap_or(0) as u32;
                if self.kitty_stack.len() < KITTY_STACK_CAP {
                    self.kitty_stack.push(flags);
                }
            }
            (Some(b'<'), b'u') => {
                // Kitty pop N (default 1).
                let n = split_params(params).next().unwrap_or(1).max(1) as usize;
                for _ in 0..n {
                    self.kitty_stack.pop();
                }
            }
            (Some(b'='), b'u') => {
                // Kitty set: param1 = flags, param2 = mode (1 replace / 2 set-bits
                // / 3 clear-bits; default replace).
                let mut it = split_params(params);
                let flags = it.next().unwrap_or(0) as u32;
                let mode = it.next().unwrap_or(1);
                let cur = self.kitty_stack.last().copied().unwrap_or(0);
                let next = match mode {
                    2 => cur | flags,
                    3 => cur & !flags,
                    _ => flags,
                };
                if let Some(top) = self.kitty_stack.last_mut() {
                    *top = next;
                } else {
                    self.kitty_stack.push(next);
                }
            }
            (None, b'r') => {
                // DECSTBM `CSI Pt ; Pb r` (no private marker; `CSI ? … r` is
                // XTRESTORE and is filtered out by the None-marker guard). Empty
                // or degenerate params reset to full screen (design FIX 3).
                let mut it = split_params(params);
                let top = it.next();
                let bottom = it.next();
                self.scroll_region = match (top, bottom) {
                    (Some(t), Some(b)) if t >= 1 && b > t => Some((t as u16, b as u16)),
                    _ => None,
                };
            }
            (None, b's') if params.is_empty() => {
                // SCOSC save-cursor — capture AFTER vt100 processes it (S6).
                out.splits.push((chunk_end, Split::CaptureSavedCursor));
            }
            _ => {
                // Everything else (mouse 1000/1002/1003/1006, app cursor/keypad,
                // bracketed paste, SGR, cursor moves, SCORC restore, kitty query)
                // is either vt100-owned or irrelevant to the residual mode set.
            }
        }
    }

    fn apply_osc(&mut self, payload: &[u8]) {
        // OSC payload = `Ps ; Pt`. Ps selects the command.
        let Some(sep) = payload.iter().position(|&b| b == b';') else {
            return;
        };
        let ps = &payload[..sep];
        let pt = &payload[sep + 1..];
        match ps {
            b"0" | b"2" => {
                // Set title (0 sets icon+title, 2 sets title). Lossy is fine —
                // a title is display text, not a byte-exact restore target.
                self.title = Some(String::from_utf8_lossy(pt).into_owned());
            }
            b"7" => {
                if let Some(cwd) = parse_osc7_cwd(pt) {
                    self.cwd = Some(cwd);
                }
            }
            _ => {}
        }
    }
}

/// Maps a combined-buffer byte index (parked tail ++ chunk) to a CHUNK-relative
/// split offset: index − `old_tail_len`, clamped to `[0, chunk_len]`. A
/// sequence that began in the parked tail therefore reports offset 0.
#[derive(Clone, Copy)]
struct ChunkMap {
    old_tail_len: usize,
    chunk_len: usize,
}

impl ChunkMap {
    fn offset(&self, combined_index: usize) -> usize {
        combined_index
            .saturating_sub(self.old_tail_len)
            .min(self.chunk_len)
    }
}

/// Iterate the numeric params of a CSI (`;`-separated, empty entries skipped).
fn split_params(params: &[u8]) -> impl Iterator<Item = u32> + '_ {
    params.split(|&b| b == b';').filter_map(|p| {
        if p.is_empty() {
            return None;
        }
        std::str::from_utf8(p).ok()?.parse::<u32>().ok()
    })
}

/// Extract a filesystem path from an OSC 7 `file://host/path` URI (or a bare
/// path some shells emit). Percent-decodes `%XX`. Returns `None` when empty.
fn parse_osc7_cwd(pt: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(pt);
    let path = if let Some(rest) = s.strip_prefix("file://") {
        // rest = host/path... ; the path begins at the first '/'.
        match rest.find('/') {
            Some(idx) => &rest[idx..],
            None => return None,
        }
    } else {
        s.as_ref()
    };
    let decoded = percent_decode(path);
    if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_whole(bytes: &[u8]) -> ModeState {
        let mut m = ModeState::new();
        m.scan(bytes);
        m
    }

    /// Tracked-mode fingerprint for whole-vs-chunked equality assertions.
    #[allow(clippy::type_complexity)]
    fn modes_of(
        m: &ModeState,
    ) -> (bool, bool, bool, u32, Option<&str>, Option<&str>, Option<(u16, u16)>) {
        (
            m.focus(),
            m.sgr_pixels(),
            m.alt(),
            m.kitty_flags(),
            m.cwd(),
            m.title(),
            m.scroll_region(),
        )
    }

    /// Assert the full S7 invariant for one stream and return its parked tail:
    /// whole-scan, byte-by-byte, and every 2-way cut must agree on tracked
    /// modes AND parked tail, and the tail must be a fixed point (rescanning it
    /// from a fresh ground state re-parks exactly it).
    fn assert_fold_safe(stream: &[u8]) -> Vec<u8> {
        let whole = scan_whole(stream);

        let mut pieces = ModeState::new();
        for b in stream {
            pieces.scan(std::slice::from_ref(b));
        }
        assert_eq!(
            modes_of(&whole),
            modes_of(&pieces),
            "modes diverged byte-by-byte on {stream:?}"
        );
        assert_eq!(
            whole.partial_escape_tail(),
            pieces.partial_escape_tail(),
            "parked tail diverged byte-by-byte on {stream:?}"
        );

        for cut in 0..=stream.len() {
            let mut m = ModeState::new();
            m.scan(&stream[..cut]);
            m.scan(&stream[cut..]);
            assert_eq!(
                modes_of(&whole),
                modes_of(&m),
                "modes diverged at cut {cut} on {stream:?}"
            );
            assert_eq!(
                whole.partial_escape_tail(),
                m.partial_escape_tail(),
                "parked tail diverged at cut {cut} on {stream:?}"
            );
        }

        let tail = whole.partial_escape_tail().to_vec();
        let re = scan_whole(&tail);
        assert_eq!(
            re.partial_escape_tail(),
            &tail[..],
            "parked tail is not a fixed point on {stream:?}"
        );
        tail
    }

    #[test]
    fn focus_1004_tracked() {
        let m = scan_whole(b"\x1b[?1004h");
        assert!(m.focus());
        let m = scan_whole(b"\x1b[?1004h\x1b[?1004l");
        assert!(!m.focus());
    }

    #[test]
    fn sgr_pixels_1016_tracked() {
        assert!(scan_whole(b"\x1b[?1016h").sgr_pixels());
        assert!(!scan_whole(b"\x1b[?1016h\x1b[?1016l").sgr_pixels());
    }

    #[test]
    fn kitty_push_pop_set() {
        assert_eq!(scan_whole(b"\x1b[>5u").kitty_flags(), 5);
        assert_eq!(scan_whole(b"\x1b[>5u\x1b[>9u").kitty_flags(), 9); // top of stack
        assert_eq!(scan_whole(b"\x1b[>5u\x1b[>9u\x1b[<1u").kitty_flags(), 5); // pop
        assert_eq!(scan_whole(b"\x1b[>5u\x1b[<u").kitty_flags(), 0); // pop default 1 → empty
        assert_eq!(scan_whole(b"\x1b[=3u").kitty_flags(), 3); // set on empty
        assert_eq!(scan_whole(b"\x1b[>1u\x1b[=2;2u").kitty_flags(), 3); // set-bits mode 2 → 1|2
        assert_eq!(scan_whole(b"\x1b[>3u\x1b[=2;3u").kitty_flags(), 1); // clear-bits mode 3 → 3&!2
    }

    #[test]
    fn osc7_cwd_and_title() {
        let m = scan_whole(b"\x1b]7;file://host/Users/me/proj\x07");
        assert_eq!(m.cwd(), Some("/Users/me/proj"));
        let m = scan_whole(b"\x1b]0;my title\x07");
        assert_eq!(m.title(), Some("my title"));
        let m = scan_whole(b"\x1b]2;win title\x1b\\"); // ST-terminated
        assert_eq!(m.title(), Some("win title"));
    }

    #[test]
    fn osc7_percent_decoded() {
        let m = scan_whole(b"\x1b]7;file://host/a%20b/c\x07");
        assert_eq!(m.cwd(), Some("/a b/c"));
    }

    #[test]
    fn alt_enter_emits_snapshot_split_at_escape_start() {
        let mut m = ModeState::new();
        let chunk = b"AB\x1b[?1049hXY";
        let r = m.scan(chunk);
        assert!(m.alt());
        // Split at the ESC index (2), BEFORE the alt-enter escape.
        assert_eq!(r.splits, vec![(2, Split::SnapshotPrimary)]);
    }

    #[test]
    fn alt_enter_no_split_when_already_alt() {
        let mut m = ModeState::new();
        m.scan(b"\x1b[?1049h");
        let r = m.scan(b"\x1b[?1049h"); // already alt
        assert!(r.splits.is_empty());
    }

    #[test]
    fn decsc_emits_capture_split_after_escape() {
        let mut m = ModeState::new();
        let r = m.scan(b"XX\x1b7YY");
        // ESC 7 spans bytes 2..4; capture split at offset 4 (after the save).
        assert_eq!(r.splits, vec![(4, Split::CaptureSavedCursor)]);
    }

    #[test]
    fn scosc_emits_capture_split() {
        let mut m = ModeState::new();
        let r = m.scan(b"\x1b[s");
        assert_eq!(r.splits, vec![(3, Split::CaptureSavedCursor)]);
    }

    #[test]
    fn partial_escape_split_across_chunks_is_fold_safe() {
        // Feeding `\x1b[?1004h` split at every boundary must land the same state
        // and (for the completing chunk) the same alt/mode result as whole.
        let seq = b"AA\x1b[?1049hBB";
        for cut in 0..=seq.len() {
            let mut m = ModeState::new();
            m.scan(&seq[..cut]);
            m.scan(&seq[cut..]);
            assert!(m.alt(), "alt lost when split at {cut}");
        }
    }

    #[test]
    fn alt_enter_split_across_chunk_reports_offset_zero() {
        // The alt-enter introducer starts in chunk 1 and completes in chunk 2:
        // the completing chunk must report SnapshotPrimary at offset 0 (the
        // primary snapshot from before chunk 2 is valid).
        let mut m = ModeState::new();
        let r1 = m.scan(b"AB\x1b[?10");
        assert!(r1.splits.is_empty()); // incomplete — parked
        assert!(!m.alt());
        let r2 = m.scan(b"49hCD");
        assert!(m.alt());
        assert_eq!(r2.splits, vec![(0, Split::SnapshotPrimary)]);
    }

    #[test]
    fn partial_tail_exposed_and_bounded() {
        let mut m = ModeState::new();
        m.scan(b"text\x1b[?100"); // ends mid-CSI
        assert_eq!(m.partial_escape_tail(), b"\x1b[?100");
        // A clean chunk clears it.
        m.scan(b"4h");
        assert_eq!(m.partial_escape_tail(), b"");
    }

    #[test]
    fn ris_resets_residual_modes() {
        let mut m = ModeState::new();
        m.scan(b"\x1b[?1004h\x1b[?1016h\x1b[>7u");
        assert!(m.focus() && m.sgr_pixels() && m.kitty_flags() == 7);
        m.scan(b"\x1bc");
        assert!(!m.focus() && !m.sgr_pixels() && m.kitty_flags() == 0);
    }

    #[test]
    fn plain_text_no_splits_no_modes() {
        let mut m = ModeState::new();
        let r = m.scan(b"just some plain text\r\nwith newlines");
        assert!(r.splits.is_empty());
        assert!(!m.focus() && !m.alt() && m.kitty_flags() == 0);
        assert_eq!(m.partial_escape_tail(), b"");
    }

    // ---- FIX 1: walk() abort semantics (parse_csi / parse_osc) ----

    #[test]
    fn csi_aborted_by_can_then_alt_enter_fires_snapshot() {
        // The reviewer's exact repro: an incomplete CSI aborted by CAN, then a
        // real alt-enter. Before the fix, parse_csi swallowed the CAN and the
        // following `\x1b[?1049h`, so alt was never seen and no split fired.
        let mut m = ModeState::new();
        let r = m.scan(b"PRIMARY\x1b[?10\x18\x1b[?1049h\x1b[HALT");
        assert!(m.alt(), "alt-enter after a CAN-aborted CSI was missed");
        assert_eq!(
            r.splits.first().map(|s| s.1),
            Some(Split::SnapshotPrimary),
            "SnapshotPrimary must fire on the post-abort alt-enter"
        );
        // The split must land at the alt-enter ESC (index 13), not offset 0.
        assert_eq!(r.splits[0].0, 13);
    }

    #[test]
    fn csi_aborted_by_sub_then_alt_enter_fires_snapshot() {
        let mut m = ModeState::new();
        let r = m.scan(b"PRIMARY\x1b[?10\x1a\x1b[?1049h\x1b[HALT");
        assert!(m.alt(), "alt-enter after a SUB-aborted CSI was missed");
        assert!(r.splits.iter().any(|s| s.1 == Split::SnapshotPrimary));
    }

    #[test]
    fn csi_aborted_by_bare_esc_then_alt_enter_fires_snapshot() {
        // A bare ESC aborts the pending CSI and starts a NEW sequence at the ESC.
        // `\x1b[?10` aborted by the `\x1b` of `\x1b[?1049h`.
        let mut m = ModeState::new();
        let r = m.scan(b"PRIMARY\x1b[?10\x1b[?1049h\x1b[HALT");
        assert!(m.alt(), "alt-enter after a bare-ESC-aborted CSI was missed");
        assert!(r.splits.iter().any(|s| s.1 == Split::SnapshotPrimary));
    }

    #[test]
    fn osc_title_aborted_by_esc_then_alt_enter_clean_title() {
        // An OSC title aborted by a bare ESC (opening a CSI), then an alt-enter.
        // Title must be clean (no trailing ESC garbage) and alt must be seen.
        let mut m = ModeState::new();
        let r = m.scan(b"\x1b]0;my title\x1b[?1049h\x1b[Halt");
        assert_eq!(m.title(), Some("my title"), "aborted OSC title must stay clean");
        assert!(m.alt(), "alt-enter after an ESC-aborted OSC was missed");
        assert!(r.splits.iter().any(|s| s.1 == Split::SnapshotPrimary));
    }

    #[test]
    fn osc_aborted_by_can_then_next_sequence() {
        // CAN terminates the OSC; the following CSI must still be parsed.
        let mut m = ModeState::new();
        m.scan(b"\x1b]0;partial\x18\x1b[?1004h");
        assert_eq!(m.title(), Some("partial"));
        assert!(m.focus());
    }

    #[test]
    fn walk_boundaries_agree_with_tail_machine_over_random_streams() {
        // Property (design S7): the single automaton must be fold-safe — for
        // every generated stream, whole-scan, byte-by-byte, and every 2-way cut
        // agree on tracked modes AND parked tail, and the tail is a fixed
        // point. Salt fragments deliberately inject the follower classes where
        // the old dual implementation diverged (double-ESC, ESC+C0,
        // abort-then-tracked, string-abort restarts) — pure random bytes hit
        // these multi-byte patterns far too rarely (an earlier bug survived
        // 2000 unsalted streams with 0 divergences). Multiple seeds guard
        // against one lucky trajectory missing a divergence shape.
        let alphabet: &[u8] = &[
            ESC, b'[', b']', b'?', b'>', b'<', b'=', b';', b'0', b'1', b'4', b'9', b'h', b'l',
            b'u', b'r', b's', b'c', b'7', CAN, SUB, BEL, ST_FINAL, b'A', b'x', 0x00,
        ];
        let salts: &[&[u8]] = &[
            b"\x1b\x1b",              // bare double ESC
            b"\x1b\x1b[?1049h",       // double ESC then alt-enter
            b"\x1b\x1bc",             // double ESC then RIS
            b"\x1b\x1b7",             // double ESC then DECSC
            b"\x1b\x00c",             // ESC + executable C0 then RIS
            b"\x1b\x07[?1049h",       // ESC + executable C0 then alt-enter
            b"\x1b[?1004h",           // set focus so a later RIS is observable
            b"\x1b[?1049h",           // plain alt-enter
            b"\x1b[?10\x18",          // CSI aborted by CAN (abort-then-...)
            b"\x1b[?10\x1a",          // CSI aborted by SUB
            b"\x1b[?10\x1b\x1b[?1049h", // CSI abort by ESC, then double ESC alt
            b"\x1b]0;t\x1b\x1b",      // OSC aborted by ESC, then a parked ESC
            b"\x1b]\x1b\x18",         // OSC aborted by ESC, then CAN (tail repro)
            b"\x1b]0;t\x1b\x1b]",     // OSC abort restart into a new OSC (tail repro)
            b"\x1bP\x1b\x1b[",        // DCS aborted by ESC, then double ESC CSI
            b"[?1049h",              // a tracked seq with NO leading ESC
            b"\x1bc",                // RIS
            b"\x1b7",                // DECSC
            b"\x18",                  // bare CAN
            b"\x1a",                  // bare SUB
        ];
        let seeds: &[u32] = &[
            0xC0FF_EE00, 0xDEAD_BEEF, 0x1234_5678, 0x0000_0001, 0xFFFF_FFFF, 0xABCD_1234,
            0x5555_5555, 0xA5A5_A5A5,
        ];
        let xs = |rng: &mut u32| {
            *rng ^= *rng << 13;
            *rng ^= *rng >> 17;
            *rng ^= *rng << 5;
            *rng
        };
        for &seed in seeds {
            let mut rng = seed;
            for _ in 0..750 {
                // Build each stream from a random number of ops: either a run
                // of raw alphabet bytes or a spliced salt fragment.
                let ops = (xs(&mut rng) % 6) as usize;
                let mut stream: Vec<u8> = Vec::new();
                for _ in 0..ops {
                    if xs(&mut rng) % 2 == 0 {
                        let run = (xs(&mut rng) % 8) as usize;
                        for _ in 0..run {
                            stream.push(alphabet[(xs(&mut rng) as usize) % alphabet.len()]);
                        }
                    } else {
                        stream.extend_from_slice(salts[(xs(&mut rng) as usize) % salts.len()]);
                    }
                }
                assert_fold_safe(&stream);
            }
        }
    }

    // ---- Parked-tail divergence repros (adversarial verifier) ----
    //
    // Root cause of the bug class: the old standalone tail scanner parked the
    // ALREADY-ABORTED leading ESC when an OSC/DCS string was aborted by ESC and
    // the abort's follower was ESC or CAN/SUB — whole-chunk and byte-by-byte
    // scans then parked different tails, and an [ESC, CAN] tail was not even a
    // fixed point. The single automaton derives the tail from the same
    // transitions as the tracked modes, so only the CURRENT pending sequence
    // is ever parked.

    #[test]
    fn osc_aborted_by_double_esc_parks_only_the_restart() {
        // Old: whole-scan parked [ESC, ESC, '['], byte-by-byte [ESC, '['].
        let tail = assert_fold_safe(b"\x1b]\x1b\x1b[");
        assert_eq!(tail, b"\x1b[");
    }

    #[test]
    fn osc_title_aborted_by_double_esc_then_osc_opener_parks_new_osc() {
        // Old: whole-scan parked [ESC, ESC, ']'], byte-by-byte [ESC, ']'].
        let tail = assert_fold_safe(b"\x1b]0;t\x1b\x1b]");
        assert_eq!(tail, b"\x1b]");
        // The aborted OSC still applied its payload.
        assert_eq!(scan_whole(b"\x1b]0;t\x1b\x1b]").title(), Some("t"));
    }

    #[test]
    fn osc_aborted_by_esc_then_can_parks_nothing() {
        // Old: whole-scan parked [ESC, CAN] — not a fixed point (rescanning it
        // parked nothing). The CAN aborts the restarted ESC: the tail is empty.
        let tail = assert_fold_safe(b"\x1b]\x1b\x18");
        assert_eq!(tail, b"");
    }

    #[test]
    fn verifier_seed_0x12345678_stream_is_fold_safe() {
        // The property generator's own stream (seed 0x12345678) whose whole vs
        // byte-by-byte parked tails diverged before the fix: an OSC title
        // aborted by ESC, restarted by a second ESC into a new pending OSC.
        let stream = [62, 114, 55, 27, 55, 27, 93, 48, 59, 116, 27, 27, 93];
        let tail = assert_fold_safe(&stream);
        assert_eq!(tail, b"\x1b]");
        assert_eq!(scan_whole(&stream).title(), Some("t"));
    }

    #[test]
    fn exhaustive_short_streams_are_fold_safe() {
        // Bounded exhaustive sweep modeled on the adversarial verifier: EVERY
        // stream up to MAX_LEN over a curated escape-relevant alphabet must be
        // fold-safe (whole vs byte-by-byte vs all 2-way cuts, tracked modes AND
        // parked tail) with a fixed-point tail. This catches the whole bug
        // class outright — the old dual implementation had 153 divergent
        // parked-tail shapes at len <= 5 over a 20-byte alphabet.
        const ALPHABET: &[u8] = &[
            ESC, CAN, SUB, BEL, b'[', b']', ST_FINAL, b'7', b'c', b'h', b'l', b'?', b'0', b';',
            b'P', b'A', 0x7f, b'x',
        ];
        // MAX_LEN 4 = ~111k streams, <0.5s in debug mode; MAX_LEN 5 (~2.1M
        // streams) measured 7.7s — too slow for the default suite.
        const MAX_LEN: usize = 4;
        let mut stream: Vec<u8> = Vec::new();
        for len in 1..=MAX_LEN {
            let mut idx = vec![0usize; len];
            'streams: loop {
                stream.clear();
                stream.extend(idx.iter().map(|&d| ALPHABET[d]));
                assert_fold_safe(&stream);
                // Odometer increment over the alphabet; done when it wraps.
                for digit in idx.iter_mut() {
                    *digit += 1;
                    if *digit < ALPHABET.len() {
                        continue 'streams;
                    }
                    *digit = 0;
                }
                break;
            }
        }
    }

    // ---- FIX 5: ESC-follower divergence (double-ESC / ESC+C0) ----
    //
    // walk()'s fallback arm used to advance i by 2 after ANY untracked ESC
    // follower. When the follower was itself ESC (or a C0 that keeps the ESC
    // pending per state_after_esc), the second byte was swallowed and the
    // sequence it introduced was never parsed. These are the verifier's four
    // proven repros plus the C0 audit cases.

    #[test]
    fn double_esc_before_alt_enter_fires_snapshot_repro1() {
        // b"PRIMARY\x1b\x1b[?1049h\x1b[HALT": the first ESC is aborted by the
        // second, which introduces the alt-enter. Pre-fix, walk skipped past
        // both ESCs and never saw the CSI — SnapshotPrimary never fired and the
        // pre-alt scrollback was lost.
        let mut m = ModeState::new();
        let r = m.scan(b"PRIMARY\x1b\x1b[?1049h\x1b[HALT");
        assert!(m.alt(), "alt-enter after a double ESC was missed");
        assert_eq!(
            r.splits.first().map(|s| s.1),
            Some(Split::SnapshotPrimary),
            "SnapshotPrimary must fire on the post-double-ESC alt-enter"
        );
        // The alt-enter escape restarts at the SECOND ESC (index 8).
        assert_eq!(r.splits[0].0, 8);
    }

    #[test]
    fn double_esc_before_ris_resets_modes_repro2() {
        // b"\x1b[?1004h\x1b\x1bc": RIS (ESC c) introduced by the second ESC.
        // Pre-fix the RIS was missed and focus stayed set.
        let mut m = ModeState::new();
        m.scan(b"\x1b[?1004h\x1b\x1bc");
        assert!(!m.focus(), "RIS after a double ESC was missed");
    }

    #[test]
    fn double_esc_across_chunk_before_alt_enter_repro3() {
        // Chunk 1 ends `...\x1b\x1b` (an OSC aborted by ESC, then a second ESC
        // parked); chunk 2 completes the alt-enter. Pre-fix, alt was missed.
        let mut m = ModeState::new();
        m.scan(b"\x1b]0;x\x1b\x1b");
        let r = m.scan(b"[?1049h");
        assert!(m.alt(), "alt-enter across a double-ESC chunk boundary was missed");
        assert_eq!(r.splits, vec![(0, Split::SnapshotPrimary)]);
    }

    #[test]
    fn double_esc_before_decsc_captures_saved_cursor_repro4() {
        // b"\x1b[3;5H\x1b\x1b7": DECSC (ESC 7) introduced by the second ESC.
        // Pre-fix CaptureSavedCursor never fired.
        let mut m = ModeState::new();
        let r = m.scan(b"\x1b[3;5H\x1b\x1b7");
        assert!(
            r.splits.iter().any(|s| s.1 == Split::CaptureSavedCursor),
            "DECSC after a double ESC was missed"
        );
        // The save completes after the '7' at the end of the chunk (offset 9).
        assert_eq!(r.splits, vec![(9, Split::CaptureSavedCursor)]);
    }

    #[test]
    fn ris_fires_through_executable_c0() {
        // ESC <C0> c: the C0 (NUL) executes but keeps the ESC pending
        // (state_after_esc → Esc), so ESC c is RIS. Pre-fix walk swallowed the
        // ESC+NUL as a 2-byte escape and the RIS was missed.
        let mut m = ModeState::new();
        m.scan(b"\x1b[?1004h\x1b\x00c");
        assert!(!m.focus(), "RIS through an executable C0 was missed");
    }

    #[test]
    fn alt_enter_fires_through_executable_c0() {
        // ESC <BEL> [?1049h: BEL executes but keeps the ESC pending, so the CSI
        // is a real alt-enter. Pre-fix walk swallowed ESC+BEL and missed alt.
        let mut m = ModeState::new();
        let r = m.scan(b"\x1b\x07[?1049h");
        assert!(m.alt(), "alt-enter through an executable C0 was missed");
        assert!(r.splits.iter().any(|s| s.1 == Split::SnapshotPrimary));
    }

    // ---- FIX 3: DECSTBM tracking ----

    #[test]
    fn decstbm_tracked_and_reset() {
        assert_eq!(scan_whole(b"\x1b[5;15r").scroll_region(), Some((5, 15)));
        // Empty params reset to full screen.
        assert_eq!(scan_whole(b"\x1b[5;15r\x1b[r").scroll_region(), None);
        // RIS resets.
        assert_eq!(scan_whole(b"\x1b[5;15r\x1bc").scroll_region(), None);
        // Alt enter/exit resets (xterm re-inits DECSTBM per buffer).
        assert_eq!(scan_whole(b"\x1b[5;15r\x1b[?1049h").scroll_region(), None);
        // `CSI ? … r` (XTRESTORE) is NOT DECSTBM.
        assert_eq!(scan_whole(b"\x1b[?1049r").scroll_region(), None);
        // Degenerate (top >= bottom) resets.
        assert_eq!(scan_whole(b"\x1b[15;5r").scroll_region(), None);
    }

    // ---- FIX 4: kitty stack cap ----

    #[test]
    fn kitty_stack_capped() {
        let mut m = ModeState::new();
        for n in 1..=(KITTY_STACK_CAP as u32 + 8) {
            m.scan(format!("\x1b[>{n}u").as_bytes());
        }
        // The stack stopped growing at the cap: the top is the value pushed AT the
        // cap (16), and all later pushes were ignored.
        assert_eq!(m.kitty_flags(), KITTY_STACK_CAP as u32);
        // Popping cap-many entries empties it — proof it never exceeded the cap.
        m.scan(format!("\x1b[<{KITTY_STACK_CAP}u").as_bytes());
        assert_eq!(m.kitty_flags(), 0);
    }

    #[test]
    fn byte_by_byte_equals_whole_for_mixed_stream() {
        let stream = b"hi\x1b[?1004h\x1b]7;file://h/x\x07\x1b[?1049h\x1b7done\x1b[?1016h";
        let mut whole = ModeState::new();
        whole.scan(stream);

        let mut piece = ModeState::new();
        for b in stream {
            piece.scan(&[*b]);
        }
        assert_eq!(whole.focus(), piece.focus());
        assert_eq!(whole.sgr_pixels(), piece.sgr_pixels());
        assert_eq!(whole.alt(), piece.alt());
        assert_eq!(whole.cwd(), piece.cwd());
        assert_eq!(whole.kitty_flags(), piece.kitty_flags());
    }
}
