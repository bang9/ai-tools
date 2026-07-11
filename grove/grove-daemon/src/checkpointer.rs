//! The 5s dirty-tracked checkpoint tick (design D8/D7, L7, fix #18).
//!
//! The checkpointer drives [`crate::history`]: on a 5s cadence it appends each
//! DIRTY session's new output to the incremental log, or takes a full snapshot
//! when a session needs re-anchoring or the log is at cap. It owns the
//! per-session [`HistoryWriter`]s and a dedicated tokio wake loop so IDLE
//! sessions never wake work (design D8). The final flush on client-disconnect /
//! app-quit covers EVERY live session and AWAITS any in-flight tick (design L7 /
//! fix #18) so a shell opened seconds before quit still gets a checkpoint.
//!
//! Stage-1 scope: this module is wired into the crate but the server does NOT
//! start the tick from its attach paths yet (stage 2 does). It is driven
//! directly by unit tests via [`Checkpointer::tick`] / [`Checkpointer::flush_all`].
//!
//! The write source is the [`CheckpointSource`] trait so the tick is testable
//! against a fake without a live PTY; `Arc<Session>` implements it (design S2/S4:
//! the session accumulates pending output that the tick drains).

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::Notify;

use crate::emulator::DaemonSnapshot;
use crate::history::{
    AppendOutcome, Checkpoint, HistoryRecord, HistoryWriter, LockError, SessionMeta,
};
use crate::lock;

/// The 5s checkpoint cadence (design D8).
pub const TICK_INTERVAL: Duration = Duration::from_secs(5);

/// The drained pending output of a session (design S2/S4): the records to append
/// to the incremental log, plus `overflowed` — set when the pending buffer blew
/// its cap and dropped records, forcing a full re-anchor snapshot instead.
#[derive(Debug, Default)]
pub struct PendingTake {
    pub records: Vec<HistoryRecord>,
    pub overflowed: bool,
}

/// The data a checkpointer reads from a session to persist it. Kept minimal so a
/// unit test can supply a fake; `Arc<Session>` implements it. All reads are
/// synchronous and cheap (they lock the session's emulator/ring briefly); the
/// disk write happens off this thread (`spawn_blocking`, design D3/D8).
pub trait CheckpointSource: Send + Sync {
    fn session_id(&self) -> String;
    fn is_alive(&self) -> bool;
    fn applied_size(&self) -> (u16, u16);
    /// The byte-exact RAW ring (design G4/contract 4): `checkpoint.scrollback_ansi`.
    fn ring_tail(&self) -> Vec<u8>;
    /// The emulator's warm snapshot, or `None` when the emulator is poisoned
    /// (design L11) — the checkpoint then degrades to the raw ring alone.
    fn snapshot(&self) -> Option<DaemonSnapshot>;
    /// Drain the pending output accumulated since the last take (design S2/S4).
    fn take_pending(&self) -> PendingTake;
    fn output_sequence(&self) -> u64;
    fn cwd(&self) -> Option<String>;
}

/// Build a full checkpoint from a source (design D3/contract 4). `scrollback_ansi`
/// is always the RAW ring (byte-exact); the emulator snapshot supplies the
/// alt body + modes. On a poisoned emulator (`snapshot() == None`) the checkpoint
/// degrades to the raw ring with default modes.
fn build_checkpoint(source: &dyn CheckpointSource) -> Checkpoint {
    let scrollback_ansi = source.ring_tail();
    match source.snapshot() {
        Some(snap) => Checkpoint {
            snapshot_ansi: snap.snapshot_ansi,
            scrollback_ansi,
            rehydrate_sequences: snap.rehydrate_sequences,
            pending_escape_tail: snap.pending_escape_tail,
            cwd: snap.cwd.or_else(|| source.cwd()),
            cols: snap.cols,
            rows: snap.rows,
            is_alternate_screen: snap.is_alternate_screen,
            kitty_keyboard_flags: snap.kitty_keyboard_flags,
            last_title: snap.title,
            scrollback_seq: snap.output_sequence,
            generation: 0, // set by HistoryWriter::checkpoint
            checkpointed_at_ms: 0,
        },
        None => {
            let (cols, rows) = source.applied_size();
            Checkpoint {
                snapshot_ansi: Vec::new(),
                scrollback_ansi,
                rehydrate_sequences: Vec::new(),
                pending_escape_tail: Vec::new(),
                cwd: source.cwd(),
                cols,
                rows,
                is_alternate_screen: false,
                kitty_keyboard_flags: 0,
                last_title: None,
                scrollback_seq: source.output_sequence(),
                generation: 0,
                checkpointed_at_ms: 0,
            }
        }
    }
}

/// The cloned handles a tick/flush needs after releasing the registry lock:
/// (source, writer, in-flight guard).
type SessionHandles = (
    Arc<dyn CheckpointSource>,
    Arc<Mutex<HistoryWriter>>,
    Arc<AsyncMutex<()>>,
);

/// One registered session: its source + writer + an in-flight guard. The
/// `inflight` async mutex is held for the duration of a disk write, so a tick
/// `try_lock`s it (skip if a write is in progress) and the final flush
/// `lock().await`s it (fix #18: await the in-flight tick before the final write).
struct Entry {
    source: Arc<dyn CheckpointSource>,
    writer: Arc<Mutex<HistoryWriter>>,
    inflight: Arc<AsyncMutex<()>>,
}

impl Entry {
    fn clone_handles(&self) -> SessionHandles {
        (
            Arc::clone(&self.source),
            Arc::clone(&self.writer),
            Arc::clone(&self.inflight),
        )
    }
}

/// The outcome of persisting one session in a tick (fix F5): steers whether the
/// tick clears the dirty flag, retries, or disables history for the session.
enum PersistOutcome {
    /// Wrote successfully (or had nothing to write): the tick may clear dirty.
    Ok,
    /// A write FAILED after `take_pending` already drained the records. The lost
    /// records still live in the ring/emulator, so a full re-anchor subsumes them
    /// (design D7): the writer's re-anchor flag is set and the session is kept
    /// dirty so the next tick retries. NEVER silently clear dirty here — that would
    /// splice an undetectable hole into the seq-consistent log.
    Retry,
    /// Even the full anchor failed: history is disabled for this session (orca
    /// `handleWriteError` parity) — the tick drops it from the registry, logged.
    /// The session keeps STREAMING; only persistence stops.
    Disabled,
}

/// Drives periodic + final checkpoints for all daemon sessions (design D8/L7).
pub struct Checkpointer {
    root: PathBuf,
    sessions: Mutex<HashMap<String, Entry>>,
    /// Dirty version per session (design D8): `mark_dirty` bumps it; the tick only
    /// clears a session's dirty flag if its version is unchanged after the write,
    /// so output arriving mid-write is not lost.
    dirty: Mutex<HashMap<String, u64>>,
    /// Wakes the run loop when a session becomes dirty — idle sessions never wake
    /// work (design D8).
    dirty_notify: Notify,
    /// The `run` loop's periodic cadence (design D8, default [`TICK_INTERVAL`]).
    /// Overridable via [`Checkpointer::new_with_tick`] so tests exercise the real
    /// run loop without a 5s wall-clock wait.
    tick_interval: Duration,
}

impl Checkpointer {
    pub fn new(root: impl Into<PathBuf>) -> Arc<Self> {
        Self::new_with_tick_interval(root, TICK_INTERVAL)
    }

    /// A checkpointer with a custom `run` cadence — test-only so the wiring test
    /// (fix F2) can drive the real run loop in milliseconds instead of 5s.
    #[cfg(test)]
    pub fn new_with_tick(root: impl Into<PathBuf>, tick_interval: Duration) -> Arc<Self> {
        Self::new_with_tick_interval(root, tick_interval)
    }

    fn new_with_tick_interval(root: impl Into<PathBuf>, tick_interval: Duration) -> Arc<Self> {
        Arc::new(Self {
            root: root.into(),
            sessions: Mutex::new(HashMap::new()),
            dirty: Mutex::new(HashMap::new()),
            dirty_notify: Notify::new(),
            tick_interval,
        })
    }

    /// Register a GENUINELY NEW session (design D9): open a writer that unlinks
    /// stale files and writes fresh meta. Marks it dirty so the first tick writes
    /// its anchor checkpoint. `OwnedElsewhere` ⇒ a live owner holds the dir; the
    /// caller must refuse to write and skip cold-restore (design R9).
    pub fn open_session(
        &self,
        source: Arc<dyn CheckpointSource>,
        meta: &SessionMeta,
    ) -> Result<(), LockError> {
        let id = source.session_id();
        let writer = HistoryWriter::open_session(&self.root, &id, meta)?;
        self.insert(id.clone(), source, writer);
        self.mark_dirty(&id);
        Ok(())
    }

    /// Register a warm reattach (design D10): preserve the existing checkpoint/log
    /// and continue appends. Marks dirty so the tick writes the forced full
    /// re-anchor before resuming increments (design D11).
    pub fn register_writer(&self, source: Arc<dyn CheckpointSource>) -> Result<(), LockError> {
        let id = source.session_id();
        let writer = HistoryWriter::register_writer(&self.root, &id)?;
        self.insert(id.clone(), source, writer);
        self.mark_dirty(&id);
        Ok(())
    }

    /// Register a COLD-RESTORE-seeded session (design D10/D11/D12/L12): preserve
    /// the existing session dir (register_writer, NOT open_session — the on-disk
    /// scrollback is the recovery data), then `reopen` to clear `ended_at` so the
    /// fresh session is cold-restorable again and to re-arm the forced full
    /// re-anchor. The first tick writes a fresh full checkpoint at a new
    /// generation, superseding the recovered state the reader already delivered.
    pub fn reopen_session(&self, source: Arc<dyn CheckpointSource>) -> Result<(), LockError> {
        let id = source.session_id();
        let mut writer = HistoryWriter::register_writer(&self.root, &id)?;
        writer.reopen().map_err(LockError::Io)?;
        self.insert(id.clone(), source, writer);
        self.mark_dirty(&id);
        Ok(())
    }

    fn insert(&self, id: String, source: Arc<dyn CheckpointSource>, writer: HistoryWriter) {
        lock(&self.sessions).insert(
            id,
            Entry {
                source,
                writer: Arc::new(Mutex::new(writer)),
                inflight: Arc::new(AsyncMutex::new(())),
            },
        );
    }

    /// Mark a session dirty so the next tick persists it (design D8). Wakes the
    /// run loop. A no-op for an unregistered id.
    pub fn mark_dirty(&self, id: &str) {
        if !lock(&self.sessions).contains_key(id) {
            return;
        }
        let mut dirty = lock(&self.dirty);
        let version = dirty.entry(id.to_string()).or_insert(0);
        *version = version.wrapping_add(1);
        drop(dirty);
        self.dirty_notify.notify_one();
    }

    /// Clean close/exit (design D2 / §9 self-reap): stamp `ended_at`, drop the
    /// session from the registry, release its flock, and REMOVE its whole disk dir.
    /// A cleanly-closed session keeps no history (there is no `keepHistory` concept
    /// this cut — design D2/§9), so its per-session dir is reaped. Contrast
    /// [`Checkpointer::remove_session`] (unclean teardown), which PRESERVES the dir
    /// so the session stays cold-restorable.
    pub fn close_session(&self, id: &str, exit_code: Option<i32>) {
        let entry = lock(&self.sessions).remove(id);
        lock(&self.dirty).remove(id);
        if let Some(entry) = entry {
            // Stamp ended_at first as a safety net (a cleanly-ended session must be
            // cold-restore INELIGIBLE even if the dir removal below fails), then drop
            // the writer to release the `.owner.lock` flock BEFORE removing the dir.
            let _ = lock(&entry.writer).stamp_ended(exit_code);
            drop(entry);
        }
        // Self-reap the disk dir (design §9): a cleanly-closed session leaves no
        // history behind. Best-effort — a missing/locked dir is harmless.
        let _ = std::fs::remove_dir_all(crate::history::session_dir(&self.root, id));
    }

    /// Remove a session without stamping `ended_at` (leaves it cold-restore
    /// eligible — e.g. the daemon is going down uncleanly).
    pub fn remove_session(&self, id: &str) {
        lock(&self.sessions).remove(id);
        lock(&self.dirty).remove(id);
    }

    pub fn session_count(&self) -> usize {
        lock(&self.sessions).len()
    }

    fn dirty_snapshot(&self) -> Vec<(String, u64)> {
        lock(&self.dirty)
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect()
    }

    fn dirty_is_empty(&self) -> bool {
        lock(&self.dirty).is_empty()
    }

    /// Clear a session's dirty flag only if its version is unchanged (design D8):
    /// output that arrived while the write was in flight bumped the version and
    /// must keep the session dirty for the next tick.
    fn clear_dirty_if_unchanged(&self, id: &str, version: u64) {
        let mut dirty = lock(&self.dirty);
        if dirty.get(id) == Some(&version) {
            dirty.remove(id);
        }
    }

    /// One checkpoint pass over the currently-dirty sessions (design D8). A
    /// session whose write is already in flight (its `inflight` guard is held) is
    /// left dirty for the next pass — never an overlapping write to the same tmp
    /// (design D8 in-flight guard).
    pub async fn tick(&self) {
        for (id, version) in self.dirty_snapshot() {
            let entry = lock(&self.sessions).get(&id).map(Entry::clone_handles);
            let Some((source, writer, inflight)) = entry else {
                lock(&self.dirty).remove(&id);
                continue;
            };
            let Ok(_permit) = inflight.try_lock() else {
                continue; // a write is in flight — retry this session next pass.
            };
            match self.persist(&source, &writer, false).await {
                PersistOutcome::Ok => self.clear_dirty_if_unchanged(&id, version),
                // Fix F5: leave the session DIRTY (do not clear) so the next tick
                // retries with a full re-anchor; the run loop keeps ticking while
                // anything is dirty, and the re-anchor subsumes the drained records.
                PersistOutcome::Retry => {}
                // Fix F5: an unrecoverable write failure — stop persisting this
                // session (it keeps streaming) rather than spinning forever.
                PersistOutcome::Disabled => self.remove_session(&id),
            }
        }
    }

    /// Final flush (design L7 / fix #18): a full checkpoint for EVERY registered
    /// session, AWAITING any in-flight tick write first. Used on client-disconnect
    /// / app-quit; the daemon + PTYs keep running so the history stays UNCLEAN
    /// (`ended_at` not stamped) — a crash while the app is closed is still
    /// detected as cold-restorable.
    pub async fn flush_all(&self) {
        let entries: Vec<SessionHandles> =
            lock(&self.sessions).values().map(Entry::clone_handles).collect();
        for (source, writer, inflight) in entries {
            // Await the in-flight tick (fix #18) rather than skipping.
            let _permit = inflight.lock().await;
            // Best-effort on quit: a failed final write is logged inside `persist`;
            // there is no next tick to retry, so the outcome is not acted on here.
            let _ = self.persist(&source, &writer, true).await;
        }
        lock(&self.dirty).clear();
    }

    /// Graceful daemon shutdown (design D2 teardown table): a final checkpoint for
    /// EVERY session (via [`Checkpointer::flush_all`]) AND stamp `ended_at` on each,
    /// making them cold-restore INELIGIBLE. Used by the SIGTERM/SIGINT signal path
    /// and the shutdown ("Restart daemon") RPC. Contrast `flush_all` alone
    /// (client-disconnect / app-quit), which leaves history UNCLEAN so an
    /// unattended crash is still recoverable (design L7).
    pub async fn shutdown_all(&self) {
        self.flush_all().await;
        let ids: Vec<String> = lock(&self.sessions).keys().cloned().collect();
        for id in ids {
            // Stamp ended_at + drop the writer (releases the flock).
            self.close_session(&id, None);
        }
    }

    /// Persist one session (design D7): a full checkpoint when forced (final /
    /// re-anchor / overflow / log-cap), else an incremental append. The disk write
    /// runs off the reactor (`spawn_blocking`, design D3). The caller holds the
    /// session's `inflight` guard.
    async fn persist(
        &self,
        source: &Arc<dyn CheckpointSource>,
        writer: &Arc<Mutex<HistoryWriter>>,
        final_flush: bool,
    ) -> PersistOutcome {
        let needs_full = final_flush || lock(writer).needs_full_anchor();

        if needs_full {
            return self.full_checkpoint_outcome(source, writer).await;
        }

        // Incremental path: drain pending output and append. An overflow (dropped
        // records → a hole in the log) or a log-cap NeedsCheckpoint forces a full
        // re-anchor snapshot, which subsumes the drained records (design D7).
        let take = source.take_pending();
        if take.overflowed {
            return self.full_checkpoint_outcome(source, writer).await;
        }
        if take.records.is_empty() {
            return PersistOutcome::Ok;
        }
        let writer_c = Arc::clone(writer);
        let outcome = tokio::task::spawn_blocking(move || {
            lock(&writer_c).append_increments(&take.records)
        })
        .await;
        match outcome {
            Ok(Ok(AppendOutcome::Appended)) => PersistOutcome::Ok,
            Ok(Ok(AppendOutcome::NeedsCheckpoint)) => {
                // The drained records are already in the emulator/ring, so the
                // full snapshot subsumes them (design D7).
                self.full_checkpoint_outcome(source, writer).await
            }
            Ok(Err(err)) => self.on_append_failure(source, writer, &err.to_string()),
            Err(join) => self.on_append_failure(source, writer, &format!("join: {join}")),
        }
    }

    /// Fix F5: an incremental append failed AFTER `take_pending` drained its
    /// records. Force a full re-anchor (which reconstructs from the ring/emulator,
    /// subsuming the lost records) and signal `Retry` so the tick keeps the session
    /// dirty. Without this the drained records vanish and the dirty flag clears,
    /// leaving a silent, seq-consistent hole no reader can detect.
    fn on_append_failure(
        &self,
        source: &Arc<dyn CheckpointSource>,
        writer: &Arc<Mutex<HistoryWriter>>,
        reason: &str,
    ) -> PersistOutcome {
        lock(writer).force_full_anchor();
        eprintln!(
            "grove-daemon: append for session {} failed ({reason}); re-anchoring next tick",
            source.session_id()
        );
        PersistOutcome::Retry
    }

    /// Run a full checkpoint and map its result to a [`PersistOutcome`] (fix F5):
    /// success → `Ok`; failure → `Disabled` (the dir is unwritable, so history is
    /// turned off for this session rather than retried forever).
    async fn full_checkpoint_outcome(
        &self,
        source: &Arc<dyn CheckpointSource>,
        writer: &Arc<Mutex<HistoryWriter>>,
    ) -> PersistOutcome {
        match self.full_checkpoint(source, writer).await {
            Ok(()) => PersistOutcome::Ok,
            Err(err) => {
                eprintln!(
                    "grove-daemon: full checkpoint for session {} failed ({err}); disabling history",
                    source.session_id()
                );
                PersistOutcome::Disabled
            }
        }
    }

    async fn full_checkpoint(
        &self,
        source: &Arc<dyn CheckpointSource>,
        writer: &Arc<Mutex<HistoryWriter>>,
    ) -> io::Result<()> {
        // Read the (fast) snapshot synchronously, then write durably off-thread.
        let checkpoint = build_checkpoint(source.as_ref());
        let writer_c = Arc::clone(writer);
        match tokio::task::spawn_blocking(move || lock(&writer_c).checkpoint(checkpoint)).await {
            Ok(result) => result,
            Err(join) => Err(io::Error::other(format!("checkpoint join: {join}"))),
        }
    }

    /// The dedicated wake loop (design D8): sleeps until a session is dirty, then
    /// ticks every 5s until nothing is dirty, then sleeps again. Not started by
    /// the server in stage 1 (stage 2 wires it); `shutdown` breaks the loop.
    pub async fn run(self: Arc<Self>, shutdown: Arc<Notify>) {
        loop {
            tokio::select! {
                _ = shutdown.notified() => return,
                _ = self.dirty_notify.notified() => {}
            }
            loop {
                tokio::select! {
                    _ = shutdown.notified() => return,
                    _ = tokio::time::sleep(self.tick_interval) => {}
                }
                self.tick().await;
                if self.dirty_is_empty() {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::Mutex as StdMutex;

    use crate::history::{decode_log, decode_log_header, HistoryReader};

    const OUTPUT_LOG: &str = "output.log";

    fn temp_root() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("grove-ckpt-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A deterministic fake source: a growing raw ring + a pending queue the tick
    /// drains, with a snapshot synthesized from the ring. No PTY / vt100 timing.
    struct FakeSource {
        id: String,
        alive: AtomicBool,
        ring: StdMutex<Vec<u8>>,
        pending: StdMutex<Vec<HistoryRecord>>,
        overflow: AtomicBool,
        seq: AtomicU64,
        /// Counts full-checkpoint reads (each `snapshot()` call) for assertions.
        snapshot_calls: AtomicU64,
        /// Simulate a poisoned emulator (design L11) → `snapshot()` returns None.
        poisoned: AtomicBool,
    }

    impl FakeSource {
        fn new(id: &str) -> Arc<Self> {
            Arc::new(Self {
                id: id.to_string(),
                alive: AtomicBool::new(true),
                ring: StdMutex::new(Vec::new()),
                pending: StdMutex::new(Vec::new()),
                overflow: AtomicBool::new(false),
                seq: AtomicU64::new(0),
                snapshot_calls: AtomicU64::new(0),
                poisoned: AtomicBool::new(false),
            })
        }

        /// Feed output: grows the ring and queues a pending Output record.
        fn feed(&self, bytes: &[u8]) {
            self.ring.lock().unwrap().extend_from_slice(bytes);
            self.pending
                .lock()
                .unwrap()
                .push(HistoryRecord::Output(bytes.to_vec()));
            self.seq.fetch_add(bytes.len() as u64, Ordering::SeqCst);
        }
    }

    impl CheckpointSource for FakeSource {
        fn session_id(&self) -> String {
            self.id.clone()
        }
        fn is_alive(&self) -> bool {
            self.alive.load(Ordering::SeqCst)
        }
        fn applied_size(&self) -> (u16, u16) {
            (80, 24)
        }
        fn ring_tail(&self) -> Vec<u8> {
            self.ring.lock().unwrap().clone()
        }
        fn snapshot(&self) -> Option<DaemonSnapshot> {
            self.snapshot_calls.fetch_add(1, Ordering::SeqCst);
            if self.poisoned.load(Ordering::SeqCst) {
                return None;
            }
            let ring = self.ring.lock().unwrap().clone();
            Some(DaemonSnapshot {
                scrollback_ansi: ring,
                cols: 80,
                rows: 24,
                output_sequence: self.seq.load(Ordering::SeqCst),
                ..Default::default()
            })
        }
        fn take_pending(&self) -> PendingTake {
            let records = std::mem::take(&mut *self.pending.lock().unwrap());
            PendingTake {
                records,
                overflowed: self.overflow.swap(false, Ordering::SeqCst),
            }
        }
        fn output_sequence(&self) -> u64 {
            self.seq.load(Ordering::SeqCst)
        }
        fn cwd(&self) -> Option<String> {
            None
        }
    }

    #[tokio::test]
    async fn first_tick_anchors_then_appends_increments() {
        let root = temp_root();
        let ckpt = Checkpointer::new(&root);
        let src = FakeSource::new("s1");
        src.feed(b"initial output\r\n");
        ckpt.open_session(src.clone() as Arc<dyn CheckpointSource>, &SessionMeta::new(None, 80, 24))
            .expect("open");

        // First tick: forced full anchor (design D11). take_pending is NOT called.
        ckpt.tick().await;
        let dir = crate::history::session_dir(&root, "s1");
        assert!(dir.join("checkpoint.json").exists(), "anchor checkpoint written");
        assert!(ckpt.dirty_is_empty(), "clean session is no longer dirty");

        // More output → dirty again → the next tick appends an increment.
        src.feed(b"more output\r\n");
        ckpt.mark_dirty("s1");
        ckpt.tick().await;

        let log = std::fs::read(dir.join(OUTPUT_LOG)).unwrap();
        let decoded = decode_log(&log).expect("decode log");
        assert_eq!(decoded.batches.len(), 1, "one incremental batch appended");
        assert!(decoded.batches[0]
            .records
            .iter()
            .any(|r| matches!(r, HistoryRecord::Output(b) if b == b"more output\r\n")));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn idle_session_does_no_work() {
        let root = temp_root();
        let ckpt = Checkpointer::new(&root);
        let src = FakeSource::new("idle");
        src.feed(b"x");
        ckpt.open_session(src.clone() as Arc<dyn CheckpointSource>, &SessionMeta::new(None, 80, 24))
            .expect("open");
        ckpt.tick().await; // anchors, clears dirty
        let calls_after_anchor = src.snapshot_calls.load(Ordering::SeqCst);

        // A tick with nothing dirty must not read or write the session.
        ckpt.tick().await;
        assert_eq!(
            src.snapshot_calls.load(Ordering::SeqCst),
            calls_after_anchor,
            "idle tick must not snapshot"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn overflow_forces_full_reanchor() {
        let root = temp_root();
        let ckpt = Checkpointer::new(&root);
        let src = FakeSource::new("ovf");
        ckpt.open_session(src.clone() as Arc<dyn CheckpointSource>, &SessionMeta::new(None, 80, 24))
            .expect("open");
        ckpt.tick().await; // anchor (generation 1)

        // Signal an overflow: the next incremental tick must instead take a full
        // snapshot (which subsumes the dropped range), bumping the generation.
        src.feed(b"post-overflow content");
        src.overflow.store(true, Ordering::SeqCst);
        ckpt.mark_dirty("ovf");
        ckpt.tick().await;

        let dir = crate::history::session_dir(&root, "ovf");
        let log = std::fs::read(dir.join(OUTPUT_LOG)).unwrap();
        assert_eq!(
            decode_log_header(&log),
            Some(2),
            "overflow re-anchor bumps the generation"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn log_cap_subsumes_into_full_checkpoint() {
        let root = temp_root();
        let ckpt = Checkpointer::new(&root);
        let src = FakeSource::new("cap");
        ckpt.open_session(src.clone() as Arc<dyn CheckpointSource>, &SessionMeta::new(None, 80, 24))
            .expect("open");
        // Shrink the writer cap so one increment overshoots it.
        {
            let sessions = lock(&ckpt.sessions);
            let entry = sessions.get("cap").unwrap();
            lock(&entry.writer).set_log_max_bytes(64);
        }
        ckpt.tick().await; // anchor → generation 1, log reset to header

        // A big increment can't fit → append returns NeedsCheckpoint → the tick
        // subsumes it with a full checkpoint → generation 2, log back to header.
        src.feed(&vec![b'z'; 512]);
        ckpt.mark_dirty("cap");
        ckpt.tick().await;

        let dir = crate::history::session_dir(&root, "cap");
        let log = std::fs::read(dir.join(OUTPUT_LOG)).unwrap();
        assert_eq!(log.len(), crate::history::LOG_HEADER_BYTES, "log reset to header");
        assert_eq!(decode_log_header(&log), Some(2), "subsume bumped the generation");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn flush_all_checkpoints_every_session_leaving_history_unclean() {
        let root = temp_root();
        let ckpt = Checkpointer::new(&root);
        for id in ["a", "b", "c"] {
            let src = FakeSource::new(id);
            src.feed(format!("output for {id}\r\n").as_bytes());
            ckpt.open_session(
                src as Arc<dyn CheckpointSource>,
                &SessionMeta::new(None, 80, 24),
            )
            .expect("open");
        }
        // A session that never ticked (dirty but not yet processed) must still get
        // a checkpoint from the final flush (design L7 / fix #18).
        ckpt.flush_all().await;

        let reader = HistoryReader::new(&root);
        for id in ["a", "b", "c"] {
            let dir = crate::history::session_dir(&root, id);
            assert!(dir.join("checkpoint.json").exists(), "{id} checkpointed");
            // History stays UNCLEAN → still cold-restorable (design L7).
            assert!(reader.has_restorable_history(id), "{id} left cold-restorable");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn in_flight_guard_skips_overlapping_write() {
        let root = temp_root();
        let ckpt = Checkpointer::new(&root);
        let src = FakeSource::new("busy");
        ckpt.open_session(src.clone() as Arc<dyn CheckpointSource>, &SessionMeta::new(None, 80, 24))
            .expect("open");
        ckpt.tick().await; // anchor

        src.feed(b"pending while busy");
        ckpt.mark_dirty("busy");

        // Hold the in-flight guard to simulate a write already in progress.
        let inflight = {
            let sessions = lock(&ckpt.sessions);
            Arc::clone(&sessions.get("busy").unwrap().inflight)
        };
        let permit = inflight.clone().lock_owned().await;

        // A tick while the guard is held must skip and LEAVE the session dirty.
        ckpt.tick().await;
        assert!(!ckpt.dirty_is_empty(), "busy session stays dirty (no overlap)");

        // Release; the next tick appends the pending increment.
        drop(permit);
        ckpt.tick().await;
        let dir = crate::history::session_dir(&root, "busy");
        let log = std::fs::read(dir.join(OUTPUT_LOG)).unwrap();
        assert!(decode_log(&log).unwrap().batches.iter().any(|b| b
            .records
            .iter()
            .any(|r| matches!(r, HistoryRecord::Output(x) if x == b"pending while busy"))));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn poisoned_emulator_degrades_to_raw_ring_checkpoint() {
        let root = temp_root();
        let ckpt = Checkpointer::new(&root);
        let src = FakeSource::new("poison");
        src.feed(b"RAW-RING-ONLY");
        src.poisoned.store(true, Ordering::SeqCst); // snapshot() → None
        ckpt.open_session(src.clone() as Arc<dyn CheckpointSource>, &SessionMeta::new(None, 80, 24))
            .expect("open");
        ckpt.tick().await; // anchor still succeeds from the raw ring

        let restore = HistoryReader::new(&root)
            .detect_cold_restore("poison", false)
            .expect("degraded checkpoint still restores");
        assert!(restore
            .scrollback_for_replay
            .windows(13)
            .any(|w| w == b"RAW-RING-ONLY"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn close_session_stamps_ended_and_drops() {
        let root = temp_root();
        let ckpt = Checkpointer::new(&root);
        let src = FakeSource::new("closing");
        src.feed(b"work");
        ckpt.open_session(src as Arc<dyn CheckpointSource>, &SessionMeta::new(None, 80, 24))
            .expect("open");
        ckpt.tick().await;
        assert_eq!(ckpt.session_count(), 1);

        ckpt.close_session("closing", Some(0));
        assert_eq!(ckpt.session_count(), 0, "closed session dropped from registry");
        assert!(
            !HistoryReader::new(&root).has_restorable_history("closing"),
            "clean close stamps ended_at → not cold-restorable (design D2)"
        );
        // Design §9 self-reap: a cleanly-closed session's disk dir is removed.
        assert!(
            !crate::history::session_dir(&root, "closing").exists(),
            "clean close must remove the per-session history dir (design §9)"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn remove_session_preserves_unclean_dir_for_cold_restore() {
        // Design §9: an UNCLEAN teardown (daemon going down mid-flight) must
        // PRESERVE the session dir so the session stays cold-restorable — unlike a
        // clean close, which reaps it.
        let root = temp_root();
        let ckpt = Checkpointer::new(&root);
        let src = FakeSource::new("crashy");
        src.feed(b"unsaved work");
        ckpt.open_session(src as Arc<dyn CheckpointSource>, &SessionMeta::new(None, 80, 24))
            .expect("open");
        ckpt.tick().await; // anchor checkpoint on disk

        ckpt.remove_session("crashy");
        assert_eq!(ckpt.session_count(), 0, "removed session dropped from registry");
        assert!(
            crate::history::session_dir(&root, "crashy").exists(),
            "unclean removal must PRESERVE the dir (design §9)"
        );
        assert!(
            HistoryReader::new(&root).has_restorable_history("crashy"),
            "unclean removal leaves the session cold-restorable (ended_at null)"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── F5: a failed append re-anchors instead of splicing a silent hole ──────

    #[tokio::test]
    async fn append_failure_reanchors_without_silent_hole() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root();
        let ckpt = Checkpointer::new(&root);
        let src = FakeSource::new("hole");
        ckpt.open_session(src.clone() as Arc<dyn CheckpointSource>, &SessionMeta::new(None, 80, 24))
            .expect("open");
        ckpt.tick().await; // anchor gen 1

        src.feed(b"AAAA");
        ckpt.mark_dirty("hole");
        ckpt.tick().await; // appended ok

        // Make the log unwritable so the NEXT append io-errors AFTER take_pending
        // has already drained "LOST-CHUNK" — the exact silent-hole shape.
        let dir = crate::history::session_dir(&root, "hole");
        let logp = dir.join(OUTPUT_LOG);
        src.feed(b"LOST-CHUNK");
        ckpt.mark_dirty("hole");
        std::fs::set_permissions(&logp, std::fs::Permissions::from_mode(0o444)).unwrap();
        ckpt.tick().await; // append fails → F5: force re-anchor, keep dirty
        assert!(
            !ckpt.dirty_is_empty(),
            "a failed append must keep the session dirty to retry (F5)"
        );
        std::fs::set_permissions(&logp, std::fs::Permissions::from_mode(0o644)).unwrap();

        src.feed(b"BBBB");
        ckpt.mark_dirty("hole");
        ckpt.tick().await; // needs_full (re-anchor) → full checkpoint from the ring

        // Cold restore must contain AAAA, LOST-CHUNK, BBBB — the full re-anchor
        // reconstructs the drained record from the byte-exact ring, so the reader
        // never sees spliced/garbled content and nothing is silently lost.
        let restore = HistoryReader::new(&root)
            .detect_cold_restore("hole", false)
            .expect("restore");
        let sb = &restore.scrollback_for_replay;
        assert!(sb.windows(4).any(|w| w == b"AAAA"), "AAAA present");
        assert!(
            sb.windows(10).any(|w| w == b"LOST-CHUNK"),
            "LOST-CHUNK recovered via re-anchor (no silent hole)"
        );
        assert!(sb.windows(4).any(|w| w == b"BBBB"), "BBBB present");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn full_anchor_failure_disables_history_for_session() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root();
        let ckpt = Checkpointer::new(&root);
        let src = FakeSource::new("dis");
        src.feed(b"X");
        ckpt.open_session(src.clone() as Arc<dyn CheckpointSource>, &SessionMeta::new(None, 80, 24))
            .expect("open");
        assert_eq!(ckpt.session_count(), 1);

        // Make the session dir read-only so the durable-rename tmp create fails →
        // the first (anchor) full checkpoint errors. A full-checkpoint failure is
        // unrecoverable, so history is disabled for the session (F5) — it is dropped
        // from the registry rather than retried forever. (Appends to an already-open
        // file would survive a read-only dir, so the anchor is the honest target.)
        let dir = crate::history::session_dir(&root, "dis");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        ckpt.tick().await; // anchor full_checkpoint fails → Disabled → dropped
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            ckpt.session_count(),
            0,
            "an unwritable dir disables history for the session (drops it)"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── F2: Session output after the anchor is persisted by the periodic tick ──

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn session_output_after_anchor_marks_dirty_and_persists() {
        use crate::server::{SessionReaper, StreamHub};
        use crate::session::Session;

        const MARK: &[u8] = b"POST-ANCHOR-F2-MARKER";
        let root = temp_root();
        // A real checkpointer with a short run cadence + a real Session wired to it
        // through a real SessionReaper — the exact production wiring for fix F2.
        let ckpt = Checkpointer::new_with_tick(&root, Duration::from_millis(30));
        let reaper = SessionReaper::with_checkpointer(&ckpt);
        let session = Session::spawn(
            "wire".to_string(),
            ".",
            80,
            24,
            &[],
            StreamHub::default(),
            reaper,
        )
        .expect("spawn session");
        ckpt.open_session(
            Arc::clone(&session) as Arc<dyn CheckpointSource>,
            &SessionMeta::new(None, 80, 24),
        )
        .expect("open");
        session.enable_history();

        // Drain the shell's startup output + the open anchor so the baseline is
        // clean (no session is dirty).
        tokio::time::sleep(Duration::from_millis(300)).await;
        for _ in 0..8 {
            ckpt.tick().await;
            if ckpt.dirty_is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        assert!(ckpt.dirty_is_empty(), "baseline output not drained");

        // Output AFTER the anchor. The fix-F2 wiring (Session tee → reaper
        // mark_dirty) is the ONLY thing that marks the session dirty here — without
        // it the periodic tick would never persist post-anchor output.
        session.test_tee(MARK);
        assert!(
            !ckpt.dirty_is_empty(),
            "Session output did not mark the checkpointer dirty (F2 regression)"
        );

        // One tick persists it — NO client disconnect, NO explicit flush.
        ckpt.tick().await;
        let dir = crate::history::session_dir(&root, "wire");
        let in_log = std::fs::read(dir.join(OUTPUT_LOG))
            .ok()
            .and_then(|b| decode_log(&b))
            .map(|d| {
                d.batches.iter().any(|b| {
                    b.records
                        .iter()
                        .any(|r| matches!(r, HistoryRecord::Output(x) if x.windows(MARK.len()).any(|w| w == MARK)))
                })
            })
            .unwrap_or(false);
        let in_cp = std::fs::read(dir.join("checkpoint.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Checkpoint>(&b).ok())
            .map(|c| c.scrollback_ansi.windows(MARK.len()).any(|w| w == MARK))
            .unwrap_or(false);
        Session::kill(&session);
        assert!(
            in_log || in_cp,
            "output after the anchor was never persisted by the periodic tick (F2)"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
