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

use crate::lock;
use crate::server::{SessionReaper, StreamHub};

/// End-to-end deadline for one input write (design G3, mirrors grove-core).
const WRITE_DEADLINE: Duration = Duration::from_secs(30);
/// Raw scrollback ring cap (design G4; grove's 256 KiB default, configurable
/// later per §8.X).
const RING_CAP_BYTES: usize = 256 * 1024;
/// Force-dispose timer after a graceful kill (orca session.ts KILL_TIMEOUT_MS).
const KILL_FORCE_TIMEOUT: Duration = Duration::from_secs(5);

struct Ring {
    buf: VecDeque<u8>,
    truncated: bool,
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
    #[allow(dead_code)] // Why: authoritative cold-restore source (G4); consumed in a later phase.
    ring: Mutex<Ring>,
    seq: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    /// Guards against emitting two `Exit` frames (reader EOF racing a kill).
    exit_emitted: Arc<AtomicBool>,
    applied: Mutex<(u16, u16)>,
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
            seq,
            alive: Arc::new(AtomicBool::new(true)),
            exit_emitted: Arc::new(AtomicBool::new(false)),
            applied: Mutex::new((cols, rows)),
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

    /// Enqueue input in strict FIFO order (design G3, fix #1). Returns
    /// immediately: the bytes are handed to the per-session forwarder thread,
    /// which performs the blocking `PtyWriter::write` off the tokio runtime. The
    /// single-consumer channel guarantees write order == enqueue (notify-receive)
    /// order. A send error means the session was already torn down; drop silently.
    pub fn enqueue_write(&self, data: &[u8]) {
        let _ = self.write_tx.send(data.to_vec());
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        {
            let guard = lock(&self.master);
            if let Some(master) = guard.as_ref() {
                master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|e| e.to_string())?;
            }
        }
        *lock(&self.applied) = (cols, rows);
        Ok(())
    }

    /// The size last applied to the PTY (design G8 — daemon-owned, no tmux
    /// shell-out). A real emulator's readback lands with the vt100 wrapper (P5).
    pub fn applied_size(&self) -> (u16, u16) {
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

    fn emit_exit(&self, hub: &StreamHub) {
        // Why: reader EOF and a kill can both reach here; only the first wins so
        // the stream never carries a duplicate Exit.
        if self.exit_emitted.swap(true, Ordering::SeqCst) {
            return;
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
        let seq = self.seq.load(Ordering::SeqCst);
        let frame = StreamFrame::exit(self.id.clone(), seq, &status);
        if let Ok(bytes) = frame.to_bytes() {
            hub.emit(bytes);
        }
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
                    session.append_ring(&buf[..n]);
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
    session.emit_exit(&hub);
    // Fix #3: the session is dead — drop the master fd so it can't leak, then
    // remove ourselves from the daemon's map. Ordering: this runs AFTER the Exit
    // barrier above, and the reaper only removes the entry if it still points at
    // THIS Session (Arc identity), so a same-id session created in the race
    // window is never clobbered.
    let _ = lock(&session.master).take();
    session.reaper.reap(&session.id, &session);
}
