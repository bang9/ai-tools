use crate::{
    config,
    daemon::{
        self,
        client::{ColdRestorePayload, CreateOrAttach, StreamSubscriber, WarmReattach},
        ExitStatus,
    },
    process_env::subprocess_env_pairs,
    tool_hooks,
    worktree_lifecycle::WorktreeResource,
    AppliedPtySize, CreatePtyInitialHydration, CreatePtyInitialHydrationSource, CreatePtyRequest,
    CreatePtyRestore, CreatePtyResult, CreatePtySessionState, PtyBellEvent,
    SaveTerminalSessionSnapshotRequest,
    TerminalGcReport, TerminalPaneSnapshot, TerminalPaneSnapshotInput, TerminalRestoreCwdSource,
    TerminalSessionSnapshot,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::env;
use std::fmt::Write as _;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::sleep;
use std::time::{Duration, Instant};

const MAX_SCROLLBACK_BYTES: usize = 256 * 1024;
/// Coalesce PTY reads into a time/size-windowed batch before emitting to the
/// sink, mirroring Orca's 8ms output batching. A flooding process produces
/// thousands of ~4KB reads/sec; without batching each pays the full
/// encode→IPC→decode→xterm.write cost. Flushing on an 8ms window or a 64KB
/// buffer collapses that into ~120Hz emits while adding ≤8ms latency.
const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const OUTPUT_FLUSH_SIZE: usize = 64 * 1024;
/// Hard ceiling on the coalescer's pending buffer. The flusher normally drains
/// every 8ms or 64KB, so `pending` only grows without bound when the sink
/// stalls (IPC backpressure) while a process floods output. Cap at 64× the
/// flush size (4 MiB) — orders of magnitude above any single 8ms window's worth
/// of reads, so normal use NEVER truncates; past it we drop oldest bytes
/// (keep-tail) so a runaway producer can't OOM the process. Sized off
/// OUTPUT_FLUSH_SIZE so it tracks the flush window if that constant changes.
const MAX_PENDING_BYTES: usize = OUTPUT_FLUSH_SIZE * 64;
// --- session identity ----------------------------------------------------------
// The PTY backend is the daemon (design P9 cutover). grove no longer shells out to
// tmux anywhere in this module; the only thing that survives the old backend is the
// SESSION ID SHAPE — `grove-{hash(worktree)}-{pane}` — which is the reattach identity
// (design G6) and must stay byte-identical forever: changing it orphans every pane a
// user already has on disk. `grove_session_name_is_stable_and_namespaced` pins it.
const WORKTREE_HASH_LEN: usize = 12;
const PANE_PREFIX_LEN: usize = 8;
const PANE_HASH_LEN: usize = 4;
const CODEX_OUTPUT_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const HOOKLESS_ATTENTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const TERMINAL_GC_PROCESS_EXIT_GRACE: Duration = Duration::from_millis(250);

pub trait PtyEventSink: Send + Sync + 'static {
    fn on_output(&self, pty_id: &str, data: &[u8]);
}

/// Bytes to seed a pane's local scrollback mirror with on attach, plus whether the
/// producer already dropped older content. Fed by the daemon's warm/cold VT snapshot.
#[derive(Clone, Copy, Debug)]
struct HydrationSeed<'a> {
    bytes: &'a [u8],
    truncated: bool,
}

#[derive(Clone, Debug)]
struct PtyRuntimeState {
    launch_cwd: String,
    process_id: Option<u32>,
    /// The daemon session id for this pane (the `grove_session_name` worktree+pane
    /// hash — a stable id across relaunches is what makes reattach work; design G6).
    session_name: String,
    last_known_cwd: Option<String>,
    /// Last geometry grove asked the daemon to apply. Local mirror only — the
    /// authoritative applied size is read back over RPC (`applied_pty_size`, G8).
    cols: u16,
    rows: u16,
    /// Local mirror of the pane's raw output, fed by the daemon stream sink. The
    /// daemon owns the byte-exact ring that backs cold restore (G4); this copy
    /// exists so `save_terminal_session_snapshot` keeps producing the exact same
    /// `terminal-session-snapshots.json` content it always has.
    scrollback: VecDeque<u8>,
    scrollback_truncated: bool,
    /// The last status grove EMITTED for this pane. Purely the delta filter for
    /// `poll_bell_events` (an event fires only when this changes) — the authoritative
    /// store is the daemon's per-session `ai_status`.
    last_ai_status: Option<String>,
    /// Stamped by the daemon stream sink on every output frame. After the cutover
    /// this is the ONLY feed for the AI-status idle clock — without it the hookless
    /// idle/attention state machine in `poll_bell_events` freezes forever.
    last_output_at: Option<Instant>,
    /// Set when a hookless tool transitions running→idle. Used for attention timeout.
    idle_since: Option<Instant>,
    /// Set by the stream sink when the daemon reports the child exited. The entry is
    /// removed from the registry on the same event, so terminal GC observes this only
    /// through a still-held `tracked` handle.
    reader_exited: bool,
}

impl PtyRuntimeState {
    fn new(
        launch_cwd: String,
        process_id: Option<u32>,
        session_name: String,
        cols: u16,
        rows: u16,
        restore: Option<&CreatePtyRestore>,
        initial_hydration: Option<HydrationSeed<'_>>,
    ) -> Self {
        let mut state = Self {
            launch_cwd,
            process_id,
            session_name,
            last_known_cwd: None,
            cols,
            rows,
            scrollback: VecDeque::new(),
            scrollback_truncated: false,
            last_ai_status: None,
            last_output_at: None,
            idle_since: None,
            reader_exited: false,
        };

        if let Some(restore) = restore {
            state.last_known_cwd = restore
                .last_known_cwd
                .as_deref()
                .map(str::trim)
                .filter(|cwd| !cwd.is_empty())
                .map(str::to_string);
            state.scrollback_truncated = restore.scrollback_truncated.unwrap_or(false);
            if let Some(scrollback) = restore.scrollback.as_deref() {
                state.append_scrollback(scrollback.as_bytes());
            }
        }

        if let Some(initial_hydration) = initial_hydration {
            state.scrollback_truncated = initial_hydration.truncated;
            state.append_scrollback(initial_hydration.bytes);
        }

        state
    }

    fn append_scrollback(&mut self, chunk: &[u8]) {
        append_scrollback_capped(
            &mut self.scrollback,
            &mut self.scrollback_truncated,
            chunk,
            MAX_SCROLLBACK_BYTES,
        );
    }
}

#[derive(Clone, Debug)]
struct PtyRuntimeSnapshot {
    launch_cwd: String,
    #[allow(dead_code)]
    process_id: Option<u32>,
    session_name: String,
    last_known_cwd: Option<String>,
    scrollback: Vec<u8>,
    scrollback_truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessSnapshot {
    pid: u32,
    ppid: u32,
    command_line: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TerminalGcSessionInfo {
    session_name: String,
    worktree_path: String,
    attached: bool,
    pane_pid: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
struct TerminalGcPlan {
    stale_worktree_paths: Vec<String>,
    stale_session_names: Vec<String>,
    stale_session_pane_pids: Vec<u32>,
    skipped_attached_worktree_paths: Vec<String>,
}

/// A pane grove has attached to the daemon. The daemon owns the PTY master, the
/// child, the ordered writer and the byte-exact scrollback ring (design G6/G4);
/// grove keeps only the routing identity, the transport sink, and the per-pane
/// runtime state the frontend contract still depends on.
struct PtyInstance {
    /// Daemon session id (worktree+pane hash — stable across relaunches).
    session_name: String,
    worktree_path: String,
    /// The transport sink (`TauriEventSink` / `NapiEventSink`) this pane's output
    /// goes to. Retained so a future re-subscribe (reconnect) can rebuild the
    /// adapter without a round trip to the frontend.
    #[allow(dead_code)]
    sink: Arc<dyn PtyEventSink>,
    /// The stream subscriber registered with the daemon client for this session.
    /// Held so the adapter (and its gate) outlives `create`, and so tests can drive
    /// it directly.
    #[allow(dead_code)]
    subscriber: Arc<DaemonSinkAdapter>,
    tracked: Arc<Mutex<PtyRuntimeState>>,
}

/// Bridges one daemon session's stream frames onto grove's `PtyEventSink` seam
/// (design G1) — the single adapter that replaces the local PTY reader thread.
///
/// It also owns a REPLAY GATE. `create` subscribes BEFORE it sends `createOrAttach`
/// (otherwise a fresh shell's prompt, emitted between spawn and the RPC reply, is
/// dropped on the floor — the client drops frames for unknown sessions). Frames that
/// land during that window are buffered here; once the reply is in, `open_gate`
/// releases them, dropping/trimming any bytes the warm snapshot already contains
/// (byte-exact, per design S3/P12: a `Data` frame's `seq` is the cumulative byte
/// total AFTER its payload, and the snapshot's `output_sequence` counts the same
/// stream, so `seq <= snapshot_seq` ⇒ fully contained).
struct DaemonSinkAdapter {
    pty_id: String,
    session_id: String,
    sink: Arc<dyn PtyEventSink>,
    tracked: Arc<Mutex<PtyRuntimeState>>,
    gate: Mutex<ReplayGate>,
}

/// Frames held while the create-time replay gate is closed: `(absolute byte seq, bytes)`.
type GatedFrames = Vec<(u64, Vec<u8>)>;

/// The create-time replay gate. `on_data` / `on_exit` run on the client's stream task,
/// `open_gate` runs on the `create` task, so EVERY transition happens under the gate
/// mutex — including the drain and the registry insert. Two invariants ride on that:
///
/// * ORDERING: a frame that lands while the buffer is draining must not overtake it.
///   The drain holds the lock for its whole run, so a concurrent `on_data` blocks and
///   is ingested strictly after the last buffered byte. Releasing the lock first and
///   draining after (which reads as harmless) reorders the byte stream and garbles
///   xterm — never do that.
/// * EARLY EXIT: the daemon's `Exit` frame rides the STREAM socket while the
///   `createOrAttach` reply rides the CONTROL socket, so an instantly-dying shell can
///   report its exit before `create` has registered anything. That exit is recorded
///   here and honored by `open_gate`, which then skips registration entirely.
enum ReplayGate {
    /// `create` is still in flight.
    Closed {
        frames: GatedFrames,
        /// The session's child exited before `create` finished registering it.
        exited: bool,
    },
    /// `create` finished: frames go straight to the sink.
    Open,
}

impl DaemonSinkAdapter {
    fn new(
        pty_id: String,
        session_id: String,
        sink: Arc<dyn PtyEventSink>,
        tracked: Arc<Mutex<PtyRuntimeState>>,
    ) -> Self {
        Self {
            pty_id,
            session_id,
            sink,
            tracked,
            gate: Mutex::new(ReplayGate::Closed {
                frames: GatedFrames::new(),
                exited: false,
            }),
        }
    }

    /// Record a chunk against the pane's runtime state, then hand it to the
    /// transport. The `last_output_at` stamp is load-bearing: it is the only
    /// remaining feed for the hookless AI-status idle clock (`poll_bell_events`).
    fn ingest(&self, data: &[u8]) {
        {
            let mut state = lock_recover(&self.tracked);
            state.append_scrollback(data);
            state.last_output_at = Some(Instant::now());
        }
        self.sink.on_output(&self.pty_id, data);
    }

    /// Release the create-time gate and register the pane in the SAME critical section.
    ///
    /// `snapshot_seq` is the warm snapshot's `output_sequence`; buffered bytes at or
    /// below it are already on screen via the hydration payload and are dropped (a
    /// straddling frame is trimmed to its post-snapshot tail). `None` (fresh spawn /
    /// cold restore — the session's seq starts at 0) forwards everything.
    ///
    /// `register` publishes the pane to the registry. It runs under the gate lock, and
    /// ONLY when no exit was recorded while `create` was in flight: registering a
    /// session the daemon already reported dead would leave a subscriber-less entry
    /// marked alive, and re-creating that pane would fail with "PTY already exists"
    /// until GC reaped it. Returns whether that early exit happened.
    fn open_gate(&self, snapshot_seq: Option<u64>, register: impl FnOnce()) -> bool {
        let exited = {
            let mut gate = lock_recover(&self.gate);
            let (frames, exited) = match std::mem::replace(&mut *gate, ReplayGate::Open) {
                ReplayGate::Closed { frames, exited } => (frames, exited),
                ReplayGate::Open => (GatedFrames::new(), false),
            };
            if !exited {
                register();
            }
            // Held across the drain on purpose — see `ReplayGate` (ORDERING).
            for (seq, data) in frames {
                match snapshot_seq {
                    Some(snapshot_seq) => {
                        let len = data.len() as u64;
                        let start = seq.saturating_sub(len);
                        if seq <= snapshot_seq {
                            continue;
                        }
                        if start < snapshot_seq {
                            let skip = (snapshot_seq - start) as usize;
                            self.ingest(&data[skip.min(data.len())..]);
                        } else {
                            self.ingest(&data);
                        }
                    }
                    None => self.ingest(&data),
                }
            }
            exited
        };

        if exited {
            // The dying shell's output has now been replayed; finish the teardown the
            // deferred `on_exit` skipped.
            self.teardown();
        }
        exited
    }

    /// Mark the pane dead and drop it: the same cleanup the GC reap performs, minus the
    /// child reap (the daemon owns the child and has already reaped it). Idempotent.
    fn teardown(&self) {
        lock_recover(&self.tracked).reader_exited = true;
        lock_recover(registry()).remove(&self.pty_id);
        if let Some(handle) = daemon::global_client() {
            handle.client().unsubscribe(&self.session_id);
        }
    }
}

impl StreamSubscriber for DaemonSinkAdapter {
    fn on_data(&self, seq: u64, data: &[u8]) {
        {
            let mut gate = lock_recover(&self.gate);
            if let ReplayGate::Closed { frames, .. } = &mut *gate {
                frames.push((seq, data.to_vec()));
                return;
            }
        }
        self.ingest(data);
    }

    fn on_exit(&self, _status: ExitStatus) {
        // Why no renderer event: exit stays discovered exactly as it always has been —
        // the shell's own EOF/output and the frontend's own lifecycle drive teardown,
        // and terminal GC reaps whatever is left. Emitting a new event here would
        // change the frozen renderer contract.
        {
            let mut gate = lock_recover(&self.gate);
            if let ReplayGate::Closed { exited, .. } = &mut *gate {
                // Exit beat the `createOrAttach` reply (separate sockets). Record it and
                // let `open_gate` finish the teardown — tearing down here would race
                // `create`, which would then re-register the dead pane as alive.
                *exited = true;
                return;
            }
        }
        self.teardown();
    }
}

struct CoalescerInner {
    pending: Vec<u8>,
    first_byte_at: Option<Instant>,
    closed: bool,
    /// Set when the pending cap forced a keep-tail drop. Internal only — never
    /// surfaced to the sink; a visible marker would corrupt the xterm stream.
    #[cfg_attr(not(test), allow(dead_code))]
    truncated: bool,
}

struct CoalescerShared {
    state: Mutex<CoalescerInner>,
    cvar: Condvar,
    sink: Arc<dyn PtyEventSink>,
    id: String,
}

/// Time/size-windowed coalescing buffer sitting between the PTY read loop and
/// `sink.on_output`. The reader thread only appends bytes (`push`); a single
/// dedicated flusher thread is the SOLE emitter, so bytes always reach the sink
/// in read order with no cross-thread interleaving. Emits happen off the lock.
///
/// Why pub: this is a SHARED grove-core library (design §1.1/§6/G2). grove-core no
/// longer owns a PTY master, so its ONLY consumer now is the daemon crate
/// (`grove-daemon`), which constructs it between its PTY read loop and the stream
/// socket. Behavior is unchanged from when grove drove it in-process.
pub struct OutputCoalescer {
    shared: Arc<CoalescerShared>,
    /// Join handle for the sole flusher thread. Retained so a consumer can block
    /// until the final tail has been emitted (see `close_and_join`); a consumer that
    /// never joins simply detaches it on drop.
    flusher: Option<std::thread::JoinHandle<()>>,
}

impl OutputCoalescer {
    pub fn new(sink: Arc<dyn PtyEventSink>, id: String) -> Self {
        let shared = Arc::new(CoalescerShared {
            state: Mutex::new(CoalescerInner {
                pending: Vec::new(),
                first_byte_at: None,
                closed: false,
                truncated: false,
            }),
            cvar: Condvar::new(),
            sink,
            id,
        });
        let flusher_shared = Arc::clone(&shared);
        let flusher = std::thread::spawn(move || run_output_flusher(flusher_shared));
        Self {
            shared,
            flusher: Some(flusher),
        }
    }

    pub fn push(&self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let mut state = lock_recover(&self.shared.state);
        if state.closed {
            return;
        }
        state.pending.extend_from_slice(data);
        if state.pending.len() > MAX_PENDING_BYTES {
            // Why: a stalled sink can't drain; keep the newest tail so xterm
            // still gets the latest screen rather than letting pending grow
            // unbounded and OOM the process.
            let mut overflow = state.pending.len() - MAX_PENDING_BYTES;
            // Why: dropping mid-codepoint would hand xterm a stray UTF-8
            // continuation byte; extend the drop to the next lead byte.
            // Mid-escape cuts remain an accepted above-cap tradeoff.
            while state
                .pending
                .get(overflow)
                .is_some_and(|b| (b & 0xC0) == 0x80)
            {
                overflow += 1;
            }
            state.pending.drain(..overflow);
            state.truncated = true;
        }
        if state.first_byte_at.is_none() {
            state.first_byte_at = Some(Instant::now());
        }
        self.shared.cvar.notify_one();
    }

    pub fn close(&self) {
        let mut state = lock_recover(&self.shared.state);
        state.closed = true;
        self.shared.cvar.notify_all();
    }

    /// Close the coalescer and BLOCK until the flusher thread has emitted its
    /// final tail and exited. Why: the daemon must order a session's `Exit`
    /// frame strictly AFTER its last `Data` frame (design P13); joining the sole
    /// emitter is that ordering barrier — no `Exit` can overtake buffered output.
    /// Consumes self. A consumer that does not need the barrier uses `close`.
    pub fn close_and_join(mut self) {
        self.close();
        if let Some(handle) = self.flusher.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for OutputCoalescer {
    fn drop(&mut self) {
        // Guarantee the flusher thread terminates even if `close` was never
        // called explicitly (e.g. panic on the reader thread).
        self.close();
    }
}

/// Sole emitter for a PTY's coalesced output. Wakes on new bytes or the 8ms
/// window, drains the pending buffer under the lock, then calls `on_output`
/// OUTSIDE the lock so IPC never blocks the reader thread's appends. Exits once
/// `closed` is set and any final tail has been flushed.
fn run_output_flusher(shared: Arc<CoalescerShared>) {
    let mut guard = lock_recover(&shared.state);
    loop {
        while !guard.closed && guard.pending.is_empty() {
            guard = shared
                .cvar
                .wait(guard)
                .unwrap_or_else(|error| error.into_inner());
        }

        if guard.closed {
            // Flush any final tail on teardown before exiting.
            let drained = std::mem::take(&mut guard.pending);
            guard.first_byte_at = None;
            drop(guard);
            if !drained.is_empty() {
                shared.sink.on_output(&shared.id, &drained);
            }
            return;
        }

        let first = guard.first_byte_at.unwrap_or_else(Instant::now);
        let elapsed = first.elapsed();
        if guard.pending.len() >= OUTPUT_FLUSH_SIZE || elapsed >= OUTPUT_FLUSH_INTERVAL {
            let drained = std::mem::take(&mut guard.pending);
            guard.first_byte_at = None;
            drop(guard);
            shared.sink.on_output(&shared.id, &drained);
            guard = lock_recover(&shared.state);
        } else {
            let remaining = OUTPUT_FLUSH_INTERVAL - elapsed;
            guard = shared
                .cvar
                .wait_timeout(guard, remaining)
                .unwrap_or_else(|error| error.into_inner())
                .0;
        }
    }
}

/// Max bytes allowed to queue for a single PTY before the SEND side blocks.
/// Why: bound memory so a wedged consumer (a PTY master whose `write_all` is not
/// draining) can't let an unbounded paste backlog grow until it OOMs the process.
/// 1 MiB is far above any real keystroke or paste burst, so healthy writes never
/// block on it.
const MAX_WRITE_QUEUE_BYTES: usize = 1024 * 1024;
/// End-to-end deadline for one write() (enqueue wait + the writer thread's
/// write_all). Why: a wedged PTY master blocks write_all indefinitely; without this
/// the caller's pool thread would hang forever. 30s never trips on a healthy pty.
///
/// grove-core itself no longer writes to a PTY — the deadline is a `PtyWriter::spawn_
/// input_only` PARAMETER, and the daemon passes its own (`grove-daemon` session.rs).
/// This copy is the value the writer's own tests drive it with.
#[cfg(test)]
const WRITE_DEADLINE: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT_MSG: &str = "terminal input write timed out; the terminal may be unresponsive";
const WRITER_CLOSED_MSG: &str = "terminal input writer is shutting down";

/// One queued write batch plus the slot its result lands in. `id` lets a
/// timed-out caller pull its own still-queued job back out (see drop_queued_job)
/// so abandoned bytes are never written later, out of order, behind a newer call.
struct QueuedWrite {
    id: u64,
    bytes: Vec<u8>,
    completion: Arc<WriteCompletion>,
}

struct WriterInner {
    queue: VecDeque<QueuedWrite>,
    queued_bytes: usize,
    next_id: u64,
    closed: bool,
}

struct WriterShared {
    inner: Mutex<WriterInner>,
    /// Writer thread waits here for a new job or `closed`.
    job_ready: Condvar,
    /// Senders blocked on the byte cap wait here for the queue to drain.
    space_free: Condvar,
}

/// Per-write completion slot. The writer thread stores the write_all Result here
/// AFTER the bytes land, then notifies; the calling thread blocks on it. Storing
/// the outcome in the slot (not just signalling) means a writer that finishes
/// before the caller waits is never a lost wakeup.
struct WriteCompletion {
    result: Mutex<Option<Result<(), String>>>,
    done: Condvar,
}

/// Handle to a PTY's dedicated, ordered writer thread. `write` enqueues bytes in
/// strict FIFO order regardless of how many threads call concurrently, then
/// blocks the caller until the writer thread's `write_all` for exactly those
/// bytes returns (or the deadline elapses). Mirrors the OutputCoalescer
/// sole-flusher pattern on the input side: one thread is the SOLE writer, so
/// concurrent writePty calls can never interleave or reorder whole batches.
///
/// Why pub: SHARED grove-core library (design §1.1/§6/G3). The daemon constructs
/// one per session so paste-body-then-CR ordering holds across the socket.
pub struct PtyWriter {
    shared: Arc<WriterShared>,
    deadline: Duration,
}

impl PtyWriter {
    /// Spawn an ordered FIFO writer for a PTY master.
    ///
    /// "Input only" = no side effects beyond the bytes. Enter-detection used to run
    /// HERE, on the writer thread, because that was the last place grove saw the input
    /// before it reached the shell. grove owns no PTY master any more: input crosses
    /// the socket as a `write` notify and the DAEMON does Enter-detection on the same
    /// bytes (`Session::enqueue_write` → `detect_enter`, design G9), writing the
    /// daemon's own AI-status store. So this writer is purely an ordered byte pump,
    /// and its only consumer is the daemon (one per session, so paste-body-then-CR
    /// ordering holds across the socket).
    pub fn spawn_input_only(writer: Box<dyn Write + Send>, deadline: Duration) -> Arc<Self> {
        let shared = Arc::new(WriterShared {
            inner: Mutex::new(WriterInner {
                queue: VecDeque::new(),
                queued_bytes: 0,
                next_id: 0,
                closed: false,
            }),
            job_ready: Condvar::new(),
            space_free: Condvar::new(),
        });
        let writer_shared = Arc::clone(&shared);
        std::thread::spawn(move || run_pty_writer(writer, writer_shared));
        Arc::new(Self { shared, deadline })
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        // Why: an empty write delivers nothing; skip the queue so it never holds
        // a slot or waits on a completion. Matches today's write_all(&[]) => Ok.
        if data.is_empty() {
            return Ok(());
        }

        let deadline_at = Instant::now() + self.deadline;
        let len = data.len();
        let completion = Arc::new(WriteCompletion {
            result: Mutex::new(None),
            done: Condvar::new(),
        });

        // Phase 1: enqueue in FIFO order. If the queue is over the byte cap,
        // block on `space_free` (with the deadline) so a runaway backlog can't
        // grow unbounded. An empty queue always admits the job even if it alone
        // exceeds the cap, so an oversized paste makes progress vs deadlocking.
        let job_id = {
            let mut inner = lock_recover(&self.shared.inner);
            loop {
                if inner.closed {
                    return Err(WRITER_CLOSED_MSG.to_string());
                }
                let fits =
                    inner.queued_bytes == 0 || inner.queued_bytes + len <= MAX_WRITE_QUEUE_BYTES;
                if fits {
                    let id = inner.next_id;
                    inner.next_id = inner.next_id.wrapping_add(1);
                    inner.queued_bytes += len;
                    inner.queue.push_back(QueuedWrite {
                        id,
                        bytes: data.to_vec(),
                        completion: Arc::clone(&completion),
                    });
                    self.shared.job_ready.notify_one();
                    break id;
                }
                let now = Instant::now();
                if now >= deadline_at {
                    return Err(WRITE_TIMEOUT_MSG.to_string());
                }
                let (guard, timeout) = self
                    .shared
                    .space_free
                    .wait_timeout(inner, deadline_at - now)
                    .unwrap_or_else(|error| error.into_inner());
                inner = guard;
                if timeout.timed_out() && Instant::now() >= deadline_at {
                    return Err(WRITE_TIMEOUT_MSG.to_string());
                }
            }
        };

        // Phase 2: wait for the writer thread to finish write_all (and
        // Enter-detection) for THIS job, or the deadline. On timeout pull the
        // job back out if it hasn't started, so its abandoned bytes are dropped
        // with the error instead of written later behind a newer call.
        let mut slot = lock_recover(&completion.result);
        loop {
            if let Some(result) = slot.take() {
                return result;
            }
            let now = Instant::now();
            if now >= deadline_at {
                drop(slot);
                self.drop_queued_job(job_id, len);
                return Err(WRITE_TIMEOUT_MSG.to_string());
            }
            let (guard, timeout) = completion
                .done
                .wait_timeout(slot, deadline_at - now)
                .unwrap_or_else(|error| error.into_inner());
            slot = guard;
            if timeout.timed_out() && slot.is_none() && Instant::now() >= deadline_at {
                drop(slot);
                self.drop_queued_job(job_id, len);
                return Err(WRITE_TIMEOUT_MSG.to_string());
            }
        }
    }

    /// Remove a still-queued job on deadline so the writer thread never writes
    /// its abandoned bytes out of order behind a later call. No-op once the
    /// writer has dequeued it (mid or post write_all — those bytes can't be
    /// pulled back, but that in-flight write is the only one affected).
    fn drop_queued_job(&self, job_id: u64, len: usize) {
        let mut inner = lock_recover(&self.shared.inner);
        if let Some(pos) = inner.queue.iter().position(|job| job.id == job_id) {
            inner.queue.remove(pos);
            inner.queued_bytes = inner.queued_bytes.saturating_sub(len);
            self.shared.space_free.notify_all();
        }
    }
}

impl Drop for PtyWriter {
    fn drop(&mut self) {
        // Why: when the session tears down, the last handle drops here. Signal the
        // writer thread to exit: if idle it wakes and returns; if blocked in write_all
        // on a wedged master it returns once write_all finally errors (EPIPE after the
        // master fd is dropped).
        let mut inner = lock_recover(&self.shared.inner);
        inner.closed = true;
        self.shared.job_ready.notify_all();
        self.shared.space_free.notify_all();
    }
}

/// Sole writer for a PTY's input. Pops jobs in FIFO order, runs `write_all` off
/// the queue lock (so a stalled write never blocks enqueues), then — after the
/// bytes land — runs Enter-detection and signals the job's completion. Exits
/// once `closed` is set and the queue is drained, or once a write fails after
/// close (EPIPE on a torn-down master fd).
fn run_pty_writer(mut writer: Box<dyn Write + Send>, shared: Arc<WriterShared>) {
    loop {
        let job = {
            let mut inner = lock_recover(&shared.inner);
            loop {
                if let Some(job) = inner.queue.pop_front() {
                    inner.queued_bytes = inner.queued_bytes.saturating_sub(job.bytes.len());
                    // Why: a slot just freed; wake any sender blocked on the cap.
                    shared.space_free.notify_all();
                    break Some(job);
                }
                if inner.closed {
                    break None;
                }
                inner = shared
                    .job_ready
                    .wait(inner)
                    .unwrap_or_else(|error| error.into_inner());
            }
        };

        let Some(job) = job else {
            return;
        };

        let result = writer.write_all(&job.bytes).map_err(|error| error.to_string());
        let write_ok = result.is_ok();

        {
            let mut slot = lock_recover(&job.completion.result);
            *slot = Some(result);
            job.completion.done.notify_all();
        }

        if !write_ok {
            // Why: a failed write on a closed/torn-down PTY (EPIPE after the
            // master fd dropped) is the writer thread's cue to exit.
            let inner = lock_recover(&shared.inner);
            if inner.closed {
                return;
            }
        }
    }
}

fn registry() -> &'static Mutex<HashMap<String, PtyInstance>> {
    static PTY_REGISTRY: OnceLock<Mutex<HashMap<String, PtyInstance>>> = OnceLock::new();
    PTY_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Recover a poisoned lock instead of propagating the panic. A panic while a
/// thread held one of the hot PTY locks (registry, per-instance writer/tracked,
/// coalescer state) leaves the guarded data structurally valid, so bricking
/// every future PTY op on the poison flag is strictly worse than continuing.
/// Mirrors the idiom in test_support::env_lock.
fn lock_recover<T>(lock: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|error| error.into_inner())
}

/// Install a process-wide panic hook that routes thread panics through
/// grove-core's logger. Idempotent; each shell may call it at init. Without it
/// a panic on a detached PTY reader/flusher thread unwinds and vanishes (the
/// default hook only touches stderr), leaving no trace on the app's log surface.
pub fn install_panic_hook() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    if INSTALLED.set(()).is_err() {
        return;
    }

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|loc| format!("{}:{}", loc.file(), loc.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        crate::logger::emit_log("error", "panic", &format!("thread panic at {location}: {message}"));
        previous(info);
    }));
}

fn is_utf8_locale(locale: &str) -> bool {
    let upper = locale.to_ascii_uppercase();
    upper.contains("UTF-8") || upper.contains("UTF8")
}

fn preferred_utf8_locale() -> String {
    for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
        if let Ok(value) = env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() && is_utf8_locale(trimmed) && is_usable_locale(trimmed) {
                return trimmed.to_string();
            }
        }
    }

    // Why: macOS ships no C.UTF-8 locale, so a GUI launch with LANG unset would
    // fall through to C/POSIX and garble CJK. en_US.UTF-8 is always present on
    // macOS. Every other platform does ship C.UTF-8, which stays the neutral pick.
    #[cfg(target_os = "macos")]
    {
        "en_US.UTF-8".to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "C.UTF-8".to_string()
    }
}

/// Bare "UTF-8" / "UTF8" are not valid POSIX locale names and cause tools
/// like zsh to mishandle multi-byte input. Require a proper locale prefix
/// (e.g. "en_US.UTF-8", "C.UTF-8").
fn is_usable_locale(locale: &str) -> bool {
    let upper = locale.to_ascii_uppercase();
    upper != "UTF-8" && upper != "UTF8"
}

/// Reject a working directory the backend would fail on opaquely: empty, missing,
/// not a directory, or a filesystem root. Why: a root-like cwd (its own parent) is
/// where the unbounded file discovery this guard exists to prevent begins, and a
/// missing/non-dir path can only be a caller bug. Mirrors orca pty-path-safety.ts.
/// Runs BEFORE `createOrAttach` so the caller gets a descriptive error instead of a
/// raw spawn failure from the daemon.
fn validate_pty_cwd(cwd: &str) -> Result<(), String> {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return Err("terminal working directory is empty".to_string());
    }

    let path = std::path::Path::new(trimmed);
    if !path.exists() {
        return Err(format!(
            "terminal working directory does not exist: {trimmed}"
        ));
    }
    if !path.is_dir() {
        return Err(format!(
            "terminal working directory is not a directory: {trimmed}"
        ));
    }
    // A filesystem root is its own parent (Path::parent returns None for "/").
    if path.parent().is_none_or(|parent| parent == path) {
        return Err(format!(
            "terminal working directory is a filesystem root: {trimmed}"
        ));
    }

    Ok(())
}

/// Per-session env the daemon-spawned shell needs beyond the portable terminal set.
/// `GROVE_SESSION_ID` is the daemon session id; `GROVE_AI_STATUS_FILE` is the
/// per-session path a tool hook writes its status into (the daemon-native
/// replacement for `tmux set-option @grove_ai_status`; stage 2 consumes it).
///
/// Convention: `<daemon base dir>/ai-status/<session id>` — i.e. `~/.grove/daemon/
/// ai-status/grove-<worktree hash>-<pane>` for the default base dir. Session ids are
/// already filesystem-safe (`grove-[0-9a-f]+-[a-z0-9]+`), so no escaping is needed.
fn ai_status_file_path(session_id: &str) -> Option<PathBuf> {
    let dir = daemon::runtime_base_dir()
        .or_else(|| config::daemon_runtime_dir().ok())?
        .join("ai-status");
    if let Err(error) = std::fs::create_dir_all(&dir) {
        crate::logger::emit_log(
            "warn",
            "pty",
            &format!("failed to create the AI-status dir {}: {error}", dir.display()),
        );
        return None;
    }
    Some(dir.join(session_id))
}

/// A status published by a tool hook since the last poll (design G9 hook channel).
/// `Some(status)` = set; `None` = explicit clear (an EMPTY file — the daemon-native
/// equivalent of the old `tmux set-option -u @grove_ai_status`).
type AiStatusSignal = Option<String>;

/// Take-and-consume the pane's AI-status file: `rename` it aside, read it, delete it.
/// Returns `None` when no hook wrote anything since the last tick.
///
/// Why rename-then-read rather than read-then-delete: a hook publishes ATOMICALLY
/// (write tmp + `mv`), so a `mv` landing between our read and our unlink would have
/// its brand-new status deleted unread. Renaming first is a single atomic take — a
/// hook that publishes afterwards simply creates a fresh file we pick up next tick.
fn consume_ai_status_file(session_id: &str) -> Option<AiStatusSignal> {
    let path = ai_status_file_path(session_id)?;
    // Append (never `with_extension`, which would REPLACE a dotted suffix and could
    // collide with the live file for an id containing a dot).
    let taken = {
        let mut name = path.clone().into_os_string();
        name.push(".taken");
        PathBuf::from(name)
    };
    // ENOENT (the common case: no hook fired this tick) is not an error.
    std::fs::rename(&path, &taken).ok()?;
    let contents = std::fs::read_to_string(&taken).ok();
    let _ = std::fs::remove_file(&taken);

    let status = contents?.trim().to_string();
    if status.is_empty() {
        // An empty payload is the hook's explicit "clear" (SessionEnd / exit trap).
        return Some(None);
    }
    Some(Some(status))
}

/// The full env the daemon spawns this pane's shell with (design G1/S11). tmux's
/// session-environment indirection is gone, but the ZDOTDIR overlay is NOT: it is how
/// grove gets `~/.grove/bin` onto PATH after all user config, which in turn delivers the
/// `open` link-interception wrapper and the `claude`/`codex`/`grove-hook` shims that the
/// AI-status channel depends on. Dropping it silently disables both features.
fn daemon_child_env(session_id: &str) -> Vec<(String, String)> {
    let mut env = portable_terminal_env_pairs();
    env.push(("GROVE_SESSION_ID".to_string(), session_id.to_string()));
    if let Some(path) = ai_status_file_path(session_id) {
        env.push((
            "GROVE_AI_STATUS_FILE".to_string(),
            path.to_string_lossy().into_owned(),
        ));
    }
    if let Some(zdotdir) = tool_hooks::grove_zdotdir() {
        env.push(("GROVE_REAL_ZDOTDIR".to_string(), grove_real_zdotdir()));
        env.push(("ZDOTDIR".to_string(), zdotdir));
    }
    env
}

/// The user's own ZDOTDIR, so grove's overlay rc files can source the real ones.
fn grove_real_zdotdir() -> String {
    let real_zdotdir = env::var("ZDOTDIR").unwrap_or_default();
    let grove_zsh = tool_hooks::grove_zdotdir();

    // If ZDOTDIR is set and it's NOT our own Grove zsh dir, honour it.
    if !real_zdotdir.is_empty() && grove_zsh.as_deref() != Some(real_zdotdir.as_str()) {
        return real_zdotdir;
    }

    dirs::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Attach a pane to the PTY daemon (design P9 `createOrAttach`), which spawns or
/// adopts the session and streams its output back through `sink`.
///
/// Async because it crosses the daemon socket (design G1). Both shells already
/// `await` this command, so the signature change is invisible above grove-core.
pub async fn create(
    request: CreatePtyRequest,
    sink: Arc<dyn PtyEventSink>,
) -> Result<CreatePtyResult, String> {
    tool_hooks::ensure_installed();

    let CreatePtyRequest {
        pty_id,
        pane_id,
        worktree_path,
        cwd,
        cols,
        rows,
        restore,
    } = request;

    let pty_id = required_arg("ptyId", &pty_id)?;
    let pane_id = required_arg("paneId", &pane_id)?;
    let worktree_path = required_arg("worktreePath", &worktree_path)?;
    let cwd = required_arg("cwd", &cwd)?;

    {
        let reg = lock_recover(registry());
        if reg.contains_key(pty_id.as_str()) {
            return Err(format!("PTY already exists: {pty_id}"));
        }
    }

    validate_pty_cwd(&cwd)?;

    // Stable session id across relaunches — the reattach identity (design G6).
    let session_name = grove_session_name(&worktree_path, &pane_id);
    let client = daemon::get_or_init_client().await?.client();

    let tracked = Arc::new(Mutex::new(PtyRuntimeState::new(
        cwd.clone(),
        // The child lives in the daemon; grove holds no pid. `last_known_cwd` +
        // the daemon's OSC-7 cwd replace the pid-based cwd probe (design S11).
        None,
        session_name.clone(),
        cols,
        rows,
        None,
        None,
    )));
    let adapter = Arc::new(DaemonSinkAdapter::new(
        pty_id.clone(),
        session_name.clone(),
        Arc::clone(&sink),
        Arc::clone(&tracked),
    ));

    // Subscribe BEFORE the RPC: a fresh shell's prompt is streamed the moment the
    // daemon spawns it, which is strictly before the reply lands. Frames that arrive
    // in that window are held by the adapter's gate and released (snapshot-deduped)
    // below, so nothing is lost and nothing is double-painted.
    client.subscribe(session_name.clone(), Arc::clone(&adapter) as Arc<dyn StreamSubscriber>);

    let scrollback_bytes = config::get_grove_preferences_impl().daemon_scrollback_bytes;
    let outcome = client
        .create_or_attach(CreateOrAttach {
            session_id: session_name.clone(),
            cwd: Some(cwd.clone()),
            cols,
            rows,
            env: daemon_child_env(&session_name),
            scrollback_bytes: Some(scrollback_bytes),
        })
        .await;

    let outcome = match outcome {
        Ok(outcome) => outcome,
        Err(error) => {
            client.unsubscribe(&session_name);
            return Err(error.to_string());
        }
    };

    // Warm adopt (live session) and cold restore (fresh child seeded from disk) both
    // hand the renderer a DaemonSnapshot to replay, so both report `Attached`. A
    // plain fresh spawn reports `Created` with NO hydration — the frontend then seeds
    // its `snapshotFallback` exactly as it does today.
    let (session_state, initial_hydration, snapshot_seq) = match (
        outcome.warm_reattach.as_ref(),
        outcome.cold_restore.as_ref(),
    ) {
        (Some(warm), _) => (
            CreatePtySessionState::Attached,
            Some(warm_initial_hydration(warm)),
            Some(warm.output_sequence),
        ),
        (None, Some(cold)) => (
            CreatePtySessionState::Attached,
            Some(cold_initial_hydration(cold)),
            // A cold-restored session is a FRESH child: its stream seq starts at 0 and
            // the payload came off disk, so no live frame can be inside it.
            None,
        ),
        (None, None) => (CreatePtySessionState::Created, None, None),
    };

    {
        let mut state = lock_recover(&tracked);
        let seed = initial_hydration.as_ref().map(|hydration| HydrationSeed {
            bytes: hydration.text.as_bytes(),
            truncated: hydration.truncated,
        });
        let restore_seed = runtime_restore_seed(session_state, restore.as_ref());
        *state = PtyRuntimeState::new(
            cwd.clone(),
            None,
            session_name.clone(),
            cols,
            rows,
            restore_seed,
            seed,
        );
    }

    let instance = PtyInstance {
        session_name,
        worktree_path,
        sink,
        subscriber: Arc::clone(&adapter),
        tracked,
    };

    // Registry insert + gate release are ONE decision, taken under the gate lock: the
    // `Exit` frame rides the stream socket and can overtake the control reply, so a
    // shell that died during the RPC must NOT be published as a live pane (see
    // `ReplayGate`). Either way the buffered frames are replayed, so the dying shell's
    // last output still reaches the screen.
    adapter.open_gate(snapshot_seq, || {
        lock_recover(registry()).insert(pty_id, instance);
    });

    Ok(CreatePtyResult {
        session_state,
        initial_hydration,
    })
}

/// Map a warm-reattach reply onto the (frozen) `CreatePtyInitialHydration` wire shape.
fn warm_initial_hydration(warm: &WarmReattach) -> CreatePtyInitialHydration {
    CreatePtyInitialHydration {
        text: warm.snapshot.clone(),
        // The daemon serializes a complete screen + scrollback view; nothing was
        // dropped on the way out (a truncated ring is the daemon's own cap, which the
        // snapshot already reflects).
        truncated: false,
        source: CreatePtyInitialHydrationSource::DaemonSnapshot,
        snapshot_cols: Some(warm.cols),
        snapshot_rows: Some(warm.rows),
        pending_escape_tail_ansi: warm.pending_escape_tail_ansi.clone(),
        kitty_keyboard_flags: warm.kitty_keyboard_flags,
        is_alternate_screen: Some(warm.is_alternate_screen),
        is_cold_restore: None,
    }
}

/// Map a cold-restore payload onto the same wire shape, flagged so the renderer runs
/// the cold reset bundle and acks it (design S15 cold variant / P16).
fn cold_initial_hydration(cold: &ColdRestorePayload) -> CreatePtyInitialHydration {
    CreatePtyInitialHydration {
        text: cold.snapshot.clone(),
        truncated: false,
        source: CreatePtyInitialHydrationSource::DaemonSnapshot,
        snapshot_cols: Some(cold.cols),
        snapshot_rows: Some(cold.rows),
        pending_escape_tail_ansi: cold.pending_escape_tail_ansi.clone(),
        kitty_keyboard_flags: None,
        is_alternate_screen: Some(cold.is_alternate_screen),
        is_cold_restore: Some(true),
    }
}

/// Resolve a pane's daemon session id, or `None` when the pane is unknown.
fn session_id_for(id: &str) -> Option<String> {
    lock_recover(registry())
        .get(id)
        .map(|instance| instance.session_name.clone())
}

fn require_session_id(id: &str) -> Result<String, String> {
    session_id_for(id).ok_or_else(|| format!("PTY not found: {}", id))
}

/// Send input to a pane (design P6 notify). NOT gated on a daemon ACK — the notify is
/// queued on the control channel and returns; keystroke latency never waits on an RPC
/// round trip. Ordering is preserved by the daemon's per-session FIFO writer.
pub async fn write(id: &str, data: &[u8]) -> Result<(), String> {
    let session_id = require_session_id(id)?;
    let client = daemon::get_or_init_client().await?.client();
    client
        .write(&session_id, data)
        .await
        .map_err(|error| error.to_string())
}

/// Resize a pane (design P6 notify). Same non-blocking contract as `write`.
pub async fn resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let session_id = require_session_id(id)?;
    {
        let reg = lock_recover(registry());
        if let Some(instance) = reg.get(id) {
            let mut state = lock_recover(&instance.tracked);
            state.cols = cols;
            state.rows = rows;
        }
    }
    let client = daemon::get_or_init_client().await?.client();
    client
        .resize(&session_id, cols, rows)
        .await
        .map_err(|error| error.to_string())
}

/// Read back the size the daemon emulator has actually applied to this pane
/// (design G8/P15 `getAppliedSize`) — no shell-out. The UI reconciles xterm's grid
/// against the size the shell/TUI truly sees, so the resize path converges on the
/// authoritative grid instead of its own optimistic tracking.
///
/// Returns `None` when the pane/session is gone — a normal race on a live UI path,
/// not an error we should surface to the renderer.
pub async fn applied_pty_size(id: &str) -> Result<Option<AppliedPtySize>, String> {
    // Why: an evicted/unknown pane is the "pane is gone" case, not a fault.
    let Some(session_id) = session_id_for(id) else {
        return Ok(None);
    };

    let client = daemon::get_or_init_client().await?.client();
    match client.applied_size(&session_id).await {
        Ok((cols, rows)) if cols > 0 && rows > 0 => Ok(Some(AppliedPtySize { cols, rows })),
        // A zero dimension is a not-yet-sized session — treat it as "no readback yet"
        // so a bogus grid never reaches the renderer's resize reconcile.
        Ok(_) => Ok(None),
        // Session killed mid-flight (GC, crash, exit) is expected; don't error — the
        // renderer's reassert loop treats None as "skip this round".
        Err(error) if is_session_missing(&error) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Does this client error mean "the daemon no longer has that session"? A vanished
/// session is a race on a live UI path, not a fault.
fn is_session_missing(error: &daemon::ClientError) -> bool {
    matches!(error, daemon::ClientError::Rpc(rpc) if rpc.message == SESSION_NOT_FOUND_MESSAGE)
}

/// The daemon's `SessionNotFound` RPC error message (grove-daemon `server.rs`).
const SESSION_NOT_FOUND_MESSAGE: &str = "SessionNotFound";

/// Clear a pane's scrollback (design item 4). The daemon drops its byte-exact ring +
/// emulator scrollback and logs a `Clear` frame; only once it acks do we clear the
/// local mirror, so the two can never disagree about what the pane still holds.
pub async fn clear_scrollback(id: &str) -> Result<(), String> {
    let (session_id, tracked) = {
        let reg = lock_recover(registry());
        let instance = reg
            .get(id)
            .ok_or_else(|| format!("PTY not found: {}", id))?;
        (instance.session_name.clone(), Arc::clone(&instance.tracked))
    };

    let client = daemon::get_or_init_client().await?.client();
    client
        .clear_history(&session_id)
        .await
        .map_err(|error| error.to_string())?;

    let mut state = lock_recover(&tracked);
    state.scrollback.clear();
    state.scrollback_truncated = false;

    Ok(())
}

/// Close a pane: kill the daemon session (the daemon stamps `ended_at`, making the
/// pane cold-restore INELIGIBLE — a deliberate close is a clean end, design D2) and
/// drop the registry entry.
pub async fn close(id: &str) -> Result<(), String> {
    let session_id = require_session_id(id)?;

    let client = daemon::get_or_init_client().await?.client();
    let killed = client.kill(&session_id).await;

    let removed = lock_recover(registry()).remove(id);
    if removed.is_some() {
        client.unsubscribe(&session_id);
        client.clear_sleep_restore(&session_id);
    }

    // The registry entry is gone either way — a pane the daemon already reaped must
    // not be left behind on a transport hiccup.
    killed.map_err(|error| error.to_string())
}

/// Close every pane grove has open for a worktree. No orphan sweep is needed: the
/// daemon owns the sessions, and a session grove never attached to in this process is
/// still reachable by id (worktree removal also drops its history via terminal GC).
pub async fn close_ptys_for_worktree(worktree_path: &str) -> Result<(), String> {
    for id in ids_for_worktree(worktree_path) {
        if let Err(error) = close(&id).await {
            eprintln!("Warning: failed to close PTY {id} for worktree {worktree_path}: {error}");
        }
    }

    Ok(())
}

fn ids_for_worktree(worktree_path: &str) -> Vec<String> {
    let reg = lock_recover(registry());
    reg.iter()
        .filter(|(_, instance)| instance.worktree_path == worktree_path)
        .map(|(id, _)| id.clone())
        .collect()
}

/// Sync bridge for [`WorktreeResource::on_remove`], which is a sync trait called from
/// inside `spawn_blocking` (worktree removal). The blocking bridge REFUSES an ambient
/// tokio runtime (design R12), so the kills run on a scratch thread that has no
/// runtime context — there the handle's OWN runtime drives them. Registry removal
/// happens regardless, so a worktree teardown never leaves a stale pane behind.
fn close_ptys_for_worktree_blocking(worktree_path: &str) -> Result<(), String> {
    let ids = ids_for_worktree(worktree_path);
    if ids.is_empty() {
        return Ok(());
    }

    let sessions: Vec<(String, String)> = ids
        .iter()
        .filter_map(|id| session_id_for(id).map(|session_id| (id.clone(), session_id)))
        .collect();
    {
        let mut reg = lock_recover(registry());
        for (id, _) in &sessions {
            reg.remove(id);
        }
    }

    let Some(handle) = daemon::global_client() else {
        // No client was ever initialized ⇒ no daemon session can exist for these
        // panes; dropping the registry entries above is the whole job.
        return Ok(());
    };

    let session_ids: Vec<String> = sessions
        .into_iter()
        .map(|(_, session_id)| session_id)
        .collect();
    std::thread::spawn(move || {
        for session_id in session_ids {
            if let Err(error) = handle.kill_blocking(&session_id) {
                eprintln!("Warning: failed to kill daemon session {session_id}: {error}");
            }
            handle.client().unsubscribe(&session_id);
        }
    })
    .join()
    .map_err(|_| "worktree PTY teardown thread panicked".to_string())
}

/// Terminal GC (design §9), on the daemon backend.
///
/// The liveness partition keys off the DAEMON's `listSessions`: a registry entry whose
/// session the daemon no longer knows is dead, a worktree whose directory is gone is
/// stale, and its sessions get killed over the socket. `TerminalGcReport` is unchanged.
///
/// Two guards are load-bearing:
///  - **Another app connected → stand down entirely.** `connected_clients()` counts
///    the CALLER's own control socket, so the gate is `> 1`, not `> 0` (a `> 0` test
///    would disable GC forever). A second connected app may reattach any session, so
///    we reap nothing rather than pull the rug out from under it.
///  - **No daemon → fail open.** If the client cannot be reached we do NOT reap the
///    registry and do NOT prune history: an unreachable daemon proves nothing about
///    session liveness, and killing every open pane on a transport hiccup is strictly
///    worse than leaking one dir. Filesystem-only pruning still runs.
pub async fn run_terminal_gc(dry_run: bool) -> Result<TerminalGcReport, String> {
    let referenced_paths = collect_referenced_worktree_paths()?;

    // Snapshot the registry BEFORE asking the daemon what it knows. Ordering matters:
    // `create` inserts a pane only AFTER `createOrAttach` returns, so anything in this
    // snapshot was created before the query — "absent from listSessions" is therefore
    // conclusive death, never a create race, and needs no re-verification round trip.
    let registry_snapshot: Vec<RegistryReapEntry> = {
        let reg = lock_recover(registry());
        reg.iter()
            .map(|(pty_id, instance)| RegistryReapEntry {
                pty_id: pty_id.clone(),
                session_name: instance.session_name.clone(),
                reader_exited: lock_recover(&instance.tracked).reader_exited,
            })
            .collect()
    };

    let client = match daemon::get_or_init_client().await {
        Ok(handle) => handle.client(),
        Err(error) => {
            crate::logger::emit_log(
                "warn",
                "pty",
                &format!("terminal GC: daemon unavailable, skipping session reaping: {error}"),
            );
            return run_terminal_gc_without_daemon(&referenced_paths, dry_run);
        }
    };

    // The gauge INCLUDES our own control connection, so `> 1` means another app.
    let another_app_connected = client
        .connected_clients()
        .await
        .map(|count| count > 1)
        .unwrap_or(false);
    if another_app_connected {
        crate::logger::emit_log(
            "info",
            "pty",
            "terminal GC: another app is connected to the daemon; standing down",
        );
        return Ok(TerminalGcReport::default());
    }

    let sessions = client
        .list_sessions()
        .await
        .map_err(|error| format!("terminal GC: failed to list daemon sessions: {error}"))?;
    let known_sessions = daemon::gc::known_session_ids(&sessions);

    let attached_session_names: HashSet<String> = registry_snapshot
        .iter()
        .map(|entry| entry.session_name.clone())
        .collect();
    let session_infos =
        daemon_gc_session_infos(&sessions, &referenced_paths, &attached_session_names);
    let plan = build_terminal_gc_plan(referenced_paths.clone(), &session_infos);
    let reap_plan = build_registry_reap_plan(&registry_snapshot, &known_sessions);

    let mut report = TerminalGcReport {
        stale_worktree_paths: plan.stale_worktree_paths.clone(),
        stale_session_names: plan.stale_session_names.clone(),
        skipped_attached_worktree_paths: plan.skipped_attached_worktree_paths.clone(),
        dead_reader_pty_ids: reap_plan.dead_reader_pty_ids.clone(),
        ..TerminalGcReport::default()
    };

    for pty_id in &reap_plan.dead_reader_pty_ids {
        crate::logger::emit_log(
            "warn",
            "pty",
            &format!("terminal GC: PTY {pty_id} has a live session but an exited reader"),
        );
    }

    if dry_run {
        report.reaped_pty_ids = reap_plan
            .reap_candidates
            .iter()
            .map(|candidate| candidate.pty_id.clone())
            .collect();
        return Ok(report);
    }

    report.reaped_pty_ids = reap_dead_registry_entries(&reap_plan.reap_candidates);

    let leftover_candidates = collect_process_tree_candidates(&plan.stale_session_pane_pids);

    for worktree_path in &plan.stale_worktree_paths {
        config::remove_terminal_layouts_for_worktree(worktree_path)?;
        config::remove_terminal_session_snapshot_for_worktree(worktree_path)?;
        config::remove_panel_layouts_for_worktree(worktree_path)?;
        report.pruned_worktree_paths.push(worktree_path.clone());
    }

    for session_name in &plan.stale_session_names {
        match client.kill(session_name).await {
            Ok(()) => {
                drop_registry_entries_for_session(session_name);
                client.unsubscribe(session_name);
                report.killed_session_names.push(session_name.clone());
            }
            Err(error) => {
                eprintln!("Warning: failed to kill stale Grove daemon session {session_name}: {error}")
            }
        }
    }

    // The child processes live under the DAEMON, and killing a session does not always
    // take its whole tree down transitively — this sweep of the pane pid's descendants
    // is what catches a detached leftover (a nohup'd agent, a stray dev server) after
    // its pane is gone.
    report.leftover_process_ids = terminate_leftover_processes(&leftover_candidates);

    prune_daemon_history_dirs(&known_sessions, &referenced_paths);

    Ok(report)
}

/// GC with no reachable daemon: prune the filesystem-derived state only. Never reaps
/// the registry, never kills a session, never touches history — an unreachable daemon
/// proves nothing about liveness (fail open).
fn run_terminal_gc_without_daemon(
    referenced_paths: &[String],
    dry_run: bool,
) -> Result<TerminalGcReport, String> {
    let plan = build_terminal_gc_plan(referenced_paths.to_vec(), &[]);
    let mut report = TerminalGcReport {
        stale_worktree_paths: plan.stale_worktree_paths.clone(),
        ..TerminalGcReport::default()
    };
    if dry_run {
        return Ok(report);
    }
    for worktree_path in &plan.stale_worktree_paths {
        config::remove_terminal_layouts_for_worktree(worktree_path)?;
        config::remove_terminal_session_snapshot_for_worktree(worktree_path)?;
        config::remove_panel_layouts_for_worktree(worktree_path)?;
        report.pruned_worktree_paths.push(worktree_path.clone());
    }
    Ok(report)
}

/// Attribute each daemon session to a worktree, in the shape `build_terminal_gc_plan`
/// consumes.
///
/// The daemon does not store a worktree path per session — but it does not have to:
/// a session id IS `grove-{hash(worktree)}-{pane}` (design G6), so the worktree hash
/// prefix attributes it exactly, and that identity is the very thing that survives
/// relaunches. A session whose prefix matches no known worktree is skipped (grove
/// cannot prove whose it is, so it must not kill it).
///
/// `attached` = grove currently holds this session in its pane registry. That is what
/// spares a worktree whose directory is only transiently missing.
fn daemon_gc_session_infos(
    sessions: &[daemon::SessionInfo],
    referenced_paths: &[String],
    attached_session_names: &HashSet<String>,
) -> Vec<TerminalGcSessionInfo> {
    let prefixes: Vec<(String, String)> = referenced_paths
        .iter()
        .map(|path| (session_worktree_prefix(path), path.clone()))
        .collect();

    sessions
        .iter()
        .filter_map(|session| {
            let worktree_path = prefixes
                .iter()
                .find(|(prefix, _)| session.session_id.starts_with(prefix.as_str()))
                .map(|(_, path)| path.clone())?;
            Some(TerminalGcSessionInfo {
                session_name: session.session_id.clone(),
                worktree_path,
                attached: attached_session_names.contains(&session.session_id),
                pane_pid: session.pid,
            })
        })
        .collect()
}

/// The `grove-{worktree hash}-` prefix every session id for `worktree_path` carries.
fn session_worktree_prefix(worktree_path: &str) -> String {
    format!("grove-{}-", short_hash(worktree_path, WORKTREE_HASH_LEN))
}

/// Prune per-session history dirs the daemon no longer needs (design §9c) via the
/// pure planner in `daemon::gc`: a dir is reaped only when its session is DEAD (the
/// daemon does not know the id), its pane is UNREFERENCED by any surviving layout,
/// and it is older than the 5-minute young-dir guard (so a dir mid-first-checkpoint,
/// created before its session registered, is never raced away).
fn prune_daemon_history_dirs(known_sessions: &HashSet<String>, referenced_paths: &[String]) {
    let Some(base_dir) = daemon::runtime_base_dir().or_else(|| config::daemon_runtime_dir().ok())
    else {
        return;
    };
    let root = daemon::protocol::history_root(&base_dir);
    let dirs = match collect_history_dirs(&root) {
        Ok(dirs) => dirs,
        Err(error) => {
            crate::logger::emit_log(
                "warn",
                "pty",
                &format!("terminal GC: failed to scan the history root: {error}"),
            );
            return;
        }
    };
    if dirs.is_empty() {
        return;
    }

    let referenced_session_ids = collect_referenced_session_ids(referenced_paths);
    let plan = daemon::gc::plan_history_gc(&daemon::gc::HistoryGcInput {
        dirs: &dirs,
        daemon_session_ids: known_sessions,
        referenced_session_ids: &referenced_session_ids,
        // The caller already stood GC down entirely if another app was connected, so
        // by construction we are the only client here.
        any_app_connected: false,
        min_age: daemon::gc::GC_MIN_AGE,
    });

    for session_id in plan {
        let dir = root.join(percent_encode_session_id(&session_id));
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => crate::logger::emit_log(
                "info",
                "pty",
                &format!("terminal GC: pruned the history dir for dead session {session_id}"),
            ),
            Err(error) => crate::logger::emit_log(
                "warn",
                "pty",
                &format!("terminal GC: failed to prune {}: {error}", dir.display()),
            ),
        }
    }
}

/// Enumerate the per-session dirs under the history root with their ages. A missing
/// root (no daemon has ever checkpointed) is an empty list, not an error.
fn collect_history_dirs(root: &Path) -> Result<Vec<daemon::gc::HistoryDirInfo>, String> {
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(root).map_err(|error| error.to_string())?;
    let now = std::time::SystemTime::now();
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let Some(session_id) = entry
            .file_name()
            .to_str()
            .and_then(percent_decode_session_id)
        else {
            continue;
        };
        // Age from the newest of created/modified: a dir being actively checkpointed
        // is young by mtime even if its inode is old, so the guard never races a live
        // writer. An unreadable timestamp reads as age 0 (spared).
        let age = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().or_else(|_| meta.created()).ok())
            .and_then(|stamp| now.duration_since(stamp).ok())
            .unwrap_or_default();
        dirs.push(daemon::gc::HistoryDirInfo::new(session_id, age));
    }
    Ok(dirs)
}

/// Every session id still referenced by a layout whose worktree EXISTS. A pane whose
/// worktree is gone is deliberately absent — that absence is what makes its history
/// dir an orphan.
fn collect_referenced_session_ids(referenced_paths: &[String]) -> HashSet<String> {
    let mut ids = HashSet::new();
    let existing: HashSet<&String> = referenced_paths
        .iter()
        .filter(|path| Path::new(path).exists())
        .collect();

    if let Ok(raw) = config::load_terminal_layouts_impl() {
        if let Ok(layouts) = serde_json::from_str::<serde_json::Map<String, Value>>(&raw) {
            for (worktree_path, layout) in layouts {
                if !existing.contains(&worktree_path) {
                    continue;
                }
                collect_layout_session_ids(&worktree_path, &layout, &mut ids);
            }
        }
    }

    // Global-terminal panes hang off the app's base dir, not a worktree, so they are
    // always "referenced" while the layout names them.
    if let Ok(raw) = config::load_panel_layouts_impl() {
        if let Ok(ids_from_panels) = panel_layout_session_ids(&raw) {
            ids.extend(ids_from_panels);
        }
    }

    ids
}

fn panel_layout_session_ids(raw: &str) -> Result<HashSet<String>, String> {
    let panels: Value = serde_json::from_str(raw)
        .map_err(|error| format!("Failed to parse panel-layouts.json: {error}"))?;

    let mut session_names = HashSet::new();
    let base_dir = config::load_app_config().base_dir;

    if let Some(tabs) = panels
        .get("globalTerminal")
        .and_then(|gt| gt.get("tabs"))
        .and_then(Value::as_array)
    {
        for tab in tabs {
            if tab.get("mirrorPtyId").and_then(Value::as_str).is_some() {
                continue;
            }
            if let Some(pane_id) = tab.get("paneId").and_then(Value::as_str) {
                session_names.insert(grove_session_name(&base_dir, pane_id));
            }
        }
    }

    Ok(session_names)
}

fn collect_layout_session_ids(
    worktree_path: &str,
    node: &Value,
    session_names: &mut HashSet<String>,
) {
    let Some(object) = node.as_object() else {
        return;
    };

    let node_type = object.get("type").and_then(Value::as_str);
    if node_type == Some("horizontal") || node_type == Some("vertical") {
        if let Some(children) = object.get("children").and_then(Value::as_array) {
            for child in children {
                collect_layout_session_ids(worktree_path, child, session_names);
            }
        }
        return;
    }

    if let Some(pane_id) = object.get("id").and_then(Value::as_str) {
        session_names.insert(grove_session_name(worktree_path, pane_id));
    }
}

/// Percent-encode a session id into its history dir name — the same transform the
/// daemon's `history::percent_encode` applies. grove session ids are already
/// RFC-3986 unreserved (`grove-<hex>-<alnum>`), so this is the identity for every id
/// grove mints; it exists so a hand-crafted or future id still lands on the right dir.
fn percent_encode_session_id(session_id: &str) -> String {
    let mut out = String::with_capacity(session_id.len());
    for &b in session_id.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out
}

/// Inverse of [`percent_encode_session_id`]; `None` on a malformed escape (the dir is
/// then not ours and is left alone).
fn percent_decode_session_id(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                if i + 2 >= bytes.len() {
                    return None;
                }
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
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

struct RegistryReapEntry {
    pty_id: String,
    session_name: String,
    reader_exited: bool,
}

struct RegistryReapPlan {
    reap_candidates: Vec<RegistryReapCandidate>,
    dead_reader_pty_ids: Vec<String>,
}

struct RegistryReapCandidate {
    pty_id: String,
    #[allow(dead_code)]
    session_name: String,
}

/// Removes confirmed-dead registry entries and returns the reaped PTY ids. No
/// re-verification round trip is needed: the registry snapshot was taken BEFORE
/// `listSessions`, so a candidate cannot be a not-yet-known fresh session.
fn reap_dead_registry_entries(candidates: &[RegistryReapCandidate]) -> Vec<String> {
    let mut reaped = Vec::new();
    for candidate in candidates {
        let removed = lock_recover(registry()).remove(&candidate.pty_id);
        if removed.is_some() {
            // No local child to reap any more — the daemon owns (and reaps) the child.
            crate::logger::emit_log(
                "info",
                "pty",
                &format!(
                    "terminal GC: reaped PTY {} (daemon session {} no longer exists)",
                    candidate.pty_id, candidate.session_name
                ),
            );
            reaped.push(candidate.pty_id.clone());
        }
    }
    reaped
}

/// Partitions a registry snapshot against the DAEMON's known session set (design §9a).
/// A pane whose session the daemon no longer knows is dead: its sink subscription and
/// registry entry leak until reaped. An entry whose session is known but whose reader
/// exited is report-only — the session (and the user's shell) must survive.
///
/// Keyed on KNOWN (not alive): a dead-but-unreaped session is still the daemon's to
/// clean up, and reaping grove's side out from under it would race its own teardown.
fn build_registry_reap_plan(
    snapshot: &[RegistryReapEntry],
    known_sessions: &HashSet<String>,
) -> RegistryReapPlan {
    let mut reap_candidates = Vec::new();
    let mut dead_reader_pty_ids = Vec::new();

    for entry in snapshot {
        if !known_sessions.contains(&entry.session_name) {
            reap_candidates.push(RegistryReapCandidate {
                pty_id: entry.pty_id.clone(),
                session_name: entry.session_name.clone(),
            });
        } else if entry.reader_exited {
            dead_reader_pty_ids.push(entry.pty_id.clone());
        }
    }

    RegistryReapPlan {
        reap_candidates,
        dead_reader_pty_ids,
    }
}

/// Startup GC. Same body as the periodic job — the tmux-only session sweep this used
/// to wrap is gone, and the one-time kill of leftover grove-* tmux sessions from a
/// pre-daemon build lives in [`crate::tmux_sweep`], which the shells call directly.
pub async fn cleanup_stale_sessions_on_startup() -> Result<(), String> {
    run_terminal_gc(false).await.map(|_| ())
}

/// Drop every registry entry pointing at a session grove just killed.
fn drop_registry_entries_for_session(session_name: &str) {
    let mut reg = lock_recover(registry());
    let matching_ids: Vec<String> = reg
        .iter()
        .filter(|(_, instance)| instance.session_name == session_name)
        .map(|(id, _)| id.clone())
        .collect();
    for id in matching_ids {
        reg.remove(&id);
    }
}

fn collect_referenced_worktree_paths() -> Result<Vec<String>, String> {
    let mut paths = BTreeSet::new();

    let terminal_layouts: serde_json::Map<String, Value> =
        serde_json::from_str(&config::load_terminal_layouts_impl()?)
            .map_err(|error| format!("Failed to parse terminal-layouts.json: {error}"))?;
    paths.extend(terminal_layouts.keys().cloned());

    let panel_layouts: serde_json::Map<String, Value> =
        serde_json::from_str(&config::load_panel_layouts_impl()?)
            .map_err(|error| format!("Failed to parse panel-layouts.json: {error}"))?;
    paths.extend(
        panel_layouts
            .keys()
            .filter(|key| Path::new(key).is_absolute())
            .cloned(),
    );

    let snapshot_store = config::load_terminal_session_snapshot_store()?;
    paths.extend(snapshot_store.worktrees.into_keys());

    Ok(paths.into_iter().collect())
}

fn build_terminal_gc_plan(
    referenced_paths: Vec<String>,
    session_infos: &[TerminalGcSessionInfo],
) -> TerminalGcPlan {
    let mut missing_paths = BTreeSet::new();
    let mut sessions_by_worktree: BTreeMap<String, Vec<&TerminalGcSessionInfo>> = BTreeMap::new();

    for worktree_path in referenced_paths {
        if !Path::new(&worktree_path).exists() {
            missing_paths.insert(worktree_path);
        }
    }

    for session in session_infos {
        if !Path::new(&session.worktree_path).exists() {
            missing_paths.insert(session.worktree_path.clone());
        }
        sessions_by_worktree
            .entry(session.worktree_path.clone())
            .or_default()
            .push(session);
    }

    let mut stale_worktree_paths = Vec::new();
    let mut stale_session_names = BTreeSet::new();
    let mut stale_session_pane_pids = BTreeSet::new();
    let mut skipped_attached_worktree_paths = Vec::new();

    for worktree_path in missing_paths {
        let attached_sessions = sessions_by_worktree
            .get(&worktree_path)
            .is_some_and(|sessions| sessions.iter().any(|session| session.attached));

        if attached_sessions {
            skipped_attached_worktree_paths.push(worktree_path);
            continue;
        }

        stale_worktree_paths.push(worktree_path.clone());

        if let Some(sessions) = sessions_by_worktree.get(&worktree_path) {
            for session in sessions.iter().filter(|session| !session.attached) {
                stale_session_names.insert(session.session_name.clone());
                if let Some(pane_pid) = session.pane_pid {
                    stale_session_pane_pids.insert(pane_pid);
                }
            }
        }
    }

    TerminalGcPlan {
        stale_worktree_paths,
        stale_session_names: stale_session_names.into_iter().collect(),
        stale_session_pane_pids: stale_session_pane_pids.into_iter().collect(),
        skipped_attached_worktree_paths,
    }
}

fn collect_process_tree_candidates(root_pids: &[u32]) -> BTreeSet<u32> {
    let processes = match list_process_snapshots() {
        Ok(processes) => processes,
        Err(error) => {
            eprintln!("Warning: failed to collect process tree for terminal GC: {error}");
            return BTreeSet::new();
        }
    };

    let children_by_pid: HashMap<u32, Vec<u32>> =
        processes.iter().fold(HashMap::new(), |mut acc, process| {
            acc.entry(process.ppid).or_default().push(process.pid);
            acc
        });

    let mut candidates = BTreeSet::new();
    for root_pid in root_pids {
        let mut stack = vec![*root_pid];
        while let Some(pid) = stack.pop() {
            if !candidates.insert(pid) {
                continue;
            }
            if let Some(children) = children_by_pid.get(&pid) {
                stack.extend(children.iter().copied());
            }
        }
    }

    candidates
}

fn terminate_leftover_processes(candidate_pids: &BTreeSet<u32>) -> Vec<u32> {
    if candidate_pids.is_empty() {
        return Vec::new();
    }

    sleep(TERMINAL_GC_PROCESS_EXIT_GRACE);

    let live_after_session_kill = match list_process_snapshots() {
        Ok(processes) => processes
            .into_iter()
            .map(|process| process.pid)
            .collect::<HashSet<_>>(),
        Err(error) => {
            eprintln!("Warning: failed to inspect leftover processes after terminal GC: {error}");
            return Vec::new();
        }
    };

    let leftover: Vec<u32> = candidate_pids
        .iter()
        .copied()
        .filter(|pid| live_after_session_kill.contains(pid))
        .collect();
    if leftover.is_empty() {
        return leftover;
    }

    if let Err(error) = signal_processes(&leftover, "-TERM") {
        eprintln!("Warning: failed to terminate leftover processes after terminal GC: {error}");
        return leftover;
    }

    sleep(TERMINAL_GC_PROCESS_EXIT_GRACE);

    let still_running = match list_process_snapshots() {
        Ok(processes) => {
            let live = processes
                .into_iter()
                .map(|process| process.pid)
                .collect::<HashSet<_>>();
            leftover
                .iter()
                .copied()
                .filter(|pid| live.contains(pid))
                .collect::<Vec<_>>()
        }
        Err(error) => {
            eprintln!(
                "Warning: failed to re-check leftover processes after SIGTERM during terminal GC: {error}"
            );
            return leftover;
        }
    };

    if !still_running.is_empty() {
        if let Err(error) = signal_processes(&still_running, "-KILL") {
            eprintln!("Warning: failed to SIGKILL leftover processes after terminal GC: {error}");
        }
    }

    leftover
}

fn signal_processes(pids: &[u32], signal: &str) -> Result<(), String> {
    for pid in pids {
        let output = Command::new("kill")
            .args([signal, &pid.to_string()])
            .output()
            .map_err(|error| format!("failed to execute kill {signal} {pid}: {error}"))?;

        if !output.status.success() {
            let message = command_output_message(&output);
            if message.contains("No such process") {
                continue;
            }
            return Err(format!("kill {signal} {pid} failed: {message}"));
        }
    }

    Ok(())
}

/// The most useful human-readable line from a failed subprocess: stderr, else stdout,
/// else the exit status. (Was `tmux_output_message`; `kill` is the only shell-out in
/// this module that still needs it.)
fn command_output_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }

    format!("kill exited with status {}", output.status)
}

fn reconcile_hookless_ai_status(
    current_ai_status: Option<&str>,
    live_tool: Option<&str>,
    last_ai_status: Option<&str>,
    last_output_at: Option<Instant>,
) -> Option<String> {
    let Some(live_tool) = live_tool else {
        return current_ai_status.map(str::to_string);
    };

    let current_tool = current_ai_status.and_then(|status| status.split(':').next());
    if current_tool == Some(live_tool) {
        return current_ai_status.map(str::to_string);
    }

    Some(recover_hookless_ai_status(
        live_tool,
        last_ai_status,
        last_output_at,
    ))
}

fn recover_hookless_ai_status(
    tool: &str,
    last_ai_status: Option<&str>,
    last_output_at: Option<Instant>,
) -> String {
    if let Some(previous) = last_ai_status {
        let previous_tool = previous.split(':').next().unwrap_or_default();
        if previous_tool == tool && !previous.ends_with(":attention") {
            return previous.to_string();
        }
    }

    if last_output_at.is_some_and(|t| t.elapsed() < CODEX_OUTPUT_IDLE_TIMEOUT) {
        format!("{tool}:running")
    } else {
        format!("{tool}:idle")
    }
}

fn detect_live_hookless_tool_in_session_from_processes(
    pane_pid: Option<u32>,
    processes: &[ProcessSnapshot],
) -> Option<&'static str> {
    detect_hookless_tool_from_process_tree(pane_pid?, processes)
}

fn list_process_snapshots() -> Result<Vec<ProcessSnapshot>, String> {
    let output = Command::new("ps")
        .args(["-Ao", "pid=,ppid=,command="])
        .output()
        .map_err(|error| format!("failed to list processes: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "failed to list processes: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(parse_process_snapshots(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn parse_process_snapshots(output: &str) -> Vec<ProcessSnapshot> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }

            let mut parts = trimmed.split_whitespace();
            let pid = parts.next()?.parse::<u32>().ok()?;
            let ppid = parts.next()?.parse::<u32>().ok()?;
            let command_line = parts.collect::<Vec<_>>().join(" ");
            if command_line.is_empty() {
                return None;
            }

            Some(ProcessSnapshot {
                pid,
                ppid,
                command_line,
            })
        })
        .collect()
}

fn detect_hookless_tool_from_process_tree(
    pane_pid: u32,
    processes: &[ProcessSnapshot],
) -> Option<&'static str> {
    let parent_by_pid: HashMap<u32, u32> = processes
        .iter()
        .map(|process| (process.pid, process.ppid))
        .collect();

    for process in processes {
        let Some(tool) = ["codex"]
            .into_iter()
            .find(|tool| process_line_mentions_tool(&process.command_line, tool))
            .filter(|tool| tool_hooks::is_hookless_tool(tool))
        else {
            continue;
        };

        let mut current = Some(process.pid);
        while let Some(pid) = current {
            if pid == pane_pid {
                return Some(tool);
            }
            current = parent_by_pid
                .get(&pid)
                .copied()
                .filter(|parent| *parent > 1 && *parent != pid);
        }
    }

    None
}

fn process_line_mentions_tool(command_line: &str, tool: &str) -> bool {
    command_line.split_whitespace().any(|token| {
        let token = token.trim_matches(|ch| matches!(ch, '"' | '\'' | '`'));
        let basename = token.rsplit('/').next().unwrap_or(token);
        basename == tool
    })
}

/// One row of the daemon's `pollBells` reply, re-keyed from the daemon SESSION id
/// to the pane's grove PTY id by the caller. The daemon returns a row per LIVE
/// session on every poll — bells DRAINED, ai_status READ — so the delta machine
/// below is what turns that into the sparse `PtyBellEvent` stream the renderer
/// contract expects (an event only when a bell fired or the status CHANGED).
struct DaemonBellRow {
    bell: bool,
    ai_status: Option<String>,
}

/// Poll every attached pane for a terminal bell + its AI-tool status (design G9).
///
/// The daemon replaced only the SOURCES here, not the machine. It stores status; it
/// does not run the idle/attention state machine — a hookless tool (codex) never
/// reports anything, so a wholesale swap to "just return `pollBells`" would freeze
/// such a pane at `running` forever. So the full client-side machine is preserved:
///
///   1. HOOK CHANNEL — the per-session status file (`GROVE_AI_STATUS_FILE`) is
///      consumed FIRST and WINS over whatever the daemon holds. Daemon-side
///      Enter-detection (`Session::detect_enter`) is the other writer of that store,
///      and it loses to a fresh hook write: last writer wins, and the hook wrote last.
///   2. HOOKLESS RECONCILE — when nothing claims a hookless tool, walk the child
///      process tree (rooted at the daemon-reported child pid) to discover a live one
///      and recover its status.
///   3. IDLE/ATTENTION CLOCK — running →(no output for 3s)→ idle →(30s)→ attention,
///      driven by `last_output_at`, which the daemon stream sink stamps on output.
///
/// The single write-back at the end pushes the resolved status into the daemon's
/// store (`setAiStatus`) whenever it differs from what the daemon reported.
pub async fn poll_bell_events() -> Result<Vec<PtyBellEvent>, String> {
    let tracked_sessions = {
        let reg = lock_recover(registry());
        reg.iter()
            .map(|(pty_id, instance)| {
                (
                    pty_id.clone(),
                    instance.session_name.clone(),
                    Arc::clone(&instance.tracked),
                )
            })
            .collect::<Vec<_>>()
    };

    if tracked_sessions.is_empty() {
        return Ok(Vec::new());
    }

    let client = daemon::get_or_init_client().await?.client();
    let rows: HashMap<String, DaemonBellRow> = client
        .poll_bells()
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        // The daemon keys its rows by SESSION id (it knows nothing of grove pane ids)
        // and ships them in the `PtyBellEvent` shape; re-key onto grove's pty ids.
        .map(|event| {
            (
                event.pty_id,
                DaemonBellRow {
                    bell: event.bell,
                    ai_status: event.ai_status,
                },
            )
        })
        .collect();

    let mut events = Vec::new();
    let mut process_probe: Option<HooklessProbe> = None;

    for (pty_id, session_name, tracked) in tracked_sessions {
        // A session the daemon no longer lists (killed/exited) reads as no bell and
        // no status.
        let (bell, daemon_status) = match rows.get(&session_name) {
            Some(row) => (row.bell, row.ai_status.clone()),
            None => (false, None),
        };

        // (1) The hook channel WINS: a status published since the last tick overrides
        // the daemon's store (which Enter-detection may also have touched).
        let ai_status = match consume_ai_status_file(&session_name) {
            Some(signal) => signal,
            None => daemon_status.clone(),
        };

        // (2) Hookless reconcile — unchanged logic, daemon-fed pid.
        let current_tool = ai_status
            .as_deref()
            .and_then(|status| status.split(':').next());
        let should_probe_live_hookless_tool = ai_status.is_none()
            || current_tool.is_some_and(|tool| !tool_hooks::is_hookless_tool(tool));

        let ai_status = if should_probe_live_hookless_tool {
            // Lazily — and at most once per tick — take one `ps` snapshot plus one
            // `listSessions` (for child pids). A pane that needs no probe pays nothing.
            if process_probe.is_none() {
                process_probe = Some(HooklessProbe::collect(client).await);
            }
            let live_tool = process_probe
                .as_ref()
                .and_then(|probe| probe.live_hookless_tool(&session_name));
            let (last_ai_status, last_output_at) = {
                let state = lock_recover(&tracked);
                (state.last_ai_status.clone(), state.last_output_at)
            };

            reconcile_hookless_ai_status(
                ai_status.as_deref(),
                live_tool,
                last_ai_status.as_deref(),
                last_output_at,
            )
        } else {
            ai_status
        };

        // (3) Hookless tool idle/attention state machine:
        // running → [output idle > 3s] → idle → [30s elapsed] → attention
        // TUI apps produce periodic screen refreshes so we don't revalidate
        // after transitions — the next Enter re-asserts running.
        let ai_ref = ai_status.as_deref();
        let is_hookless = tool_hooks::needs_idle_detection(ai_ref);

        let ai_status = if is_hookless && tool_hooks::is_running(ai_ref) {
            let should_idle = match lock_recover(&tracked).last_output_at {
                Some(t) => t.elapsed() >= CODEX_OUTPUT_IDLE_TIMEOUT,
                None => true, // no output tracked (e.g. after app restart)
            };
            if should_idle {
                Some(tool_hooks::to_idle(ai_ref.unwrap()))
            } else {
                ai_status
            }
        } else if is_hookless && tool_hooks::is_idle(ai_ref) {
            let should_attention = lock_recover(&tracked)
                .idle_since
                .is_some_and(|t| t.elapsed() >= HOOKLESS_ATTENTION_TIMEOUT);
            if should_attention {
                Some(format!(
                    "{}:attention",
                    ai_ref.unwrap().split(':').next().unwrap()
                ))
            } else {
                ai_status
            }
        } else {
            ai_status
        };

        // Write the resolved status back to the daemon's store whenever it differs
        // from what the daemon reported. One store, last writer wins, so a single
        // deduped push at the end of the tick is equivalent to the separate write-backs
        // the reconcile / idle / attention branches each used to perform — and skipping
        // it when nothing changed keeps a steady-state poll free of socket traffic.
        if ai_status != daemon_status {
            if let Err(error) = client
                .set_ai_status(&session_name, ai_status.as_deref())
                .await
            {
                crate::logger::emit_log(
                    "warn",
                    "pty",
                    &format!("failed to publish AI status for {session_name}: {error}"),
                );
            }
        }

        let mut state = lock_recover(&tracked);
        let ai_changed = ai_status != state.last_ai_status;
        if ai_changed {
            // Track running→idle transition for attention timeout.
            let prev = state.last_ai_status.as_deref();
            let next = ai_status.as_deref();
            if tool_hooks::needs_idle_detection(next)
                && tool_hooks::is_idle(next)
                && tool_hooks::is_running(prev)
            {
                state.idle_since = Some(Instant::now());
            } else {
                state.idle_since = None;
            }
            state.last_ai_status = ai_status.clone();
        }
        // DELTA EMISSION (unchanged contract): the daemon hands us one row per live
        // session per poll, but grove emits an event ONLY on a bell or a CHANGED
        // status — never a row-per-tick stream. The bell needs no local edge detector:
        // the daemon DRAINS it, so `true` is already "a bell since the last poll" (and
        // two bells on two consecutive ticks both report, which a rising-edge filter
        // over a latched flag would have swallowed).
        if bell || ai_changed {
            events.push(PtyBellEvent {
                pty_id,
                bell,
                ai_status,
            });
        }
    }

    Ok(events)
}

/// One tick's worth of hookless-tool probing inputs: the machine's process table plus
/// each daemon session's child pid. Collected at most once per poll, and only when a
/// pane actually needs a probe (the common steady state — every pane claimed by a
/// hooked tool, or no AI tool at all — pays nothing).
struct HooklessProbe {
    processes: Vec<ProcessSnapshot>,
    /// Daemon session id → child-shell pid (the root of the pane's process tree).
    pids: HashMap<String, u32>,
}

impl HooklessProbe {
    async fn collect(client: &daemon::DaemonClient) -> Self {
        let processes = list_process_snapshots().unwrap_or_default();
        // A failed `listSessions` degrades to "no pids" → no live-tool detection.
        let pids = client
            .list_sessions()
            .await
            .map(|sessions| {
                sessions
                    .into_iter()
                    .filter_map(|session| Some((session.session_id, session.pid?)))
                    .collect()
            })
            .unwrap_or_default();
        Self { processes, pids }
    }

    fn live_hookless_tool(&self, session_id: &str) -> Option<&'static str> {
        detect_live_hookless_tool_in_session_from_processes(
            self.pids.get(session_id).copied(),
            &self.processes,
        )
    }
}

pub struct PtySessionResource;

impl WorktreeResource for PtySessionResource {
    fn name(&self) -> &str {
        "PTY sessions"
    }

    fn on_remove(&self, worktree_path: &str) -> Result<(), String> {
        close_ptys_for_worktree_blocking(worktree_path)
    }
}

pub async fn save_terminal_session_snapshot(
    request: SaveTerminalSessionSnapshotRequest,
) -> Result<TerminalSessionSnapshot, String> {
    let worktree_path = request.worktree_path.trim();
    if worktree_path.is_empty() {
        return Err("worktreePath is required".to_string());
    }

    if request.panes.is_empty() {
        config::remove_terminal_session_snapshot_for_worktree(worktree_path)?;
        return Ok(TerminalSessionSnapshot {
            worktree_path: worktree_path.to_string(),
            panes: Vec::new(),
        });
    }

    let mut seen_pane_ids = HashSet::new();
    let mut panes = Vec::with_capacity(request.panes.len());
    for pane in &request.panes {
        let pane_id = pane.pane_id.trim();
        if pane_id.is_empty() {
            return Err("paneId is required for every terminal snapshot pane".to_string());
        }
        if !seen_pane_ids.insert(pane_id.to_string()) {
            return Err(format!(
                "Duplicate paneId in terminal snapshot request: {pane_id}"
            ));
        }
        panes.push(build_pane_snapshot(pane).await?);
    }

    let snapshot = TerminalSessionSnapshot {
        worktree_path: worktree_path.to_string(),
        panes,
    };

    config::update_terminal_session_snapshot_store(|store| {
        store
            .worktrees
            .insert(worktree_path.to_string(), snapshot.clone());
        Ok(())
    })?;

    Ok(snapshot)
}

pub fn load_terminal_session_snapshot(
    worktree_path: &str,
) -> Result<Option<TerminalSessionSnapshot>, String> {
    let store = config::load_terminal_session_snapshot_store()?;
    Ok(store.worktrees.get(worktree_path).cloned())
}

async fn build_pane_snapshot(
    input: &TerminalPaneSnapshotInput,
) -> Result<TerminalPaneSnapshot, String> {
    let runtime_state = input
        .pty_id
        .as_deref()
        .filter(|pty_id| !pty_id.trim().is_empty())
        .map(runtime_snapshot_for_pty)
        .transpose()?
        .flatten();

    let launch_cwd = match runtime_state.as_ref() {
        Some(runtime_state) => runtime_state.launch_cwd.clone(),
        None => input
            .launch_cwd
            .as_deref()
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                format!(
                    "launchCwd is required when pane {} has no live ptyId",
                    input.pane_id
                )
            })?,
    };

    // cwd source (design S11/P15): the daemon's OSC-7 tracked cwd, falling back to the
    // cached `last_known_cwd`. A daemon that is unreachable, lagging, or has not seen
    // an OSC 7 yet must NEVER fail the snapshot — the snapshot is what restores the
    // pane, so a missing cwd degrades to the cached/launch cwd instead of erroring.
    let live_cwd = match runtime_state.as_ref() {
        Some(state) => daemon_session_cwd(&state.session_name).await,
        None => None,
    };
    let last_known_cwd = live_cwd.or_else(|| {
        runtime_state
            .as_ref()
            .and_then(|state| state.last_known_cwd.clone())
    });

    if let (Some(pty_id), Some(cwd)) = (input.pty_id.as_deref(), last_known_cwd.as_deref()) {
        cache_last_known_cwd(pty_id, cwd)?;
    }

    let scrollback = runtime_state
        .as_ref()
        .map(|state| String::from_utf8_lossy(&state.scrollback).into_owned())
        .unwrap_or_default();
    let scrollback_truncated = runtime_state
        .as_ref()
        .map(|state| state.scrollback_truncated)
        .unwrap_or(false);

    let (restore_cwd, restore_cwd_source) = match last_known_cwd.clone() {
        Some(cwd) => (cwd, TerminalRestoreCwdSource::LastKnownCwd),
        None => (launch_cwd.clone(), TerminalRestoreCwdSource::LaunchCwd),
    };

    Ok(TerminalPaneSnapshot {
        pane_id: input.pane_id.trim().to_string(),
        scrollback,
        scrollback_truncated,
        launch_cwd,
        last_known_cwd,
        restore_cwd,
        restore_cwd_source,
    })
}

/// The daemon's OSC-7 cwd for a session, or `None` on any failure (no client, no
/// connection, session gone, no OSC 7 seen yet). Deliberately total — see the Why in
/// [`build_pane_snapshot`].
async fn daemon_session_cwd(session_id: &str) -> Option<String> {
    let handle = daemon::get_or_init_client().await.ok()?;
    handle
        .client()
        .cwd(session_id)
        .await
        .ok()
        .flatten()
        .map(|cwd| cwd.trim().to_string())
        .filter(|cwd| !cwd.is_empty())
}

fn runtime_snapshot_for_pty(pty_id: &str) -> Result<Option<PtyRuntimeSnapshot>, String> {
    let tracked = {
        let reg = lock_recover(registry());
        reg.get(pty_id)
            .map(|instance| Arc::clone(&instance.tracked))
    };

    let Some(tracked) = tracked else {
        return Ok(None);
    };

    let state = lock_recover(&tracked);
    Ok(Some(PtyRuntimeSnapshot {
        launch_cwd: state.launch_cwd.clone(),
        process_id: state.process_id,
        session_name: state.session_name.clone(),
        last_known_cwd: state.last_known_cwd.clone(),
        scrollback: Vec::from(state.scrollback.clone()),
        scrollback_truncated: state.scrollback_truncated,
    }))
}

fn cache_last_known_cwd(pty_id: &str, cwd: &str) -> Result<(), String> {
    let tracked = {
        let reg = lock_recover(registry());
        reg.get(pty_id)
            .map(|instance| Arc::clone(&instance.tracked))
    };

    let Some(tracked) = tracked else {
        return Ok(());
    };

    let mut state = lock_recover(&tracked);
    state.last_known_cwd = Some(cwd.to_string());
    Ok(())
}

/// Append `chunk` to a raw scrollback ring, dropping oldest bytes past `limit`.
/// Why pub: SHARED grove-core library (design §1.1/§6/G4). The daemon holds one
/// ring per session as the byte-exact source for cold restore. Behavior is
/// unchanged; only visibility widened.
pub fn append_scrollback_capped(
    scrollback: &mut VecDeque<u8>,
    scrollback_truncated: &mut bool,
    chunk: &[u8],
    limit: usize,
) {
    if limit == 0 || chunk.is_empty() {
        return;
    }

    scrollback.extend(chunk.iter().copied());
    if scrollback.len() > limit {
        // VecDeque front-prefix drain is O(overflow), not the O(cap) memmove a
        // Vec::drain(..overflow) would pay per chunk under sustained flood.
        let overflow = scrollback.len() - limit;
        scrollback.drain(..overflow);
        *scrollback_truncated = true;
    }
}

fn runtime_restore_seed<'a>(
    session_state: CreatePtySessionState,
    restore: Option<&'a CreatePtyRestore>,
) -> Option<&'a CreatePtyRestore> {
    match session_state {
        CreatePtySessionState::Created => restore,
        CreatePtySessionState::Attached => None,
    }
}

fn required_arg(name: &str, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{name} is required"));
    }

    Ok(trimmed.to_string())
}

/// The portable terminal env every grove pane's child gets. The daemon spawns the
/// child, so these ride `createOrAttach.env` (which the daemon layers on top of its
/// inherited env).
fn portable_terminal_env_pairs() -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = subprocess_env_pairs().into_iter().collect();
    env.push(("TERM".to_string(), "xterm-256color".to_string()));
    // Why: advertise Grove so tools (and the user's shell prompt) can detect the
    // host terminal the same way they detect iTerm/Apple_Terminal.
    env.push(("TERM_PROGRAM".to_string(), "Grove".to_string()));
    env.push(("TERM_PROGRAM_VERSION".to_string(), crate::app_version()));
    let locale = preferred_utf8_locale();
    env.push(("LC_ALL".to_string(), locale.clone()));
    env.push(("LANG".to_string(), locale.clone()));
    env.push(("LC_CTYPE".to_string(), locale));
    env
}

/// The daemon session id for a pane: `grove-{hash(worktree)}-{pane}` (design G6).
/// Stable across relaunches — it IS the reattach identity — and its worktree-hash
/// prefix is what terminal GC uses to attribute a daemon session to a worktree
/// (`session_worktree_prefix`). Exposed so callers/tests can name a session without
/// re-deriving the hash.
pub fn daemon_session_id(worktree_path: &str, pane_id: &str) -> String {
    grove_session_name(worktree_path, pane_id)
}

/// FROZEN OUTPUT. This id names a pane's session on disk (history dir) and in the
/// daemon; changing a single byte of it silently orphans every terminal every user
/// already has. It kept the `grove-` prefix and the exact hash shape across the tmux
/// → daemon cutover for precisely that reason. Pinned by
/// `grove_session_name_is_stable_and_namespaced`.
fn grove_session_name(worktree_path: &str, pane_id: &str) -> String {
    format!(
        "grove-{}-{}",
        short_hash(worktree_path, WORKTREE_HASH_LEN),
        pane_short_id(pane_id)
    )
}

fn pane_short_id(pane_id: &str) -> String {
    let prefix: String = pane_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .take(PANE_PREFIX_LEN)
        .collect();
    let hash = short_hash(pane_id, PANE_HASH_LEN);

    if prefix.is_empty() {
        hash
    } else {
        format!("{prefix}{hash}")
    }
}

fn short_hash(input: &str, len: usize) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex.truncate(len);
    hex
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::env_lock;
    use crate::TerminalPaneSnapshotInput;
    use std::fs;
    use std::io;
    use std::path::PathBuf;
    use std::thread::sleep;
    use std::time::Duration;
    use uuid::Uuid;

    fn unique_test_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()))
    }

    struct TestHome {
        root: PathBuf,
        original_home: Option<String>,
    }

    impl TestHome {
        fn new() -> Self {
            let root = unique_test_dir("grove-pty-home");
            fs::create_dir_all(&root).unwrap();

            let original_home = std::env::var("HOME").ok();
            unsafe {
                std::env::set_var("HOME", &root);
            }

            Self {
                root,
                original_home,
            }
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            match &self.original_home {
                Some(original_home) => unsafe {
                    std::env::set_var("HOME", original_home);
                },
                None => unsafe {
                    std::env::remove_var("HOME");
                },
            }

            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn terminal_gc_plan_prunes_missing_paths_and_unattached_sessions() {
        let existing_path = unique_test_dir("grove-terminal-gc-existing");
        fs::create_dir_all(&existing_path).unwrap();

        let missing_path = unique_test_dir("grove-terminal-gc-missing");
        let existing_path_str = existing_path.to_string_lossy().into_owned();
        let missing_path_str = missing_path.to_string_lossy().into_owned();

        let plan = build_terminal_gc_plan(
            vec![existing_path_str.clone(), missing_path_str.clone()],
            &[TerminalGcSessionInfo {
                session_name: "grove-stale-session".into(),
                worktree_path: missing_path_str.clone(),
                attached: false,
                pane_pid: Some(4242),
            }],
        );

        assert_eq!(plan.stale_worktree_paths, vec![missing_path_str]);
        assert_eq!(plan.stale_session_names, vec!["grove-stale-session"]);
        assert_eq!(plan.stale_session_pane_pids, vec![4242]);
        assert!(plan.skipped_attached_worktree_paths.is_empty());

        let _ = fs::remove_dir_all(existing_path);
    }

    #[test]
    fn terminal_gc_plan_skips_missing_paths_with_attached_sessions() {
        let missing_path = unique_test_dir("grove-terminal-gc-attached");
        let missing_path_str = missing_path.to_string_lossy().into_owned();

        let plan = build_terminal_gc_plan(
            vec![missing_path_str.clone()],
            &[TerminalGcSessionInfo {
                session_name: "grove-attached-session".into(),
                worktree_path: missing_path_str.clone(),
                attached: true,
                pane_pid: Some(99),
            }],
        );

        assert!(plan.stale_worktree_paths.is_empty());
        assert!(plan.stale_session_names.is_empty());
        assert!(plan.stale_session_pane_pids.is_empty());
        assert_eq!(plan.skipped_attached_worktree_paths, vec![missing_path_str]);
    }

    #[test]
    fn terminal_gc_plan_prunes_missing_layout_paths_without_sessions() {
        let missing_path = unique_test_dir("grove-terminal-gc-layout-only");
        let missing_path_str = missing_path.to_string_lossy().into_owned();

        let plan = build_terminal_gc_plan(vec![missing_path_str.clone()], &[]);

        assert_eq!(plan.stale_worktree_paths, vec![missing_path_str]);
        assert!(plan.stale_session_names.is_empty());
        assert!(plan.stale_session_pane_pids.is_empty());
        assert!(plan.skipped_attached_worktree_paths.is_empty());
    }

    #[tokio::test]
    async fn empty_snapshot_request_removes_saved_snapshot_for_worktree() {
        let _env = env_lock();
        let _home = TestHome::new();
        let worktree_path = unique_test_dir("grove-terminal-snapshot-clear");
        fs::create_dir_all(&worktree_path).unwrap();
        let worktree_path_str = worktree_path.to_string_lossy().into_owned();

        save_terminal_session_snapshot(SaveTerminalSessionSnapshotRequest {
            worktree_path: worktree_path_str.clone(),
            panes: vec![TerminalPaneSnapshotInput {
                pane_id: "pane-1".into(),
                pty_id: None,
                launch_cwd: Some(worktree_path_str.clone()),
            }],
        })
        .await
        .unwrap();
        assert!(load_terminal_session_snapshot(&worktree_path_str)
            .unwrap()
            .is_some());

        let cleared = save_terminal_session_snapshot(SaveTerminalSessionSnapshotRequest {
            worktree_path: worktree_path_str.clone(),
            panes: Vec::new(),
        })
        .await
        .unwrap();

        assert_eq!(cleared.worktree_path, worktree_path_str);
        assert!(cleared.panes.is_empty());
        assert!(load_terminal_session_snapshot(&worktree_path_str)
            .unwrap()
            .is_none());

        let _ = fs::remove_dir_all(worktree_path);
    }

    struct NoopSink;

    impl PtyEventSink for NoopSink {
        fn on_output(&self, _pty_id: &str, _data: &[u8]) {}
    }

    #[derive(Default)]
    struct CollectingSink {
        calls: Mutex<Vec<Vec<u8>>>,
    }

    impl PtyEventSink for CollectingSink {
        fn on_output(&self, _pty_id: &str, data: &[u8]) {
            self.calls.lock().unwrap().push(data.to_vec());
        }
    }

    /// Records every emit, and STALLS inside the first one after signalling — the
    /// window a racing `on_data` needs to overtake the replay gate's drain.
    struct RacingSink {
        calls: Mutex<Vec<Vec<u8>>>,
        first: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    }

    impl PtyEventSink for RacingSink {
        fn on_output(&self, _pty_id: &str, data: &[u8]) {
            self.calls.lock().unwrap().push(data.to_vec());
            let signal = self.first.lock().unwrap().take();
            if let Some(tx) = signal {
                let _ = tx.send(());
                sleep(Duration::from_millis(150));
            }
        }
    }

    /// Write implementation whose `write` blocks until a gate is released,
    /// used to simulate a stalled `write_all` (a wedged PTY master).
    struct BlockingWriter {
        gate: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let (lock, cvar) = &*self.gate;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = cvar.wait(released).unwrap();
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Write implementation that records each `write_all` batch verbatim, in the
    /// order the sole writer thread performed it. Used to assert FIFO ordering.
    struct RecordingWriter {
        recorded: Arc<Mutex<Vec<Vec<u8>>>>,
    }

    impl Write for RecordingWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.recorded.lock().unwrap().push(buf.to_vec());
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Write implementation that blocks on a gate BEFORE recording the bytes,
    /// so a test can prove write() has not resolved while the writer thread has
    /// not yet received the bytes.
    struct GatedRecordingWriter {
        recorded: Arc<Mutex<Vec<u8>>>,
        gate: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Write for GatedRecordingWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let (lock, cvar) = &*self.gate;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = cvar.wait(released).unwrap();
            }
            self.recorded.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// A pane registered against the daemon-era registry: no local writer/master/child
    /// (the daemon owns those now), just the routing identity + runtime state.
    fn register_mock_pty(session_name: String) -> String {
        register_mock_pty_in(session_name, "/tmp/grove/worktree".to_string())
    }

    fn register_mock_pty_in(session_name: String, worktree_path: String) -> String {
        let pty_id = format!("pty-{}", Uuid::new_v4().simple());
        let tracked = Arc::new(Mutex::new(PtyRuntimeState::new(
            worktree_path.clone(),
            None,
            session_name.clone(),
            80,
            24,
            None,
            None,
        )));
        let sink: Arc<dyn PtyEventSink> = Arc::new(NoopSink);
        let subscriber = Arc::new(DaemonSinkAdapter::new(
            pty_id.clone(),
            session_name.clone(),
            Arc::clone(&sink),
            Arc::clone(&tracked),
        ));
        // Registered panes are past `create`, so their replay gate is already open.
        subscriber.open_gate(None, || {});

        registry().lock().unwrap().insert(
            pty_id.clone(),
            PtyInstance {
                session_name,
                worktree_path,
                sink,
                subscriber,
                tracked,
            },
        );

        pty_id
    }

    fn tracked_for(pty_id: &str) -> Arc<Mutex<PtyRuntimeState>> {
        let reg = registry().lock().unwrap();
        Arc::clone(&reg.get(pty_id).unwrap().tracked)
    }

    fn subscriber_for(pty_id: &str) -> Arc<DaemonSinkAdapter> {
        let reg = registry().lock().unwrap();
        Arc::clone(&reg.get(pty_id).unwrap().subscriber)
    }

    #[test]
    fn coalesces_burst_within_window_into_single_output() {
        let sink = Arc::new(CollectingSink::default());
        let coalescer =
            OutputCoalescer::new(Arc::clone(&sink) as Arc<dyn PtyEventSink>, "pty-burst".into());

        // Several sub-threshold reads back-to-back, well within the 8ms window.
        coalescer.push(b"aa");
        coalescer.push(b"bb");
        coalescer.push(b"cc");

        // Wait past the flush interval for the single coalesced emit.
        sleep(Duration::from_millis(40));

        let calls = sink.calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "burst should coalesce into one on_output");
        assert_eq!(calls[0], b"aabbcc");
    }

    #[test]
    fn flushes_small_tail_on_close() {
        let sink = Arc::new(CollectingSink::default());
        let coalescer =
            OutputCoalescer::new(Arc::clone(&sink) as Arc<dyn PtyEventSink>, "pty-eof".into());

        // A sub-threshold tail must still reach the sink when the producer ends.
        coalescer.push(b"tail");
        coalescer.close();

        // Give the flusher thread a moment to emit the final tail.
        sleep(Duration::from_millis(20));
        assert_eq!(sink.calls.lock().unwrap().concat(), b"tail");
    }

    /// The sink adapter is the ONLY remaining feed for `last_output_at` (the hookless
    /// AI-status idle clock) and for the local scrollback mirror that
    /// `save_terminal_session_snapshot` persists. A regression here freezes the status
    /// machine silently, so assert both stamps plus the transport hand-off.
    #[test]
    fn stream_sink_stamps_runtime_state_before_forwarding_output() {
        let sink = Arc::new(CollectingSink::default());
        let tracked = Arc::new(Mutex::new(PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            80,
            24,
            None,
            None,
        )));
        let adapter = DaemonSinkAdapter::new(
            "pty-sink".into(),
            "grove-test".into(),
            Arc::clone(&sink) as Arc<dyn PtyEventSink>,
            Arc::clone(&tracked),
        );
        adapter.open_gate(None, || {});

        adapter.on_data(5, b"hello");

        assert_eq!(sink.calls.lock().unwrap().concat(), b"hello");
        let state = tracked.lock().unwrap();
        assert_eq!(Vec::from(state.scrollback.clone()), b"hello");
        assert!(
            state.last_output_at.is_some(),
            "last_output_at must be stamped — it is the only idle-clock feed left"
        );
    }

    /// Frames that land between `subscribe` and the `createOrAttach` reply are held by
    /// the gate; on release, bytes the warm snapshot already contains are dropped and a
    /// straddling frame is trimmed to its post-snapshot tail (design S3/P12).
    #[test]
    fn stream_sink_gate_drops_bytes_already_in_the_warm_snapshot() {
        let sink = Arc::new(CollectingSink::default());
        let tracked = Arc::new(Mutex::new(PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            80,
            24,
            None,
            None,
        )));
        let adapter = DaemonSinkAdapter::new(
            "pty-gate".into(),
            "grove-test".into(),
            Arc::clone(&sink) as Arc<dyn PtyEventSink>,
            Arc::clone(&tracked),
        );

        // Buffered while the RPC is in flight; nothing reaches the sink yet.
        adapter.on_data(4, b"AAAA"); // bytes 0..4  — fully inside the snapshot
        adapter.on_data(10, b"BBCCCC"); // bytes 4..10 — straddles seq 6
        adapter.on_data(13, b"DDD"); // bytes 10..13 — fully after
        assert!(sink.calls.lock().unwrap().is_empty());

        adapter.open_gate(Some(6), || {});

        assert_eq!(sink.calls.lock().unwrap().concat(), b"CCCCDDD");
    }

    #[test]
    fn stream_sink_exit_removes_the_registry_entry_without_emitting_output() {
        let session_name = format!("grove-test-exit-{}", Uuid::new_v4().simple());
        let pty_id = register_mock_pty(session_name);
        let subscriber = subscriber_for(&pty_id);
        let tracked = tracked_for(&pty_id);

        subscriber.on_exit(ExitStatus {
            code: Some(0),
            signal: None,
        });

        assert!(
            !registry().lock().unwrap().contains_key(&pty_id),
            "exit must reap the registry entry, as the GC reap does today"
        );
        assert!(tracked.lock().unwrap().reader_exited);
    }

    /// The gate's drain and `on_data` run on DIFFERENT tasks (`create` vs the client's
    /// stream reader). A frame that lands mid-drain must never overtake the frames still
    /// in the buffer — out-of-order bytes are garbage on the wire and garble xterm.
    /// `RacingSink` stalls inside the first replayed frame and hands a racer thread the
    /// widest possible window to jump the queue.
    #[test]
    fn stream_sink_gate_drain_is_never_overtaken_by_a_concurrent_frame() {
        let (tx, drain_started) = std::sync::mpsc::channel();
        let sink = Arc::new(RacingSink {
            calls: Mutex::new(Vec::new()),
            first: Mutex::new(Some(tx)),
        });
        let tracked = Arc::new(Mutex::new(PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            80,
            24,
            None,
            None,
        )));
        let adapter = Arc::new(DaemonSinkAdapter::new(
            "pty-race".into(),
            "grove-test".into(),
            Arc::clone(&sink) as Arc<dyn PtyEventSink>,
            Arc::clone(&tracked),
        ));

        // Buffered while the RPC is in flight.
        adapter.on_data(1, b"1");
        adapter.on_data(2, b"2");
        adapter.on_data(3, b"3");

        // The stream task: a frame produced while the drain is running.
        let racer = {
            let adapter = Arc::clone(&adapter);
            std::thread::spawn(move || {
                drain_started
                    .recv_timeout(Duration::from_secs(5))
                    .expect("the drain must reach the sink");
                adapter.on_data(4, b"R");
            })
        };

        adapter.open_gate(None, || {});
        racer.join().unwrap();

        assert_eq!(
            sink.calls.lock().unwrap().concat(),
            b"123R",
            "a frame arriving mid-drain must be ingested AFTER the buffered frames"
        );
    }

    /// An `Exit` frame rides the STREAM socket while the `createOrAttach` reply rides the
    /// CONTROL socket, so an instantly-dying shell can report its exit before `create`
    /// registers anything. `create` must then not publish the pane at all: a
    /// subscriber-less entry marked ALIVE only heals on the next GC pass, and until then
    /// re-creating the same `pty_id` fails with "PTY already exists".
    #[test]
    fn stream_sink_exit_before_create_finishes_never_registers_the_dead_pane() {
        let session_name = format!("grove-test-early-exit-{}", Uuid::new_v4().simple());
        let pty_id = format!("pty-{}", Uuid::new_v4().simple());
        let worktree_path = "/tmp/grove/worktree".to_string();
        let sink: Arc<dyn PtyEventSink> = Arc::new(CollectingSink::default());
        let tracked = Arc::new(Mutex::new(PtyRuntimeState::new(
            worktree_path.clone(),
            None,
            session_name.clone(),
            80,
            24,
            None,
            None,
        )));
        let adapter = Arc::new(DaemonSinkAdapter::new(
            pty_id.clone(),
            session_name.clone(),
            Arc::clone(&sink),
            Arc::clone(&tracked),
        ));

        // The shell printed and died while `createOrAttach` was still in flight.
        adapter.on_data(4, b"bye\n");
        adapter.on_exit(ExitStatus {
            code: Some(0),
            signal: None,
        });

        // …and only now does `create` get its reply and try to register the pane.
        let instance = PtyInstance {
            session_name,
            worktree_path,
            sink: Arc::clone(&sink),
            subscriber: Arc::clone(&adapter),
            tracked: Arc::clone(&tracked),
        };
        let pty_id_for_insert = pty_id.clone();
        let exited = adapter.open_gate(None, move || {
            lock_recover(registry()).insert(pty_id_for_insert, instance);
        });

        assert!(
            !registry().lock().unwrap().contains_key(&pty_id),
            "a session the daemon already reported dead must never be registered as alive"
        );
        assert!(exited, "create must observe the exit that beat its reply");
        assert!(
            tracked.lock().unwrap().reader_exited,
            "the pane's runtime state must stay marked exited"
        );
    }

    /// The ordered per-PTY writer is now constructed DAEMON-side (it is a shared
    /// grove-core lib, design G3), so these drive `PtyWriter` directly instead of
    /// through `pty::write` — same machinery, same guarantees, no registry.
    #[test]
    fn write_to_one_writer_does_not_block_another() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let a = PtyWriter::spawn_input_only(
            Box::new(BlockingWriter {
                gate: Arc::clone(&gate),
            }),
            WRITE_DEADLINE,
        );
        let b = PtyWriter::spawn_input_only(Box::new(io::sink()), WRITE_DEADLINE);

        // Stall a write to A inside write_all (holding only A's writer lock).
        let a_writer = Arc::clone(&a);
        let a_handle = std::thread::spawn(move || a_writer.write(b"blocked"));
        sleep(Duration::from_millis(50));

        // B's write must complete even though A is stuck.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(b.write(b"ok"));
        });
        let received = rx.recv_timeout(Duration::from_secs(2));
        assert!(
            received.is_ok(),
            "write to B blocked while A's write_all was stalled"
        );
        assert!(received.unwrap().is_ok());

        {
            let (lock, cvar) = &*gate;
            *lock.lock().unwrap() = true;
            cvar.notify_all();
        }
        let _ = a_handle.join();
    }

    #[test]
    fn writes_stay_in_enqueue_order_under_concurrency() {
        let recorded = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let writer = PtyWriter::spawn_input_only(
            Box::new(RecordingWriter {
                recorded: Arc::clone(&recorded),
            }),
            WRITE_DEADLINE,
        );

        const PRODUCERS: usize = 4;
        const PER: usize = 25;
        let mut handles = Vec::new();
        for p in 0..PRODUCERS {
            let writer = Arc::clone(&writer);
            handles.push(std::thread::spawn(move || {
                // Each producer's calls are program-ordered => enqueue-ordered.
                for i in 0..PER {
                    writer.write(format!("p{p}-{i:03}\r").as_bytes()).unwrap();
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }

        let recorded = recorded.lock().unwrap();
        assert_eq!(
            recorded.len(),
            PRODUCERS * PER,
            "every batch must be written exactly once and never split"
        );
        for batch in recorded.iter() {
            let s = String::from_utf8(batch.clone()).unwrap();
            assert!(
                s.starts_with('p') && s.ends_with('\r'),
                "batch was not written atomically: {s:?}"
            );
        }
        // FIFO: within each producer, batches land in ascending program order.
        for p in 0..PRODUCERS {
            let seq: Vec<usize> = recorded
                .iter()
                .filter_map(|batch| {
                    let s = std::str::from_utf8(batch).ok()?.trim_end_matches('\r');
                    let (producer, index) = s.split_once('-')?;
                    (producer == format!("p{p}")).then(|| index.parse().ok())?
                })
                .collect();
            assert_eq!(
                seq,
                (0..PER).collect::<Vec<_>>(),
                "producer {p}'s batches were reordered"
            );
        }
    }

    #[test]
    fn write_does_not_resolve_before_writer_received_bytes() {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let writer = PtyWriter::spawn_input_only(
            Box::new(GatedRecordingWriter {
                recorded: Arc::clone(&recorded),
                gate: Arc::clone(&gate),
            }),
            WRITE_DEADLINE,
        );

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(writer.write(b"paste-body"));
        });

        // The writer is gated before recording, so write() must NOT have
        // resolved and no bytes may have been received yet.
        assert!(
            rx.recv_timeout(Duration::from_millis(150)).is_err(),
            "write() resolved before the writer received the bytes"
        );
        assert!(recorded.lock().unwrap().is_empty());

        // Release the gate: the writer records the bytes, write_all returns, and
        // only then does write() resolve.
        {
            let (lock, cvar) = &*gate;
            *lock.lock().unwrap() = true;
            cvar.notify_all();
        }
        let result = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("write() must resolve after the writer received the bytes");
        assert!(result.is_ok());
        assert_eq!(*recorded.lock().unwrap(), b"paste-body");
    }

    #[test]
    fn write_deadline_releases_caller_and_teardown_completes() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let writer = PtyWriter::spawn_input_only(
            Box::new(BlockingWriter {
                gate: Arc::clone(&gate),
            }),
            Duration::from_millis(200),
        );

        // The writer thread blocks forever in write_all; write() must still
        // release the caller at the (injected) deadline with a timeout error.
        let (tx, rx) = std::sync::mpsc::channel();
        let started = Instant::now();
        let writing = Arc::clone(&writer);
        std::thread::spawn(move || {
            let _ = tx.send(writing.write(b"paste-body"));
        });
        let received = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("caller must be released at the deadline");
        assert!(received.is_err());
        assert!(received.unwrap_err().contains("timed out"));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "caller was released far past the injected deadline"
        );

        // Teardown must not deadlock even though the writer thread is still stuck
        // inside write_all.
        let (dtx, drx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            drop(writer);
            let _ = dtx.send(());
        });
        assert!(
            drx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "writer teardown deadlocked with a blocked writer thread"
        );

        // Release the gate so the writer thread exits cleanly instead of leaking.
        {
            let (lock, cvar) = &*gate;
            *lock.lock().unwrap() = true;
            cvar.notify_all();
        }
    }

    #[tokio::test]
    async fn applied_pty_size_returns_none_for_unknown_pty() {
        // Resolves entirely from the registry — no daemon round trip for a pane that
        // was never registered (an evicted pane is "gone", not a fault).
        assert_eq!(
            applied_pty_size("pty-does-not-exist").await.unwrap(),
            None
        );
    }

    #[test]
    fn detects_utf8_locale_variants() {
        assert!(is_utf8_locale("ko_KR.UTF-8"));
        assert!(is_utf8_locale("en_US.UTF8"));
        assert!(!is_utf8_locale("C"));
    }

    #[test]
    fn rejects_bare_utf8_as_unusable_locale() {
        assert!(!is_usable_locale("UTF-8"));
        assert!(!is_usable_locale("UTF8"));
        assert!(!is_usable_locale("utf-8"));
        assert!(is_usable_locale("en_US.UTF-8"));
        assert!(is_usable_locale("ko_KR.UTF-8"));
        assert!(is_usable_locale("C.UTF-8"));
    }

    fn with_locale_env_cleared<T>(body: impl FnOnce() -> T) -> T {
        let _lock = env_lock();
        let keys = ["LC_ALL", "LC_CTYPE", "LANG"];
        let saved: Vec<(&str, Option<String>)> =
            keys.iter().map(|k| (*k, env::var(k).ok())).collect();
        unsafe {
            for key in keys {
                env::remove_var(key);
            }
        }
        let result = body();
        unsafe {
            for (key, value) in saved {
                match value {
                    Some(val) => env::set_var(key, val),
                    None => env::remove_var(key),
                }
            }
        }
        result
    }

    #[test]
    fn preferred_utf8_locale_falls_back_per_os_when_env_unset() {
        let locale = with_locale_env_cleared(preferred_utf8_locale);
        #[cfg(target_os = "macos")]
        assert_eq!(locale, "en_US.UTF-8");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(locale, "C.UTF-8");
    }

    #[test]
    fn preferred_utf8_locale_honors_usable_env_locale() {
        let locale = with_locale_env_cleared(|| {
            unsafe {
                env::set_var("LANG", "ko_KR.UTF-8");
            }
            preferred_utf8_locale()
        });
        assert_eq!(locale, "ko_KR.UTF-8");
    }

    #[test]
    fn validate_pty_cwd_rejects_bad_and_accepts_dir() {
        // Empty.
        assert!(validate_pty_cwd("").is_err());
        assert!(validate_pty_cwd("   ").is_err());

        // Missing.
        let missing = unique_test_dir("grove-cwd-missing");
        assert!(validate_pty_cwd(missing.to_string_lossy().as_ref()).is_err());

        // File, not a directory.
        let file = unique_test_dir("grove-cwd-file");
        fs::write(&file, b"x").unwrap();
        assert!(validate_pty_cwd(file.to_string_lossy().as_ref()).is_err());
        let _ = fs::remove_file(&file);

        // Filesystem root.
        assert!(validate_pty_cwd("/").is_err());

        // Valid directory.
        let dir = unique_test_dir("grove-cwd-ok");
        fs::create_dir_all(&dir).unwrap();
        assert!(validate_pty_cwd(dir.to_string_lossy().as_ref()).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    /// The env the daemon spawns the pane's shell with keeps advertising Grove exactly
    /// as it always has, and adds the two daemon-era session vars.
    #[test]
    fn daemon_child_env_advertises_term_program_and_session_vars() {
        let env = daemon_child_env("grove-abc-pane1");
        let get = |key: &str| {
            env.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| panic!("{key} present"))
        };

        assert_eq!(get("TERM"), "xterm-256color");
        assert_eq!(get("TERM_PROGRAM"), "Grove");
        let version = get("TERM_PROGRAM_VERSION");
        assert!(!version.is_empty());
        assert_eq!(version, crate::app_version());
        assert_eq!(get("GROVE_SESSION_ID"), "grove-abc-pane1");
        // The AI-status file is per-session and lives under the daemon runtime dir.
        let status_file = env
            .iter()
            .find(|(k, _)| k == "GROVE_AI_STATUS_FILE")
            .map(|(_, v)| v.clone());
        if let Some(status_file) = status_file {
            assert!(status_file.ends_with("/ai-status/grove-abc-pane1"), "{status_file}");
        }
    }

    /// Regression: the daemon rewrite dropped ZDOTDIR from the child env, which silently
    /// disabled BOTH the `open` link-interception wrapper and the `claude`/`codex` hook
    /// shims — they reach the shell only because grove's overlay rc prepends
    /// `~/.grove/bin` to PATH after all user config. The pair must ship together:
    /// ZDOTDIR points zsh at grove's overlay, GROVE_REAL_ZDOTDIR tells that overlay
    /// which rc files to source, so omitting the latter silently drops the user's config.
    #[test]
    fn daemon_child_env_carries_the_zdotdir_overlay_when_installed() {
        let env = daemon_child_env("grove-abc-pane1");
        let lookup = |key: &str| {
            env.iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())
        };

        let Some(grove_zsh) = tool_hooks::grove_zdotdir() else {
            // Hooks not installed in this environment — nothing to overlay.
            assert!(lookup("ZDOTDIR").is_none(), "ZDOTDIR without an overlay");
            return;
        };

        assert_eq!(lookup("ZDOTDIR").as_deref(), Some(grove_zsh.as_str()));
        assert!(
            lookup("GROVE_REAL_ZDOTDIR").is_some_and(|real| real != grove_zsh),
            "GROVE_REAL_ZDOTDIR must name the USER's zdotdir, never grove's own"
        );
    }

    // Why: fallback and set-value in ONE test because APP_VERSION is a process-wide
    // OnceLock — checking the fallback must happen before any set, and no other
    // grove-core test sets it, so this reads the compiled default first, then pins
    // the first-write-wins behavior.
    #[test]
    fn app_version_uses_compiled_fallback_then_host_value() {
        assert_eq!(crate::app_version(), env!("CARGO_PKG_VERSION"));
        crate::set_app_version("42.0.0-grove-test");
        assert_eq!(crate::app_version(), "42.0.0-grove-test");
        // First-write-wins: a second set is a no-op.
        crate::set_app_version("99.0.0-ignored");
        assert_eq!(crate::app_version(), "42.0.0-grove-test");
    }

    #[test]
    fn detect_hookless_tool_from_process_tree_matches_wrapper_descendants() {
        let processes = vec![
            ProcessSnapshot {
                pid: 100,
                ppid: 1,
                command_line: "-zsh".into(),
            },
            ProcessSnapshot {
                pid: 110,
                ppid: 100,
                command_line: "bash /Users/airenkang/.grove/bin/codex --yolo".into(),
            },
            ProcessSnapshot {
                pid: 120,
                ppid: 110,
                command_line: "node /Users/airenkang/.nvm/versions/node/v23.7.0/bin/codex --yolo"
                    .into(),
            },
            ProcessSnapshot {
                pid: 130,
                ppid: 120,
                command_line:
                    "/Users/airenkang/.nvm/.../vendor/aarch64-apple-darwin/codex/codex --yolo"
                        .into(),
            },
        ];

        assert_eq!(
            detect_hookless_tool_from_process_tree(100, &processes),
            Some("codex")
        );
    }

    #[test]
    fn recover_hookless_ai_status_uses_recent_output_when_previous_status_is_missing() {
        assert_eq!(
            recover_hookless_ai_status("codex", None, Some(Instant::now())),
            "codex:running"
        );
        assert_eq!(
            recover_hookless_ai_status("codex", None, None),
            "codex:idle"
        );
    }

    #[test]
    fn recover_hookless_ai_status_drops_stale_attention_to_idle() {
        assert_eq!(
            recover_hookless_ai_status("codex", Some("codex:attention"), None),
            "codex:idle"
        );
        assert_eq!(
            recover_hookless_ai_status("codex", Some("codex:idle"), None),
            "codex:idle"
        );
    }

    #[test]
    fn reconcile_hookless_ai_status_recovers_stale_non_hookless_provider() {
        assert_eq!(
            reconcile_hookless_ai_status(
                Some("claude:running"),
                Some("codex"),
                Some("claude:running"),
                Some(Instant::now()),
            ),
            Some("codex:running".into())
        );
    }

    #[test]
    fn reconcile_hookless_ai_status_preserves_matching_hookless_status() {
        assert_eq!(
            reconcile_hookless_ai_status(
                Some("codex:attention"),
                Some("codex"),
                Some("codex:attention"),
                None,
            ),
            Some("codex:attention".into())
        );
    }

    #[test]
    fn reconcile_hookless_ai_status_keeps_existing_status_without_live_hookless_tool() {
        assert_eq!(
            reconcile_hookless_ai_status(
                Some("claude:running"),
                None,
                Some("claude:running"),
                Some(Instant::now()),
            ),
            Some("claude:running".into())
        );
    }

    #[test]
    fn scrollback_cap_discards_oldest_bytes() {
        let mut scrollback: VecDeque<u8> = b"abc".iter().copied().collect();
        let mut truncated = false;

        append_scrollback_capped(&mut scrollback, &mut truncated, b"def", 4);

        assert_eq!(Vec::from(scrollback), b"cdef");
        assert!(truncated);
    }

    #[test]
    fn scrollback_ring_boundaries_never_panic_and_stay_capped() {
        // Property fuzz over the ring: random-sized chunks of random bytes and
        // deliberately split multibyte UTF-8 must never panic and must keep the
        // ring within `limit`. Why documented-not-fixed: the ring is a raw-byte
        // tail drained oldest-first with no boundary alignment, so truncation
        // can land mid-UTF-8/mid-escape — restore relies on from_utf8_lossy
        // downstream (roadmap: snapshot/preamble rehydrate on restore). This
        // asserts the invariants AS THEY ARE, not UTF-8 boundary preservation.
        let limit = 64usize;
        // xorshift32 for deterministic, dependency-free pseudo-random input.
        let mut rng = 0x1234_5678u32;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            rng
        };
        let multibyte = "你好🟢é".as_bytes().to_vec();
        let mut scrollback: VecDeque<u8> = VecDeque::new();
        let mut truncated = false;
        let mut total_appended: usize = 0;
        for _ in 0..5000 {
            let chunk: Vec<u8> = if next() % 3 == 0 {
                // Tail slice of a multibyte string starting at a random byte
                // offset — feeds a lone continuation byte at the chunk head.
                let cut = (next() as usize) % (multibyte.len() + 1);
                multibyte[cut..].to_vec()
            } else {
                let len = (next() as usize) % 40;
                (0..len).map(|_| (next() & 0xff) as u8).collect()
            };
            total_appended += chunk.len();
            append_scrollback_capped(&mut scrollback, &mut truncated, &chunk, limit);
            assert!(scrollback.len() <= limit, "ring exceeded cap");
            if truncated {
                // Once truncation begins the ring stays exactly full.
                assert_eq!(scrollback.len(), limit);
            }
        }
        assert_eq!(truncated, total_appended > limit);
    }

    #[tokio::test]
    async fn pane_snapshot_falls_back_to_launch_cwd_without_live_pty() {
        let snapshot = build_pane_snapshot(&TerminalPaneSnapshotInput {
            pane_id: "pane-1".into(),
            pty_id: None,
            launch_cwd: Some("/tmp/grove/worktree".into()),
        })
        .await
        .unwrap();

        assert_eq!(snapshot.pane_id, "pane-1");
        assert_eq!(snapshot.launch_cwd, "/tmp/grove/worktree");
        assert_eq!(snapshot.restore_cwd, "/tmp/grove/worktree");
        assert_eq!(
            snapshot.restore_cwd_source,
            TerminalRestoreCwdSource::LaunchCwd
        );
        assert!(snapshot.last_known_cwd.is_none());
        assert!(snapshot.scrollback.is_empty());
        assert!(!snapshot.scrollback_truncated);
    }

    #[test]
    fn runtime_state_seeds_restore_scrollback_before_live_output() {
        let restore = CreatePtyRestore {
            last_known_cwd: None,
            scrollback: Some("abc".into()),
            scrollback_truncated: Some(false),
        };
        let mut state = PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            80,
            24,
            Some(&restore),
            None,
        );

        state.append_scrollback(b"def");

        assert_eq!(Vec::from(state.scrollback.clone()), b"abcdef");
        assert!(!state.scrollback_truncated);
    }

    #[test]
    fn runtime_state_preserves_restore_seed_truncation_metadata() {
        let restore = CreatePtyRestore {
            last_known_cwd: None,
            scrollback: Some("abc".into()),
            scrollback_truncated: Some(true),
        };
        let state = PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            80,
            24,
            Some(&restore),
            None,
        );

        assert_eq!(Vec::from(state.scrollback.clone()), b"abc");
        assert!(state.scrollback_truncated);
    }

    /// The hook channel: a status published into the pane's file is READ and CONSUMED
    /// on the next poll, and an EMPTY payload is the explicit clear (the daemon-native
    /// `tmux set-option -u`). Consuming is what stops a stale hook write from
    /// re-asserting itself over the state machine on every subsequent tick.
    #[test]
    fn ai_status_file_is_consumed_on_read_and_empty_means_clear() {
        let _env = env_lock();
        let _home = TestHome::new();
        let session_id = format!("grove-test-{}", Uuid::new_v4().simple());

        // No hook wrote anything → no signal at all (leave the daemon's store alone).
        assert_eq!(consume_ai_status_file(&session_id), None);

        let path = ai_status_file_path(&session_id).expect("the AI-status path resolves");
        fs::write(&path, "claude:running\n").unwrap();
        assert_eq!(
            consume_ai_status_file(&session_id),
            Some(Some("claude:running".to_string())),
            "a published status is read (and trimmed)"
        );
        assert!(!path.exists(), "reading the file must CONSUME it");
        assert_eq!(
            consume_ai_status_file(&session_id),
            None,
            "a consumed status must not re-assert on the next tick"
        );

        fs::write(&path, "").unwrap();
        assert_eq!(
            consume_ai_status_file(&session_id),
            Some(None),
            "an EMPTY payload is the hook's explicit clear"
        );
    }

    /// GC attributes a daemon session to a worktree by the worktree-hash prefix its id
    /// carries (the daemon stores no worktree path). A session whose prefix matches no
    /// known worktree is skipped — grove cannot prove whose it is, so it must not kill
    /// it.
    #[test]
    fn daemon_gc_session_infos_attribute_sessions_by_worktree_hash_prefix() {
        let worktree = "/tmp/grove/worktree-a".to_string();
        let other = "/tmp/grove/worktree-b".to_string();
        let mine = daemon_session_id(&worktree, "pane-1");
        let attached = daemon_session_id(&other, "pane-2");

        let sessions = vec![
            daemon::SessionInfo {
                session_id: mine.clone(),
                is_alive: true,
                cols: 80,
                rows: 24,
                pid: Some(4242),
            },
            daemon::SessionInfo {
                session_id: attached.clone(),
                is_alive: true,
                cols: 80,
                rows: 24,
                pid: Some(4243),
            },
            daemon::SessionInfo {
                session_id: "grove-ffffffffffff-unknown".to_string(),
                is_alive: true,
                cols: 80,
                rows: 24,
                pid: Some(4244),
            },
        ];
        let attached_names: HashSet<String> = [attached.clone()].into_iter().collect();

        let infos = daemon_gc_session_infos(
            &sessions,
            &[worktree.clone(), other.clone()],
            &attached_names,
        );

        assert_eq!(infos.len(), 2, "the unattributable session is skipped");
        let a = infos
            .iter()
            .find(|info| info.session_name == mine)
            .expect("session a");
        assert_eq!(a.worktree_path, worktree);
        assert!(!a.attached, "not held in the pane registry");
        assert_eq!(a.pane_pid, Some(4242), "the child pid comes from the daemon");

        let b = infos
            .iter()
            .find(|info| info.session_name == attached)
            .expect("session b");
        assert_eq!(b.worktree_path, other);
        assert!(b.attached, "a registry-held pane counts as attached");
    }

    #[test]
    fn history_dir_names_round_trip_through_percent_encoding() {
        let id = daemon_session_id("/tmp/grove/worktree", "pane-1");
        // grove ids are RFC-3986 unreserved, so the dir name IS the id.
        assert_eq!(percent_encode_session_id(&id), id);
        assert_eq!(percent_decode_session_id(&id), Some(id.clone()));
        // …and a dir name that is not ours decodes back to its id or is rejected.
        assert_eq!(percent_encode_session_id("a/b"), "a%2Fb");
        assert_eq!(
            percent_decode_session_id("a%2Fb"),
            Some("a/b".to_string()),
            "the encoder and decoder are inverses"
        );
        assert_eq!(percent_decode_session_id("bad%"), None);
    }

    #[test]
    fn detect_live_hookless_tool_returns_none_without_pane_pid() {
        let processes = vec![ProcessSnapshot {
            pid: 100,
            ppid: 1,
            command_line: "codex --yolo".into(),
        }];

        assert_eq!(
            detect_live_hookless_tool_in_session_from_processes(None, &processes),
            None
        );
        assert_eq!(
            detect_live_hookless_tool_in_session_from_processes(Some(100), &processes),
            Some("codex")
        );
    }

    #[test]
    fn runtime_state_applies_cap_after_seeded_and_live_output_combine() {
        let restore = CreatePtyRestore {
            last_known_cwd: None,
            scrollback: Some(format!("0123{}", "a".repeat(MAX_SCROLLBACK_BYTES - 6))),
            scrollback_truncated: Some(false),
        };
        let mut state = PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            80,
            24,
            Some(&restore),
            None,
        );

        state.append_scrollback(b"bcde");

        let scrollback_bytes = Vec::from(state.scrollback.clone());
        let scrollback = String::from_utf8_lossy(&scrollback_bytes);
        assert_eq!(state.scrollback.len(), MAX_SCROLLBACK_BYTES);
        assert!(scrollback.starts_with("23"));
        assert!(scrollback.ends_with("bcde"));
        assert!(state.scrollback_truncated);
    }

    #[test]
    fn runtime_state_seeds_last_known_cwd_from_restore_metadata() {
        let restore = CreatePtyRestore {
            last_known_cwd: Some("/tmp/grove/restored".into()),
            scrollback: None,
            scrollback_truncated: None,
        };
        let state = PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            80,
            24,
            Some(&restore),
            None,
        );

        assert_eq!(state.last_known_cwd.as_deref(), Some("/tmp/grove/restored"));
        assert!(state.scrollback.is_empty());
        assert!(!state.scrollback_truncated);
    }

    /// GOLDEN PIN — do not "fix" these strings.
    ///
    /// A session id names the pane's session in the daemon AND its history dir on disk
    /// (`~/.grove/daemon/history/<id>`), and it is the identity `createOrAttach` uses to
    /// re-adopt a live shell across an app relaunch. Change one byte of the hash shape,
    /// the prefix, or the pane-id sanitizer and EVERY terminal every user already has is
    /// silently orphaned: warm reattach misses, cold restore misses, the old history dirs
    /// are GC'd as unreferenced, and the pane comes back as a blank fresh shell.
    ///
    /// These values were captured from the pre-daemon (tmux) build and MUST NOT drift.
    /// The `grove-` prefix is likewise load-bearing: it is what `tmux_sweep` matches when
    /// it reaps leftover sessions from a pre-daemon build.
    #[test]
    fn grove_session_name_is_stable_and_namespaced() {
        let session_name = grove_session_name(
            "/tmp/grove/worktree",
            "550e8400-e29b-41d4-a716-446655440000",
        );
        assert!(session_name.starts_with("grove-"));
        assert_eq!(session_name, "grove-40c3d931f1d8-550e8400a3a9");

        // A second fixed input, so a change to EITHER hash (worktree or pane) trips.
        assert_eq!(
            grove_session_name("/Users/grove/worktrees/main", "pane-1"),
            "grove-d22dedc09796-pane1370b"
        );
        // `daemon_session_id` is the public alias — it must agree byte-for-byte.
        assert_eq!(
            daemon_session_id("/tmp/grove/worktree", "550e8400-e29b-41d4-a716-446655440000"),
            session_name
        );
        // And the GC worktree-attribution prefix must stay a prefix of it.
        assert!(session_name.starts_with(&session_worktree_prefix("/tmp/grove/worktree")));
    }

    #[test]
    fn pane_short_id_falls_back_to_hash_when_sanitized_prefix_is_empty() {
        assert_eq!(pane_short_id("---"), short_hash("---", PANE_HASH_LEN));
    }

    #[test]
    fn runtime_restore_seed_only_applies_to_new_sessions() {
        let restore = CreatePtyRestore {
            last_known_cwd: Some("/tmp/grove/restored".into()),
            scrollback: Some("seed".into()),
            scrollback_truncated: Some(true),
        };

        assert!(runtime_restore_seed(CreatePtySessionState::Attached, Some(&restore)).is_none());
        assert_eq!(
            runtime_restore_seed(CreatePtySessionState::Created, Some(&restore))
                .and_then(|seed| seed.scrollback.as_deref()),
            Some("seed")
        );
    }

    /// On attach the local scrollback mirror is seeded from the hydration payload (the
    /// daemon's warm/cold snapshot), so the very first `save_terminal_session_snapshot`
    /// after a reattach still persists real content.
    #[test]
    fn runtime_state_seeds_attached_scrollback_from_initial_hydration() {
        let state = PtyRuntimeState::new(
            "/tmp/grove".into(),
            None,
            "grove-session".into(),
            80,
            24,
            None,
            Some(HydrationSeed {
                bytes: b"live daemon snapshot",
                truncated: true,
            }),
        );

        assert_eq!(Vec::from(state.scrollback.clone()), b"live daemon snapshot");
        assert!(state.scrollback_truncated);
    }

    #[test]
    fn clear_scrollback_resets_runtime_buffer() {
        let tracked = Arc::new(Mutex::new(PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            80,
            24,
            None,
            None,
        )));

        {
            let mut state = tracked.lock().unwrap();
            state.append_scrollback(b"hello");
            state.scrollback_truncated = true;
        }

        {
            let mut state = tracked.lock().unwrap();
            state.scrollback.clear();
            state.scrollback_truncated = false;
        }

        let state = tracked.lock().unwrap();
        assert!(state.scrollback.is_empty());
        assert!(!state.scrollback_truncated);
    }

    /// Run `f` with panic output suppressed so intentional test panics don't
    /// spam stderr; restores the previous hook once `f` (and any panic it drives
    /// to completion via join/catch_unwind) has returned.
    fn with_silenced_panics<F: FnOnce()>(f: F) {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        f();
        std::panic::set_hook(previous);
    }

    fn poison_mutex<T: Send + 'static>(lock: Arc<Mutex<T>>) {
        with_silenced_panics(|| {
            let _ = std::thread::spawn(move || {
                let _guard = lock.lock().unwrap();
                panic!("intentional poison for test");
            })
            .join();
        });
    }

    struct BlockingSink {
        entered: Arc<(Mutex<bool>, Condvar)>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    impl PtyEventSink for BlockingSink {
        fn on_output(&self, _pty_id: &str, _data: &[u8]) {
            {
                let (lock, cvar) = &*self.entered;
                *lock.lock().unwrap() = true;
                cvar.notify_all();
            }
            let (lock, cvar) = &*self.release;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = cvar.wait(released).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn poisoned_registry_lock_recovers_for_subsequent_ops() {
        let _env = env_lock();

        // Poison the global registry: a thread panics while holding its lock.
        with_silenced_panics(|| {
            let _ = std::thread::spawn(|| {
                let _guard = registry().lock().unwrap();
                panic!("intentional poison for test");
            })
            .join();
        });

        // Sanity: the registry really is poisoned now.
        assert!(registry().lock().is_err());

        // The recovery path used by every production op still yields a guard.
        {
            let guard = lock_recover(registry());
            assert!(!guard.contains_key("definitely-missing"));
        }

        // write/close/resize acquire the registry through lock_recover, so they reach
        // their own not-found logic instead of erroring on the poison — and they do so
        // BEFORE any daemon round trip, so this holds with no daemon running.
        let missing = format!("pty-missing-{}", Uuid::new_v4().simple());
        assert_eq!(
            write(&missing, b"x").await,
            Err(format!("PTY not found: {missing}"))
        );
        assert_eq!(
            close(&missing).await,
            Err(format!("PTY not found: {missing}"))
        );
        assert_eq!(
            resize(&missing, 80, 24).await,
            Err(format!("PTY not found: {missing}"))
        );
        // poll_bell_events reaches the same lock_recover path; with no daemon
        // configured its RPC may legitimately fail, but it must not panic on the poison.
        let _ = poll_bell_events().await;

        // Restore a clean flag so unrelated tests' .lock().unwrap() don't panic.
        registry().clear_poison();
        assert!(registry().lock().is_ok());
    }

    /// The per-instance `tracked` lock is still grove-owned (the AI-status + snapshot
    /// state), so a panic while holding it must not brick later ops. The writer lock
    /// moved into the daemon; `PtyWriter`'s own recovery is covered below.
    #[test]
    fn poisoned_instance_lock_recovers_for_snapshot() {
        let id = register_mock_pty(format!("grove-test-poison-inst-{}", Uuid::new_v4().simple()));
        let tracked = tracked_for(&id);

        poison_mutex(Arc::clone(&tracked));
        assert!(tracked.lock().is_err());

        // A tracked-reading op recovers the poisoned tracked lock.
        assert!(runtime_snapshot_for_pty(&id).unwrap().is_some());
        {
            let _guard = lock_recover(&tracked);
        }

        registry().lock().unwrap().remove(&id);
    }

    #[test]
    fn poisoned_writer_queue_lock_recovers_for_subsequent_writes() {
        let writer = PtyWriter::spawn_input_only(Box::new(io::sink()), WRITE_DEADLINE);
        let shared = Arc::clone(&writer.shared);

        with_silenced_panics(|| {
            let shared = Arc::clone(&shared);
            let _ = std::thread::spawn(move || {
                let _guard = shared.inner.lock().unwrap();
                panic!("intentional poison for test");
            })
            .join();
        });
        assert!(shared.inner.lock().is_err());

        // The writer recovers the poisoned queue lock and still delivers.
        assert!(writer.write(b"hello").is_ok());
    }

    #[test]
    fn registry_reap_plan_partitions_missing_and_dead_reader_sessions() {
        let live: HashSet<String> = ["grove-live".to_string()].into_iter().collect();
        let snapshot = vec![
            RegistryReapEntry {
                pty_id: "a".into(),
                session_name: "grove-live".into(),
                reader_exited: false,
            },
            RegistryReapEntry {
                pty_id: "b".into(),
                session_name: "grove-live".into(),
                reader_exited: true,
            },
            RegistryReapEntry {
                pty_id: "c".into(),
                session_name: "grove-gone".into(),
                reader_exited: true,
            },
        ];

        let plan = build_registry_reap_plan(&snapshot, &live);

        let candidate_ids: Vec<&str> = plan
            .reap_candidates
            .iter()
            .map(|candidate| candidate.pty_id.as_str())
            .collect();
        assert_eq!(candidate_ids, vec!["c"]);
        assert_eq!(plan.dead_reader_pty_ids, vec!["b".to_string()]);
    }

    #[test]
    fn terminal_gc_reaps_registry_entries_the_daemon_no_longer_knows() {
        // The registry snapshot is taken BEFORE `listSessions`, so a candidate is
        // conclusively dead — no re-verification round trip is needed.
        let session_name = format!("grove-test-reap-{}", Uuid::new_v4().simple());
        let id = register_mock_pty(session_name.clone());

        let reaped = reap_dead_registry_entries(&[RegistryReapCandidate {
            pty_id: id.clone(),
            session_name: session_name.clone(),
        }]);

        assert_eq!(reaped, vec![id.clone()]);
        assert!(!registry().lock().unwrap().contains_key(&id));
    }

    #[test]
    fn coalescer_pending_cap_keeps_newest_bytes_when_sink_stalls() {
        let entered = Arc::new((Mutex::new(false), Condvar::new()));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let sink = Arc::new(BlockingSink {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
        });
        let coalescer = OutputCoalescer::new(sink as Arc<dyn PtyEventSink>, "pty-cap".into());

        // Prime the flusher so it enters (and wedges inside) on_output.
        coalescer.push(b"x");
        {
            let (lock, cvar) = &*entered;
            let mut is_entered = lock.lock().unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while !*is_entered {
                let now = Instant::now();
                assert!(now < deadline, "flusher never entered on_output");
                let (guard, _) = cvar.wait_timeout(is_entered, deadline - now).unwrap();
                is_entered = guard;
            }
        }

        // Flusher is wedged and cannot drain; push far past the cap.
        let tail = b"NEWEST-TAIL-MARKER";
        coalescer.push(&vec![b'A'; MAX_PENDING_BYTES + 4096]);
        coalescer.push(tail);

        {
            let state = lock_recover(&coalescer.shared.state);
            assert!(
                state.pending.len() <= MAX_PENDING_BYTES,
                "pending exceeded cap: {}",
                state.pending.len()
            );
            assert!(
                state.pending.ends_with(tail),
                "keep-tail must preserve the newest bytes"
            );
            assert!(
                state.truncated,
                "overflow must set the internal truncated flag"
            );
        }

        // Release the flusher so its thread can exit when the coalescer drops.
        {
            let (lock, cvar) = &*release;
            *lock.lock().unwrap() = true;
            cvar.notify_all();
        }
    }
}
