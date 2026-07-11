//! Producer flow-control + Tier-C sleep/wake e2e (design S14/P11/L12).
//!
//! Each test spawns the REAL grove-daemon binary on a temp unix socket and drives
//! it through the async grove-core `DaemonClient`, exercising the full cross-process
//! surface: pause parks output (kernel backpressure) and resume delivers the
//! buffered tail in order; kill of a write-blocked flooding child terminates
//! promptly via resume-before-kill; a paused session unparks after a reconnect
//! (owed-resume); and `checkpoint_all` writes a checkpoint for every live session
//! without stamping `ended_at`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use grove_core::daemon::client::{
    CreateOrAttach, DaemonClient, DaemonClientOptions, StreamSubscriber,
};
use grove_core::daemon::framing::ExitStatus;
use grove_core::daemon::protocol::{daemon_token_path, history_root};
use grove_daemon::history::{session_dir, HistoryReader};

// --- process harness -----------------------------------------------------

/// A spawned daemon binary; killed on drop so a failing assert never leaks it.
struct DaemonProc {
    child: std::process::Child,
}

impl Drop for DaemonProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Unique short /tmp paths (unix sockets cap at ~104 bytes → keep them short).
fn unique_paths() -> (PathBuf, PathBuf) {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id();
    let socket = PathBuf::from(format!("/tmp/grove-fc-{pid}-{n}.sock"));
    let base_dir = PathBuf::from(format!("/tmp/grove-fc-{pid}-{n}.d"));
    (socket, base_dir)
}

fn spawn_daemon(socket: &Path, token: &str, base_dir: &Path) -> DaemonProc {
    std::fs::create_dir_all(base_dir).expect("create base dir");
    let child = Command::new(env!("CARGO_BIN_EXE_grove-daemon"))
        .arg("--socket")
        .arg(socket)
        .arg("--token")
        .arg(token)
        .arg("--base-dir")
        .arg(base_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn grove-daemon");
    DaemonProc { child }
}

async fn wait_ready(socket: &Path, token_file: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if token_file.exists() && tokio::net::UnixStream::connect(socket).await.is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

async fn wait_until<F: Fn() -> bool>(f: F, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    f()
}

fn client_for(socket: &Path, base_dir: &Path) -> DaemonClient {
    DaemonClient::new(DaemonClientOptions::new(
        socket.to_path_buf(),
        daemon_token_path(base_dir),
    ))
}

fn attach(session_id: &str) -> CreateOrAttach {
    CreateOrAttach {
        session_id: session_id.to_string(),
        cwd: Some("/tmp".to_string()),
        cols: 80,
        rows: 24,
        ..Default::default()
    }
}

// --- test stream subscriber ----------------------------------------------

#[derive(Default)]
struct Collector {
    data: Mutex<Vec<u8>>,
    exits: Mutex<Vec<ExitStatus>>,
    /// Running `\n` count, advanced incrementally in `on_data`. Lets a poller detect
    /// "the whole sequence arrived" in O(1) instead of re-scanning the (multi-MB)
    /// buffer each tick — a full re-scan under the data lock would starve the stream
    /// reader and stall delivery.
    newlines: AtomicU64,
}

impl Collector {
    fn len(&self) -> usize {
        self.data.lock().unwrap().len()
    }
    fn snapshot(&self) -> Vec<u8> {
        self.data.lock().unwrap().clone()
    }
    fn newlines(&self) -> u64 {
        self.newlines.load(Ordering::SeqCst)
    }
    fn exit_count(&self) -> usize {
        self.exits.lock().unwrap().len()
    }
}

impl StreamSubscriber for Collector {
    fn on_data(&self, _seq: u64, data: &[u8]) {
        let nl = data.iter().filter(|&&b| b == b'\n').count() as u64;
        self.newlines.fetch_add(nl, Ordering::SeqCst);
        self.data.lock().unwrap().extend_from_slice(data);
    }
    fn on_exit(&self, status: ExitStatus) {
        self.exits.lock().unwrap().push(status);
    }
}

/// Poll `collector.len()` until it stops growing (two equal samples 120ms apart),
/// then return the settled length. This is the point at which the daemon reader has
/// parked — proving pause applied kernel backpressure (design S14).
async fn wait_for_quiesce(collector: &Collector, timeout: Duration) -> usize {
    let deadline = Instant::now() + timeout;
    let mut last = collector.len();
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(120)).await;
        let now = collector.len();
        if now == last {
            return now;
        }
        last = now;
    }
    last
}

// --- tests ---------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pause_parks_output_then_resume_delivers_tail_in_order() {
    // Design S14: pause parks the PTY reader so a flooding child hits kernel
    // backpressure (output QUIESCES); resume delivers the buffered tail, and the
    // reconstructed stream is byte-ordered with no loss/dup/reorder across the
    // pause boundary. `seq 1 N` is the ordered probe; a strictly-increasing
    // contiguous run of pure-integer lines proves ordering + integrity.
    let (socket, base_dir) = unique_paths();
    let _daemon = spawn_daemon(&socket, "tok-fc", &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let client = client_for(&socket, &base_dir);
    let collector = Arc::new(Collector::default());
    client.subscribe("flood", collector.clone());
    client.create_or_attach(attach("flood")).await.expect("create flood");

    // ~14 MB of ordered lines — far more than can drain before pause lands. `awk`
    // (not `seq`) is the ordered probe: BSD `seq` prints `%g` scientific notation
    // (`1e+06`) at >=1,000,000, whereas `awk` prints plain integers on both macOS
    // and Linux, so every line stays a pure-digit ordering check.
    const N: u64 = 2_000_000;
    client
        .write(
            "flood",
            format!("awk 'BEGIN{{for(i=1;i<={N};i++)print i}}'\n").as_bytes(),
        )
        .await
        .expect("write awk");

    // Wait until the flood is well underway, then pause.
    assert!(
        wait_until(|| collector.len() > 20_000, Duration::from_secs(5)).await,
        "flood never started streaming"
    );
    client.pause_pty("flood").await.expect("pause");

    // Output must QUIESCE while paused (the reader parked). Record the settled tail.
    let paused_len = wait_for_quiesce(&collector, Duration::from_secs(3)).await;
    let after_settle = collector.len();
    assert_eq!(
        paused_len, after_settle,
        "output kept flowing while paused — the reader did not park"
    );

    client.resume_pty("flood").await.expect("resume");

    // Wait until every output line has arrived (design S14: the buffered tail is
    // delivered after resume). `seq 1 N` emits N lines; the echoed command + prompt
    // add a few more, so `>= N` newlines means the whole sequence landed. The check
    // is O(1) (an incremental counter) so it never starves the stream reader.
    assert!(
        wait_until(|| collector.newlines() >= N, Duration::from_secs(45)).await,
        "the buffered tail never arrived after resume (newlines={})",
        collector.newlines()
    );
    let final_len = collector.len();

    // Self-validation: a large tail must have arrived AFTER resume, proving the
    // reader was genuinely holding data back (not that the flood merely finished
    // before we paused). If pause had landed after completion this would be ~0.
    assert!(
        final_len - paused_len > 2_000_000,
        "expected a large post-resume tail (parked data); paused_len={paused_len}, final_len={final_len}"
    );

    // Order + integrity: the pure-integer lines are exactly 1,2,3,...,N contiguous.
    let text = String::from_utf8_lossy(&collector.snapshot()).into_owned();
    let mut expect: u64 = 1;
    for line in text.split('\n') {
        let t = line.trim_end_matches('\r');
        if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
            continue; // shell prompt / the echoed `seq 1 N` command line
        }
        let value: u64 = t.parse().expect("pure-digit line parses");
        assert_eq!(
            value, expect,
            "sequence broke ordering/integrity at {value} (expected {expect})"
        );
        expect += 1;
    }
    assert_eq!(
        expect - 1,
        N,
        "did not observe the full contiguous 1..={N} sequence (last was {})",
        expect - 1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kill_of_write_blocked_flooding_child_terminates_promptly() {
    // Design S14 (resume-before-kill, mustReplicate): pause a flooding child so it
    // blocks in write() against a full PTY buffer and the reader parks. A kill must
    // unpark the reader BEFORE signalling, so the child dies and the Exit frame
    // lands PROMPTLY — not after the 5s lost-resume failsafe.
    let (socket, base_dir) = unique_paths();
    let _daemon = spawn_daemon(&socket, "tok-kb", &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let client = client_for(&socket, &base_dir);
    let collector = Arc::new(Collector::default());
    client.subscribe("kb", collector.clone());
    client.create_or_attach(attach("kb")).await.expect("create kb");

    // `yes` floods forever → after pause it blocks in write() (full PTY buffer).
    client.write("kb", b"yes FLOODY_LINE\n").await.expect("write yes");
    assert!(
        wait_until(|| collector.len() > 20_000, Duration::from_secs(5)).await,
        "yes never started flooding"
    );
    client.pause_pty("kb").await.expect("pause");
    wait_for_quiesce(&collector, Duration::from_secs(3)).await;

    // Kill the write-blocked, reader-parked session and time the Exit.
    let started = Instant::now();
    client.kill("kb").await.expect("kill");
    assert!(
        wait_until(|| collector.exit_count() >= 1, Duration::from_secs(4)).await,
        "the killed session never emitted an Exit frame"
    );
    let elapsed = started.elapsed();
    // Resume-before-kill makes this near-instant; without it the reader would stay
    // parked until the 5s failsafe. A <3s bound cleanly distinguishes the two.
    assert!(
        elapsed < Duration::from_secs(3),
        "kill of a write-blocked/parked child took {elapsed:?} — resume-before-kill did not fire"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn paused_session_unparks_after_reconnect_via_owed_resume() {
    // Design P11: a session paused when the socket drops queues an OWED resume; on
    // the next fresh connect the client re-sends `resumePty` so the reader never
    // stays parked. We pause a live flooding session, force a transient disconnect,
    // reconnect, and assert both the owed bookkeeping (populated → flushed) and the
    // outcome (the reader unparks and the flood resumes).
    let (socket, base_dir) = unique_paths();
    let _daemon = spawn_daemon(&socket, "tok-rc", &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let client = client_for(&socket, &base_dir);
    let collector = Arc::new(Collector::default());
    client.subscribe("rc", collector.clone());
    client.create_or_attach(attach("rc")).await.expect("create rc");

    client.write("rc", b"yes RECON_LINE\n").await.expect("write yes");
    assert!(
        wait_until(|| collector.len() > 20_000, Duration::from_secs(5)).await,
        "flood never started"
    );
    client.pause_pty("rc").await.expect("pause");
    assert!(client.is_producer_paused("rc"), "rc must be locally recorded paused");
    let paused_len = wait_for_quiesce(&collector, Duration::from_secs(3)).await;

    // A transient socket drop: paused sessions move into the owed-resume set.
    client.reset_connection();
    assert!(
        !client.is_producer_paused("rc"),
        "reset must drain the paused set into owed"
    );
    assert_eq!(
        client.producer_resumes_owed_len(),
        1,
        "the paused session must owe a resume across the disconnect"
    );

    // Any op reconnects; the fresh-connect resync flushes the owed resume.
    client.list_sessions().await.expect("reconnect via listSessions");
    assert_eq!(
        client.producer_resumes_owed_len(),
        0,
        "the owed resume must be flushed on reconnect"
    );

    // Outcome: the reader is unparked and the flood streams again.
    assert!(
        wait_until(|| collector.len() > paused_len + 50_000, Duration::from_secs(5)).await,
        "the reader never unparked after reconnect (len stuck at {paused_len})"
    );

    client.kill("rc").await.expect("kill");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn checkpoint_all_writes_checkpoints_without_stamping_ended_at() {
    // Design L12: `checkpoint_all` writes a final checkpoint for EVERY live session
    // (awaiting any in-flight tick, covered by the checkpointer unit tests) and does
    // NOT stamp `ended_at` — so each stays cold-restore ELIGIBLE for wake.
    let (socket, base_dir) = unique_paths();
    let _daemon = spawn_daemon(&socket, "tok-ca", &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let client = client_for(&socket, &base_dir);
    let ids = ["ca0", "ca1", "ca2"];
    let mut collectors = Vec::new();
    for id in ids {
        let c = Arc::new(Collector::default());
        client.subscribe(id, c.clone());
        client.create_or_attach(attach(id)).await.expect("create session");
        client
            .write(id, format!("echo MARK_{id}\n").as_bytes())
            .await
            .expect("write");
        collectors.push(c);
    }
    // Let each session emit some output so it has state worth checkpointing.
    for (id, c) in ids.iter().zip(&collectors) {
        assert!(
            wait_until(
                || String::from_utf8_lossy(&c.snapshot()).contains(&format!("MARK_{id}")),
                Duration::from_secs(5),
            )
            .await,
            "{id} never echoed its marker"
        );
    }

    // Checkpoint every session. On return the writes are durable (the RPC awaits).
    client.checkpoint_all().await.expect("checkpoint_all");

    let root = history_root(&base_dir);
    let reader = HistoryReader::new(&root);
    for id in ids {
        let dir = session_dir(&root, id);
        assert!(
            dir.join("checkpoint.json").exists(),
            "{id} must have a checkpoint after checkpoint_all"
        );
        // ended_at==null (unclean) is the D2 cold-restore discriminator: an
        // un-ended, checkpointed session is restorable.
        assert!(
            reader.has_restorable_history(id),
            "{id} must stay cold-restorable (ended_at NOT stamped by checkpoint_all)"
        );
    }

    for id in ids {
        client.kill(id).await.expect("kill");
    }
}
