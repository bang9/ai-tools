//! One-time sweep of leftover grove-managed tmux sessions (design OVERLAY 1
//! "First-launch sweep").
//!
//! The daemon cutover removes the tmux backend entirely. Any `grove-` tmux
//! sessions left running by a pre-daemon build would otherwise leak invisibly —
//! their shells stay alive with no grove UI attached and no code path that ever
//! reaps them. On the FIRST daemon launch we kill every grove-managed tmux
//! session (attached count 0 AND 1 alike — the old backend is gone, so an
//! attached client is a stale ghost too), then drop a marker so we never sweep
//! again.
//!
//! ## Self-contained on purpose
//!
//! This module carries its OWN minimal tmux shell-out (list / show-option /
//! kill) rather than calling into `pty.rs`. The P9 cutover DELETES `pty.rs`'s
//! tmux machinery, but this sweep must keep working in the shipped binary for
//! months (users upgrade from a tmux build at some arbitrary later launch). Pin
//! the three helpers here so that deletion can't break the sweep.
//!
//! Identity of a grove-managed session (matches the old `pty.rs` contract):
//! name starts with `grove-` AND tmux option `@grove_managed == "1"`.

use std::path::Path;
use std::process::{Command, Output};

use crate::process_env::enriched_path;

/// Marker filename written into the daemon base dir after a successful sweep.
/// Versioned so a future forced re-sweep can bump it.
const MARKER_FILENAME: &str = "tmux-swept-v1";
/// tmux session option marking a grove-owned session (old `pty.rs` contract).
const GROVE_MANAGED_OPTION: &str = "@grove_managed";
/// Name prefix every grove tmux session used.
const GROVE_SESSION_PREFIX: &str = "grove-";

/// Which tmux SERVER the sweep talks to.
///
/// The sweep KILLS sessions, so the server is an explicit parameter, never an
/// ambient default: production sweeps the user's default server
/// ([`TmuxServer::user_default`]), and tests MUST pass a private
/// [`TmuxServer::with_socket_name`] server (`tmux -L <socket>`). Otherwise
/// `cargo test` runs the production sweep against the developer's REAL tmux
/// server and kills whatever grove-managed sessions they still have open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxServer {
    /// `tmux -L <name>` — `None` is the user's default server.
    socket_name: Option<String>,
}

impl TmuxServer {
    /// The user's default tmux server — the only server production ever sweeps.
    pub fn user_default() -> Self {
        Self { socket_name: None }
    }

    /// A private tmux server addressed by socket name (`tmux -L <name>`). Isolation
    /// seam for tests: a sweep against it can never reach the user's terminals.
    pub fn with_socket_name(name: impl Into<String>) -> Self {
        Self {
            socket_name: Some(name.into()),
        }
    }

    /// `args` prefixed with this server's `-L <socket>` selector, if any.
    fn command_args<'a>(&'a self, args: &[&'a str]) -> Vec<&'a str> {
        match self.socket_name.as_deref() {
            Some(socket) => {
                let mut all = Vec::with_capacity(args.len() + 2);
                all.push("-L");
                all.push(socket);
                all.extend_from_slice(args);
                all
            }
            None => args.to_vec(),
        }
    }
}

/// Outcome of a sweep attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepReport {
    /// The marker already existed → the sweep was skipped this launch.
    pub already_swept: bool,
    /// Whether a tmux binary was found (absent → nothing to sweep, no-op success).
    pub tmux_available: bool,
    /// Names of the grove-managed sessions killed this run.
    pub killed: Vec<String>,
}

impl SweepReport {
    fn already_swept() -> Self {
        Self {
            already_swept: true,
            tmux_available: false,
            killed: Vec::new(),
        }
    }
}

/// Run the leftover-tmux sweep AT MOST ONCE, gated by a marker file in `base_dir`
/// (the daemon runtime dir, `~/.grove/daemon`). Idempotent: a second call after a
/// successful first one returns immediately with `already_swept = true`.
///
/// If tmux is not installed, this is a success no-op (there can be no grove tmux
/// sessions without tmux) and the marker is still written so we never re-probe.
pub fn sweep_grove_tmux_sessions_once(base_dir: &Path) -> Result<SweepReport, String> {
    sweep_grove_tmux_sessions_once_on(base_dir, &TmuxServer::user_default())
}

/// [`sweep_grove_tmux_sessions_once`] against an explicit tmux server. Tests drive the
/// production sweep through here with a private server so they can never kill a real
/// terminal (see [`TmuxServer`]).
pub fn sweep_grove_tmux_sessions_once_on(
    base_dir: &Path,
    server: &TmuxServer,
) -> Result<SweepReport, String> {
    let marker = base_dir.join(MARKER_FILENAME);
    if marker.exists() {
        return Ok(SweepReport::already_swept());
    }

    let report = sweep_grove_tmux_sessions_on(server);

    // Write the marker even when the sweep hit tmux errors: the point is to run
    // the best-effort cleanup exactly once on upgrade, not to retry forever.
    std::fs::create_dir_all(base_dir)
        .map_err(|e| format!("failed to create daemon base dir {}: {e}", base_dir.display()))?;
    std::fs::write(&marker, b"1")
        .map_err(|e| format!("failed to write tmux-sweep marker {}: {e}", marker.display()))?;

    Ok(report)
}

/// Kill every grove-managed tmux session on the user's default server, ignoring the
/// marker. Exposed for any future explicit "sweep now" action.
pub fn sweep_grove_tmux_sessions() -> SweepReport {
    sweep_grove_tmux_sessions_on(&TmuxServer::user_default())
}

/// [`sweep_grove_tmux_sessions`] against an explicit tmux server (see [`TmuxServer`]).
pub fn sweep_grove_tmux_sessions_on(server: &TmuxServer) -> SweepReport {
    let sessions = match list_grove_tmux_sessions(server) {
        Ok(sessions) => sessions,
        // tmux missing (or no server) → nothing to do.
        Err(TmuxError::NotFound) => {
            return SweepReport {
                already_swept: false,
                tmux_available: false,
                killed: Vec::new(),
            }
        }
        Err(TmuxError::Message(message)) => {
            eprintln!("Warning: failed to list tmux sessions during grove tmux sweep: {message}");
            return SweepReport {
                already_swept: false,
                tmux_available: true,
                killed: Vec::new(),
            };
        }
    };

    let mut killed = Vec::new();
    for session_name in sessions {
        match session_option(server, &session_name, GROVE_MANAGED_OPTION) {
            Ok(Some(value)) if value == "1" => {}
            // Not grove-managed, or the session vanished mid-sweep → skip.
            Ok(_) => continue,
            Err(TmuxError::NotFound) => break,
            Err(TmuxError::Message(message)) => {
                eprintln!(
                    "Warning: failed to inspect tmux session {session_name} during grove tmux sweep: {message}"
                );
                continue;
            }
        }

        match kill_session_if_exists(server, &session_name) {
            Ok(()) => killed.push(session_name),
            Err(TmuxError::NotFound) => break,
            Err(TmuxError::Message(message)) => {
                eprintln!(
                    "Warning: failed to kill stale tmux session {session_name} during grove tmux sweep: {message}"
                );
            }
        }
    }

    SweepReport {
        already_swept: false,
        tmux_available: true,
        killed,
    }
}

// ---------------------------------------------------------------------------
// Minimal, self-contained tmux shell-out (pinned so the P9 tmux deletion in
// pty.rs cannot break this sweep).
// ---------------------------------------------------------------------------

enum TmuxError {
    /// The tmux binary is not installed (or no server is running).
    NotFound,
    Message(String),
}

fn tmux(server: &TmuxServer, args: &[&str]) -> Result<Output, TmuxError> {
    Command::new("tmux")
        .args(server.command_args(args))
        .env("PATH", enriched_path())
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                TmuxError::NotFound
            } else {
                TmuxError::Message(format!("failed to execute tmux: {error}"))
            }
        })
}

fn output_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        stderr
    }
}

fn is_no_server(message: &str) -> bool {
    message.contains("no server running") || message.contains("error connecting to")
}

fn list_grove_tmux_sessions(server: &TmuxServer) -> Result<Vec<String>, TmuxError> {
    let output = tmux(server, &["list-sessions", "-F", "#{session_name}"])?;
    if !output.status.success() {
        let message = output_message(&output);
        if is_no_server(&message) {
            return Ok(Vec::new());
        }
        return Err(TmuxError::Message(format!(
            "failed to list tmux sessions: {message}"
        )));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.starts_with(GROVE_SESSION_PREFIX))
        .map(str::to_string)
        .collect())
}

fn session_option(
    server: &TmuxServer,
    session_name: &str,
    option: &str,
) -> Result<Option<String>, TmuxError> {
    let output = tmux(server, &["show-options", "-qv", "-t", session_name, option])?;
    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(if value.is_empty() { None } else { Some(value) });
    }

    let message = output_message(&output);
    if is_session_missing(&message) || message.is_empty() {
        return Ok(None);
    }
    Err(TmuxError::Message(format!(
        "failed to query tmux option {option} on {session_name}: {message}"
    )))
}

fn kill_session_if_exists(server: &TmuxServer, session_name: &str) -> Result<(), TmuxError> {
    let output = tmux(server, &["kill-session", "-t", session_name])?;
    if output.status.success() {
        return Ok(());
    }

    let message = output_message(&output);
    if is_session_missing(&message) {
        return Ok(());
    }
    Err(TmuxError::Message(format!(
        "failed to kill tmux session {session_name}: {message}"
    )))
}

fn is_session_missing(message: &str) -> bool {
    message.contains("can't find session") || is_no_server(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::env_lock;
    use std::path::PathBuf;
    use uuid::Uuid;

    /// NOTHING in this module may sweep [`TmuxServer::user_default`]: these tests run on
    /// a developer's machine (`pnpm test:core`), the sweep KILLS sessions, and a
    /// grove-managed session on the real server is a terminal the user still has open.
    /// Every test drives the production sweep against a [`PrivateTmuxServer`] instead.
    fn temp_base_dir() -> PathBuf {
        std::env::temp_dir().join(format!("grove-tmux-sweep-tests-{}", Uuid::new_v4()))
    }

    fn tmux_installed() -> bool {
        Command::new("tmux")
            .arg("-V")
            .env("PATH", enriched_path())
            .output()
            .is_ok()
    }

    /// A tmux server of our own (`tmux -L <unique socket>`), torn down on drop.
    struct PrivateTmuxServer {
        server: TmuxServer,
    }

    impl PrivateTmuxServer {
        fn new() -> Self {
            Self {
                server: TmuxServer::with_socket_name(format!(
                    "grove-sweep-test-{}",
                    &Uuid::new_v4().simple().to_string()[..12]
                )),
            }
        }

        fn run(&self, args: &[&str]) -> Output {
            tmux(&self.server, args).unwrap_or_else(|_| panic!("tmux {args:?}"))
        }

        /// A detached session running a long sleep — it stays alive until we kill it.
        fn start_session(&self, name: &str) {
            let out = self.run(&["new-session", "-d", "-s", name, "sleep", "300"]);
            assert!(
                out.status.success(),
                "failed to start test session {name}: {}",
                output_message(&out)
            );
        }

        fn mark_grove_managed(&self, name: &str) {
            let out = self.run(&["set-option", "-t", name, GROVE_MANAGED_OPTION, "1"]);
            assert!(out.status.success(), "failed to mark {name} grove-managed");
        }

        fn session_names(&self) -> Vec<String> {
            let out = self.run(&["list-sessions", "-F", "#{session_name}"]);
            if !out.status.success() {
                return Vec::new();
            }
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        }
    }

    impl Drop for PrivateTmuxServer {
        fn drop(&mut self) {
            // `kill-server` leaves the socket inode behind, so read its path off the
            // live server first — otherwise every test run drops a stale socket file in
            // the developer's tmux tmpdir.
            let socket = tmux(&self.server, &["display-message", "-p", "#{socket_path}"])
                .ok()
                .filter(|out| out.status.success())
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
                .filter(|path| !path.is_empty());
            let _ = tmux(&self.server, &["kill-server"]);
            if let Some(socket) = socket {
                let _ = std::fs::remove_file(socket);
            }
        }
    }

    #[test]
    fn marker_gates_the_sweep_to_run_once() {
        let base = temp_base_dir();
        let tmux = PrivateTmuxServer::new();

        // First call runs the sweep (no grove sessions on our private server) and
        // writes the marker.
        let first = sweep_grove_tmux_sessions_once_on(&base, &tmux.server).unwrap();
        assert!(!first.already_swept);
        assert!(base.join(MARKER_FILENAME).exists());

        // Second call short-circuits on the marker without touching tmux.
        let second = sweep_grove_tmux_sessions_once_on(&base, &tmux.server).unwrap();
        assert!(second.already_swept);
        assert!(second.killed.is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn sweep_creates_missing_base_dir() {
        let base = temp_base_dir().join("nested").join("daemon");
        let tmux = PrivateTmuxServer::new();
        assert!(!base.exists());
        let report = sweep_grove_tmux_sessions_once_on(&base, &tmux.server).unwrap();
        assert!(!report.already_swept);
        assert!(base.join(MARKER_FILENAME).exists());
        let _ = std::fs::remove_dir_all(base.parent().unwrap().parent().unwrap());
    }

    /// The sweep's kill rule, exercised end to end against a REAL tmux server that is
    /// ours: only `grove-` sessions carrying `@grove_managed = 1` die.
    #[test]
    fn sweep_kills_only_grove_managed_sessions() {
        if !tmux_installed() {
            return;
        }
        let tmux = PrivateTmuxServer::new();
        let suffix = &Uuid::new_v4().simple().to_string()[..8];
        let managed = format!("grove-{suffix}-managed");
        let unmanaged = format!("grove-{suffix}-unmanaged");
        let foreign = format!("work-{suffix}");

        tmux.start_session(&managed);
        tmux.mark_grove_managed(&managed);
        tmux.start_session(&unmanaged);
        tmux.start_session(&foreign);

        let report = sweep_grove_tmux_sessions_on(&tmux.server);

        assert!(report.tmux_available);
        assert_eq!(report.killed, vec![managed.clone()]);
        let survivors = tmux.session_names();
        assert!(!survivors.contains(&managed), "the managed session must die");
        assert!(
            survivors.contains(&unmanaged),
            "a grove-named session WITHOUT @grove_managed=1 must survive"
        );
        assert!(survivors.contains(&foreign), "a foreign session must survive");
    }

    /// GUARD (the point of [`TmuxServer`]): a sweep test must never reach the AMBIENT
    /// tmux server — `cargo test` would then kill the developer's own leftover grove
    /// terminals. `TMUX_TMPDIR` redirects tmux's DEFAULT server into a temp dir, so a
    /// grove-managed canary can be planted on the "user's" default server safely; the
    /// sweep the tests run (a private `-L` server) must leave it alive. A sweep that
    /// talks to the default server kills it.
    #[test]
    fn sweep_tests_never_reach_the_default_tmux_server() {
        if !tmux_installed() {
            return;
        }
        let _lock = env_lock();
        let tmpdir = PathBuf::from(format!("/tmp/gsw-{}", &Uuid::new_v4().simple().to_string()[..8]));
        std::fs::create_dir_all(&tmpdir).unwrap();
        let previous = std::env::var_os("TMUX_TMPDIR");
        // SAFETY: env mutation is serialized by `env_lock` (single-threaded section).
        unsafe { std::env::set_var("TMUX_TMPDIR", &tmpdir) };

        // The "user's" leftover grove terminal, on the DEFAULT server.
        let default_server = TmuxServer::user_default();
        let canary = format!("grove-{}-canary", &Uuid::new_v4().simple().to_string()[..8]);
        let started = tmux(
            &default_server,
            &["new-session", "-d", "-s", &canary, "sleep", "300"],
        );
        let planted = matches!(&started, Ok(out) if out.status.success());
        if planted {
            let marked = tmux(
                &default_server,
                &["set-option", "-t", &canary, GROVE_MANAGED_OPTION, "1"],
            );
            assert!(matches!(&marked, Ok(out) if out.status.success()));
        }

        // What every sweep test does: sweep OUR server, never the user's.
        let base = temp_base_dir();
        let private = PrivateTmuxServer::new();
        let report = sweep_grove_tmux_sessions_once_on(&base, &private.server).unwrap();
        assert!(report.killed.is_empty());

        let canary_alive = matches!(
            session_option(&default_server, &canary, GROVE_MANAGED_OPTION),
            Ok(Some(value)) if value == "1"
        );

        // Restore the ambient env + tear the canary's server down BEFORE asserting, so a
        // failure never leaks a server or a stray env var into the rest of the run.
        let _ = tmux(&default_server, &["kill-server"]);
        drop(private);
        // SAFETY: still inside the `env_lock` section.
        unsafe {
            match previous {
                Some(value) => std::env::set_var("TMUX_TMPDIR", value),
                None => std::env::remove_var("TMUX_TMPDIR"),
            }
        }
        let _ = std::fs::remove_dir_all(&tmpdir);
        let _ = std::fs::remove_dir_all(&base);

        assert!(planted, "the canary session must start for this guard to mean anything");
        assert!(
            canary_alive,
            "a sweep test killed a grove-managed session on the DEFAULT tmux server — on a \
             developer's machine that is one of their open terminals"
        );
    }

    #[test]
    fn private_server_args_select_the_injected_socket() {
        assert_eq!(
            TmuxServer::with_socket_name("sock").command_args(&["kill-session", "-t", "x"]),
            vec!["-L", "sock", "kill-session", "-t", "x"]
        );
        assert_eq!(
            TmuxServer::user_default().command_args(&["kill-session", "-t", "x"]),
            vec!["kill-session", "-t", "x"]
        );
    }
}
