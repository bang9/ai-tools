//! A single daemon-owned PTY session (design §2.2 S1 + P2 row).
//!
//! A `Session` owns a `portable_pty` master + child and wires together the three
//! SHARED grove-core libraries:
//! - `OutputCoalescer` — batches PTY reads before they hit the stream sink.
//! - `PtyWriter` (`spawn_input_only`) — ordered FIFO input, no tmux side effect.
//! - `append_scrollback_capped` — the byte-exact raw ring (cold-restore source).
//!
//! Isolation (design L11): the reader loop runs on its own std thread and every
//! read iteration is wrapped in `catch_unwind`, so one PTY's IO error/panic never
//! tears down the daemon or its siblings.
//!
//! Exit ordering (design P13): on child exit the reader drains + JOINS the
//! coalescer (`close_and_join`) BEFORE emitting the `Exit` frame, so `Exit` can
//! never overtake the session's last `Data`.

use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use grove_core::daemon::framing::{ExitStatus as FrameExit, StreamFrame};
use grove_core::pty::{append_scrollback_capped, OutputCoalescer, PtyWriter};
use grove_core::PtyEventSink;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::checkpointer::{CheckpointSource, PendingTake};
use crate::emulator::{DaemonEmulator, DaemonSnapshot, SnapshotOptions, DEFAULT_SCROLLBACK_LINES};
use crate::history::HistoryRecord;
use crate::lock;
use crate::server::{SessionReaper, StreamHub};

/// End-to-end deadline for one input write (design G3, mirrors grove-core).
const WRITE_DEADLINE: Duration = Duration::from_secs(30);
/// Raw scrollback ring cap (design G4; grove's 256 KiB default, configurable
/// later per §8.X).
const RING_CAP_BYTES: usize = 256 * 1024;
/// Force-dispose timer after a graceful kill (orca session.ts KILL_TIMEOUT_MS).
const KILL_FORCE_TIMEOUT: Duration = Duration::from_secs(5);
/// Pending-output overflow cap (design S4): past this the accumulated records are
/// dropped and `overflowed` is flagged, forcing the checkpointer to take a full
/// snapshot instead of an incremental append.
const PENDING_OUTPUT_MAX_BYTES: usize = 2 * 1024 * 1024;
/// Coalesce trailing `Output` records under this segment cap (design S4) so a
/// long burst becomes a few large records instead of thousands of tiny ones.
const PENDING_SEGMENT_CAP: usize = 64 * 1024;

struct Ring {
    buf: VecDeque<u8>,
    truncated: bool,
}

/// Accumulated output records drained by the checkpointer's incremental append
/// (design S2/S4). Populated on the reader tee + on resize ONLY while history is
/// enabled — in stage 1 the checkpointer is not wired to sessions, so this stays
/// inert (zero extra work/memory) until stage 2 calls [`Session::enable_history`].
#[derive(Default)]
struct PendingOutput {
    records: Vec<HistoryRecord>,
    bytes: usize,
    overflowed: bool,
}

impl PendingOutput {
    /// Append raw output, coalescing into a trailing `Output` record under the
    /// segment cap. On exceeding the 2 MB total cap, drop everything and flag
    /// overflow (design S4) — the next take forces a full snapshot.
    fn push_output(&mut self, data: &[u8]) {
        if self.overflowed {
            return;
        }
        self.bytes += data.len();
        if self.bytes > PENDING_OUTPUT_MAX_BYTES {
            self.records.clear();
            self.bytes = 0;
            self.overflowed = true;
            return;
        }
        if let Some(HistoryRecord::Output(last)) = self.records.last_mut() {
            if last.len() < PENDING_SEGMENT_CAP {
                last.extend_from_slice(data);
                return;
            }
        }
        self.records.push(HistoryRecord::Output(data.to_vec()));
    }

    fn push_record(&mut self, record: HistoryRecord) {
        if self.overflowed {
            return;
        }
        // Non-output records count a small fixed weight toward the cap.
        self.bytes += 8;
        self.records.push(record);
    }

    fn take(&mut self) -> PendingTake {
        let records = std::mem::take(&mut self.records);
        let overflowed = self.overflowed;
        self.bytes = 0;
        self.overflowed = false;
        PendingTake { records, overflowed }
    }
}

/// The stream sink: each coalesced output batch becomes one `Data` frame pushed
/// into the stream hub in read order. `seq` is the session's absolute output
/// sequence (design S3); it advances by batch byte length so consecutive frames
/// are strictly non-decreasing and an `Exit` frame can repeat the final value.
///
/// NOTE (design S3/P12, OVERLAY 2.5): seq is BYTE-counted and stays that way.
/// The earlier UTF-16-code-unit plan was amended out — bytes are grove's
/// canonical stream unit across the ring, coalescer, and gap reconciliation, so
/// every layer counts the same thing with no cross-unit conversion.
struct StreamSink {
    session_id: String,
    hub: StreamHub,
    seq: Arc<AtomicU64>,
}

impl PtyEventSink for StreamSink {
    fn on_output(&self, _pty_id: &str, data: &[u8]) {
        // Why bytes (OVERLAY 2.5): bytes are grove's canonical stream unit; the
        // seq advances by this batch's byte length so every layer counts alike.
        let total = self.seq.fetch_add(data.len() as u64, Ordering::SeqCst) + data.len() as u64;
        let frame = StreamFrame::data(self.session_id.clone(), total, data.to_vec());
        if let Ok(bytes) = frame.to_bytes() {
            self.hub.emit(bytes);
        }
    }
}

pub struct Session {
    pub id: String,
    /// `Option` so the kill watchdog can `take()` and drop the master fd to force
    /// the reader loop to EOF if a graceful kill doesn't land in time.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    /// FIFO input channel drained by a dedicated per-session std thread (fix #1).
    /// Notifies enqueue here in receive order; the forwarder thread calls the
    /// blocking `PtyWriter::write` off any tokio worker, preserving write order.
    write_tx: mpsc::Sender<Vec<u8>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// Byte-exact raw ring (design G4): authoritative for cold restore AND the
    /// degraded fallback source when the emulator is poisoned.
    ring: Mutex<Ring>,
    /// The daemon-side VT emulator (design P5). `Option` so a vt100 panic can
    /// `take()` it — poisoning the emulator MUST NOT kill the session; the ring
    /// keeps working and the snapshot degrades to the raw ring tail.
    emulator: Mutex<Option<DaemonEmulator>>,
    /// Set once the emulator has been dropped after a panic in its write/serialize
    /// path (design L11/G5). A fast pre-check so the hot read loop skips the lock.
    emulator_poisoned: AtomicBool,
    /// DELIVERED byte counter shared with `StreamSink`: advanced at coalescer
    /// flush time, so each `Data` frame's seq is its cumulative delivered byte
    /// offset. The `Exit` frame repeats the final value (design S3/P13).
    seq: Arc<AtomicU64>,
    /// INGESTION byte counter (design FIX 2 / S3): advanced in the reader-thread
    /// tee, on the SAME thread and chunk as `feed_emulator`, so a snapshot taken
    /// right after ingestion stamps an `output_sequence` that is exactly
    /// consistent with the emulator content it just serialized — no coalescer lag.
    /// It counts the identical byte stream as `seq`; a `Data` frame's delivered
    /// seq therefore equals the ingestion value at the moment those bytes were
    /// ingested, so a client reconciles snapshot⇄stream on one byte axis.
    ingest_seq: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    /// Guards against emitting two `Exit` frames (reader EOF racing a kill).
    exit_emitted: Arc<AtomicBool>,
    applied: Mutex<(u16, u16)>,
    /// Pending output drained by the checkpointer's incremental append (design
    /// S2/S4). Only populated while `history_enabled` is set (stage 2).
    pending: Mutex<PendingOutput>,
    /// Gates pending-output accumulation. Default false so the tee stays exactly
    /// as before until stage 2 wires the checkpointer and calls `enable_history`
    /// — no memory or work is spent on history in stage 1.
    history_enabled: AtomicBool,
    /// Removes this session from the daemon's map on reader exit (fix #3), so a
    /// dead session never leaks its master fd or lingers as a zombie map entry.
    reaper: SessionReaper,
}

enum ReadStep {
    Continue,
    Stop,
}

impl Session {
    /// Spawn a fresh PTY session running the user's shell in `cwd`.
    pub fn spawn(
        id: String,
        cwd: &str,
        cols: u16,
        rows: u16,
        env: &[(String, String)],
        hub: StreamHub,
        reaper: SessionReaper,
    ) -> Result<Arc<Session>, String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);
        // Why: portable_pty does not inherit the parent env by default; seed the
        // current process env so the shell has PATH/HOME, then advertise a real
        // terminal, then let the caller's requested env override.
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        for (k, v) in env {
            cmd.env(k, v);
        }

        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        // Why: dropping the slave here (post-spawn) mirrors grove-core; the child
        // holds its own slave fd, and keeping ours open would wedge EOF detection.
        drop(pair.slave);

        let seq = Arc::new(AtomicU64::new(0));
        let sink: Arc<dyn PtyEventSink> = Arc::new(StreamSink {
            session_id: id.clone(),
            hub: hub.clone(),
            seq: Arc::clone(&seq),
        });
        let coalescer = OutputCoalescer::new(sink, id.clone());
        let writer_handle = PtyWriter::spawn_input_only(writer, WRITE_DEADLINE);

        // Fix #1: a dedicated per-session forwarder thread drains queued writes in
        // strict receive order and calls the blocking `PtyWriter::write`. Because
        // exactly ONE thread performs the enqueue-under-lock, two writes can never
        // invert their `PtyWriter` FIFO position the way two racing `spawn_blocking`
        // tasks could — and no tokio worker is ever blocked on a 30s deadline.
        let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>();
        let forwarder_writer = Arc::clone(&writer_handle);
        std::thread::Builder::new()
            .name(format!("grove-daemon-writer-{id}"))
            .spawn(move || {
                // Exits when the Session (hence `write_tx`) is dropped and the
                // channel closes; holds no `Arc<Session>`, so it forms no cycle.
                while let Ok(data) = write_rx.recv() {
                    let _ = forwarder_writer.write(&data);
                }
            })
            .map_err(|e| e.to_string())?;

        let session = Arc::new(Session {
            id: id.clone(),
            master: Mutex::new(Some(pair.master)),
            write_tx,
            child: Mutex::new(child),
            ring: Mutex::new(Ring {
                buf: VecDeque::new(),
                truncated: false,
            }),
            emulator: Mutex::new(Some(DaemonEmulator::new(rows, cols, DEFAULT_SCROLLBACK_LINES))),
            emulator_poisoned: AtomicBool::new(false),
            seq,
            ingest_seq: Arc::new(AtomicU64::new(0)),
            alive: Arc::new(AtomicBool::new(true)),
            exit_emitted: Arc::new(AtomicBool::new(false)),
            applied: Mutex::new((cols, rows)),
            pending: Mutex::new(PendingOutput::default()),
            history_enabled: AtomicBool::new(false),
            reaper,
        });

        let reader_session = Arc::clone(&session);
        std::thread::Builder::new()
            .name(format!("grove-daemon-reader-{id}"))
            .spawn(move || run_reader(reader, coalescer, reader_session, hub))
            .map_err(|e| e.to_string())?;

        Ok(session)
    }

    fn append_ring(&self, chunk: &[u8]) {
        let mut ring = lock(&self.ring);
        let Ring { buf, truncated } = &mut *ring;
        append_scrollback_capped(buf, truncated, chunk, RING_CAP_BYTES);
    }

    /// The raw ring contents (design G4) — the degraded snapshot source used when
    /// the emulator is poisoned, and the byte-exact cold-restore source.
    pub fn ring_tail(&self) -> Vec<u8> {
        let ring = lock(&self.ring);
        ring.buf.iter().copied().collect()
    }

    /// The reader-thread byte tee (design P5 item 2 / FIX 2): the SAME bytes feed
    /// the byte-exact raw ring (cold source) and the emulator (warm VT snapshot),
    /// then advance the ingestion counter — all on this thread, for one chunk. A
    /// snapshot taken immediately after therefore reflects exactly these bytes in
    /// BOTH its content and its `output_sequence` (no coalescer lag). The
    /// coalescer→stream push stays in the reader loop after this returns.
    fn tee(&self, chunk: &[u8]) {
        self.append_ring(chunk);
        self.feed_emulator(chunk);
        // History accumulation (design S2/S4) — inert until stage 2 enables it.
        if self.history_enabled.load(Ordering::Relaxed) {
            lock(&self.pending).push_output(chunk);
            // Fix F2: mark the session dirty so the 5s tick actually persists this
            // output. NOTHING else calls `mark_dirty` on output — without this the
            // checkpointer only fires at open/register/reopen, so after the first
            // anchor the incremental log + periodic checkpoint never run again and
            // crash loss is UNBOUNDED (not the intended ≤5s). Gated on
            // `history_enabled` so the stage-1 inert property survives. The pending
            // lock is released before this call (no cross-lock hold).
            self.reaper.mark_dirty(&self.id);
        }
        // Advance AFTER feed_emulator so the counter never leads the emulator
        // content a concurrent snapshot would serialize.
        self.ingest_seq
            .fetch_add(chunk.len() as u64, Ordering::SeqCst);
    }

    /// Enable pending-output accumulation for the checkpointer (design S2/S4).
    /// Called by stage 2 when the session is registered with the checkpointer;
    /// until then the tee does no history work.
    pub fn enable_history(&self) {
        self.history_enabled.store(true, Ordering::SeqCst);
    }

    /// Drain the pending output for one incremental append (design S2/S4).
    pub fn take_pending_output(&self) -> PendingTake {
        lock(&self.pending).take()
    }

    /// Feed the emulator under per-write panic isolation (design P5 item 2 /
    /// L11 / G5). A vt100 panic drops the emulator and marks it poisoned; the
    /// ring already captured the same bytes, so the session streams on and the
    /// next snapshot falls back to the ring tail.
    fn feed_emulator(&self, chunk: &[u8]) {
        if self.emulator_poisoned.load(Ordering::Relaxed) {
            return;
        }
        let mut guard = lock(&self.emulator);
        let Some(emu) = guard.as_mut() else {
            return;
        };
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emu.process(chunk)));
        if outcome.is_err() {
            *guard = None;
            self.emulator_poisoned.store(true, Ordering::SeqCst);
        }
    }

    /// Serialize a warm-reattach snapshot (design S6/S9/S15). Returns `None` when
    /// the emulator is poisoned/absent — the caller then falls back to the ring
    /// tail. `output_sequence` is stamped from the session's own byte counter so
    /// the snapshot and stream `Data` frames share one seq origin (design S3).
    pub fn snapshot(&self, opts: SnapshotOptions) -> Option<DaemonSnapshot> {
        // Stamp from the INGESTION counter (design FIX 2): it reflects the bytes
        // the emulator has actually processed, so the snapshot content and its
        // output_sequence are consistent — unlike the delivered `seq`, which lags
        // behind by whatever the coalescer has yet to flush.
        let seq = self.ingest_seq.load(Ordering::SeqCst);
        let mut guard = lock(&self.emulator);
        let emu = guard.as_ref()?;
        let outcome =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emu.snapshot(opts, seq)));
        match outcome {
            Ok(snap) => Some(snap),
            Err(_) => {
                // A panic while serializing poisons the emulator just like a bad
                // write does; degrade to the ring tail on the next snapshot.
                *guard = None;
                self.emulator_poisoned.store(true, Ordering::SeqCst);
                None
            }
        }
    }

    pub fn cwd(&self) -> Option<String> {
        lock(&self.emulator).as_ref().and_then(DaemonEmulator::cwd)
    }

    pub fn title(&self) -> Option<String> {
        lock(&self.emulator).as_ref().and_then(DaemonEmulator::title)
    }

    /// The absolute ingestion sequence (design FIX 2): total bytes teed into the
    /// ring + emulator. The degraded (poisoned-emulator) snapshot path stamps its
    /// `outputSequence` from this, staying consistent with the ring tail it serves
    /// (the ring is fed on the same tee).
    pub fn output_sequence(&self) -> u64 {
        self.ingest_seq.load(Ordering::SeqCst)
    }

    /// Simulate a post-panic poisoned emulator (design L11/G5). A real vt100
    /// panic is not deterministically triggerable from bytes, so tests use this
    /// to drive the degradation path: drop the emulator + set the poison flag,
    /// exactly as `feed_emulator`/`snapshot` do on a caught unwind.
    #[cfg(test)]
    pub fn test_poison_emulator(&self) {
        *lock(&self.emulator) = None;
        self.emulator_poisoned.store(true, Ordering::SeqCst);
    }

    /// Simulate reader-thread teardown (design FIX 5 test hook): mark the session
    /// dead and drop the master fd, exactly as `run_reader` does on EOF. A real
    /// child exit is not deterministically timed from a unit test, so this drives
    /// the "resize on a dead session is skipped" path.
    #[cfg(test)]
    pub fn test_mark_dead(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = lock(&self.master).take();
    }

    /// Drive the reader-thread tee directly (design FIX 2 test hook): the same
    /// ring + emulator + ingestion-seq advance `run_reader` performs, minus the
    /// coalescer push. A snapshot taken right after is a synchronous barrier —
    /// no PTY/coalescer timing to wait on.
    #[cfg(test)]
    pub fn test_tee(&self, chunk: &[u8]) {
        self.tee(chunk);
    }

    /// Enqueue input in strict FIFO order (design G3, fix #1). Returns
    /// immediately: the bytes are handed to the per-session forwarder thread,
    /// which performs the blocking `PtyWriter::write` off the tokio runtime. The
    /// single-consumer channel guarantees write order == enqueue (notify-receive)
    /// order. A send error means the session was already torn down; drop silently.
    pub fn enqueue_write(&self, data: &[u8]) {
        let _ = self.write_tx.send(data.to_vec());
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        // Ordering (design G8 / FIX 5): apply the size to the SUBPROCESS first and
        // advance the emulator/`applied` dims ONLY after that succeeds on a LIVE
        // session. A dead session, a taken master, or a failed `master.resize`
        // therefore leaves `applied_size` at its prior value — a readback never
        // reports a size the child never actually took.
        if !self.is_alive() {
            return Ok(());
        }
        {
            let guard = lock(&self.master);
            let Some(master) = guard.as_ref() else {
                // Master already taken (teardown) — skip; dims stay unchanged.
                return Ok(());
            };
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
        }
        // The kernel accepted the new PTY size: now advance the daemon-side dims.
        if let Some(emu) = lock(&self.emulator).as_mut() {
            emu.resize(cols, rows);
        }
        *lock(&self.applied) = (cols, rows);
        // Record the resize for the incremental log (design D4) — inert until
        // stage 2 enables history. Ordered relative to output records so cold
        // restore re-sizes the scratch vt100 at the right point.
        if self.history_enabled.load(Ordering::Relaxed) {
            lock(&self.pending).push_record(HistoryRecord::Resize { cols, rows });
            // Fix F2: a resize is persistable state too — mark dirty so the tick
            // appends the Resize record (cold restore re-sizes the scratch vt100 at
            // the right point). Same wiring as the output tee.
            self.reaper.mark_dirty(&self.id);
        }
        Ok(())
    }

    /// The size last applied to the PTY (design G8 — daemon-owned, no tmux
    /// shell-out). Read from the emulator dims (advanced atomically in `resize`
    /// before the subprocess); falls back to the mirrored `applied` tuple when
    /// the emulator is poisoned.
    pub fn applied_size(&self) -> (u16, u16) {
        if let Some(emu) = lock(&self.emulator).as_ref() {
            return emu.applied_size();
        }
        *lock(&self.applied)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Kill the session's child, then arm a 5s force-dispose watchdog that drops
    /// the master fd if the child hasn't died — so a wedged child can never keep
    /// the session (and its reader thread) alive forever.
    pub fn kill(session: &Arc<Session>) {
        {
            let mut child = lock(&session.child);
            let _ = child.kill();
        }
        let watch = Arc::clone(session);
        std::thread::spawn(move || {
            std::thread::sleep(KILL_FORCE_TIMEOUT);
            if watch.alive.load(Ordering::SeqCst) {
                // Force-dispose: a second kill, then drop the master fd so the
                // blocked reader unblocks with EOF and emits the Exit frame.
                {
                    let mut child = lock(&watch.child);
                    let _ = child.kill();
                }
                let _ = lock(&watch.master).take();
            }
        });
    }

    /// Emit the ordered `Exit` frame and return the child's exit code (for the
    /// history `ended_at` stamp, design D2). Returns `None` when a prior kill/EOF
    /// already emitted the Exit (only the first caller wins) or the code is
    /// unavailable.
    fn emit_exit(&self, hub: &StreamHub) -> Option<i32> {
        // Why: reader EOF and a kill can both reach here; only the first wins so
        // the stream never carries a duplicate Exit.
        if self.exit_emitted.swap(true, Ordering::SeqCst) {
            return None;
        }
        let status = {
            let mut child = lock(&self.child);
            match child.wait() {
                Ok(s) => FrameExit {
                    code: Some(s.exit_code() as i32),
                    signal: None,
                },
                Err(_) => FrameExit {
                    code: None,
                    signal: None,
                },
            }
        };
        let code = status.code;
        let seq = self.seq.load(Ordering::SeqCst);
        let frame = StreamFrame::exit(self.id.clone(), seq, &status);
        if let Ok(bytes) = frame.to_bytes() {
            hub.emit(bytes);
        }
        code
    }

    /// A trivial spawn+exit probe (design L3 `checkPtySpawnHealth`): confirms the
    /// daemon can still open a PTY and reap a child in this environment.
    pub fn probe_spawn_health() -> bool {
        let sys = native_pty_system();
        let pair = match sys.openpty(PtySize {
            rows: 2,
            cols: 8,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(p) => p,
            Err(_) => return false,
        };
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("exit 0");
        let mut child = match pair.slave.spawn_command(cmd) {
            Ok(c) => c,
            Err(_) => return false,
        };
        drop(pair.slave);
        let ok = matches!(child.wait(), Ok(status) if status.success());
        drop(pair.master);
        ok
    }
}

/// The checkpointer reads a live session through this trait (design D8/S2/S4).
/// All reads are the session's own cheap, isolated accessors; the disk write
/// happens off-thread in the checkpointer. `Arc<Session>` unsizes to
/// `Arc<dyn CheckpointSource>` for the registry. Implemented on `Session` (not
/// `Arc<Session>`) so the inherent `Session::snapshot(opts)` still wins method
/// resolution — the trait's zero-arg `snapshot()` would otherwise shadow it. All
/// bodies name the inherent methods explicitly to avoid any self-recursion.
/// Stage 2 registers the session and calls `enable_history` to start the tee.
impl CheckpointSource for Session {
    fn session_id(&self) -> String {
        self.id.clone()
    }
    fn is_alive(&self) -> bool {
        Session::is_alive(self)
    }
    fn applied_size(&self) -> (u16, u16) {
        Session::applied_size(self)
    }
    fn ring_tail(&self) -> Vec<u8> {
        Session::ring_tail(self)
    }
    fn snapshot(&self) -> Option<DaemonSnapshot> {
        Session::snapshot(self, SnapshotOptions::default())
    }
    fn take_pending(&self) -> PendingTake {
        Session::take_pending_output(self)
    }
    fn output_sequence(&self) -> u64 {
        Session::output_sequence(self)
    }
    fn cwd(&self) -> Option<String> {
        Session::cwd(self)
    }
}

fn run_reader(
    mut reader: Box<dyn Read + Send>,
    coalescer: OutputCoalescer,
    session: Arc<Session>,
    hub: StreamHub,
) {
    let mut buf = [0u8; 4096];
    loop {
        // Why (design L11): a panic anywhere in the read path must never escape
        // this detached thread and take down siblings. catch_unwind contains it;
        // the coalescer is still drained + Exit still emitted below.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match reader.read(&mut buf) {
                Ok(0) => ReadStep::Stop,
                Ok(n) => {
                    // Byte tee (design P5 item 2 / FIX 2): the SAME bytes feed the
                    // byte-exact raw ring (cold source), the emulator (warm VT
                    // snapshot), and advance the ingestion seq — all in `tee`, on
                    // this thread and chunk — then the coalescer→stream. The
                    // emulator write is isolated so a vt100 panic degrades, never
                    // kills.
                    session.tee(&buf[..n]);
                    coalescer.push(&buf[..n]);
                    ReadStep::Continue
                }
                Err(_) => ReadStep::Stop,
            }
        }));
        match outcome {
            Ok(ReadStep::Continue) => continue,
            Ok(ReadStep::Stop) => break,
            Err(_) => break,
        }
    }
    session.alive.store(false, Ordering::SeqCst);
    // Ordering barrier (design P13): join the sole flusher so the final Data
    // batch has reached the hub BEFORE the Exit frame is enqueued.
    coalescer.close_and_join();
    let exit_code = session.emit_exit(&hub);
    // Fix #3: the session is dead — drop the master fd so it can't leak, then
    // remove ourselves from the daemon's map. Ordering: this runs AFTER the Exit
    // barrier above, and the reaper only removes the entry if it still points at
    // THIS Session (Arc identity), so a same-id session created in the race
    // window is never clobbered.
    let _ = lock(&session.master).take();
    // Child self-exit is a clean teardown (design D2 teardown table): stamp
    // ended_at so a cleanly-ended session is cold-restore INELIGIBLE (it exited by
    // its own process, not a crash), then reap from the daemon's session map.
    session.reaper.close_history(&session.id, exit_code);
    session.reaper.reap(&session.id, &session);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emulator::SnapshotOptions;
    use crate::server::{SessionReaper, StreamHub};

    fn spawn_test_session() -> Arc<Session> {
        Session::spawn(
            "test-sess".to_string(),
            ".",
            80,
            24,
            &[],
            StreamHub::default(),
            SessionReaper::dangling(),
        )
        .expect("spawn test session")
    }

    #[test]
    fn byte_tee_feeds_both_ring_and_emulator() {
        let session = spawn_test_session();
        // Drive the tee directly (deterministic; no dependency on shell timing).
        session.append_ring(b"HELLO-RING");
        session.feed_emulator(b"HELLO-RING");

        let snap = session
            .snapshot(SnapshotOptions::default())
            .expect("emulator snapshot");
        assert!(
            String::from_utf8_lossy(&snap.scrollback_ansi).contains("HELLO-RING"),
            "emulator did not capture teed bytes"
        );
        assert!(
            session.ring_tail().windows(10).any(|w| w == b"HELLO-RING"),
            "ring did not capture teed bytes"
        );
        Session::kill(&session);
    }

    #[test]
    fn emulator_poisoned_degrades_to_ring_tail() {
        let session = spawn_test_session();
        session.append_ring(b"COLD-SOURCE-BYTES");
        session.feed_emulator(b"COLD-SOURCE-BYTES");

        // Healthy: snapshot serves from the emulator.
        assert!(session.snapshot(SnapshotOptions::default()).is_some());

        // Poison the emulator (simulated caught panic). The session must NOT die.
        session.test_poison_emulator();
        assert!(session.is_alive(), "poisoning the emulator killed the session");

        // Snapshot now degrades to None → callers fall back to the ring tail,
        // which still holds the byte-exact bytes.
        assert!(session.snapshot(SnapshotOptions::default()).is_none());
        assert!(
            session
                .ring_tail()
                .windows(17)
                .any(|w| w == b"COLD-SOURCE-BYTES"),
            "ring tail lost the cold-restore bytes after poisoning"
        );

        // A further feed on a poisoned emulator is a no-op (no panic, no revive).
        session.feed_emulator(b"MORE");
        assert!(session.snapshot(SnapshotOptions::default()).is_none());
        Session::kill(&session);
    }

    #[test]
    fn resize_advances_emulator_dims_before_readback() {
        let session = spawn_test_session();
        assert_eq!(session.applied_size(), (80, 24));
        session.resize(120, 40).expect("resize");
        // getAppliedSize reads the emulator dims advanced inside resize (design G8).
        assert_eq!(session.applied_size(), (120, 40));
        Session::kill(&session);
    }

    #[test]
    fn resize_on_dead_session_leaves_applied_size_unchanged() {
        // Design FIX 5: a skipped resize (dead session / taken master) must NOT
        // advance applied_size — a readback never reports a size the child never
        // took.
        let session = spawn_test_session();
        session.resize(120, 40).expect("live resize");
        assert_eq!(session.applied_size(), (120, 40));

        // Tear the session down, then attempt a resize: it is skipped.
        session.test_mark_dead();
        session.resize(200, 50).expect("skipped resize is not an error");
        assert_eq!(
            session.applied_size(),
            (120, 40),
            "skipped resize must leave applied_size at the prior value"
        );
    }

    #[test]
    fn snapshot_output_sequence_equals_bytes_ingested() {
        // Design FIX 2: the snapshot's output_sequence is stamped from the
        // ingestion counter advanced in the tee, so a snapshot taken immediately
        // after ingesting a marker reports exactly the bytes ingested — with no
        // coalescer lag. `test_tee` is the synchronous barrier.
        let session = spawn_test_session();
        assert_eq!(session.output_sequence(), 0);

        let marker = b"MARKER-BYTES-1234";
        session.test_tee(marker);
        assert_eq!(session.output_sequence(), marker.len() as u64);

        let snap = session
            .snapshot(SnapshotOptions::default())
            .expect("emulator snapshot");
        assert_eq!(
            snap.output_sequence,
            marker.len() as u64,
            "snapshot output_sequence must equal total bytes ingested"
        );

        // A second tee advances it cumulatively, still in lockstep.
        let more = b"MORE";
        session.test_tee(more);
        assert_eq!(
            session.output_sequence(),
            (marker.len() + more.len()) as u64
        );
        Session::kill(&session);
    }
}
