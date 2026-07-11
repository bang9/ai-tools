//! Binary stream-frame codec for the daemon↔host STREAM socket (the GCKL frame
//! family, design §5 / P13 / R10).
//!
//! Why binary, not NDJSON: live PTY output is arbitrary bytes — a multibyte
//! UTF-8 sequence can split across reads, and a raw child can emit genuinely
//! invalid/binary bytes. `serde_json` cannot represent a lone continuation byte
//! in a JSON string at all, so raw `Data`/`Exit`/`Resize` never ride the
//! control NDJSON channel; they travel as length-prefixed binary frames here.
//!
//! Wire layout (little-endian), one self-delimiting frame:
//! ```text
//!   magic        4  b"GCKL"
//!   kind         1  Data=0x02 | Resize=0x03 | Exit=0x10
//!   sid_len      2  u16  session-id byte length
//!   seq          8  u64  absolute output sequence (S3)
//!   payload_len  4  u32  payload byte length
//!   session_id  sid_len  utf8 bytes
//!   payload    payload_len bytes
//! ```
//! The per-frame magic lets a reader validate framing on a socket that (unlike
//! the on-disk `output.log`) has no single leading header after the hello
//! handshake switches the stream to binary.

use serde::{Deserialize, Serialize};

/// Frame magic shared with the on-disk history log (design D4).
pub const STREAM_FRAME_MAGIC: [u8; 4] = *b"GCKL";

/// Fixed-size header preceding the variable session-id + payload.
/// magic(4) + kind(1) + sid_len(2) + seq(8) + payload_len(4).
pub const STREAM_FRAME_HEADER_BYTES: usize = 4 + 1 + 2 + 8 + 4;

/// Hard cap on a single frame's payload. Why: a corrupt/hostile length prefix
/// must not make the decoder buffer or allocate unbounded memory. Matches the
/// control NDJSON cap (design P4, 16 MiB) as the wire-wide safety bound; the
/// batcher's real coalescing budget (design S4, ~2 MiB) sits well under it.
pub const MAX_STREAM_FRAME_PAYLOAD: usize = 16 * 1024 * 1024;

/// Hard cap on a session-id length. grove session ids are short worktree+pane
/// hashes; anything larger is a desynced/corrupt stream.
pub const MAX_SESSION_ID_BYTES: u16 = 4096;

const KIND_DATA: u8 = 0x02;
const KIND_RESIZE: u8 = 0x03;
const KIND_EXIT: u8 = 0x10;

/// The three frame kinds carried on the live stream socket. `Data` is raw PTY
/// bytes; `Resize`/`Exit` carry small typed payloads (see the typed helpers).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamFrameKind {
    Data,
    Resize,
    Exit,
}

impl StreamFrameKind {
    fn to_u8(self) -> u8 {
        match self {
            StreamFrameKind::Data => KIND_DATA,
            StreamFrameKind::Resize => KIND_RESIZE,
            StreamFrameKind::Exit => KIND_EXIT,
        }
    }

    fn from_u8(v: u8) -> Option<Self> {
        match v {
            KIND_DATA => Some(StreamFrameKind::Data),
            KIND_RESIZE => Some(StreamFrameKind::Resize),
            KIND_EXIT => Some(StreamFrameKind::Exit),
            _ => None,
        }
    }
}

/// Small JSON payload of an `Exit` frame (design P13). Both fields optional:
/// a normal exit carries `code`, a signalled death carries `signal`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
}

/// A decoded/decodable stream frame. The payload stays raw bytes at this layer;
/// `Exit`/`Resize` interpretation is done via the typed helpers so the codec
/// itself is byte-exact for the `Data` hot path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamFrame {
    pub kind: StreamFrameKind,
    pub session_id: String,
    pub seq: u64,
    pub payload: Vec<u8>,
}

/// Errors from decoding (or validating on encode) a stream frame. All are
/// unrecoverable protocol desyncs on a socket — the caller tears the stream down.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    BadMagic,
    UnknownKind(u8),
    OversizedPayload { len: usize, cap: usize },
    OversizedSessionId { len: usize, cap: u16 },
    /// Session id bytes were not valid UTF-8.
    InvalidSessionId,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::BadMagic => write!(f, "stream frame: bad magic"),
            FrameError::UnknownKind(k) => write!(f, "stream frame: unknown kind 0x{k:02x}"),
            FrameError::OversizedPayload { len, cap } => {
                write!(f, "stream frame: payload {len} exceeds cap {cap}")
            }
            FrameError::OversizedSessionId { len, cap } => {
                write!(f, "stream frame: session id {len} exceeds cap {cap}")
            }
            FrameError::InvalidSessionId => write!(f, "stream frame: session id not utf8"),
        }
    }
}

impl std::error::Error for FrameError {}

impl StreamFrame {
    /// A raw-output frame (the hot path). `seq` is the absolute output sequence.
    pub fn data(session_id: impl Into<String>, seq: u64, payload: impl Into<Vec<u8>>) -> Self {
        Self {
            kind: StreamFrameKind::Data,
            session_id: session_id.into(),
            seq,
            payload: payload.into(),
        }
    }

    /// A resize frame carrying `cols`/`rows` as `u16le cols + u16le rows`.
    pub fn resize(session_id: impl Into<String>, seq: u64, cols: u16, rows: u16) -> Self {
        let mut payload = Vec::with_capacity(4);
        payload.extend_from_slice(&cols.to_le_bytes());
        payload.extend_from_slice(&rows.to_le_bytes());
        Self {
            kind: StreamFrameKind::Resize,
            session_id: session_id.into(),
            seq,
            payload,
        }
    }

    /// An exit frame; the small `{code, signal}` JSON rides inside the payload.
    /// Ordered AFTER the session's final `Data` frame (design P13).
    pub fn exit(session_id: impl Into<String>, seq: u64, status: &ExitStatus) -> Self {
        // Why unwrap-safe: ExitStatus is two optional ints — serialization to a
        // JSON object cannot fail.
        let payload = serde_json::to_vec(status).expect("ExitStatus serializes");
        Self {
            kind: StreamFrameKind::Exit,
            session_id: session_id.into(),
            seq,
            payload,
        }
    }

    /// Decode a `Resize` payload to `(cols, rows)`; `None` for any other kind or
    /// a malformed payload.
    pub fn as_resize(&self) -> Option<(u16, u16)> {
        if self.kind != StreamFrameKind::Resize || self.payload.len() != 4 {
            return None;
        }
        let cols = u16::from_le_bytes([self.payload[0], self.payload[1]]);
        let rows = u16::from_le_bytes([self.payload[2], self.payload[3]]);
        Some((cols, rows))
    }

    /// Decode an `Exit` payload; `None` for any other kind or invalid JSON.
    pub fn as_exit(&self) -> Option<ExitStatus> {
        if self.kind != StreamFrameKind::Exit {
            return None;
        }
        serde_json::from_slice(&self.payload).ok()
    }

    /// Append the encoded frame to `out`. Validates the caps so an over-budget
    /// session id / payload can never be put on the wire (it would be undecodable
    /// past the caps on the far side).
    pub fn encode(&self, out: &mut Vec<u8>) -> Result<(), FrameError> {
        let sid = self.session_id.as_bytes();
        if sid.len() > MAX_SESSION_ID_BYTES as usize {
            return Err(FrameError::OversizedSessionId {
                len: sid.len(),
                cap: MAX_SESSION_ID_BYTES,
            });
        }
        if self.payload.len() > MAX_STREAM_FRAME_PAYLOAD {
            return Err(FrameError::OversizedPayload {
                len: self.payload.len(),
                cap: MAX_STREAM_FRAME_PAYLOAD,
            });
        }
        out.extend_from_slice(&STREAM_FRAME_MAGIC);
        out.push(self.kind.to_u8());
        out.extend_from_slice(&(sid.len() as u16).to_le_bytes());
        out.extend_from_slice(&self.seq.to_le_bytes());
        out.extend_from_slice(&(self.payload.len() as u32).to_le_bytes());
        out.extend_from_slice(sid);
        out.extend_from_slice(&self.payload);
        Ok(())
    }

    /// Convenience: encode into a fresh `Vec`.
    pub fn to_bytes(&self) -> Result<Vec<u8>, FrameError> {
        let mut out = Vec::with_capacity(STREAM_FRAME_HEADER_BYTES + self.payload.len());
        self.encode(&mut out)?;
        Ok(out)
    }
}

/// Streaming decoder that tolerates partial reads: bytes are fed in as they
/// arrive off the socket, and complete frames are pulled out one at a time. A
/// trailing partial frame stays buffered until the rest arrives.
#[derive(Debug, Default)]
pub struct StreamDecoder {
    buf: Vec<u8>,
}

impl StreamDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append freshly read bytes to the internal buffer.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Pull the next complete frame.
    /// - `Ok(Some(frame))` — a full frame was decoded and consumed.
    /// - `Ok(None)` — not enough bytes yet (partial read); feed more.
    /// - `Err(_)` — protocol desync (bad magic / unknown kind / oversized); the
    ///   caller must tear the stream down (the buffer is intentionally left
    ///   intact so the error is sticky rather than silently skipped).
    pub fn next_frame(&mut self) -> Result<Option<StreamFrame>, FrameError> {
        if self.buf.len() < STREAM_FRAME_HEADER_BYTES {
            return Ok(None);
        }
        if self.buf[0..4] != STREAM_FRAME_MAGIC {
            return Err(FrameError::BadMagic);
        }
        let kind = StreamFrameKind::from_u8(self.buf[4]).ok_or(FrameError::UnknownKind(self.buf[4]))?;
        let sid_len = u16::from_le_bytes([self.buf[5], self.buf[6]]);
        let seq = u64::from_le_bytes([
            self.buf[7], self.buf[8], self.buf[9], self.buf[10], self.buf[11], self.buf[12],
            self.buf[13], self.buf[14],
        ]);
        let payload_len = u32::from_le_bytes([self.buf[15], self.buf[16], self.buf[17], self.buf[18]])
            as usize;

        // Reject oversize on the LENGTH PREFIX, before waiting for bytes — a
        // corrupt huge prefix must fail fast, not buffer forever.
        if sid_len > MAX_SESSION_ID_BYTES {
            return Err(FrameError::OversizedSessionId {
                len: sid_len as usize,
                cap: MAX_SESSION_ID_BYTES,
            });
        }
        if payload_len > MAX_STREAM_FRAME_PAYLOAD {
            return Err(FrameError::OversizedPayload {
                len: payload_len,
                cap: MAX_STREAM_FRAME_PAYLOAD,
            });
        }

        let sid_start = STREAM_FRAME_HEADER_BYTES;
        let sid_end = sid_start + sid_len as usize;
        let payload_end = sid_end + payload_len;
        if self.buf.len() < payload_end {
            return Ok(None); // partial frame — wait for more
        }

        let session_id = match std::str::from_utf8(&self.buf[sid_start..sid_end]) {
            Ok(s) => s.to_string(),
            Err(_) => return Err(FrameError::InvalidSessionId),
        };
        let payload = self.buf[sid_end..payload_end].to_vec();
        self.buf.drain(0..payload_end);

        Ok(Some(StreamFrame {
            kind,
            session_id,
            seq,
            payload,
        }))
    }

    /// Bytes buffered but not yet forming a complete frame (diagnostics/tests).
    pub fn buffered_len(&self) -> usize {
        self.buf.len()
    }
}

/// Is `next` a monotonic (non-decreasing) successor of `prev`? The absolute
/// output sequence (S3) advances by chunk length on each ingested `Data` chunk,
/// while an `Exit`/`Resize` frame carries the CURRENT sequence — so consecutive
/// frames are non-decreasing, never strictly increasing.
pub fn seq_is_monotonic(prev: Option<u64>, next: u64) -> bool {
    match prev {
        None => true,
        Some(p) => next >= p,
    }
}

/// Stateful per-session sequence guard built on [`seq_is_monotonic`]. `observe`
/// returns `false` (and does not advance) on a regression, so a caller can drop
/// the stream / force a full re-anchor.
#[derive(Debug, Default, Clone)]
pub struct SeqTracker {
    last: Option<u64>,
}

impl SeqTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn observe(&mut self, seq: u64) -> bool {
        let ok = seq_is_monotonic(self.last, seq);
        if ok {
            self.last = Some(seq);
        }
        ok
    }

    pub fn last(&self) -> Option<u64> {
        self.last
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_frame_round_trips() {
        let frame = StreamFrame::data("sess-a", 42, vec![0x00, 0xff, 0x1b, 0x5b]);
        let bytes = frame.to_bytes().unwrap();
        let mut dec = StreamDecoder::new();
        dec.feed(&bytes);
        assert_eq!(dec.next_frame().unwrap(), Some(frame));
        assert_eq!(dec.next_frame().unwrap(), None);
        assert_eq!(dec.buffered_len(), 0);
    }

    #[test]
    fn resize_frame_typed_payload_round_trips() {
        let frame = StreamFrame::resize("s", 7, 120, 40);
        assert_eq!(frame.as_resize(), Some((120, 40)));
        let bytes = frame.to_bytes().unwrap();
        let mut dec = StreamDecoder::new();
        dec.feed(&bytes);
        let decoded = dec.next_frame().unwrap().unwrap();
        assert_eq!(decoded.as_resize(), Some((120, 40)));
        assert_eq!(decoded, frame);
    }

    #[test]
    fn exit_frame_typed_payload_round_trips() {
        let status = ExitStatus {
            code: Some(137),
            signal: Some(9),
        };
        let frame = StreamFrame::exit("s", 999, &status);
        assert_eq!(frame.as_exit(), Some(status.clone()));
        let bytes = frame.to_bytes().unwrap();
        let mut dec = StreamDecoder::new();
        dec.feed(&bytes);
        let decoded = dec.next_frame().unwrap().unwrap();
        assert_eq!(decoded.as_exit(), Some(status));
        assert_eq!(decoded.kind, StreamFrameKind::Exit);
    }

    #[test]
    fn exit_status_omits_none_fields() {
        let frame = StreamFrame::exit("s", 1, &ExitStatus { code: Some(0), signal: None });
        // {"code":0} — no null signal key.
        assert_eq!(std::str::from_utf8(&frame.payload).unwrap(), r#"{"code":0}"#);
    }

    #[test]
    fn partial_reads_yield_none_until_complete() {
        let frame = StreamFrame::data("worktree-hash-pane2", 1234, b"hello world".to_vec());
        let bytes = frame.to_bytes().unwrap();
        let mut dec = StreamDecoder::new();
        // Feed one byte at a time; only the last byte completes the frame.
        for (i, b) in bytes.iter().enumerate() {
            dec.feed(&[*b]);
            let got = dec.next_frame().unwrap();
            if i + 1 == bytes.len() {
                assert_eq!(got, Some(frame.clone()));
            } else {
                assert_eq!(got, None, "frame completed early at byte {i}");
            }
        }
    }

    #[test]
    fn multiple_frames_in_one_buffer() {
        let f1 = StreamFrame::data("a", 1, b"one".to_vec());
        let f2 = StreamFrame::resize("a", 3, 80, 24);
        let f3 = StreamFrame::exit("a", 3, &ExitStatus { code: Some(0), signal: None });
        let mut bytes = Vec::new();
        f1.encode(&mut bytes).unwrap();
        f2.encode(&mut bytes).unwrap();
        f3.encode(&mut bytes).unwrap();
        let mut dec = StreamDecoder::new();
        dec.feed(&bytes);
        assert_eq!(dec.next_frame().unwrap(), Some(f1));
        assert_eq!(dec.next_frame().unwrap(), Some(f2));
        assert_eq!(dec.next_frame().unwrap(), Some(f3));
        assert_eq!(dec.next_frame().unwrap(), None);
    }

    #[test]
    fn empty_session_id_and_empty_payload_are_valid() {
        let frame = StreamFrame::data("", 0, Vec::new());
        let bytes = frame.to_bytes().unwrap();
        assert_eq!(bytes.len(), STREAM_FRAME_HEADER_BYTES);
        let mut dec = StreamDecoder::new();
        dec.feed(&bytes);
        assert_eq!(dec.next_frame().unwrap(), Some(frame));
    }

    #[test]
    fn bad_magic_is_rejected() {
        let mut bytes = StreamFrame::data("a", 1, b"x".to_vec()).to_bytes().unwrap();
        bytes[0] = b'X';
        let mut dec = StreamDecoder::new();
        dec.feed(&bytes);
        assert_eq!(dec.next_frame(), Err(FrameError::BadMagic));
    }

    #[test]
    fn unknown_kind_is_rejected() {
        let mut bytes = StreamFrame::data("a", 1, b"x".to_vec()).to_bytes().unwrap();
        bytes[4] = 0x7f; // not Data/Resize/Exit
        let mut dec = StreamDecoder::new();
        dec.feed(&bytes);
        assert_eq!(dec.next_frame(), Err(FrameError::UnknownKind(0x7f)));
    }

    #[test]
    fn oversized_payload_prefix_is_rejected_before_buffering() {
        // Hand-craft a header claiming a payload past the cap; feed ONLY the
        // header — rejection must not wait for the (impossible) bytes.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&STREAM_FRAME_MAGIC);
        bytes.push(KIND_DATA);
        bytes.extend_from_slice(&0u16.to_le_bytes()); // sid_len
        bytes.extend_from_slice(&0u64.to_le_bytes()); // seq
        bytes.extend_from_slice(&((MAX_STREAM_FRAME_PAYLOAD as u32) + 1).to_le_bytes());
        let mut dec = StreamDecoder::new();
        dec.feed(&bytes);
        assert_eq!(
            dec.next_frame(),
            Err(FrameError::OversizedPayload {
                len: MAX_STREAM_FRAME_PAYLOAD + 1,
                cap: MAX_STREAM_FRAME_PAYLOAD,
            })
        );
    }

    #[test]
    fn oversized_session_id_prefix_is_rejected() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&STREAM_FRAME_MAGIC);
        bytes.push(KIND_DATA);
        bytes.extend_from_slice(&(MAX_SESSION_ID_BYTES + 1).to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        let mut dec = StreamDecoder::new();
        dec.feed(&bytes);
        assert_eq!(
            dec.next_frame(),
            Err(FrameError::OversizedSessionId {
                len: (MAX_SESSION_ID_BYTES + 1) as usize,
                cap: MAX_SESSION_ID_BYTES,
            })
        );
    }

    #[test]
    fn encode_rejects_oversized_session_id() {
        let frame = StreamFrame::data("x".repeat(MAX_SESSION_ID_BYTES as usize + 1), 0, Vec::new());
        assert!(matches!(
            frame.to_bytes(),
            Err(FrameError::OversizedSessionId { .. })
        ));
    }

    #[test]
    fn seq_monotonic_helper() {
        assert!(seq_is_monotonic(None, 0));
        assert!(seq_is_monotonic(Some(5), 5)); // exit repeats last seq
        assert!(seq_is_monotonic(Some(5), 9));
        assert!(!seq_is_monotonic(Some(9), 5));

        let mut t = SeqTracker::new();
        assert!(t.observe(10));
        assert!(t.observe(10));
        assert!(t.observe(25));
        assert!(!t.observe(24)); // regression rejected
        assert_eq!(t.last(), Some(25)); // and does not advance
    }

    // Deterministic, dependency-free xorshift32 (mirrors the pty.rs ring fuzz).
    fn xorshift32(state: &mut u32) -> u32 {
        *state ^= *state << 13;
        *state ^= *state >> 17;
        *state ^= *state << 5;
        *state
    }

    #[test]
    fn round_trip_fuzz_arbitrary_binary_payloads() {
        // Generate many frames with random kinds, session ids, and — crucially —
        // payloads full of arbitrary/invalid-UTF-8 bytes (lone continuation
        // bytes, NULs, raw 0xff), encode them concatenated, then decode fed in
        // random-sized chunks. Every frame must survive byte-identical. This is
        // the R10 guarantee: binary PTY bytes never corrupt on the wire.
        let mut rng = 0x9e37_79b9u32;
        let mut frames: Vec<StreamFrame> = Vec::new();
        let mut wire: Vec<u8> = Vec::new();

        for _ in 0..3000 {
            let seq = ((xorshift32(&mut rng) as u64) << 16) | xorshift32(&mut rng) as u64;
            let sid_len = (xorshift32(&mut rng) % 12) as usize;
            let session_id: String = (0..sid_len)
                .map(|_| (b'a' + (xorshift32(&mut rng) % 26) as u8) as char)
                .collect();
            let frame = match xorshift32(&mut rng) % 3 {
                0 => {
                    let len = (xorshift32(&mut rng) % 300) as usize;
                    let payload: Vec<u8> =
                        (0..len).map(|_| (xorshift32(&mut rng) & 0xff) as u8).collect();
                    StreamFrame::data(session_id, seq, payload)
                }
                1 => StreamFrame::resize(
                    session_id,
                    seq,
                    (xorshift32(&mut rng) & 0xffff) as u16,
                    (xorshift32(&mut rng) & 0xffff) as u16,
                ),
                _ => {
                    let code = if xorshift32(&mut rng) % 2 == 0 {
                        Some((xorshift32(&mut rng) & 0xff) as i32)
                    } else {
                        None
                    };
                    let signal = if xorshift32(&mut rng) % 2 == 0 {
                        Some((xorshift32(&mut rng) % 32) as i32)
                    } else {
                        None
                    };
                    StreamFrame::exit(session_id, seq, &ExitStatus { code, signal })
                }
            };
            frame.encode(&mut wire).unwrap();
            frames.push(frame);
        }

        let mut dec = StreamDecoder::new();
        let mut decoded: Vec<StreamFrame> = Vec::new();
        let mut offset = 0;
        while offset < wire.len() {
            let chunk = 1 + (xorshift32(&mut rng) as usize % 64);
            let end = (offset + chunk).min(wire.len());
            dec.feed(&wire[offset..end]);
            offset = end;
            while let Some(f) = dec.next_frame().unwrap() {
                decoded.push(f);
            }
        }
        assert_eq!(dec.buffered_len(), 0, "trailing partial bytes left over");
        assert_eq!(decoded, frames);
    }
}
