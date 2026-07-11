//! On-disk terminal history: the per-session dir layout, the `.owner.lock`
//! flock, `meta.json`, the durable-rename `checkpoint.json`, and the framed
//! append-only `output.log` — plus the cold-restore reader (design §5, rows
//! D1-D13, fix #10/#16/#18).
//!
//! This module is the DISK layer only: it has no `Session` dependency and no
//! sockets, so every crash-consistency property (durable rename, generation
//! pairing, torn-tail detection, seq-gap rejection, corrupt-newest fallback,
//! flock ownership) is unit-testable against synthetic bytes. The 5s tick that
//! drives it lives in [`crate::checkpointer`]; the reader's cold-restore output
//! is composed into a wire payload by stage 2 (it stays unused here).
//!
//! Layout (design D1/§5), under `history_root(app_data)` =
//! `terminal-history/v{PROTOCOL_VERSION}/`:
//! ```text
//!   {percent_encode(pty_id)}/
//!     .owner.lock      advisory flock held for the owning daemon's lifetime
//!     meta.json        {cwd, cols, rows, started_at_ms, ended_at_ms, exit_code}
//!     checkpoint.json  full VT snapshot + raw-ring scrollback + generation
//!     output.log       GCKL header + framed incremental Batch/Output/Resize/Clear
//! ```
//!
//! Generation pairing (design D5, core invariant): a `u32 generation` lives in
//! BOTH `checkpoint.json` and the log header. On a full checkpoint the write
//! order is checkpoint durable-rename FIRST, then truncate+rewrite the log
//! header at the NEW generation — so a crash in between leaves a stale-generation
//! log that the reader drops, falling back to the consistent checkpoint alone.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use grove_core::daemon::framing::STREAM_FRAME_MAGIC;

use crate::emulator::{DaemonEmulator, SnapshotOptions, DEFAULT_SCROLLBACK_LINES};

// ---------------------------------------------------------------------------
// Constants (design D4/D7/§5)
// ---------------------------------------------------------------------------

/// `output.log` header: magic(4) + `u8 format_version` + `u32le generation`.
/// The magic is REUSED from the stream codec ([`STREAM_FRAME_MAGIC`], design
/// D4). The socket [`grove_core::daemon::framing::StreamFrame`] shape cannot
/// express a single leading generation header (it carries a per-frame magic +
/// session id + `u64` seq), so the disk log's compact framing is built here on
/// top of the shared magic constant — additive, with zero change to the socket
/// wire path (design contract §5 escape clause).
pub const LOG_HEADER_BYTES: usize = 9;

/// On-disk log format version (bumped independently of the protocol version if
/// the framing changes but the socket protocol does not).
const LOG_FORMAT_VERSION: u8 = 1;

const FRAME_BATCH: u8 = 0x01;
const FRAME_OUTPUT: u8 = 0x02;
const FRAME_RESIZE: u8 = 0x03;
const FRAME_CLEAR: u8 = 0x04;

/// A per-frame header: `u8 kind + u32le len`.
const FRAME_HEADER_BYTES: usize = 5;

/// Default incremental-log cap (design D7). Reaching it makes `append_increments`
/// return [`AppendOutcome::NeedsCheckpoint`]; the caller then takes a full
/// snapshot (which subsumes the un-appended records) and resets the log to a new
/// generation. grove's interim cap is 256 KiB (smaller than orca's 5 MiB, §8.X).
pub const DEFAULT_LOG_MAX_BYTES: u64 = 256 * 1024;

/// The per-session file names.
const OWNER_LOCK: &str = ".owner.lock";
const META_JSON: &str = "meta.json";
const CHECKPOINT_JSON: &str = "checkpoint.json";
const OUTPUT_LOG: &str = "output.log";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Percent-encoding (design D1): a stable, filesystem-safe per-session dir name.
// ---------------------------------------------------------------------------

/// Percent-encode `pty_id` into a single path segment, leaving only RFC-3986
/// unreserved bytes (`A-Za-z0-9-._~`) literal. Why: real grove session ids embed
/// worktree identity and can contain `:` / `/` — invalid or path-splitting in a
/// filesystem segment. A hand-rolled encoder avoids pulling a URL crate for one
/// small, self-consistent transform (design D1 "tiny approach without heavy
/// deps"). It is the inverse of [`percent_decode`].
pub fn percent_encode(pty_id: &str) -> String {
    let mut out = String::with_capacity(pty_id.len());
    for &b in pty_id.as_bytes() {
        let unreserved = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~');
        if unreserved {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(hex_upper(b >> 4));
            out.push(hex_upper(b & 0x0f));
        }
    }
    out
}

/// Decode a [`percent_encode`]d segment back to the original id. Returns `None`
/// on a malformed `%`-escape. Used by cold-restore enumeration (stage 2).
pub fn percent_decode(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                if i + 2 >= bytes.len() {
                    return None;
                }
                let hi = from_hex(bytes[i + 1])?;
                let lo = from_hex(bytes[i + 2])?;
                out.push((hi << 4) | lo);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn hex_upper(nibble: u8) -> char {
    match nibble {
        0..=9 => (b'0' + nibble) as char,
        _ => (b'A' + (nibble - 10)) as char,
    }
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// The per-session dir under a history root: `root/{percent_encode(pty_id)}/`.
pub fn session_dir(root: &Path, pty_id: &str) -> PathBuf {
    root.join(percent_encode(pty_id))
}

// ---------------------------------------------------------------------------
// Owner lock (design D1/§5, R9): one writer per session dir.
// ---------------------------------------------------------------------------

/// The outcome of trying to become the session dir's owning writer.
#[derive(Debug)]
pub enum LockError {
    /// Another live daemon already holds the dir's `.owner.lock` (design R9): the
    /// caller MUST refuse to write AND skip cold-restore — the live owner wins.
    OwnedElsewhere,
    Io(io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::OwnedElsewhere => write!(f, "session dir owned by another daemon"),
            LockError::Io(e) => write!(f, "owner lock io: {e}"),
        }
    }
}

impl std::error::Error for LockError {}

/// An advisory `flock(LOCK_EX|LOCK_NB)` on a session dir's `.owner.lock`, held
/// for the owning daemon's lifetime (design D1). Dropping it (fd close) releases
/// the lock. Unix-only — the daemon is unix-only (macOS primary).
///
/// flock is per open-file-description, so two `OpenOptions::open` of the same
/// path in one process contend: the second `flock(LOCK_EX|LOCK_NB)` returns
/// `EWOULDBLOCK` (verified on macOS). That is exactly the second-owner refusal.
#[derive(Debug)]
pub struct OwnerLock {
    _file: File,
}

impl OwnerLock {
    /// Try to acquire the exclusive advisory lock on `dir/.owner.lock`,
    /// creating the file if needed. `OwnedElsewhere` when a live owner holds it.
    pub fn acquire(dir: &Path) -> Result<OwnerLock, LockError> {
        let path = dir.join(OWNER_LOCK);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(LockError::Io)?;
        // SAFETY: fd is valid for the duration of the call; flock only inspects
        // it. LOCK_EX | LOCK_NB → fail fast rather than block if held elsewhere.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            return Ok(OwnerLock { _file: file });
        }
        let err = io::Error::last_os_error();
        // EWOULDBLOCK / EAGAIN ⇒ another fd holds the lock (live owner wins).
        match err.raw_os_error() {
            Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN => {
                Err(LockError::OwnedElsewhere)
            }
            _ => Err(LockError::Io(err)),
        }
    }
}

// ---------------------------------------------------------------------------
// meta.json (design D2): the cold-restore-eligibility discriminator.
// ---------------------------------------------------------------------------

/// `meta.json`. `ended_at_ms == None` ⇔ cold-restore eligible (design D2): it is
/// stamped only on a clean close/exit or graceful daemon shutdown, so a reboot
/// or crash (no clean write) leaves it null and thus recoverable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub started_at_ms: u64,
    /// `None` ⇔ unclean ⇔ cold-restore eligible.
    #[serde(default)]
    pub ended_at_ms: Option<u64>,
    #[serde(default)]
    pub exit_code: Option<i32>,
}

impl SessionMeta {
    pub fn new(cwd: Option<String>, cols: u16, rows: u16) -> Self {
        Self {
            cwd,
            cols,
            rows,
            started_at_ms: now_ms(),
            ended_at_ms: None,
            exit_code: None,
        }
    }

    fn read(dir: &Path) -> Option<SessionMeta> {
        let raw = fs::read_to_string(dir.join(META_JSON)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    fn write(&self, dir: &Path) -> io::Result<()> {
        let data = serde_json::to_vec_pretty(self)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        fs::write(dir.join(META_JSON), data)
    }
}

// ---------------------------------------------------------------------------
// checkpoint.json (design D3): full VT snapshot + raw-ring scrollback.
// ---------------------------------------------------------------------------

/// Byte fields ride as base64 in JSON: the raw ring and the emulator's pending
/// escape tail are NOT guaranteed valid UTF-8, so a JSON string would corrupt
/// them (design contract §5 / R10 rationale, same as the stream codec).
mod b64 {
    use base64::Engine as _;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        base64::engine::general_purpose::STANDARD
            .encode(bytes)
            .serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(s.as_bytes())
            .map_err(serde::de::Error::custom)
    }
}

/// `checkpoint.json` (design D3/contract §5). Content sources (contract 4):
/// `scrollback_ansi` = the session's RAW ring bytes (byte-exact, G4 — never
/// re-emulated); `snapshot_ansi` / `rehydrate_sequences` / `pending_escape_tail`
/// / modes = the emulator's `DaemonSnapshot`. `generation` pairs with the log
/// header (design D5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    /// Emulator alt-buffer body (present only when in alt-screen).
    #[serde(with = "b64")]
    pub snapshot_ansi: Vec<u8>,
    /// RAW ring bytes (byte-exact scrollback; the authoritative cold source).
    #[serde(with = "b64")]
    pub scrollback_ansi: Vec<u8>,
    /// Mode-rehydrate preamble rebuilt from the emulator's ModeState.
    #[serde(with = "b64")]
    pub rehydrate_sequences: Vec<u8>,
    /// The parked incomplete escape (design S7); the restorer writes it last.
    #[serde(with = "b64")]
    pub pending_escape_tail: Vec<u8>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub is_alternate_screen: bool,
    pub kitty_keyboard_flags: u32,
    pub last_title: Option<String>,
    /// The absolute ingest byte sequence at snapshot time (design S3).
    pub scrollback_seq: u64,
    /// Pairs with the log header (design D5). Set by [`HistoryWriter::checkpoint`].
    pub generation: u32,
    pub checkpointed_at_ms: u64,
}

impl Checkpoint {
    fn read(path: &Path) -> Option<Checkpoint> {
        let raw = fs::read(path).ok()?;
        // A zero-length checkpoint (torn newest write) is treated as absent so the
        // reader degrades to log-only / previous-gen, never to nothing (fix #10).
        if raw.is_empty() {
            return None;
        }
        serde_json::from_slice(&raw).ok()
    }
}

// ---------------------------------------------------------------------------
// Incremental log codec (design D4): framed Batch/Output/Resize/Clear.
// ---------------------------------------------------------------------------

/// One record inside an incremental log batch — also the pending-output shape
/// the checkpointer drains from a session (design S2/S4). `Output` carries RAW
/// ring bytes (byte-exact, never re-emulated).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HistoryRecord {
    Output(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Clear,
}

impl HistoryRecord {
    fn output_bytes(&self) -> u64 {
        match self {
            HistoryRecord::Output(b) => b.len() as u64,
            _ => 0,
        }
    }
}

/// A decoded batch: its stamped `seq` (cumulative Output bytes within the log
/// generation, design contract 6 "seq unit = BYTES") + its records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogBatch {
    pub seq: u64,
    pub records: Vec<HistoryRecord>,
}

/// A decoded `output.log`. `truncated_tail` is true when the file ended mid-frame
/// (a torn final append, design D4): the complete prefix is still safe to replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedLog {
    pub generation: u32,
    pub batches: Vec<LogBatch>,
    pub truncated_tail: bool,
}

/// Encode a 9-byte log header at `generation` (design D4).
pub fn encode_log_header(generation: u32) -> [u8; LOG_HEADER_BYTES] {
    let mut h = [0u8; LOG_HEADER_BYTES];
    h[0..4].copy_from_slice(&STREAM_FRAME_MAGIC);
    h[4] = LOG_FORMAT_VERSION;
    h[5..9].copy_from_slice(&generation.to_le_bytes());
    h
}

/// Validate magic + format version and return the generation, or `None` when the
/// buffer is not a readable log header.
pub fn decode_log_header(buf: &[u8]) -> Option<u32> {
    if buf.len() < LOG_HEADER_BYTES {
        return None;
    }
    if buf[0..4] != STREAM_FRAME_MAGIC || buf[4] != LOG_FORMAT_VERSION {
        return None;
    }
    Some(u32::from_le_bytes([buf[5], buf[6], buf[7], buf[8]]))
}

fn push_frame(out: &mut Vec<u8>, kind: u8, payload: &[u8]) {
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
}

/// Encode one batch: a leading `Batch(seq)` frame then one frame per record
/// (design D4). `seq` is the cumulative Output-byte total AFTER this batch.
pub fn encode_log_batch(seq: u64, records: &[HistoryRecord]) -> Vec<u8> {
    let mut out = Vec::new();
    push_frame(&mut out, FRAME_BATCH, &seq.to_le_bytes());
    for record in records {
        match record {
            HistoryRecord::Output(bytes) => push_frame(&mut out, FRAME_OUTPUT, bytes),
            HistoryRecord::Resize { cols, rows } => {
                let mut p = [0u8; 4];
                p[0..2].copy_from_slice(&cols.to_le_bytes());
                p[2..4].copy_from_slice(&rows.to_le_bytes());
                push_frame(&mut out, FRAME_RESIZE, &p);
            }
            HistoryRecord::Clear => push_frame(&mut out, FRAME_CLEAR, &[]),
        }
    }
    out
}

/// Decode a full `output.log` buffer (design D4/D5). Returns `None` when the
/// header is unreadable or the framing is structurally broken (unknown kind, a
/// record frame before any batch, a bad fixed-size payload, or a SEQ GAP — a
/// batch whose cumulative-byte seq does not match its Output payload lengths,
/// contract 6). A torn final frame sets `truncated_tail` and stops at the last
/// complete frame rather than failing (design D4).
pub fn decode_log(buf: &[u8]) -> Option<DecodedLog> {
    let generation = decode_log_header(buf)?;
    let mut batches: Vec<LogBatch> = Vec::new();
    let mut current: Option<LogBatch> = None;
    // Running cumulative Output bytes within this generation. The first batch's
    // seq must equal its own Output bytes (base 0), each subsequent batch must
    // advance by exactly its Output bytes — else a range was dropped (a hole).
    let mut running: u64 = 0;
    let mut offset = LOG_HEADER_BYTES;
    let mut truncated_tail = false;

    while offset < buf.len() {
        if offset + FRAME_HEADER_BYTES > buf.len() {
            truncated_tail = true;
            break;
        }
        let kind = buf[offset];
        let len = u32::from_le_bytes([
            buf[offset + 1],
            buf[offset + 2],
            buf[offset + 3],
            buf[offset + 4],
        ]) as usize;
        let payload_start = offset + FRAME_HEADER_BYTES;
        let payload_end = payload_start.checked_add(len)?;
        if payload_end > buf.len() {
            truncated_tail = true;
            break;
        }
        let payload = &buf[payload_start..payload_end];

        match kind {
            FRAME_BATCH => {
                if len != 8 {
                    return None;
                }
                // Close the previous batch: verify its byte accounting.
                if let Some(prev) = current.take() {
                    let bob: u64 = prev.records.iter().map(HistoryRecord::output_bytes).sum();
                    if prev.seq != running + bob {
                        return None; // seq gap → a range was lost; drop the log.
                    }
                    running = prev.seq;
                    batches.push(prev);
                }
                let seq = u64::from_le_bytes(payload.try_into().ok()?);
                current = Some(LogBatch {
                    seq,
                    records: Vec::new(),
                });
            }
            _ => {
                let Some(cur) = current.as_mut() else {
                    // A record frame before any batch: writer/format disagree.
                    return None;
                };
                match kind {
                    FRAME_OUTPUT => cur.records.push(HistoryRecord::Output(payload.to_vec())),
                    FRAME_RESIZE => {
                        if len != 4 {
                            return None;
                        }
                        cur.records.push(HistoryRecord::Resize {
                            cols: u16::from_le_bytes([payload[0], payload[1]]),
                            rows: u16::from_le_bytes([payload[2], payload[3]]),
                        });
                    }
                    FRAME_CLEAR => cur.records.push(HistoryRecord::Clear),
                    // Unknown kind: a structural break with no batch to attach it
                    // to and no safe way to skip it — drop the whole log.
                    _ => return None,
                }
            }
        }
        offset = payload_end;
    }

    // Close and verify the final open batch.
    if let Some(prev) = current.take() {
        let bob: u64 = prev.records.iter().map(HistoryRecord::output_bytes).sum();
        if prev.seq != running + bob {
            return None;
        }
        batches.push(prev);
    }

    Some(DecodedLog {
        generation,
        batches,
        truncated_tail,
    })
}

// ---------------------------------------------------------------------------
// HistoryWriter (design D3/D4/D5/D9/D10/D11): the per-session disk writer.
// ---------------------------------------------------------------------------

/// The result of an incremental append (design D7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendOutcome {
    /// The batch was appended.
    Appended,
    /// Appending would exceed the log cap: the caller must take a full snapshot
    /// (which subsumes the un-appended records) and [`HistoryWriter::checkpoint`]
    /// to reset the log to a new generation.
    NeedsCheckpoint,
}

/// The per-session disk writer. Holds the dir's [`OwnerLock`] for its lifetime
/// (design D1) and the lazily-resolved log generation + size so warm reattaches
/// continue the existing stream instead of clobbering it (design D10).
pub struct HistoryWriter {
    dir: PathBuf,
    checkpoint_path: PathBuf,
    log_path: PathBuf,
    _lock: OwnerLock,
    /// Generation of the on-disk log header. `None` until lazily resolved on the
    /// first append/checkpoint after a warm `register_writer` (design D10).
    log_generation: Option<u32>,
    /// Current log file size in bytes; `None` until resolved alongside generation.
    log_bytes: Option<u64>,
    /// Cumulative Output bytes written in the current log generation (the seq
    /// stamped into `Batch` frames, contract 6). Reset to 0 on a full checkpoint.
    appended_output_bytes: u64,
    /// Set by `open_session`/`register_writer`; the checkpointer forces a full
    /// re-anchor checkpoint before resuming incremental appends (design D11).
    needs_full_anchor: bool,
    log_max_bytes: u64,
}

impl HistoryWriter {
    /// Open a GENUINELY NEW session (design D9): mkdir, write fresh `meta.json`
    /// (`ended_at` null), and UNLINK any stale `checkpoint.json`/`output.log`
    /// BEFORE the first write — else a reused id could replay the previous
    /// session's content after a crash before the first tick. Acquires the owner
    /// lock (design D1); `OwnedElsewhere` ⇒ a live owner wins, caller refuses.
    pub fn open_session(
        root: &Path,
        pty_id: &str,
        meta: &SessionMeta,
    ) -> Result<HistoryWriter, LockError> {
        let dir = session_dir(root, pty_id);
        fs::create_dir_all(&dir).map_err(LockError::Io)?;
        let lock = OwnerLock::acquire(&dir)?;
        let checkpoint_path = dir.join(CHECKPOINT_JSON);
        let log_path = dir.join(OUTPUT_LOG);
        // Fix F6 / D9: UNLINK the previous incarnation's checkpoint+log BEFORE
        // writing the fresh (unclean) meta. The old order (meta first, then unlink)
        // left a crash window where on-disk state was `fresh unclean meta + old
        // checkpoint/log` — the reader trusts the unclean meta and replays the
        // PREVIOUS session's content under the reused id (D9's exact hazard).
        // Unlinking first means the only reachable mid-open state is `old meta + no
        // files`, which the reader treats as nothing-to-restore.
        let _ = fs::remove_file(&checkpoint_path);
        let _ = fs::remove_file(&log_path);
        meta.write(&dir).map_err(LockError::Io)?;
        Ok(HistoryWriter {
            dir,
            checkpoint_path,
            log_path,
            _lock: lock,
            log_generation: Some(0),
            log_bytes: Some(0),
            appended_output_bytes: 0,
            needs_full_anchor: true,
            log_max_bytes: DEFAULT_LOG_MAX_BYTES,
        })
    }

    /// Warm reattach (design D10): register a writer for an EXISTING session dir
    /// WITHOUT writing meta or deleting the checkpoint/log (they are the only
    /// valid recovery data until the next tick). The log generation + size are
    /// resolved lazily so appends CONTINUE the stream. Forces a full re-anchor
    /// before the first incremental append (design D11).
    pub fn register_writer(root: &Path, pty_id: &str) -> Result<HistoryWriter, LockError> {
        let dir = session_dir(root, pty_id);
        fs::create_dir_all(&dir).map_err(LockError::Io)?;
        let lock = OwnerLock::acquire(&dir)?;
        Ok(HistoryWriter {
            checkpoint_path: dir.join(CHECKPOINT_JSON),
            log_path: dir.join(OUTPUT_LOG),
            dir,
            _lock: lock,
            log_generation: None,
            log_bytes: None,
            appended_output_bytes: 0,
            needs_full_anchor: true,
            log_max_bytes: DEFAULT_LOG_MAX_BYTES,
        })
    }

    /// True until the first checkpoint after open/register (design D11).
    pub fn needs_full_anchor(&self) -> bool {
        self.needs_full_anchor
    }

    /// Force the next persist to take a full re-anchor checkpoint (fix F5). Used by
    /// the checkpointer when an incremental append fails after draining records: a
    /// full snapshot reconstructed from the ring/emulator subsumes the lost records.
    pub fn force_full_anchor(&mut self) {
        self.needs_full_anchor = true;
    }

    #[cfg(test)]
    pub fn set_log_max_bytes(&mut self, cap: u64) {
        self.log_max_bytes = cap;
    }

    /// Resolve the existing log's generation + size once, for a warm reattach
    /// (design D10). Reads the header for the generation and the last `Batch`
    /// seq to seed `appended_output_bytes` so seq accounting continues. A
    /// missing/garbage log resolves to size 0 (next append rewrites from scratch)
    /// with the generation taken from `checkpoint.json` (or 0).
    fn resolve_log_state(&mut self) {
        if self.log_bytes.is_some() && self.log_generation.is_some() {
            return;
        }
        match fs::read(&self.log_path) {
            Ok(buf) => {
                if let Some(gen) = decode_log_header(&buf) {
                    self.log_generation = Some(gen);
                    self.log_bytes = Some(buf.len() as u64);
                    // Seed the seq counter from the last decodable batch so a
                    // continued append advances from the right byte offset.
                    self.appended_output_bytes = decode_log(&buf)
                        .and_then(|d| d.batches.last().map(|b| b.seq))
                        .unwrap_or(0);
                    return;
                }
                // Unreadable header: force a rewrite-from-scratch on next append.
                self.log_bytes = Some(0);
                self.log_generation = Some(self.checkpoint_generation().unwrap_or(0));
                self.appended_output_bytes = 0;
            }
            Err(_) => {
                self.log_bytes = Some(0);
                self.log_generation = Some(self.checkpoint_generation().unwrap_or(0));
                self.appended_output_bytes = 0;
            }
        }
    }

    fn checkpoint_generation(&self) -> Option<u32> {
        Checkpoint::read(&self.checkpoint_path).map(|c| c.generation)
    }

    /// Append one batch of records to the incremental log (design D4/D7). Returns
    /// [`AppendOutcome::NeedsCheckpoint`] WITHOUT writing when the batch would
    /// exceed the cap. The `Batch` frame's seq is the cumulative Output-byte
    /// total after this batch (contract 6). The header is written lazily on the
    /// first append; batch bytes use `OpenOptions::append`.
    pub fn append_increments(&mut self, records: &[HistoryRecord]) -> io::Result<AppendOutcome> {
        if records.is_empty() {
            return Ok(AppendOutcome::Appended);
        }
        self.resolve_log_state();
        let batch_output_bytes: u64 = records.iter().map(HistoryRecord::output_bytes).sum();
        let seq = self.appended_output_bytes + batch_output_bytes;
        let batch = encode_log_batch(seq, records);

        // A fresh log gets its header written below, so the projected size must
        // include the header or the cap could be overshot (design D7).
        let current = self.log_bytes.unwrap_or(0).max(LOG_HEADER_BYTES as u64);
        if current + batch.len() as u64 > self.log_max_bytes {
            return Ok(AppendOutcome::NeedsCheckpoint);
        }

        if self.log_bytes == Some(0) {
            // Header carries the generation tying this log to its base checkpoint;
            // written lazily so a warm reattach never clobbers an appended log.
            let gen = self.log_generation.unwrap_or(0);
            fs::write(&self.log_path, encode_log_header(gen))?;
            self.log_bytes = Some(LOG_HEADER_BYTES as u64);
        }
        let mut f = OpenOptions::new().append(true).open(&self.log_path)?;
        f.write_all(&batch)?;
        self.log_bytes = Some(self.log_bytes.unwrap_or(LOG_HEADER_BYTES as u64) + batch.len() as u64);
        self.appended_output_bytes = seq;
        Ok(AppendOutcome::Appended)
    }

    /// Write a full checkpoint durably, then reset the log (design D3/D5). Sets
    /// `checkpoint.generation` to the next generation, DURABLE-renames it FIRST
    /// (write `.tmp` → fsync tmp fd → rename → fsync dir fd), THEN truncates the
    /// log to a fresh header at that generation. A crash between the two leaves a
    /// stale-generation log the reader drops (design D5). Clears the re-anchor
    /// flag (design D11).
    pub fn checkpoint(&mut self, mut checkpoint: Checkpoint) -> io::Result<()> {
        self.resolve_log_state();
        let generation = self.log_generation.unwrap_or(0).wrapping_add(1);
        checkpoint.generation = generation;
        checkpoint.checkpointed_at_ms = now_ms();

        let data = serde_json::to_vec(&checkpoint)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        write_durable(&self.checkpoint_path, &data)?;

        // The snapshot subsumes every logged record, so reset the log to the new
        // generation. A crash before this reset is safe: the stale log's
        // generation no longer matches the checkpoint's (design D5).
        fs::write(&self.log_path, encode_log_header(generation))?;
        self.log_generation = Some(generation);
        self.log_bytes = Some(LOG_HEADER_BYTES as u64);
        self.appended_output_bytes = 0;
        self.needs_full_anchor = false;
        Ok(())
    }

    /// Stamp `ended_at`/`exit_code` on a clean close/exit or graceful shutdown
    /// (design D2): the session becomes cold-restore INELIGIBLE.
    pub fn stamp_ended(&self, exit_code: Option<i32>) -> io::Result<()> {
        let Some(mut meta) = SessionMeta::read(&self.dir) else {
            return Ok(());
        };
        meta.ended_at_ms = Some(now_ms());
        meta.exit_code = exit_code;
        meta.write(&self.dir)
    }

    /// Clear `ended_at` for a restore-seeded / woken session (design D2/L12) so
    /// the same session can sleep/wake (cold-restore) again. Re-arms the full
    /// re-anchor (design D11).
    pub fn reopen(&mut self) -> io::Result<()> {
        if let Some(mut meta) = SessionMeta::read(&self.dir) {
            meta.ended_at_ms = None;
            meta.exit_code = None;
            meta.write(&self.dir)?;
        }
        self.needs_full_anchor = true;
        Ok(())
    }

    #[cfg(test)]
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// Durable file replace (design D3, fix #10): write `.tmp` → fsync(tmp fd) →
/// rename → fsync(dir fd). Plain rename only guarantees the old-or-new NAME, not
/// that the new file's DATA is durable across power loss — the exact Tier-B
/// scenario. Runs synchronously; the checkpointer calls it off the tick thread
/// (`spawn_blocking`) so the daemon loop never stalls (design D3/D8).
pub fn write_durable(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut f = File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    if let Some(dir) = path.parent() {
        // fsync the directory so the rename itself is durable across power loss.
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// HistoryReader (design D6/D12/D13, fix #10/#16): cold-restore composition.
// ---------------------------------------------------------------------------

/// The composed cold-restore payload inputs (design D6, contract 10). Carries
/// everything stage 2 needs for the S15 COLD payload shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColdRestore {
    /// Byte-exact scrollback for the renderer to replay as history: the
    /// checkpoint's RAW ring bytes + the byte-exact log Output tail. Never
    /// re-emulated (design G4/D6) → no width drift.
    pub scrollback_for_replay: Vec<u8>,
    /// The normalized final screen, composed to land in the NORMAL screen (design
    /// D13): a fresh scratch vt100 (sized from checkpoint/meta) after writing the
    /// checkpoint base and replaying the log, serialized as its body WITHOUT the
    /// alt-enter (`?1049h`). For an alt-screen session this is the frozen primary
    /// (or the alt body when the primary is empty); for a normal session it is the
    /// live body. Display-only; NO reflow claim (design D6/§3.4).
    pub final_screen_ansi: Vec<u8>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub is_alternate_screen: bool,
    /// The parked incomplete escape; the restorer writes it LAST (design S7).
    pub pending_escape_tail: Vec<u8>,
    /// Fix F7 / fix #10: true when the checkpoint base was LOST (torn/zero-length
    /// newest checkpoint) and only the incremental log tail survived. The scrollback
    /// history before the log is gone, but the recent tail is intact — a degraded
    /// (tail-only) restore, never nothing. Stage 2 surfaces this to the renderer.
    pub degraded: bool,
}

impl ColdRestore {
    /// The renderer-facing cold-restore body (design S15 cold variant / D13). It
    /// NEVER contains an alt-screen enter (`\x1b[?1049h`): a cold-restored session's
    /// daemon-side child is gone, so there is no TUI to resume — the content lands
    /// in the NORMAL screen and must not re-enter alt (the renderer's cold reset
    /// would not undo it). Composition:
    /// - alt session → `final_screen_ansi` (the frozen primary / last TUI frame,
    ///   serialized clean — no `?1049h`).
    /// - normal session → `scrollback_for_replay` (the byte-exact history, which
    ///   replays to the current screen without ever entering alt).
    pub fn cold_snapshot(&self) -> Vec<u8> {
        if self.is_alternate_screen {
            self.final_screen_ansi.clone()
        } else {
            self.scrollback_for_replay.clone()
        }
    }
}

/// Reads a session dir and composes a cold-restore payload (design D6). Stays
/// unused by the server in stage 1; stage 2 calls it from the atomic
/// live-vs-cold decision (design D12).
pub struct HistoryReader<'a> {
    root: &'a Path,
}

impl<'a> HistoryReader<'a> {
    pub fn new(root: &'a Path) -> Self {
        Self { root }
    }

    /// Cheap eligibility predicate (design D6): reads only `meta.json` and
    /// applies the same unclean-shutdown test [`detect_cold_restore`] starts
    /// with (`ended_at == null`).
    pub fn has_restorable_history(&self, pty_id: &str) -> bool {
        SessionMeta::read(&session_dir(self.root, pty_id))
            .map(|m| m.ended_at_ms.is_none())
            .unwrap_or(false)
    }

    /// Compose a cold restore for `pty_id`, or `None` when the session is clean
    /// (design D2) or nothing recoverable exists. Fallback chain (fix #10): log
    /// replay → checkpoint-only → nothing. A parse failure / zero-length
    /// `checkpoint.json` degrades gracefully rather than to nothing.
    ///
    /// `ignore_clean_end` mirrors orca's spawn-probe race guard (design D12): a
    /// dying session's exit can stamp `ended_at` between the caller's eligibility
    /// check and this call; the caller already established eligibility, so the
    /// just-written clean end must not downgrade the restore.
    pub fn detect_cold_restore(
        &self,
        pty_id: &str,
        ignore_clean_end: bool,
    ) -> Option<ColdRestore> {
        let dir = session_dir(self.root, pty_id);
        let meta = SessionMeta::read(&dir)?;
        if meta.ended_at_ms.is_some() && !ignore_clean_end {
            return None;
        }

        let checkpoint_path = dir.join(CHECKPOINT_JSON);
        let raw_checkpoint = Checkpoint::read(&checkpoint_path);

        // Fix F6 / D9 (reader-side defense in depth): a readable checkpoint whose
        // `checkpointed_at` PREDATES this incarnation's `started_at` is a previous
        // incarnation's file left under a reused id. Refuse the whole session — its
        // checkpoint AND its same-generation log both carry the prior session's
        // content. The unlink-before-meta write order (fix F6) stops this state
        // arising normally; this guards a torn/racy interleaving. A synthetic /
        // pre-timestamp checkpoint (`checkpointed_at == 0`) is exempted — its time
        // is unknown, so trust it rather than reject.
        if let Some(cp) = &raw_checkpoint {
            if cp.checkpointed_at_ms != 0 && cp.checkpointed_at_ms < meta.started_at_ms {
                return None;
            }
        }

        // Fix F7 / fix #10: a checkpoint FILE that exists but is unreadable/
        // zero-length (a torn newest write) means the incremental log — at WHATEVER
        // generation — is the only survivor. Accept it tail-only (degraded) rather
        // than restoring nothing. Distinguished from a never-written checkpoint,
        // where the log must be generation 0 (pre-first-checkpoint).
        let checkpoint_torn = raw_checkpoint.is_none() && checkpoint_path.exists();
        let checkpoint = raw_checkpoint;

        // 1. Prefer log replay (byte-exact tail ~5s fresher than the checkpoint).
        if let Some(restore) = self.restore_from_log(&dir, &meta, checkpoint.as_ref(), checkpoint_torn)
        {
            return Some(restore);
        }
        // 2. Fall back to the checkpoint alone.
        if let Some(cp) = checkpoint.as_ref() {
            return Some(self.restore_from_checkpoint(cp, &meta));
        }
        // 3. Nothing recoverable.
        None
    }

    /// Replay the incremental log through a fresh scratch vt100 (design D6). The
    /// log is IGNORED on a generation mismatch (design D5) — the checkpoint alone
    /// is consistent — or on any structural break (`decode_log` → None). Output
    /// frames also accumulate the byte-exact `scrollback_for_replay` tail.
    fn restore_from_log(
        &self,
        dir: &Path,
        meta: &SessionMeta,
        checkpoint: Option<&Checkpoint>,
        checkpoint_torn: bool,
    ) -> Option<ColdRestore> {
        let buf = fs::read(dir.join(OUTPUT_LOG)).ok()?;
        let log = decode_log(&buf)?;
        if log.batches.is_empty() {
            return None;
        }
        // Generation pairing (design D5): a mismatch means the log does not
        // continue this checkpoint — replaying would duplicate/garble content.
        match checkpoint {
            Some(cp) if log.generation != cp.generation => return None,
            // No usable checkpoint. Normally the log must be generation 0 (i.e. it
            // predates any checkpoint). But a TORN checkpoint (fix F7) accepts the
            // newest log at ANY generation as a tail-only degraded restore.
            None if !checkpoint_torn && log.generation != 0 => return None,
            _ => {}
        }
        // Degraded (fix F7): the checkpoint base was lost, so only the log tail is
        // being restored (the pre-log scrollback history is gone).
        let degraded = checkpoint.is_none() && checkpoint_torn;

        let cols = checkpoint.map(|c| c.cols).unwrap_or(meta.cols).max(1);
        let rows = checkpoint.map(|c| c.rows).unwrap_or(meta.rows).max(1);
        let mut scratch = DaemonEmulator::new(rows, cols, DEFAULT_SCROLLBACK_LINES);

        // Byte-exact scrollback = checkpoint base (raw ring) + log Output tail.
        let mut scrollback = Vec::new();
        if let Some(cp) = checkpoint {
            let base = self.checkpoint_base_bytes(cp);
            scratch.process(&base);
            scrollback.extend_from_slice(&cp.scrollback_ansi);
        }
        for batch in &log.batches {
            for record in &batch.records {
                match record {
                    HistoryRecord::Output(bytes) => {
                        scratch.process(bytes);
                        scrollback.extend_from_slice(bytes);
                    }
                    HistoryRecord::Resize { cols, rows } => scratch.resize(*cols, *rows),
                    HistoryRecord::Clear => scrollback.clear(),
                }
            }
        }

        Some(self.finish(scratch, scrollback, checkpoint, meta, degraded))
    }

    /// Checkpoint-only restore (design D6 fallback): no usable log. The base is
    /// the raw ring; alt-screen with an empty ring falls back to `snapshot_ansi`
    /// (design D13).
    fn restore_from_checkpoint(&self, cp: &Checkpoint, meta: &SessionMeta) -> ColdRestore {
        let cols = cp.cols.max(1);
        let rows = cp.rows.max(1);
        let mut scratch = DaemonEmulator::new(rows, cols, DEFAULT_SCROLLBACK_LINES);
        let base = self.checkpoint_base_bytes(cp);
        scratch.process(&base);

        // scrollback_for_replay is the byte-exact ring; the alt fallback (D13)
        // only applies when the ring is empty and we were in alt.
        let scrollback = if cp.scrollback_ansi.is_empty() && cp.is_alternate_screen {
            cp.snapshot_ansi.clone()
        } else {
            cp.scrollback_ansi.clone()
        };
        // A present (readable) checkpoint is the base → not degraded.
        self.finish(scratch, scrollback, Some(cp), meta, false)
    }

    /// The bytes written to the scratch vt100 to reproduce the checkpoint's final
    /// screen. `scrollback_ansi` is the RAW ring, which alone reproduces the
    /// terminal state (including alt); the alt-empty fallback uses the emulator's
    /// alt body + rehydrate (design D13).
    fn checkpoint_base_bytes(&self, cp: &Checkpoint) -> Vec<u8> {
        if cp.scrollback_ansi.is_empty() && cp.is_alternate_screen {
            // The raw ring is empty but the session was in alt-screen: drive the
            // scratch into alt explicitly (the raw ring would normally carry the
            // `?1049h`), then rehydrate + the alt body so the final screen — and
            // `is_alternate_screen` — reflect the alt buffer (design D13).
            let mut base = Vec::new();
            base.extend_from_slice(b"\x1b[?1049h");
            base.extend_from_slice(&cp.rehydrate_sequences);
            base.extend_from_slice(&cp.snapshot_ansi);
            return base;
        }
        cp.scrollback_ansi.clone()
    }

    /// Serialize the scratch emulator's normalized final screen and assemble the
    /// [`ColdRestore`] (design D6/contract 10).
    fn finish(
        &self,
        scratch: DaemonEmulator,
        scrollback_for_replay: Vec<u8>,
        checkpoint: Option<&Checkpoint>,
        meta: &SessionMeta,
        degraded: bool,
    ) -> ColdRestore {
        let snap = scratch.snapshot(SnapshotOptions::default(), 0);
        let cwd = checkpoint
            .and_then(|c| c.cwd.clone())
            .or_else(|| snap.cwd.clone())
            .or_else(|| meta.cwd.clone());
        let pending_escape_tail = checkpoint
            .map(|c| c.pending_escape_tail.clone())
            .unwrap_or_else(|| snap.pending_escape_tail.clone());
        // The land-in-normal final screen (design D13): the scratch's mode-neutral
        // body, never the rehydrate preamble (which is the only source of a
        // `?1049h`). For an alt session the frozen primary is the normal-buffer
        // content; fall back to the alt body only when the primary is empty.
        let final_screen_ansi = if snap.is_alternate_screen && snap.scrollback_ansi.is_empty() {
            snap.snapshot_ansi.clone()
        } else {
            snap.scrollback_ansi.clone()
        };
        ColdRestore {
            scrollback_for_replay,
            final_screen_ansi,
            cwd,
            cols: snap.cols,
            rows: snap.rows,
            is_alternate_screen: snap.is_alternate_screen,
            pending_escape_tail,
            degraded,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "grove-hist-{}-{}-{n}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_checkpoint() -> Checkpoint {
        Checkpoint {
            snapshot_ansi: Vec::new(),
            scrollback_ansi: b"hello scrollback\r\n".to_vec(),
            rehydrate_sequences: Vec::new(),
            pending_escape_tail: Vec::new(),
            cwd: Some("/work".to_string()),
            cols: 80,
            rows: 24,
            is_alternate_screen: false,
            kitty_keyboard_flags: 0,
            last_title: None,
            scrollback_seq: 18,
            generation: 0,
            checkpointed_at_ms: 0,
        }
    }

    // ── percent-encoding ───────────────────────────────────────────────────

    #[test]
    fn percent_encode_round_trips_worktree_ids() {
        for id in ["simple", "work/tree:pane#2", "a b/c%d", "漢字-pane", "x~._-"] {
            let enc = percent_encode(id);
            assert!(!enc.contains('/'), "encoded id must be one segment: {enc}");
            assert_eq!(percent_decode(&enc).as_deref(), Some(id), "round trip {id}");
        }
    }

    #[test]
    fn percent_decode_rejects_malformed() {
        assert_eq!(percent_decode("%"), None);
        assert_eq!(percent_decode("%2"), None);
        assert_eq!(percent_decode("%zz"), None);
    }

    // ── log codec ──────────────────────────────────────────────────────────

    #[test]
    fn log_header_round_trips() {
        let h = encode_log_header(7);
        assert_eq!(decode_log_header(&h), Some(7));
        assert_eq!(&h[0..4], &STREAM_FRAME_MAGIC);
    }

    #[test]
    fn log_batches_round_trip_with_byte_seq() {
        let mut buf = encode_log_header(3).to_vec();
        buf.extend_from_slice(&encode_log_batch(
            5,
            &[HistoryRecord::Output(b"hello".to_vec())],
        ));
        buf.extend_from_slice(&encode_log_batch(
            10,
            &[
                HistoryRecord::Resize { cols: 100, rows: 30 },
                HistoryRecord::Output(b"world".to_vec()),
            ],
        ));
        let decoded = decode_log(&buf).expect("decode");
        assert_eq!(decoded.generation, 3);
        assert!(!decoded.truncated_tail);
        assert_eq!(decoded.batches.len(), 2);
        assert_eq!(decoded.batches[0].seq, 5);
        assert_eq!(
            decoded.batches[1].records[0],
            HistoryRecord::Resize { cols: 100, rows: 30 }
        );
    }

    #[test]
    fn seq_gap_drops_log() {
        // Batch 1 has 5 output bytes → seq 5. Batch 2 has 5 bytes but claims seq
        // 20 (a hole of 10 bytes) — the reader must reject the whole log.
        let mut buf = encode_log_header(1).to_vec();
        buf.extend_from_slice(&encode_log_batch(5, &[HistoryRecord::Output(b"aaaaa".to_vec())]));
        buf.extend_from_slice(&encode_log_batch(20, &[HistoryRecord::Output(b"bbbbb".to_vec())]));
        assert_eq!(decode_log(&buf), None, "seq gap must drop the log");
    }

    #[test]
    fn torn_tail_decodes_to_last_complete_frame() {
        let mut buf = encode_log_header(1).to_vec();
        buf.extend_from_slice(&encode_log_batch(4, &[HistoryRecord::Output(b"good".to_vec())]));
        let complete_len = buf.len();
        // Append a second batch then truncate it mid-payload (torn append).
        buf.extend_from_slice(&encode_log_batch(8, &[HistoryRecord::Output(b"torn".to_vec())]));
        buf.truncate(complete_len + 6); // cut inside the second batch's frames
        let decoded = decode_log(&buf).expect("decode prefix");
        assert!(decoded.truncated_tail, "torn tail must be flagged");
        assert_eq!(decoded.batches.len(), 1, "only the complete batch survives");
        assert_eq!(decoded.batches[0].seq, 4);
    }

    #[test]
    fn unknown_kind_and_bad_header_are_rejected() {
        // Bad header.
        assert_eq!(decode_log(b"NOPExxxxx"), None);
        // Unknown frame kind.
        let mut buf = encode_log_header(1).to_vec();
        buf.extend_from_slice(&encode_log_batch(0, &[]));
        push_frame(&mut buf, 0x7f, b"x");
        assert_eq!(decode_log(&buf), None);
    }

    // ── durable rename ───────────────────────────────────────────────────────

    #[test]
    fn durable_rename_produces_valid_checkpoint() {
        let root = temp_root();
        let mut w = HistoryWriter::open_session(&root, "sess-a", &SessionMeta::new(None, 80, 24))
            .expect("open");
        w.checkpoint(sample_checkpoint()).expect("checkpoint");
        // The committed file parses back and no `.tmp` is left behind.
        let cp = Checkpoint::read(&w.checkpoint_path).expect("read committed checkpoint");
        assert_eq!(cp.scrollback_ansi, b"hello scrollback\r\n");
        assert_eq!(cp.generation, 1, "first checkpoint bumps generation to 1");
        let mut tmp = w.checkpoint_path.as_os_str().to_os_string();
        tmp.push(".tmp");
        assert!(!Path::new(&tmp).exists(), "tmp must be renamed away");
        let _ = fs::remove_dir_all(&root);
    }

    // ── generation pairing ───────────────────────────────────────────────────

    #[test]
    fn checkpoint_then_log_share_generation_and_replay() {
        let root = temp_root();
        let mut w = HistoryWriter::open_session(&root, "sess-g", &SessionMeta::new(None, 80, 24))
            .expect("open");
        w.checkpoint(sample_checkpoint()).expect("checkpoint");
        w.append_increments(&[HistoryRecord::Output(b"tail-bytes".to_vec())])
            .expect("append");
        // The log header generation matches the checkpoint's.
        let log = fs::read(&w.log_path).unwrap();
        let cp = Checkpoint::read(&w.checkpoint_path).unwrap();
        assert_eq!(decode_log_header(&log), Some(cp.generation));

        let restore = HistoryReader::new(&root)
            .detect_cold_restore("sess-g", false)
            .expect("cold restore");
        // scrollback = checkpoint raw ring + log Output tail (byte-exact).
        assert!(restore.scrollback_for_replay.ends_with(b"tail-bytes"));
        assert!(restore
            .scrollback_for_replay
            .windows(16)
            .any(|w| w == b"hello scrollback"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn generation_mismatch_drops_log() {
        let root = temp_root();
        let mut w = HistoryWriter::open_session(&root, "sess-m", &SessionMeta::new(None, 80, 24))
            .expect("open");
        w.checkpoint(sample_checkpoint()).expect("checkpoint"); // generation 1
        w.append_increments(&[HistoryRecord::Output(b"live-tail".to_vec())])
            .expect("append");
        // Corrupt the checkpoint's generation so it no longer pairs with the log.
        let mut cp = Checkpoint::read(&w.checkpoint_path).unwrap();
        cp.generation = 99;
        fs::write(&w.checkpoint_path, serde_json::to_vec(&cp).unwrap()).unwrap();

        let restore = HistoryReader::new(&root)
            .detect_cold_restore("sess-m", false)
            .expect("cold restore falls back to checkpoint-only");
        // The log is dropped (generation mismatch), so the mismatched-checkpoint
        // scrollback is used alone — the live tail is NOT replayed.
        assert!(
            !restore.scrollback_for_replay.windows(9).any(|w| w == b"live-tail"),
            "mismatched log must be dropped"
        );
        assert!(restore
            .scrollback_for_replay
            .windows(16)
            .any(|w| w == b"hello scrollback"));
        let _ = fs::remove_dir_all(&root);
    }

    // ── corrupt-newest fallback (fix #10) ────────────────────────────────────

    #[test]
    fn zero_length_checkpoint_falls_back_to_log_only() {
        let root = temp_root();
        let mut w = HistoryWriter::open_session(&root, "sess-z", &SessionMeta::new(None, 80, 24))
            .expect("open");
        // Write a log at generation 0 (pre-first-checkpoint), then a torn
        // (zero-length) checkpoint.json.
        w.append_increments(&[HistoryRecord::Output(b"log-only-content".to_vec())])
            .expect("append");
        fs::write(w.dir.join(CHECKPOINT_JSON), b"").unwrap();

        let restore = HistoryReader::new(&root)
            .detect_cold_restore("sess-z", false)
            .expect("zero-length checkpoint degrades to log-only, never nothing");
        assert!(restore
            .scrollback_for_replay
            .windows(16)
            .any(|w| w == b"log-only-content"));
        let _ = fs::remove_dir_all(&root);
    }

    // ── flock (design R9) ────────────────────────────────────────────────────

    #[test]
    fn second_owner_is_refused() {
        let root = temp_root();
        let _first =
            HistoryWriter::open_session(&root, "sess-lock", &SessionMeta::new(None, 80, 24))
                .expect("first owner acquires the lock");
        // A second writer (a second fd/flock in this same process) must be refused
        // — flock is per open-file-description, so the two fds contend on macOS.
        let second = HistoryWriter::register_writer(&root, "sess-lock");
        assert!(
            matches!(second, Err(LockError::OwnedElsewhere)),
            "second owner must be refused while the first holds the lock"
        );
        drop(_first);
        // Once the first releases (fd close), a new owner can acquire.
        assert!(HistoryWriter::register_writer(&root, "sess-lock").is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    // ── open_session vs register_writer (design D9/D10) ───────────────────────

    #[test]
    fn open_session_unlinks_stale_register_writer_preserves() {
        let root = temp_root();
        // Seed a session dir with a checkpoint + log.
        {
            let mut w =
                HistoryWriter::open_session(&root, "sess-life", &SessionMeta::new(None, 80, 24))
                    .expect("open");
            w.checkpoint(sample_checkpoint()).expect("checkpoint");
            w.append_increments(&[HistoryRecord::Output(b"prior".to_vec())])
                .expect("append");
        } // drop releases the lock

        let dir = session_dir(&root, "sess-life");
        assert!(dir.join(CHECKPOINT_JSON).exists());

        // register_writer preserves the existing files.
        {
            let _w = HistoryWriter::register_writer(&root, "sess-life").expect("register");
            assert!(
                dir.join(CHECKPOINT_JSON).exists(),
                "register_writer must NOT delete the checkpoint"
            );
            assert!(dir.join(OUTPUT_LOG).exists());
        }

        // open_session (genuinely new session, id reused) unlinks the stale files.
        {
            let _w =
                HistoryWriter::open_session(&root, "sess-life", &SessionMeta::new(None, 80, 24))
                    .expect("reopen fresh");
            assert!(
                !dir.join(CHECKPOINT_JSON).exists(),
                "open_session must unlink the stale checkpoint (design D9)"
            );
            assert!(!dir.join(OUTPUT_LOG).exists());
        }
        let _ = fs::remove_dir_all(&root);
    }

    // ── log cap → NeedsCheckpoint → subsume (design D7) ──────────────────────

    #[test]
    fn log_cap_needs_checkpoint_then_subsumes() {
        let root = temp_root();
        let mut w = HistoryWriter::open_session(&root, "sess-cap", &SessionMeta::new(None, 80, 24))
            .expect("open");
        w.set_log_max_bytes(128); // tiny cap
        w.checkpoint(sample_checkpoint()).expect("anchor"); // generation 1

        // Small appends fit.
        assert_eq!(
            w.append_increments(&[HistoryRecord::Output(b"tiny".to_vec())])
                .unwrap(),
            AppendOutcome::Appended
        );
        // A large append overshoots the cap → NeedsCheckpoint (no write).
        let big = vec![b'x'; 256];
        assert_eq!(
            w.append_increments(&[HistoryRecord::Output(big)]).unwrap(),
            AppendOutcome::NeedsCheckpoint
        );
        // The caller subsumes with a full checkpoint → generation bumps + log
        // resets to just the header (design D7).
        w.checkpoint(sample_checkpoint()).expect("subsume checkpoint");
        let log = fs::read(&w.log_path).unwrap();
        assert_eq!(log.len(), LOG_HEADER_BYTES, "log resets to header on subsume");
        assert_eq!(decode_log_header(&log), Some(2), "generation advanced to 2");
        let _ = fs::remove_dir_all(&root);
    }

    // ── reader replay through scratch vt100 (design D6) ──────────────────────

    #[test]
    fn reader_replays_resize_and_clear_mid_log() {
        let root = temp_root();
        let mut w = HistoryWriter::open_session(&root, "sess-replay", &SessionMeta::new(None, 80, 24))
            .expect("open");
        let mut cp = sample_checkpoint();
        cp.scrollback_ansi = b"BASE-LINE\r\n".to_vec();
        w.checkpoint(cp).expect("anchor");
        // Output, then a resize mid-log, then more output, then a clear.
        w.append_increments(&[
            HistoryRecord::Output(b"before-resize\r\n".to_vec()),
            HistoryRecord::Resize { cols: 100, rows: 30 },
            HistoryRecord::Output(b"after-resize\r\n".to_vec()),
        ])
        .expect("append batch 1");
        w.append_increments(&[
            HistoryRecord::Clear,
            HistoryRecord::Output(b"post-clear\r\n".to_vec()),
        ])
        .expect("append batch 2");

        let restore = HistoryReader::new(&root)
            .detect_cold_restore("sess-replay", false)
            .expect("cold restore");
        // Resize mid-log took effect on the scratch emulator.
        assert_eq!(restore.cols, 100);
        assert_eq!(restore.rows, 30);
        // Clear truncated the byte-exact scrollback: only post-clear bytes remain.
        assert!(restore
            .scrollback_for_replay
            .windows(10)
            .any(|w| w == b"post-clear"));
        assert!(
            !restore.scrollback_for_replay.windows(9).any(|w| w == b"BASE-LINE"),
            "clear must drop pre-clear scrollback"
        );
        // The normalized final screen carries the post-clear content.
        assert!(String::from_utf8_lossy(&restore.final_screen_ansi).contains("post-clear"));
        let _ = fs::remove_dir_all(&root);
    }

    // ── alt fallback (design D13) ────────────────────────────────────────────

    #[test]
    fn alt_screen_empty_ring_falls_back_to_snapshot_ansi() {
        let root = temp_root();
        let _w = HistoryWriter::open_session(&root, "sess-alt", &SessionMeta::new(None, 80, 24))
            .expect("open");
        // Craft a checkpoint: in alt-screen, empty raw ring, alt body in
        // snapshot_ansi (design D13 blank-pane fix).
        let mut cp = sample_checkpoint();
        cp.scrollback_ansi = Vec::new();
        cp.is_alternate_screen = true;
        cp.snapshot_ansi = b"\x1b[H\x1b[2JALT-TUI-CONTENT".to_vec();
        cp.generation = 5;
        let dir = session_dir(&root, "sess-alt");
        fs::write(dir.join(CHECKPOINT_JSON), serde_json::to_vec(&cp).unwrap()).unwrap();
        // No usable log (empty file → decode fails) so the reader uses the
        // checkpoint alone, and the alt fallback kicks in.
        let _ = fs::remove_file(dir.join(OUTPUT_LOG));

        let restore = HistoryReader::new(&root)
            .detect_cold_restore("sess-alt", false)
            .expect("checkpoint-only alt restore");
        assert!(restore.is_alternate_screen);
        assert!(
            restore
                .scrollback_for_replay
                .windows(15)
                .any(|w| w == b"ALT-TUI-CONTENT"),
            "alt fallback must serve snapshot_ansi as scrollback"
        );
        let _ = fs::remove_dir_all(&root);
    }

    // ── cold-restore payload shape (design S15 cold variant / D13) ───────────

    #[test]
    fn cold_snapshot_never_re_enters_alt() {
        // An alt-screen session's cold body must land in the NORMAL screen: the
        // renderer-facing `snapshot` must NOT contain the alt-enter `\x1b[?1049h`
        // (design D13). The raw ring holds `?1049h`, so the composition MUST use
        // the clean frozen-primary/alt body, never the byte-exact scrollback.
        let root = temp_root();
        let _w = HistoryWriter::open_session(&root, "sess-altnorm", &SessionMeta::new(None, 80, 24))
            .expect("open");
        let dir = session_dir(&root, "sess-altnorm");
        let mut cp = sample_checkpoint();
        // A raw ring that drove the session into alt (contains the alt-enter) plus
        // an alt body — the realistic alt checkpoint shape.
        cp.scrollback_ansi = b"PRIMARY-BEFORE\x1b[?1049h\x1b[HALT-BODY".to_vec();
        cp.snapshot_ansi = b"\x1b[H\x1b[2JALT-BODY".to_vec();
        cp.is_alternate_screen = true;
        cp.generation = 3;
        fs::write(dir.join(CHECKPOINT_JSON), serde_json::to_vec(&cp).unwrap()).unwrap();
        let _ = fs::remove_file(dir.join(OUTPUT_LOG));

        let restore = HistoryReader::new(&root)
            .detect_cold_restore("sess-altnorm", false)
            .expect("alt cold restore");
        assert!(restore.is_alternate_screen);
        let cold = restore.cold_snapshot();
        assert!(
            !cold.windows(8).any(|w| w == b"\x1b[?1049h"),
            "alt cold snapshot must not re-enter alt: {:?}",
            String::from_utf8_lossy(&cold)
        );
        // A normal-screen session, by contrast, hands back the byte-exact history.
        let normal = ColdRestore {
            scrollback_for_replay: b"plain scrollback bytes".to_vec(),
            final_screen_ansi: Vec::new(),
            cwd: None,
            cols: 80,
            rows: 24,
            is_alternate_screen: false,
            pending_escape_tail: Vec::new(),
            degraded: false,
        };
        assert_eq!(normal.cold_snapshot(), b"plain scrollback bytes");
        let _ = fs::remove_dir_all(&root);
    }

    // ── meta / ended_at (design D2) ──────────────────────────────────────────

    #[test]
    fn stamp_ended_makes_session_ineligible_reopen_restores() {
        let root = temp_root();
        let mut w = HistoryWriter::open_session(&root, "sess-end", &SessionMeta::new(None, 80, 24))
            .expect("open");
        w.checkpoint(sample_checkpoint()).expect("checkpoint");
        let reader = HistoryReader::new(&root);
        assert!(reader.has_restorable_history("sess-end"));

        w.stamp_ended(Some(0)).expect("stamp ended");
        assert!(!reader.has_restorable_history("sess-end"));
        assert!(
            reader.detect_cold_restore("sess-end", false).is_none(),
            "a cleanly-ended session is not cold-restored"
        );
        // ignore_clean_end overrides (design D12 spawn-probe race).
        assert!(reader.detect_cold_restore("sess-end", true).is_some());

        // reopen clears ended_at → eligible again (design L12).
        w.reopen().expect("reopen");
        assert!(reader.has_restorable_history("sess-end"));
        assert!(w.needs_full_anchor(), "reopen re-arms the full re-anchor");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn register_writer_continues_log_generation() {
        let root = temp_root();
        {
            let mut w =
                HistoryWriter::open_session(&root, "sess-warm", &SessionMeta::new(None, 80, 24))
                    .expect("open");
            w.checkpoint(sample_checkpoint()).expect("checkpoint"); // gen 1
            w.append_increments(&[HistoryRecord::Output(b"first".to_vec())])
                .expect("append");
        }
        // Warm reattach: a fresh writer must resolve the existing generation and
        // CONTINUE the byte-seq stream, not clobber it.
        let mut w = HistoryWriter::register_writer(&root, "sess-warm").expect("register");
        w.append_increments(&[HistoryRecord::Output(b"second".to_vec())])
            .expect("continued append");
        let log = fs::read(&w.log_path).unwrap();
        let decoded = decode_log(&log).expect("decode continued log");
        assert_eq!(decoded.generation, 1, "same generation preserved");
        // Two batches, byte-seqs contiguous: 5 then 5+6=11.
        assert_eq!(decoded.batches.len(), 2);
        assert_eq!(decoded.batches[0].seq, 5);
        assert_eq!(decoded.batches[1].seq, 11);
        let _ = fs::remove_dir_all(&root);
    }

    // ── F7: torn checkpoint + gen-N≥1 log → log-only degraded restore ─────────

    #[test]
    fn torn_checkpoint_gen1_log_restores_tail_degraded() {
        // Fix F7 / fix #10: a zero-length (torn) checkpoint.json alongside a
        // generation-1 log must degrade to the log tail ALONE — not restore
        // nothing. The pre-log base is gone (degraded=true) but the tail survives.
        let root = temp_root();
        let mut w = HistoryWriter::open_session(&root, "sess-f7", &SessionMeta::new(None, 80, 24))
            .expect("open");
        w.checkpoint(sample_checkpoint()).expect("checkpoint"); // generation 1
        w.append_increments(&[HistoryRecord::Output(b"TAIL-SURVIVES-F7".to_vec())])
            .expect("append gen-1 log");
        // Tear the newest checkpoint to zero length (crash mid durable rename).
        fs::write(w.dir.join(CHECKPOINT_JSON), b"").unwrap();

        let restore = HistoryReader::new(&root)
            .detect_cold_restore("sess-f7", false)
            .expect("torn checkpoint + gen-1 log must still restore the tail");
        assert!(
            restore
                .scrollback_for_replay
                .windows(16)
                .any(|w| w == b"TAIL-SURVIVES-F7"),
            "gen-1 log tail must survive a torn checkpoint"
        );
        assert!(
            restore.degraded,
            "a torn-checkpoint log-only restore must be flagged degraded"
        );
        let _ = fs::remove_dir_all(&root);
    }

    // ── F6/D9: reused-id crash window must not leak the previous session ──────

    #[test]
    fn stale_checkpoint_under_reused_id_is_refused() {
        // Fix F6 / D9: the crash window `fresh unclean meta + previous incarnation's
        // checkpoint` (the OLD meta-before-unlink order) must never replay the prior
        // session's content. The reader refuses a checkpoint that predates this
        // incarnation's started_at.
        let root = temp_root();
        // Previous incarnation of the reused id: checkpoint SECRET, then crash
        // (drop without stamping ended_at).
        {
            let mut w =
                HistoryWriter::open_session(&root, "reused", &SessionMeta::new(None, 80, 24))
                    .expect("open previous");
            let mut cp = sample_checkpoint();
            cp.scrollback_ansi = b"PREVIOUS-SESSION-SECRET\r\n".to_vec();
            w.checkpoint(cp).expect("checkpoint previous");
        }
        // Ensure the fresh meta's started_at is strictly newer than the old
        // checkpoint's checkpointed_at (a real reboot has minutes; be robust here).
        std::thread::sleep(std::time::Duration::from_millis(5));
        // Simulate the crash between meta.write and the unlink in the OLD order:
        // a fresh unclean meta over the previous incarnation's checkpoint/log.
        let dir = session_dir(&root, "reused");
        fs::write(
            dir.join(META_JSON),
            serde_json::to_vec_pretty(&SessionMeta::new(Some("/new".into()), 100, 30)).unwrap(),
        )
        .unwrap();

        let restore = HistoryReader::new(&root).detect_cold_restore("reused", false);
        assert!(
            restore.is_none(),
            "a checkpoint predating the fresh meta must be refused (D9 leak guard)"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn open_session_unlinks_before_meta_crash_window_is_safe() {
        // Fix F6: the reachable mid-`open_session` crash state under the NEW order is
        // `old meta + no checkpoint/log` (unlink precedes the meta write). The reader
        // must treat that as nothing-to-restore — never a leak.
        let root = temp_root();
        {
            let mut w =
                HistoryWriter::open_session(&root, "win", &SessionMeta::new(None, 80, 24))
                    .expect("open previous");
            let mut cp = sample_checkpoint();
            cp.scrollback_ansi = b"OLD-CONTENT-SECRET\r\n".to_vec();
            w.checkpoint(cp).expect("checkpoint previous");
        }
        // Reproduce the fixed order's intermediate state: unlink the stale files
        // FIRST, leaving the old (unclean) meta in place.
        let dir = session_dir(&root, "win");
        let _ = fs::remove_file(dir.join(CHECKPOINT_JSON));
        let _ = fs::remove_file(dir.join(OUTPUT_LOG));
        assert!(dir.join(META_JSON).exists(), "old meta still present mid-open");

        let restore = HistoryReader::new(&root).detect_cold_restore("win", false);
        assert!(
            restore.is_none(),
            "old-meta + no files must restore nothing (no previous-content leak)"
        );
        let _ = fs::remove_dir_all(&root);
    }
}
