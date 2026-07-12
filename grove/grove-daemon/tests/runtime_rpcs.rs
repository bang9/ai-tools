//! Daemon-native runtime RPC e2e (design G8/P15 getSize+cwd, G9 bell+AI status,
//! P6 background, §9b connected-clients).
//!
//! Each test spawns the REAL grove-daemon binary on a temp unix socket and drives
//! it through the async grove-core `DaemonClient`, so the full cross-process RPC
//! surface is exercised: a resize is reflected by `applied_size` (getSize); an
//! OSC 7 emitted by a real shell is reported by `cwd` (getCwd); a real terminal
//! BEL rings the bell flag (drained on poll) while an OSC terminator does not; the
//! Enter-detection transition and injected AI status ride `poll_bells`; a
//! background flag round-trips; and the connected-control gauge is non-zero while
//! a client is attached.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use grove_core::daemon::client::{CreateOrAttach, DaemonClient, DaemonClientOptions};
use grove_core::daemon::protocol::daemon_token_path;

// --- process harness -----------------------------------------------------

struct DaemonProc {
    child: std::process::Child,
}

impl Drop for DaemonProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn unique_paths() -> (PathBuf, PathBuf) {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id();
    let socket = PathBuf::from(format!("/tmp/grove-rt-{pid}-{n}.sock"));
    let base_dir = PathBuf::from(format!("/tmp/grove-rt-{pid}-{n}.d"));
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
        env: shell_rc_quiet_env(),
        ..Default::default()
    }
}

/// Env that stops the spawned shell's own rc files from emitting OSC 7 / OSC 0 at every
/// prompt, which would overwrite what a test's `printf` just wrote (the shell's cwd is
/// `/private/tmp`, not the probe path). Two emitters on a dev mac:
///   * `/etc/zshrc_Apple_Terminal`'s `update_terminal_cwd`, armed whenever
///     TERM_PROGRAM==Apple_Terminal is inherited from the terminal running `cargo test`
///     (grove itself always sets TERM_PROGRAM=Grove, so this is purely a test artifact);
///   * a user `~/.zshrc` with a cwd/title hook.
///
/// Blank TERM_PROGRAM disarms the first; an empty ZDOTDIR gives zsh no user rc to read.
fn shell_rc_quiet_env() -> Vec<(String, String)> {
    let empty_zdotdir =
        std::env::temp_dir().join(format!("grove-rpc-zdotdir-{}", std::process::id()));
    std::fs::create_dir_all(&empty_zdotdir).expect("create empty zdotdir");
    vec![
        ("TERM".to_string(), "dumb".to_string()),
        ("TERM_PROGRAM".to_string(), String::new()),
        (
            "ZDOTDIR".to_string(),
            empty_zdotdir.to_string_lossy().into_owned(),
        ),
    ]
}

/// Spawn a daemon, wait for readiness, and return (proc, client). The `_proc`
/// must be held for the test's lifetime (drop kills the daemon).
async fn boot() -> (DaemonProc, DaemonClient, PathBuf) {
    let (socket, base_dir) = unique_paths();
    let proc = spawn_daemon(&socket, "runtime-rpc-token", &base_dir);
    assert!(
        wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(10)).await,
        "daemon did not become ready"
    );
    let client = client_for(&socket, &base_dir);
    (proc, client, base_dir)
}

// --- tests ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn get_size_reflects_applied_dims_after_resize() {
    // Design G8/P15: a resize is reflected by the emulator's applied dims that
    // getSize returns — the daemon-native replacement for the tmux
    // `applied_pty_size` shell-out.
    let (_proc, client, _base) = boot().await;
    client.create_or_attach(attach("sz")).await.expect("attach");

    // Opening dims.
    assert_eq!(
        client.applied_size("sz").await.expect("getSize"),
        (80, 24),
        "opening dims"
    );

    client.resize("sz", 120, 40).await.expect("resize");

    // The resize is a notify; poll until getSize reflects the applied dims.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if client.applied_size("sz").await.expect("getSize") == (120, 40) {
            break;
        }
        assert!(Instant::now() < deadline, "getSize never reflected the resize");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn get_cwd_reflects_osc7_from_a_real_shell() {
    // Design S11/P15/G8: OSC 7 emitted by a real shell is tracked into the session
    // cwd and served by getCwd without composing a full snapshot. We drive a real
    // `printf` in the shell to emit the OSC 7 (a `cd` would emit it too, but printf
    // is shell-agnostic and deterministic).
    let (_proc, client, _base) = boot().await;
    client.create_or_attach(attach("cw")).await.expect("attach");

    // No OSC 7 yet.
    assert_eq!(client.cwd("cw").await.expect("getCwd"), None, "cwd unset initially");

    // Emit an OSC 7 (BEL-terminated) naming a distinctive path via printf's octal
    // escapes. `\r` submits the command to the shell.
    client
        .write(
            "cw",
            b"printf '\\033]7;file://host/tmp/daemon-cwd-probe\\007'\r",
        )
        .await
        .expect("write printf");

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if client.cwd("cw").await.expect("getCwd").as_deref() == Some("/tmp/daemon-cwd-probe") {
            break;
        }
        assert!(Instant::now() < deadline, "getCwd never reflected the OSC 7");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn poll_bells_reports_the_bell_and_a_plain_shell_never_badges() {
    // Design G9 + agent-status design §3.6 rung D. A real terminal BEL rings the bell
    // flag (drained on poll). The AI status half of this test is GONE on purpose: the
    // app is no longer a writer of status (`setAiStatus` is deleted — one writer, one
    // owner), and Enter-detection is deleted with it, because "the user pressed Enter,
    // therefore an agent is working" is a guess that fired for `ls`.
    //
    // What remains is the property that matters here: a PLAIN SHELL — typing, pressing
    // Enter, printing escape sequences, ringing the bell — produces NO badge, ever.
    // That is structural: a badge requires a claim, and a claim requires the agentClaim
    // RPC (see tests/agent_socket.rs). Bytes on a terminal cannot produce one.
    let (_proc, client, _base) = boot().await;
    client.create_or_attach(attach("bl")).await.expect("attach");

    // Ring a real bell from the shell, and print an OSC 2 title that looks exactly
    // like Claude's idle title (U+2733) — oh-my-zsh really does set OSC 2 to the
    // command line, which is why the title is not a status source.
    client
        .write("bl", b"printf '\\033]2;\\342\\234\\263 claude --version\\007\\007'\r")
        .await
        .expect("write bell");

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let events = client.poll_bells().await.expect("poll bells");
        if let Some(e) = events.iter().find(|e| e.pty_id == "bl") {
            assert_eq!(
                e.ai_status, None,
                "a plain shell must NEVER badge, whatever it prints or types"
            );
            if e.bell {
                break;
            }
        }
        assert!(Instant::now() < deadline, "the BEL never reached the daemon");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    // The bell drained on the poll that observed it (it is an event); the absent
    // status is not an event, and stays absent.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let events = client.poll_bells().await.expect("poll bells again");
    let entry = events.iter().find(|e| e.pty_id == "bl").expect("bl present");
    assert!(!entry.bell, "bell must have drained on the earlier poll");
    assert_eq!(entry.ai_status, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn background_flag_and_connected_clients_round_trip() {
    // Design P6 (set_session_background bookkeeping) + §9b (connected-control
    // gauge): the background notify is accepted, and the gauge is non-zero while a
    // client's control socket is attached.
    let (_proc, client, _base) = boot().await;
    client.create_or_attach(attach("bg")).await.expect("attach");

    // The background notify is accepted (no error). It is pure bookkeeping — there
    // is no read-back RPC, so success is the observable contract this cut.
    client
        .set_session_background("bg", true)
        .await
        .expect("set background");

    // The connected-control gauge counts THIS client's own control connection.
    let count = client.connected_clients().await.expect("getDaemonInfo");
    assert!(count >= 1, "an attached client must be counted (got {count})");
}
