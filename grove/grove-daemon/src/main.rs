//! grove-daemon entry point (design P2 + L8).
//!
//! Parses `--socket`/`--token`/`--base-dir`, binds the versioned unix socket,
//! writes the 0600 token + pid files, installs a SIGTERM/SIGINT handler that
//! triggers a bounded (5s) shutdown, and serves until then. The daemon logs to
//! stderr; wiring stderr to `daemon-v{N}.log` is the supervisor's job (P4).

use std::path::PathBuf;
use std::process;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use grove_core::daemon::protocol::{
    daemon_pid_path, daemon_token_path, history_root, serialize_pid_file, write_secret_file,
    DaemonPidFile, GROVE_DAEMON_PROTOCOL_VERSION,
};
use grove_daemon::server::Daemon;
use tokio::net::UnixListener;
use tokio::signal::unix::{signal, SignalKind};

/// Bounded shutdown budget (design L8): a wedged teardown can't hang the process.
const SHUTDOWN_BUDGET: Duration = Duration::from_secs(5);

struct Config {
    socket: PathBuf,
    token: String,
    base_dir: PathBuf,
}

impl Config {
    fn from_args() -> Result<Self, String> {
        let mut socket = None;
        let mut token = None;
        let mut base_dir = None;
        let mut args = std::env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--socket" => socket = args.next(),
                "--token" => token = args.next(),
                "--base-dir" => base_dir = args.next(),
                other => return Err(format!("unexpected argument: {other}")),
            }
        }
        Ok(Config {
            socket: PathBuf::from(socket.ok_or("missing --socket")?),
            token: token.ok_or("missing --token")?,
            base_dir: PathBuf::from(base_dir.ok_or("missing --base-dir")?),
        })
    }
}

#[tokio::main]
async fn main() {
    let config = match Config::from_args() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("grove-daemon: {error}");
            process::exit(2);
        }
    };

    // Fix #5: refuse to start with an empty token — an empty token would let any
    // client authenticate. The Hello path rejects empties too (defense in depth).
    if config.token.is_empty() {
        eprintln!("grove-daemon: --token must not be empty");
        process::exit(2);
    }

    // Why: a leftover socket file from a crashed predecessor would make bind fail
    // with EADDRINUSE even though nothing is listening; unlink it first.
    let _ = std::fs::remove_file(&config.socket);
    let listener = match UnixListener::bind(&config.socket) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "grove-daemon: bind {}: {error}",
                config.socket.display()
            );
            process::exit(1);
        }
    };
    set_socket_perms_0600(&config.socket);

    // Token + pid files (0600) so clients can authenticate and the supervisor can
    // identify/kill the daemon (design §1.3, L6).
    if let Err(error) = write_secret_file(&daemon_token_path(&config.base_dir), config.token.as_bytes())
    {
        eprintln!("grove-daemon: write token file: {error}");
    }
    let pid_file = DaemonPidFile {
        pid: process::id(),
        started_at_ms: now_ms(),
        bin_path: std::env::current_exe()
            .ok()
            .map(|path| path.display().to_string()),
        app_version: None,
    };
    if let Err(error) = write_secret_file(
        &daemon_pid_path(&config.base_dir),
        serialize_pid_file(&pid_file).as_bytes(),
    ) {
        eprintln!("grove-daemon: write pid file: {error}");
    }

    eprintln!(
        "grove-daemon: listening on {} (protocol v{})",
        config.socket.display(),
        GROVE_DAEMON_PROTOCOL_VERSION
    );

    // The version-namespaced history root under the daemon's base dir (design
    // D1/§5). Cold restore and the checkpointer both use this single tree; it is
    // stable across daemon restarts (same --base-dir), so a fresh daemon finds a
    // predecessor's unclean checkpoints.
    let hist_root = history_root(&config.base_dir);
    let daemon = Daemon::new(config.token.clone(), hist_root);
    let serve = {
        let daemon = Arc::clone(&daemon);
        tokio::spawn(async move { daemon.serve(listener).await })
    };

    // SIGTERM/SIGINT handler (design L8, fix F3).
    {
        let daemon = Arc::clone(&daemon);
        tokio::spawn(async move {
            let mut sigterm = signal(SignalKind::terminate()).expect("install SIGTERM handler");
            let mut sigint = signal(SignalKind::interrupt()).expect("install SIGINT handler");
            tokio::select! {
                _ = sigterm.recv() => {}
                _ = sigint.recv() => {}
            }
            eprintln!("grove-daemon: shutdown signal received");
            // Fix F3: a signal (launchd SIGTERMs the daemon on a clean macOS reboot)
            // must flush a final checkpoint for every session but leave history
            // UNCLEAN — stamping `ended_at` here would make a rebooted session
            // cold-restore INELIGIBLE, regressing Tier-B vs tmux. `ended_at` is
            // stamped ONLY on child self-exit, an explicit close/kill RPC, and the
            // explicit shutdown ("Restart daemon") RPC. We also do NOT kill children
            // here: a kill would drive each reader to EOF → `close_history` →
            // stamp `ended_at` (the child-self-exit path), re-suppressing cold
            // restore. On process exit the PTY masters close and the shells get
            // SIGHUP; on a real reboot the OS reaps everything.
            //
            // The graceful flush is bounded by the shutdown budget (design L8) so a
            // wedged final write can't hang the process indefinitely.
            if tokio::time::timeout(SHUTDOWN_BUDGET, daemon.flush_history_unclean())
                .await
                .is_err()
            {
                eprintln!(
                    "grove-daemon: final flush exceeded {SHUTDOWN_BUDGET:?}; forcing exit"
                );
            }
            daemon.trigger_shutdown();
        });
    }

    // Serve until a shutdown is triggered (the signal path above or the shutdown
    // RPC), then fall through to socket/token/pid cleanup.
    //
    // Fix F1: await the serve loop UNCONDITIONALLY. The old
    // `timeout(SHUTDOWN_BUDGET, serve)` wrapped the ENTIRE serve future, so every
    // daemon died ~5s after launch (unlinking its socket) regardless of activity —
    // a catastrophic self-termination. The 5s budget now bounds ONLY the
    // post-signal teardown flush (above), never steady-state serving.
    let _ = serve.await;

    let _ = std::fs::remove_file(&config.socket);
    let _ = std::fs::remove_file(daemon_token_path(&config.base_dir));
    let _ = std::fs::remove_file(daemon_pid_path(&config.base_dir));
}

fn now_ms() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn set_socket_perms_0600(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}
