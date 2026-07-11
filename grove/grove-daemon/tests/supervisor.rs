//! Supervisor integration tests (design P4). These live in grove-daemon's test
//! crate so `env!("CARGO_BIN_EXE_grove-daemon")` resolves to the REAL daemon
//! binary — the supervisor copies/spawns it, then adopts/kills it through
//! `grove_core::daemon::supervisor`.
//!
//! Coverage: spawn→adopt (same pid), unresponsive-socket adopt (SIGSTOP),
//! fail-open kill-stale on an unidentified pid, crash-loop fast-fail, and
//! empty-token regeneration.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use grove_core::daemon::client::{CreateOrAttach, DaemonClient, DaemonClientOptions};
use grove_core::daemon::protocol::{
    daemon_pid_path, daemon_socket_path, daemon_token_path, parse_pid_file, serialize_pid_file,
    DaemonPidFile,
};
use grove_core::daemon::supervisor::{
    ensure_running, kill_stale, EnsureOutcome, EnsureResult, EnsureRunningConfig, SupervisorError,
};

// --- harness --------------------------------------------------------------

/// Unique short base dir (unix sockets cap ~104 bytes → keep the path short).
fn unique_base() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id();
    PathBuf::from(format!("/tmp/grove-sup-{pid}-{n}.d"))
}

fn cfg_for(base: &Path) -> EnsureRunningConfig {
    EnsureRunningConfig {
        base_dir: base.to_path_buf(),
        bin_source_path: PathBuf::from(env!("CARGO_BIN_EXE_grove-daemon")),
        app_version: "1.0.0-test".to_string(),
    }
}

fn socket_path(base: &Path) -> PathBuf {
    daemon_socket_path(base).as_path().unwrap().to_path_buf()
}

fn read_pid(base: &Path) -> u32 {
    let contents = std::fs::read_to_string(daemon_pid_path(base)).expect("read pid file");
    parse_pid_file(&contents).expect("parse pid file").pid
}

/// SIGCONT-then-SIGKILL a spawned detached daemon on drop so a failing assert
/// never leaks it (the supervisor detaches, so there is no Child handle to reap).
struct DaemonKiller(u32);
impl Drop for DaemonKiller {
    fn drop(&mut self) {
        let _ = Command::new("kill").arg("-CONT").arg(self.0.to_string()).status();
        let _ = Command::new("kill").arg("-KILL").arg(self.0.to_string()).status();
    }
}

fn cleanup(base: &Path) {
    let _ = std::fs::remove_dir_all(base);
}

fn signal(name: &str, pid: u32) {
    Command::new("kill")
        .arg(name)
        .arg(pid.to_string())
        .status()
        .expect("send signal");
}

/// An async `DaemonClient` bound to the endpoint an `ensure_running` resolved to —
/// used by the L5 preservation tests to create a REAL live session on the daemon
/// (the plain socket probes the supervisor uses cannot spawn one).
fn client_for(res: &EnsureResult) -> DaemonClient {
    DaemonClient::new(DaemonClientOptions::new(
        res.socket_path.clone(),
        res.token_path.clone(),
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

/// Is `id` present AND alive in the daemon's session list right now?
async fn session_alive(client: &DaemonClient, id: &str) -> bool {
    match client.list_sessions().await {
        Ok(sessions) => sessions.iter().any(|s| s.session_id == id && s.is_alive),
        Err(_) => false,
    }
}

/// Poll until `id` is alive (a freshly created session registers in the map
/// essentially immediately, but a poll keeps the tests robust under load).
async fn wait_session_alive(client: &DaemonClient, id: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if session_alive(client, id).await {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Poll until `id` is no longer alive (the child's reaper removes it after kill).
async fn wait_session_gone(client: &DaemonClient, id: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !session_alive(client, id).await {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// --- tests ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_then_adopt_same_pid() {
    let base = unique_base();
    let cfg = cfg_for(&base);

    let first = ensure_running(&cfg).await.expect("initial spawn");
    assert_eq!(first.outcome, EnsureOutcome::Spawned, "first launch spawns");
    let pid = read_pid(&base);
    let _killer = DaemonKiller(pid);

    // A second ensure on the same endpoint must ADOPT the live daemon — same pid,
    // no respawn (design L3 warm adoption).
    let second = ensure_running(&cfg).await.expect("adopt");
    assert_eq!(second.outcome, EnsureOutcome::Adopted, "second launch adopts");
    assert_eq!(read_pid(&base), pid, "adoption must reuse the same daemon pid");

    cleanup(&base);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unresponsive_socket_is_adopted() {
    let base = unique_base();
    let cfg = cfg_for(&base);

    let first = ensure_running(&cfg).await.expect("initial spawn");
    assert_eq!(first.outcome, EnsureOutcome::Spawned);
    let pid = read_pid(&base);
    let _killer = DaemonKiller(pid);

    // Freeze the daemon: its socket still accepts connections (kernel backlog)
    // but it can never answer the hello. The supervisor must ADOPT it and let the
    // client reconnect-drain, NOT kill+replace it (design L3e).
    signal("-STOP", pid);
    tokio::time::sleep(Duration::from_millis(150)).await;

    let outcome = ensure_running(&cfg).await.expect("ensure while stopped");
    assert_eq!(
        outcome.outcome,
        EnsureOutcome::AdoptedUnresponsive,
        "a wedged daemon with a live socket is preserved, not replaced"
    );
    assert_eq!(read_pid(&base), pid, "the same daemon pid is preserved");

    signal("-CONT", pid);
    cleanup(&base);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kill_stale_refuses_unidentified_pid() {
    let base = unique_base();
    std::fs::create_dir_all(&base).unwrap();

    // A long-lived unrelated process stands in for a recycled pid: the pid file
    // points at it, but its cmdline does not carry our endpoint socket path.
    let mut decoy = Command::new("sleep").arg("30").spawn().expect("spawn decoy");
    let decoy_pid = decoy.id();

    let socket = socket_path(&base);
    let pid_file = DaemonPidFile {
        pid: decoy_pid,
        // A deliberately wrong start time — but the cmdline mismatch alone must
        // already refuse the kill (fail-open, invariant #1/#2).
        started_at_ms: Some(1),
        bin_path: Some("/nonexistent/daemon-bin-v1".to_string()),
        app_version: Some("9.9.9".to_string()),
    };
    std::fs::write(daemon_pid_path(&base), serialize_pid_file(&pid_file)).unwrap();

    let killed = {
        let base = base.clone();
        let socket = socket.clone();
        let token = daemon_token_path(&base);
        tokio::task::spawn_blocking(move || kill_stale(&base, &socket, &token))
            .await
            .unwrap()
    };
    assert!(!killed, "kill_stale must refuse an unidentified pid");
    assert!(
        decoy.try_wait().unwrap().is_none(),
        "the decoy process must survive a fail-open kill_stale"
    );

    let _ = decoy.kill();
    let _ = decoy.wait();
    cleanup(&base);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn crash_loop_binary_fails_fast() {
    let base = unique_base();
    std::fs::create_dir_all(&base).unwrap();

    // A binary that exits 1 immediately (a crash-looping daemon).
    let script = base.join("crash.sh");
    std::fs::write(&script, b"#!/bin/sh\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let cfg = EnsureRunningConfig {
        base_dir: base.clone(),
        bin_source_path: script,
        app_version: "1.0.0-test".to_string(),
    };

    let started = Instant::now();
    let err = ensure_running(&cfg).await.expect_err("crash loop must fail");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(2),
        "child-exit fast-fail must not block the 10s readiness deadline; took {elapsed:?}"
    );
    assert!(
        matches!(err, SupervisorError::SpawnFailed { .. }),
        "expected SpawnFailed with a surfaced reason, got {err:?}"
    );

    cleanup(&base);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_regenerates_token() {
    let base = unique_base();
    std::fs::create_dir_all(&base).unwrap();

    // A leftover EMPTY token file must not be reused: spawn regenerates a fresh
    // 32-byte (64 hex char) token that the daemon then authenticates against.
    std::fs::write(daemon_token_path(&base), b"").unwrap();

    let cfg = cfg_for(&base);
    let result = ensure_running(&cfg).await.expect("spawn over empty token");
    assert_eq!(result.outcome, EnsureOutcome::Spawned);
    let _killer = DaemonKiller(read_pid(&base));

    let token = std::fs::read_to_string(daemon_token_path(&base)).unwrap();
    let token = token.trim();
    assert_eq!(token.len(), 64, "token must be 32 random bytes hex-encoded");
    assert!(
        token.chars().all(|c| c.is_ascii_hexdigit()),
        "token must be hex; got {token:?}"
    );

    cleanup(&base);
}

// --- L5 preservation-branch tests (stale code vs live sessions) -----------
//
// The launch-identity staleness check (L4) alone would replace a daemon whose
// bundle `app_version` differs from the current one. The preservation guard (L5)
// must veto that replacement whenever the stale daemon still owns live sessions —
// killing it would destroy the user's terminals. These three tests exercise the
// full matrix against the REAL daemon: stale+live→adopt, stale+wedged+live→adopt-
// unresponsive, stale+empty→replace.

/// (a) A stale daemon (newer app_version) that owns a LIVE session must be
/// ADOPTED, not replaced — same pid, session survives (design L4/L5).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stale_daemon_with_live_session_is_adopted() {
    let base = unique_base();
    let cfg = cfg_for(&base);

    let first = ensure_running(&cfg).await.expect("initial spawn");
    assert_eq!(first.outcome, EnsureOutcome::Spawned);
    let pid = read_pid(&base);
    let _killer = DaemonKiller(pid);

    // Create a real, live session on the daemon.
    let client = client_for(&first);
    client
        .create_or_attach(attach("live-a"))
        .await
        .expect("createOrAttach live-a");
    assert!(
        wait_session_alive(&client, "live-a", Duration::from_secs(5)).await,
        "the created session should be alive"
    );

    // A NEWER app version makes the running daemon's code stale (L4). Because it
    // owns a live session, the preservation guard (L5) must ADOPT it — never kill
    // the terminals to swap code.
    let mut stale_cfg = cfg_for(&base);
    stale_cfg.app_version = "2.0.0-test".to_string();
    let second = ensure_running(&stale_cfg)
        .await
        .expect("adopt stale-but-live daemon");
    assert_eq!(
        second.outcome,
        EnsureOutcome::Adopted,
        "a stale daemon owning a live session must be preserved (L5)"
    );
    assert_eq!(read_pid(&base), pid, "preservation must reuse the same daemon pid");
    assert!(
        session_alive(&client, "live-a").await,
        "the live session must survive the adoption"
    );

    cleanup(&base);
}

/// (b) A stale, WEDGED daemon (SIGSTOP) that owns a live session must be adopted
/// as unresponsive — its socket still accepts raw connects, so the client
/// reconnect-drains it rather than replacing and losing the session (design L3e).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stopped_daemon_with_live_session_is_adopted_unresponsive() {
    let base = unique_base();
    let cfg = cfg_for(&base);

    let first = ensure_running(&cfg).await.expect("initial spawn");
    assert_eq!(first.outcome, EnsureOutcome::Spawned);
    let pid = read_pid(&base);
    let _killer = DaemonKiller(pid);

    let client = client_for(&first);
    client
        .create_or_attach(attach("live-b"))
        .await
        .expect("createOrAttach live-b");
    assert!(
        wait_session_alive(&client, "live-b", Duration::from_secs(5)).await,
        "the created session should be alive"
    );

    // Freeze the daemon: its socket still accepts connections (kernel backlog) but
    // it can never answer hello, and the session-list probe times out → the
    // session count is unverifiable. A raw connect still succeeds, so the daemon
    // must be preserved as AdoptedUnresponsive, NOT killed (L3e).
    signal("-STOP", pid);
    tokio::time::sleep(Duration::from_millis(150)).await;

    let second = ensure_running(&cfg).await.expect("ensure while stopped");
    assert_eq!(
        second.outcome,
        EnsureOutcome::AdoptedUnresponsive,
        "a wedged daemon with a live socket must be preserved, not replaced"
    );
    assert_eq!(read_pid(&base), pid, "the same daemon pid is preserved");

    // Thaw it: the session must have survived the freeze/thaw untouched.
    signal("-CONT", pid);
    assert!(
        wait_session_alive(&client, "live-b", Duration::from_secs(5)).await,
        "the live session must survive SIGSTOP/SIGCONT"
    );

    cleanup(&base);
}

/// (c) A stale daemon with ZERO live sessions (the session was killed) is no
/// longer protected by L5, so the staleness check REPLACES it with a fresh spawn
/// on a new pid (design L4).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stale_daemon_with_no_live_sessions_is_replaced() {
    let base = unique_base();
    let cfg = cfg_for(&base);

    let first = ensure_running(&cfg).await.expect("initial spawn");
    assert_eq!(first.outcome, EnsureOutcome::Spawned);
    let pid1 = read_pid(&base);
    let killer1 = DaemonKiller(pid1);

    let client = client_for(&first);
    client
        .create_or_attach(attach("live-c"))
        .await
        .expect("createOrAttach live-c");
    assert!(
        wait_session_alive(&client, "live-c", Duration::from_secs(5)).await,
        "the created session should be alive"
    );

    // Kill the session so the daemon owns zero live sessions.
    client.kill("live-c").await.expect("kill live-c");
    assert!(
        wait_session_gone(&client, "live-c", Duration::from_secs(5)).await,
        "the killed session should drain from the daemon"
    );

    // Stale code AND no live session to protect → the daemon is retired and
    // REPLACED with a fresh spawn on a new pid.
    let mut stale_cfg = cfg_for(&base);
    stale_cfg.app_version = "2.0.0-test".to_string();
    let second = ensure_running(&stale_cfg)
        .await
        .expect("replace stale, session-free daemon");
    assert_eq!(
        second.outcome,
        EnsureOutcome::Replaced,
        "a stale daemon with no live sessions must be replaced (L4)"
    );
    let pid2 = read_pid(&base);
    assert_ne!(pid2, pid1, "replacement must spawn a new daemon pid");
    let _killer2 = DaemonKiller(pid2);
    // pid1 was gracefully retired + killed by the replace path; its killer drop is
    // now a harmless no-op.
    drop(killer1);

    cleanup(&base);
}
