//! Stage 2 — AI status / bell polling + terminal GC, driven through grove-core's PTY
//! **pub API** against the REAL daemon binary (design G9 / §9).
//!
//! Same harness as `pty_pub_api.rs` (see its header): `GROVE_DAEMON_BIN` hands the
//! supervisor the freshly-built daemon, and HOME + the base dir are temp dirs so the
//! test never touches the developer's `~/.grove`.
//!
//! ONE test, not six: `daemon::configure` is a process-wide OnceLock and the daemon it
//! spawns is DETACHED, so it must be shut down exactly once, at the end.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use grove_core::daemon::{self, CreateOrAttach, DaemonRuntimeConfig, DAEMON_BIN_ENV};
use grove_core::pty;
use grove_core::{
    CreatePtyRequest, PtyBellEvent, PtyEventSink, SaveTerminalSessionSnapshotRequest,
    TerminalPaneSnapshotInput,
};

mod support;
use support::TempDir;

#[derive(Default)]
struct CollectingSink {
    bytes: Mutex<Vec<u8>>,
}

impl PtyEventSink for CollectingSink {
    fn on_output(&self, _pty_id: &str, data: &[u8]) {
        self.bytes.lock().unwrap().extend_from_slice(data);
    }
}

impl CollectingSink {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.lock().unwrap()).into_owned()
    }
}

/// Every scratch dir is an RAII `TempDir` (see `support`) — a test run must not leave
/// `/tmp/gv-*` dirs on the developer's machine.
fn unique_dir(prefix: &str) -> TempDir {
    TempDir::new(prefix)
}

async fn wait_until(timeout: Duration, label: &str, mut probe: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !probe() {
        assert!(Instant::now() < deadline, "timed out waiting for {label}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Publish a status the way a tool hook does: an atomic write into the pane's
/// `GROVE_AI_STATUS_FILE`. An EMPTY payload is the hook's explicit "clear".
fn publish_hook_status(base_dir: &Path, session_id: &str, status: &str) {
    let dir = base_dir.join("ai-status");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(session_id);
    let tmp = dir.join(format!("{session_id}.test.tmp"));
    std::fs::write(&tmp, status).unwrap();
    std::fs::rename(&tmp, &path).unwrap();
}

fn status_of(events: &[PtyBellEvent], pty_id: &str) -> Option<String> {
    events
        .iter()
        .find(|event| event.pty_id == pty_id)
        .and_then(|event| event.ai_status.clone())
}

/// A second app's CONTROL socket — a raw hello, nothing more. Deliberately NOT a full
/// `DaemonClient`: the daemon's stream hub holds ONE subscriber slot, so a second
/// client's stream hello would evict the first app's stream and disconnect it. The GC
/// gate under test reads the CONTROL-client gauge, which this bumps to exactly 2.
/// Dropping the returned stream disconnects it (the daemon decrements on socket close).
async fn connect_second_control_client(base_dir: &Path) -> tokio::net::UnixStream {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let socket = daemon::daemon_socket_path(base_dir)
        .as_path()
        .expect("a unix socket endpoint")
        .to_path_buf();
    let token = std::fs::read_to_string(daemon::daemon_token_path(base_dir))
        .expect("the daemon token file")
        .trim()
        .to_string();

    let mut stream = tokio::net::UnixStream::connect(&socket)
        .await
        .expect("a second app connects to the daemon socket");
    let hello = daemon::Hello {
        version: daemon::GROVE_DAEMON_PROTOCOL_VERSION,
        token,
        client_id: "second-app-test".to_string(),
        kind: daemon::ClientKind::Control,
    };
    let line = daemon::encode_ndjson_line(&hello).unwrap();
    stream.write_all(line.as_bytes()).await.unwrap();
    stream.flush().await.unwrap();

    let mut ack = String::new();
    BufReader::new(&mut stream)
        .read_line(&mut ack)
        .await
        .expect("the daemon acks the hello");
    assert!(ack.contains("\"ok\":true"), "hello ack: {ack}");
    stream
}

/// Backdate a directory's mtime so the 5-minute young-dir guard can be exercised
/// without a 5-minute test.
fn backdate(dir: &Path, age: Duration) {
    let handle = std::fs::File::open(dir).expect("open the history dir for a timestamp rewrite");
    handle
        .set_modified(SystemTime::now() - age)
        .expect("backdate the history dir mtime");
}

#[tokio::test(flavor = "multi_thread")]
async fn ai_status_poll_and_terminal_gc_against_real_daemon() {
    let home = unique_dir("home");
    let base_dir = unique_dir("dmn");
    let worktree = unique_dir("wt");
    // A second worktree that will be DELETED, to drive the stale/kill GC path.
    let doomed = unique_dir("dead");
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var(DAEMON_BIN_ENV, env!("CARGO_BIN_EXE_grove-daemon"));
    }

    daemon::configure(DaemonRuntimeConfig {
        base_dir: base_dir.to_path_buf(),
        bin_source_path: base_dir.join("not-a-real-daemon"),
        app_version: "0.0.0-test".to_string(),
    });

    let worktree_path = worktree.to_string_lossy().into_owned();
    let doomed_path = doomed.to_string_lossy().into_owned();
    let pane_id = "pane-status";
    let session_id = pty::daemon_session_id(&worktree_path, pane_id);
    let sink = Arc::new(CollectingSink::default());

    pty::create(
        CreatePtyRequest {
            pty_id: "pty-1".into(),
            pane_id: pane_id.into(),
            worktree_path: worktree_path.clone(),
            cwd: worktree_path.clone(),
            cols: 80,
            rows: 24,
            restore: None,
        },
        Arc::clone(&sink) as Arc<dyn PtyEventSink>,
    )
    .await
    .expect("create must spawn a daemon session");

    let client = daemon::global_client()
        .expect("create() installs the global client")
        .client();

    // Let the shell settle (its prompt is the pane's first output).
    pty::write("pty-1", b"echo GROVE_READY\r").await.unwrap();
    {
        let sink = Arc::clone(&sink);
        wait_until(Duration::from_secs(20), "shell prompt", move || {
            sink.text().contains("GROVE_READY")
        })
        .await;
    }

    // ── DELTA EMISSION ──────────────────────────────────────────────────────────
    // The daemon returns a row per LIVE session on EVERY poll. grove must emit a
    // PtyBellEvent only when something CHANGED — never a row-per-tick stream.
    let events = pty::poll_bell_events().await.unwrap();
    assert!(
        events.is_empty(),
        "a quiet pane with no bell and no status must emit NO event; got {events:?}"
    );

    // A hook publishes a status → exactly one event carrying it.
    publish_hook_status(&base_dir, &session_id, "claude:running");
    let events = pty::poll_bell_events().await.unwrap();
    assert_eq!(events.len(), 1, "a status change emits one event");
    assert_eq!(events[0].pty_id, "pty-1", "events are keyed by grove PTY id");
    assert!(!events[0].bell);
    assert_eq!(events[0].ai_status.as_deref(), Some("claude:running"));

    // Nothing changed since → NO event. (This also proves the write-back landed: the
    // daemon now reports claude:running, so the poll finds no delta.)
    let events = pty::poll_bell_events().await.unwrap();
    assert!(
        events.is_empty(),
        "an unchanged status must NOT re-emit; got {events:?}"
    );
    assert_eq!(
        client
            .poll_bells()
            .await
            .unwrap()
            .iter()
            .find(|row| row.pty_id == session_id)
            .and_then(|row| row.ai_status.clone())
            .as_deref(),
        Some("claude:running"),
        "the hook's status must have been written back into the daemon's store"
    );

    // A real BEL in the pane's output → one event with bell=true, and the bell DRAINS
    // (the daemon swaps it false on read), so it never re-fires.
    pty::write("pty-1", b"printf '\\a'\r").await.unwrap();
    let mut bell_events: Vec<PtyBellEvent> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while bell_events.is_empty() {
        assert!(Instant::now() < deadline, "the BEL never reached the daemon");
        tokio::time::sleep(Duration::from_millis(100)).await;
        bell_events = pty::poll_bell_events()
            .await
            .unwrap()
            .into_iter()
            .filter(|event| event.bell)
            .collect();
    }
    assert_eq!(bell_events[0].pty_id, "pty-1");
    assert_eq!(
        bell_events[0].ai_status.as_deref(),
        Some("claude:running"),
        "a bell event carries the CURRENT status, unchanged"
    );
    let events = pty::poll_bell_events().await.unwrap();
    assert!(
        events.iter().all(|event| !event.bell),
        "the bell drained on the previous poll; got {events:?}"
    );

    // ── HOOK FILE vs ENTER-DETECTION ────────────────────────────────────────────
    // The daemon flips a hookless tool idle→running when it sees `\r` in the input
    // (Session::detect_enter — the successor of pty.rs's Enter-detection). A status
    // the HOOK published since the last tick must WIN over that, exactly as a hook's
    // `tmux set-option` overwrote whatever Enter-detection had just set.
    client
        .set_ai_status(&session_id, Some("codex:idle"))
        .await
        .unwrap();
    pty::write("pty-1", b"\r").await.unwrap();
    {
        let client_ref = client;
        let session = session_id.clone();
        wait_until(Duration::from_secs(20), "daemon Enter-detection", || {
            let session = session.clone();
            futures_lite_block(async move {
                client_ref
                    .poll_bells()
                    .await
                    .unwrap()
                    .iter()
                    .find(|row| row.pty_id == session)
                    .and_then(|row| row.ai_status.clone())
                    .as_deref()
                    == Some("codex:running")
            })
        })
        .await;
    }

    publish_hook_status(&base_dir, &session_id, "codex:attention");
    let events = pty::poll_bell_events().await.unwrap();
    assert_eq!(
        status_of(&events, "pty-1").as_deref(),
        Some("codex:attention"),
        "the hook FILE must win over the daemon's Enter-detection transition"
    );

    // ── IDLE CLOCK ──────────────────────────────────────────────────────────────
    // running →(no output for CODEX_OUTPUT_IDLE_TIMEOUT=3s)→ idle, driven entirely by
    // `last_output_at`, which the daemon stream sink stamps on every output frame.
    client
        .set_ai_status(&session_id, Some("codex:running"))
        .await
        .unwrap();
    pty::write("pty-1", b"echo GROVE_IDLE_CLOCK\r").await.unwrap();
    {
        let sink = Arc::clone(&sink);
        wait_until(Duration::from_secs(20), "idle-clock output", move || {
            sink.text().contains("GROVE_IDLE_CLOCK")
        })
        .await;
    }
    // Fresh output ⇒ still running.
    let events = pty::poll_bell_events().await.unwrap();
    assert_eq!(
        status_of(&events, "pty-1").as_deref(),
        Some("codex:running"),
        "a hookless tool with FRESH output must stay running"
    );
    // Output stops ⇒ idle once the 3s window elapses.
    tokio::time::sleep(Duration::from_millis(3_300)).await;
    let events = pty::poll_bell_events().await.unwrap();
    assert_eq!(
        status_of(&events, "pty-1").as_deref(),
        Some("codex:idle"),
        "no output for >3s must transition a hookless tool running→idle"
    );

    // ── TERMINAL GC ─────────────────────────────────────────────────────────────
    // Stage the world: a doomed worktree that is REFERENCED (its pane snapshot is in
    // the store) and owns a daemon session grove is NOT holding in its registry (an
    // unattached session — the tmux path's `attached == 0`).
    let doomed_session = pty::daemon_session_id(&doomed_path, "pane-doomed");
    client
        .create_or_attach(CreateOrAttach {
            session_id: doomed_session.clone(),
            cwd: Some(doomed_path.clone()),
            cols: 80,
            rows: 24,
            env: Vec::new(),
            scrollback_bytes: None,
        })
        .await
        .expect("the doomed worktree's session must spawn");

    pty::save_terminal_session_snapshot(SaveTerminalSessionSnapshotRequest {
        worktree_path: doomed_path.clone(),
        panes: vec![TerminalPaneSnapshotInput {
            pane_id: "pane-doomed".into(),
            pty_id: None,
            launch_cwd: Some(doomed_path.clone()),
        }],
    })
    .await
    .unwrap();

    // History dirs: one DEAD + ORPHANED + OLD (reapable), one DEAD + ORPHANED + YOUNG
    // (spared by the guard). The live pane's own dir must survive both.
    let history_root = daemon::history_root(&base_dir);
    std::fs::create_dir_all(&history_root).unwrap();
    let old_dir = history_root.join("grove-000000000000-oldorphan");
    let young_dir = history_root.join("grove-111111111111-youngorph");
    std::fs::create_dir_all(&old_dir).unwrap();
    std::fs::create_dir_all(&young_dir).unwrap();
    backdate(&old_dir, Duration::from_secs(30 * 60));

    // The worktree is gone; every layout/snapshot that references it is now stale.
    std::fs::remove_dir_all(&doomed).unwrap();

    // (a) ANOTHER APP CONNECTED → stand down entirely. The connected-client gauge
    // COUNTS THE CALLER, so this gate is `> 1`; a `> 0` test would disable GC forever.
    let second_app = connect_second_control_client(&base_dir).await;
    wait_until(Duration::from_secs(10), "two connected clients", || {
        futures_lite_block(async { client.connected_clients().await.unwrap_or(0) >= 2 })
    })
    .await;

    let report = pty::run_terminal_gc(false).await.unwrap();
    assert!(
        report.stale_worktree_paths.is_empty()
            && report.pruned_worktree_paths.is_empty()
            && report.stale_session_names.is_empty()
            && report.killed_session_names.is_empty()
            && report.reaped_pty_ids.is_empty()
            && report.skipped_attached_worktree_paths.is_empty()
            && report.leftover_process_ids.is_empty()
            && report.dead_reader_pty_ids.is_empty(),
        "another connected app must skip EVERYTHING; got {report:?}"
    );
    assert!(
        old_dir.is_dir(),
        "history GC must stand down while another app is connected"
    );

    // (b) Alone again → the full partition runs.
    drop(second_app);
    wait_until(Duration::from_secs(10), "one connected client", || {
        futures_lite_block(async { client.connected_clients().await.unwrap_or(9) <= 1 })
    })
    .await;

    let report = pty::run_terminal_gc(false).await.unwrap();

    // Report SHAPE is unchanged from the tmux era — same fields, same meaning.
    assert_eq!(report.stale_worktree_paths, vec![doomed_path.clone()]);
    assert_eq!(report.pruned_worktree_paths, vec![doomed_path.clone()]);
    assert_eq!(report.stale_session_names, vec![doomed_session.clone()]);
    assert_eq!(report.killed_session_names, vec![doomed_session.clone()]);
    assert!(
        report.skipped_attached_worktree_paths.is_empty(),
        "the doomed session is NOT in grove's registry, so it is not 'attached'"
    );
    assert!(
        report.reaped_pty_ids.is_empty(),
        "the live pane's session is still known to the daemon — it must NOT be reaped"
    );
    assert!(report.dead_reader_pty_ids.is_empty());

    // The stale session is really gone from the daemon.
    let sessions = client.list_sessions().await.unwrap();
    assert!(
        !sessions
            .iter()
            .any(|session| session.session_id == doomed_session),
        "the stale worktree's session must be killed"
    );
    // …and the live pane survived, still reporting a child pid (the hookless probe's
    // process-tree root — the `#{pane_pid}` replacement).
    let live = sessions
        .iter()
        .find(|session| session.session_id == session_id)
        .expect("the live pane's session must survive GC");
    assert!(live.is_alive);
    assert!(
        live.pid.is_some_and(|pid| pid > 0),
        "listSessions must expose the child pid"
    );

    // History GC: dead + orphaned + old is reaped; the young orphan is spared.
    assert!(
        !old_dir.exists(),
        "a dead, unreferenced, >5min-old history dir must be reaped"
    );
    assert!(
        young_dir.is_dir(),
        "a young history dir must be spared (GC-vs-create TOCTOU guard)"
    );
    assert!(
        daemon::history_root(&base_dir)
            .join(&session_id)
            .is_dir(),
        "the LIVE session's history dir must survive"
    );

    pty::close("pty-1").await.expect("close must succeed");
    client
        .shutdown(true)
        .await
        .expect("tear the detached daemon down");
}

/// Block on a future from inside a sync `probe` closure. The probes above need one
/// RPC each; `wait_until` takes a sync closure, so this bridges the two. Uses a
/// dedicated current-thread runtime on a scratch thread so it never re-enters the
/// test's multi-thread runtime.
fn futures_lite_block<F>(future: F) -> bool
where
    F: std::future::Future<Output = bool> + Send + 'static,
{
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(future)
            })
            .join()
            .unwrap()
    })
}
