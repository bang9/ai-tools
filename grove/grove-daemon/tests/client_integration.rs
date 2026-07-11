//! grove-core DaemonClient ↔ grove-daemon integration tests (design P3).
//!
//! These live in grove-daemon's test crate because that is where
//! `env!("CARGO_BIN_EXE_grove-daemon")` resolves: each test spawns the REAL
//! daemon binary on a temp unix socket and drives it through the async
//! `DaemonClient` from grove-core. That exercises the full P3 surface end to end:
//! RPC round-trip, per-request timeout on a stalled method, connect-coalescing,
//! in-flight rejection on disconnect (no hang), and a generation-guarded
//! reconnect that re-delivers Exit + resubscribes the stream after a kill.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use grove_core::daemon::client::{
    ClientError, CreateOrAttach, DaemonClient, DaemonClientOptions, StreamSubscriber,
};
use grove_core::daemon::framing::ExitStatus;
use grove_core::daemon::protocol::daemon_token_path;
use serde_json::{json, Value};

// --- process harness -----------------------------------------------------

/// A spawned daemon binary; killed on drop so a failing assert never leaks it.
struct DaemonProc {
    child: std::process::Child,
}

impl DaemonProc {
    fn kill_now(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for DaemonProc {
    fn drop(&mut self) {
        self.kill_now();
    }
}

/// Unique short /tmp paths (unix sockets cap at ~104 bytes → keep them short).
fn unique_paths() -> (PathBuf, PathBuf) {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id();
    let socket = PathBuf::from(format!("/tmp/grove-cit-{pid}-{n}.sock"));
    let base_dir = PathBuf::from(format!("/tmp/grove-cit-{pid}-{n}.d"));
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

/// Wait until the daemon has bound the socket AND written its token file.
async fn wait_ready(socket: &Path, token_file: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if token_file.exists()
            && tokio::net::UnixStream::connect(socket).await.is_ok()
        {
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
}

impl Collector {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.data.lock().unwrap()).into_owned()
    }
    fn exit_count(&self) -> usize {
        self.exits.lock().unwrap().len()
    }
}

impl StreamSubscriber for Collector {
    fn on_data(&self, _seq: u64, data: &[u8]) {
        self.data.lock().unwrap().extend_from_slice(data);
    }
    fn on_exit(&self, status: ExitStatus) {
        self.exits.lock().unwrap().push(status);
    }
}

// --- tests ---------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_round_trip_and_stream_data() {
    let (socket, base_dir) = unique_paths();
    let _daemon = spawn_daemon(&socket, "tok-rt", &base_dir);
    assert!(
        wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await,
        "daemon never became ready"
    );

    let client = client_for(&socket, &base_dir);
    let collector = Arc::new(Collector::default());
    client.subscribe("s1", collector.clone());

    let result = client.create_or_attach(attach("s1")).await.expect("createOrAttach");
    assert!(result.is_new, "fresh session should be new");

    let sessions = client.list_sessions().await.expect("listSessions");
    assert!(
        sessions.iter().any(|s| s.session_id == "s1" && s.is_alive),
        "s1 should be listed alive; got {sessions:?}"
    );

    client.write("s1", b"echo CLIENT_MARKER_71\n").await.expect("write");
    let saw = wait_until(
        || collector.text().contains("CLIENT_MARKER_71"),
        Duration::from_secs(5),
    )
    .await;
    assert!(saw, "did not observe echoed marker; got: {:?}", collector.text());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_times_out_on_stalled_method() {
    let (socket, base_dir) = unique_paths();
    let _daemon = spawn_daemon(&socket, "tok-to", &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let client = client_for(&socket, &base_dir);
    let started = Instant::now();
    let err = client
        .request_with_timeout("debugSleep", json!({ "ms": 3000 }), Duration::from_millis(200))
        .await
        .expect_err("stalled method must time out");
    assert!(
        matches!(err, ClientError::Timeout { .. }),
        "expected Timeout, got {err:?}"
    );
    // The timeout must fire near its deadline, not near the 3s daemon sleep.
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "timeout took too long: {:?}",
        started.elapsed()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_connect_is_coalesced_to_one_hello() {
    let (socket, base_dir) = unique_paths();
    let _daemon = spawn_daemon(&socket, "tok-coal", &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let client = client_for(&socket, &base_dir);

    // Many concurrent ensure_connected callers must share ONE connect → one
    // control hello (design P7 connect-coalescing).
    let mut handles = Vec::new();
    for _ in 0..12 {
        let c = client.clone();
        handles.push(tokio::spawn(async move { c.ensure_connected().await }));
    }
    for h in handles {
        h.await.expect("join").expect("ensure_connected");
    }

    let reply = client
        .request("debugControlHelloCount", Value::Null)
        .await
        .expect("debugControlHelloCount");
    assert_eq!(
        reply.get("count").and_then(Value::as_u64),
        Some(1),
        "concurrent callers must produce exactly one control hello; got {reply:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn in_flight_rpc_rejected_on_disconnect_without_hanging() {
    let (socket, base_dir) = unique_paths();
    let mut daemon = spawn_daemon(&socket, "tok-inflight", &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let client = client_for(&socket, &base_dir);
    client.ensure_connected().await.expect("connect");

    // Launch a long RPC (30s timeout) and let it register in the pending map.
    let c = client.clone();
    let inflight = tokio::spawn(async move {
        c.request_with_timeout("debugSleep", json!({ "ms": 30000 }), Duration::from_secs(30))
            .await
    });
    tokio::time::sleep(Duration::from_millis(250)).await;

    // Kill the daemon out from under it. The socket EOF must reject the pending
    // RPC promptly — NOT leave it hanging until the 30s deadline (design P7).
    daemon.kill_now();

    let joined = tokio::time::timeout(Duration::from_secs(3), inflight).await;
    let result = joined.expect("in-flight RPC hung past disconnect").expect("join");
    assert!(
        matches!(result, Err(ClientError::ConnectionLost)),
        "in-flight RPC should be rejected with ConnectionLost, got {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn warm_reattach_returns_live_snapshot_with_modes() {
    // Design P9/S15 end to end: a second createOrAttach on a LIVE session must come
    // back with the warm VT snapshot the daemon builds from its emulator — the
    // current screen, its alt-screen flag, and the rehydrate mode bytes — NOT a
    // fresh spawn. The first attach here dropped that payload before P6.
    let (socket, base_dir) = unique_paths();
    let _daemon = spawn_daemon(&socket, "tok-warm", &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let client = client_for(&socket, &base_dir);
    let collector = Arc::new(Collector::default());
    client.subscribe("warm1", collector.clone());

    let first = client.create_or_attach(attach("warm1")).await.expect("create warm1");
    assert!(first.is_new, "fresh session should be new");
    assert!(first.warm_reattach.is_none(), "a fresh spawn carries no warm reattach");

    // Drive the CHILD to EMIT (not type) the mode-setting escapes so the daemon's
    // emulator ingests them from PTY output: set a title, enter the alternate
    // screen (?1049h), enable button-motion mouse tracking (?1002h), then paint an
    // alt-screen marker. `printf` from the shell writes these to its stdout.
    client
        .write(
            "warm1",
            b"printf '\\033]0;WARMTITLE\\007\\033[?1049h\\033[?1002hALT_SCREEN_BODY'\n",
        )
        .await
        .expect("write escapes");

    // Poll createOrAttach until the emulator has ingested the alt-screen enter.
    // Re-attaching a live session is idempotent (it just re-serves the snapshot).
    let mut warm = None;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let r = client.create_or_attach(attach("warm1")).await.expect("reattach warm1");
        assert!(!r.is_new, "an adopted live session is never new");
        if let Some(w) = r.warm_reattach {
            if w.is_alternate_screen {
                warm = Some(w);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let warm = warm.expect("warm reattach with alt screen never materialized");

    assert!(warm.is_alternate_screen, "session must be in the alternate screen");
    assert!(!warm.snapshot.is_empty(), "warm snapshot must be non-empty");
    assert!(
        warm.snapshot.contains("?1049h"),
        "rehydrate must re-arm the alternate screen; snapshot: {:?}",
        warm.snapshot
    );
    assert!(
        warm.snapshot.contains("?1002h"),
        "rehydrate must re-arm button-motion mouse mode; snapshot: {:?}",
        warm.snapshot
    );
    assert!(
        warm.pending_escape_tail_ansi.is_none(),
        "no partial escape was left mid-sequence; got {:?}",
        warm.pending_escape_tail_ansi
    );
    assert_eq!(warm.cols, 80, "warm dims must match the live session");
    assert_eq!(warm.rows, 24, "warm dims must match the live session");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconnect_after_kill_delivers_exit_and_restreams() {
    let (socket, base_dir) = unique_paths();
    let mut daemon_a = spawn_daemon(&socket, "tok-recon", &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let client = client_for(&socket, &base_dir);
    let s1 = Arc::new(Collector::default());
    client.subscribe("s1", s1.clone());
    client.create_or_attach(attach("s1")).await.expect("create s1");
    client.ensure_connected().await.expect("connected");

    // Kill daemon A: s1's child dies with no Exit frame (SIGKILL). The client
    // must notice the disconnect.
    daemon_a.kill_now();
    assert!(
        wait_until(|| !client.is_connected(), Duration::from_secs(3)).await,
        "client never noticed the daemon dying"
    );

    // Bring a FRESH daemon up on the same endpoint (it unlinks the stale socket).
    let _daemon_b = spawn_daemon(&socket, "tok-recon", &base_dir);
    assert!(
        wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await,
        "replacement daemon never became ready"
    );

    // Any op reconnects and resyncs (design P8): listSessions on the fresh daemon
    // is empty, so s1 (believed alive, now gone) gets a synthesized Exit.
    let sessions = client.list_sessions().await.expect("listSessions after reconnect");
    assert!(
        sessions.is_empty(),
        "fresh daemon should have no sessions; got {sessions:?}"
    );
    assert!(
        wait_until(|| s1.exit_count() >= 1, Duration::from_secs(3)).await,
        "s1 never received its re-delivered Exit after reconnect"
    );

    // The stream is resubscribed on the new connection: a fresh session streams.
    let s2 = Arc::new(Collector::default());
    client.subscribe("s2", s2.clone());
    let r = client.create_or_attach(attach("s2")).await.expect("create s2");
    assert!(r.is_new, "s2 on the fresh daemon should be new");
    client.write("s2", b"echo RESTREAM_OK_44\n").await.expect("write s2");
    let saw = wait_until(
        || s2.text().contains("RESTREAM_OK_44"),
        Duration::from_secs(5),
    )
    .await;
    assert!(
        saw,
        "stream did not resubscribe after reconnect; got: {:?}",
        s2.text()
    );
}
