//! The daemon supervisor (design P4 + L1/L1-sig/L2–L6).
//!
//! `ensure_running` is grove's port of orca's connect-or-spawn adoption gate
//! (daemon-init.ts `createOutOfProcessLauncher` + daemon-health.ts). On every
//! host launch it:
//!
//!   1. probes the versioned socket (connect + hello + a `checkPtySpawnHealth`
//!      RPC, 1s connect deadline) and classifies the daemon's health;
//!   2. on a healthy daemon, decides ADOPT vs REPLACE by launch-identity
//!      staleness (L4) gated by the live-session-preservation guard (L5);
//!   3. on an unhealthy / unreachable / rejected daemon, preserves it when it
//!      still owns live sessions (L5) or its socket still accepts raw connects
//!      (L3 unresponsive-adopt), else kills the stale process by verified pid
//!      identity (L6) and spawns a fresh, signed, detached daemon (L1/L1-sig).
//!
//! Cross-cutting invariant #1 (fail-open on ambiguity): a daemon is never killed
//! unless it is positively identified as stale AND session-free; any
//! unverifiable signal (`None` session count, unreadable start time, socket that
//! still connects) preserves it.
//!
//! Unix-only: the endpoint is a unix socket and the pid guards use `libc` +
//! `/proc`/`ps`. The Windows named-pipe host lands later.

use std::io;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedReadHalf;
use tokio::net::UnixStream;

use super::protocol::{
    daemon_bin_path, daemon_log_path, daemon_pid_path, daemon_socket_path, daemon_token_path,
    decode_ndjson_line, encode_ndjson_line, parse_pid_file, serialize_pid_file, write_secret_file,
    ClientKind, ControlMessage, DaemonPidFile, Hello, HelloAck, RpcReply, RpcRequest,
    GROVE_DAEMON_PROTOCOL_VERSION,
};

// ---------------------------------------------------------------------------
// Tunables (orca daemon-health.ts constants, design L1/L6)
// ---------------------------------------------------------------------------

/// connect + hello handshake deadline for a health/session probe (design L3:
/// "connect the versioned socket, 1s deadline").
const CONNECT_HELLO_DEADLINE: Duration = Duration::from_secs(1);
/// Raw `connect()` probe deadline for the fast readiness paths (orca
/// `canConnectSocket`, 500ms).
const RAW_CONNECT_DEADLINE: Duration = Duration::from_millis(500);
/// Last-ditch raw-connect probe deadline at the adopt-unresponsive gate (orca
/// daemon-init `probeSocket`, 1s). Wider than [`RAW_CONNECT_DEADLINE`] because a
/// wedged-but-live daemon under update / disk pressure can accept the connection
/// slowly; being too eager here is what fails a live daemon closed and destroys
/// its sessions, so the last-ditch check gets the roomier budget while the fast
/// readiness/health paths keep the 500ms one (design L3e / orca parity).
const ADOPT_UNRESPONSIVE_CONNECT_DEADLINE: Duration = Duration::from_secs(1);
/// Deadline within a probe RPC (`checkPtySpawnHealth`/`listSessions`).
const PROBE_RPC_TIMEOUT: Duration = Duration::from_secs(3);
/// Readiness deadline for a freshly spawned daemon (design L1: 10s).
const READINESS_DEADLINE: Duration = Duration::from_secs(10);
/// Poll cadence while awaiting readiness.
const READINESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// SIGTERM→exit grace before escalating to SIGKILL (orca KILL_WAIT_MS, 3s).
const KILL_WAIT: Duration = Duration::from_secs(3);
/// Poll cadence while awaiting a SIGTERM'd process to exit (orca KILL_POLL_MS).
const KILL_POLL: Duration = Duration::from_millis(100);
/// Start-time recycle-guard tolerance (orca START_TIME_TOLERANCE_MS, posix).
const START_TIME_TOLERANCE_MS: u64 = 1_500;
/// How many trailing bytes of the daemon log to surface on a spawn failure.
const LOG_TAIL_BYTES: usize = 4_096;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/// Inputs to [`ensure_running`]. `bin_source_path` is the app bundle's ALREADY
/// SIGNED daemon binary; the supervisor copies it into `base_dir` before spawn
/// so the running image carries the bundle signature and no quarantine xattr
/// (design L1-sig). `app_version` backs the launch-identity staleness check (L4).
#[derive(Debug, Clone)]
pub struct EnsureRunningConfig {
    pub base_dir: PathBuf,
    pub bin_source_path: PathBuf,
    pub app_version: String,
}

/// What [`ensure_running`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureOutcome {
    /// A healthy, current daemon was adopted (warm — sessions survive).
    Adopted,
    /// A daemon that failed the PTY-spawn probe but still owns live sessions was
    /// preserved (design L3c degraded — logged; no degraded routing this cut).
    AdoptedDegraded,
    /// A daemon whose socket still accepts connections but never answered hello
    /// was preserved; the client reconnect-drains it (design L3e).
    AdoptedUnresponsive,
    /// No daemon was running (or it was unreachable + session-free); a fresh one
    /// was spawned.
    Spawned,
    /// A stale/rejected/dead daemon was killed and replaced with a fresh spawn.
    Replaced,
}

/// The resolved endpoint after [`ensure_running`].
#[derive(Debug, Clone)]
pub struct EnsureResult {
    pub outcome: EnsureOutcome,
    pub socket_path: PathBuf,
    pub token_path: PathBuf,
}

/// The result of a [`restart_daemon`] (design L8 / §7 first-cut restart).
///
/// `prior_session_ids` are the sessions the OLD daemon owned, captured BEFORE it
/// was told to shut down. **Exit-event contract (design §7):** the daemon does NOT
/// fan out exit frames when it is killed with `kill_sessions`, so the P9 frontend
/// MUST synthesize a synthetic exit for each of these panes — and it must do so
/// BEFORE it tears down its per-pane renderer handlers, or the exits are lost. The
/// fresh daemon (`result`) is empty on return; the frontend re-creates the panes
/// (fresh shells) after firing the synthesized exits.
#[derive(Debug, Clone)]
pub struct RestartOutcome {
    pub result: EnsureResult,
    pub prior_session_ids: Vec<String>,
}

/// Everything that can go wrong ensuring a daemon.
#[derive(Debug)]
pub enum SupervisorError {
    /// Filesystem / directory-creation failure.
    Io(io::Error),
    /// Writing the 0600 token file failed (spawn cannot proceed).
    TokenGen(io::Error),
    /// The signed daemon binary is missing or failed signature/arch verify with
    /// no usable fallback.
    BinaryVerify(String),
    /// The spawned child exited during the readiness window — fail fast rather
    /// than block the whole 10s deadline (design L1). Carries the log tail.
    SpawnFailed {
        reason: String,
        log_tail: Option<String>,
    },
    /// The child stayed alive but never became connectable within the deadline.
    ReadinessTimeout { log_tail: Option<String> },
}

impl std::fmt::Display for SupervisorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SupervisorError::Io(e) => write!(f, "supervisor io: {e}"),
            SupervisorError::TokenGen(e) => write!(f, "supervisor token write: {e}"),
            SupervisorError::BinaryVerify(m) => write!(f, "supervisor binary verify: {m}"),
            SupervisorError::SpawnFailed { reason, log_tail } => match log_tail {
                Some(tail) => write!(f, "daemon spawn failed: {reason}\nlog tail:\n{tail}"),
                None => write!(f, "daemon spawn failed: {reason}"),
            },
            SupervisorError::ReadinessTimeout { log_tail } => match log_tail {
                Some(tail) => write!(f, "daemon readiness timed out\nlog tail:\n{tail}"),
                None => write!(f, "daemon readiness timed out"),
            },
        }
    }
}

impl std::error::Error for SupervisorError {}

/// A coalescing facade over [`ensure_running`] (design L9 / P4 item 4). Concurrent
/// callers (e.g. the P3 client's dead-socket respawn path hitting several PTY ops
/// at once) serialize on `gate`, so exactly ONE spawn happens: the first caller
/// spawns, the rest observe the now-healthy daemon and adopt. Wired into `pty.rs`
/// at P9.
pub struct Supervisor {
    cfg: EnsureRunningConfig,
    gate: tokio::sync::Mutex<()>,
}

impl Supervisor {
    pub fn new(cfg: EnsureRunningConfig) -> Self {
        Self {
            cfg,
            gate: tokio::sync::Mutex::new(()),
        }
    }

    /// The versioned unix socket path for this supervisor's base dir.
    pub fn socket_path(&self) -> PathBuf {
        socket_path_for(&self.cfg.base_dir)
    }

    /// The versioned token file path for this supervisor's base dir.
    pub fn token_path(&self) -> PathBuf {
        daemon_token_path(&self.cfg.base_dir)
    }

    /// Ensure a live daemon, coalescing concurrent callers behind one spawn.
    pub async fn ensure_running(&self) -> Result<EnsureResult, SupervisorError> {
        let _guard = self.gate.lock().await;
        ensure_running(&self.cfg).await
    }
}

fn socket_path_for(base_dir: &Path) -> PathBuf {
    daemon_socket_path(base_dir)
        .as_path()
        .expect("unix endpoint is a filesystem socket path")
        .to_path_buf()
}

// ---------------------------------------------------------------------------
// ensure_running — the connect-or-spawn adoption gate (design L3/L4/L5)
// ---------------------------------------------------------------------------

/// Connect-or-spawn. See the module docs for the decision tree; the branch
/// structure mirrors orca `createOutOfProcessLauncher` verbatim.
pub async fn ensure_running(cfg: &EnsureRunningConfig) -> Result<EnsureResult, SupervisorError> {
    std::fs::create_dir_all(&cfg.base_dir).map_err(SupervisorError::Io)?;
    let socket_path = socket_path_for(&cfg.base_dir);
    let token_path = daemon_token_path(&cfg.base_dir);
    let pid_path = daemon_pid_path(&cfg.base_dir);

    let health = probe_health(&socket_path, &token_path).await;

    match health {
        DaemonHealth::Healthy => {
            // A protocol-healthy daemon can outlive the bundle that launched it
            // (dev rebuild / packaged update). A version change is a CLEAN-CUT
            // migration: the running daemon is a different build that may not
            // speak this app's protocol/features — e.g. the agent-status role is
            // additive, and an older daemon rejects it, silently breaking the
            // badge. Adopting stale code to save the shells trades a visible
            // feature break for invisible session survival, so a major update
            // instead retires the old daemon and respawns fresh. The killed
            // sessions stay cold-restorable on disk (their checkpoints outlive
            // the SIGKILL), so scrollback returns even though the processes do
            // not — the same contract as any app the user quits to update.
            // (An unchanged version — app quit/reopen with no update — is NOT
            // stale, so it still warm-adopts and the shells survive.)
            if is_stale_for_current(&pid_path, &socket_path, &cfg.app_version) {
                request_shutdown(&socket_path, &token_path).await;
                kill_stale_blocking(&cfg.base_dir, &socket_path, &token_path).await;
                spawn_daemon(cfg, &socket_path, &token_path, &pid_path, false).await?;
                Ok(make_result(EnsureOutcome::Replaced, socket_path, token_path))
            } else {
                Ok(make_result(
                    EnsureOutcome::Adopted,
                    socket_path,
                    token_path,
                ))
            }
        }
        DaemonHealth::Unreachable | DaemonHealth::Rejected | DaemonHealth::PtySpawnUnhealthy => {
            // A busy machine (post-update disk pressure) can time out the health
            // check while the daemon is alive and owning terminals. Re-verify
            // with a session list before killing anything (design L5).
            let count = alive_session_count(&socket_path, &token_path).await;
            if let Some(count) = count {
                if count > 0 {
                    let outcome = if matches!(health, DaemonHealth::PtySpawnUnhealthy) {
                        EnsureOutcome::AdoptedDegraded
                    } else {
                        EnsureOutcome::Adopted
                    };
                    return Ok(make_result(outcome, socket_path, token_path));
                }
            }
            // A socket that still accepts a raw connect proves a live daemon that
            // is merely wedged past its RPC budget: adopt it and let the client
            // reconnect-drain (design L3e). 'rejected' means the daemon answered
            // and refused the handshake — it can never be adopted (L3d).
            if count.is_none()
                && !matches!(health, DaemonHealth::Rejected)
                && probe_socket(&socket_path, ADOPT_UNRESPONSIVE_CONNECT_DEADLINE).await
            {
                return Ok(make_result(
                    EnsureOutcome::AdoptedUnresponsive,
                    socket_path,
                    token_path,
                ));
            }

            // Truly dead / rejected / stale-empty: a raw socket can outlive a
            // broken daemon, so kill by verified pid before respawn (design L6).
            let killed = kill_stale_blocking(&cfg.base_dir, &socket_path, &token_path).await;
            spawn_daemon(cfg, &socket_path, &token_path, &pid_path, false).await?;
            let outcome = if killed || matches!(health, DaemonHealth::Rejected) {
                EnsureOutcome::Replaced
            } else {
                EnsureOutcome::Spawned
            };
            Ok(make_result(outcome, socket_path, token_path))
        }
    }
}

fn make_result(outcome: EnsureOutcome, socket_path: PathBuf, token_path: PathBuf) -> EnsureResult {
    EnsureResult {
        outcome,
        socket_path,
        token_path,
    }
}

// ---------------------------------------------------------------------------
// restart_daemon — the explicit "Restart daemon" action (design L8 / §7)
// ---------------------------------------------------------------------------

/// Restart the daemon in place: kill it (and its sessions), re-copy the CURRENT
/// signed binary, and spawn a fresh one (design L8 + L1-sig + §7 first-cut).
///
/// This is the supervisor half of orca's `cleanupDaemonForProtocol` + respawn: it
/// (1) captures the sessions about to die so the frontend can synthesize their exit
/// events (see [`RestartOutcome`]); (2) sends the graceful `shutdown{killSessions:
/// true}` RPC, TOLERATING no reply (the daemon may be wedged/gone); (3) falls back
/// to the pid-guarded [`kill_stale`]; (4) FORCE re-copies the running bundle's
/// signed daemon binary — even when byte-identical — so the restart is guaranteed to
/// run CURRENT code (design L1-sig); (5) spawns fresh + polls readiness.
///
/// Unlike [`ensure_running`], this NEVER adopts: it always tears down and respawns.
/// Use it only for the explicit user "Restart daemon" action, never on normal
/// launch (that is `ensure_running`, which prefers warm adoption).
pub async fn restart_daemon(cfg: &EnsureRunningConfig) -> Result<RestartOutcome, SupervisorError> {
    std::fs::create_dir_all(&cfg.base_dir).map_err(SupervisorError::Io)?;
    let socket_path = socket_path_for(&cfg.base_dir);
    let token_path = daemon_token_path(&cfg.base_dir);
    let pid_path = daemon_pid_path(&cfg.base_dir);

    // (1) Snapshot the sessions the old daemon owns BEFORE we tear it down, so the
    // P9 frontend can synthesize their exit events (design §7 exit-event contract).
    let prior_session_ids = list_session_ids(&socket_path, &token_path).await;

    // (2) Graceful shutdown, killing sessions, tolerating no reply; (3) pid-guarded
    // kill-stale fallback + socket/pid cleanup. Together = client cleanup_for_protocol.
    request_shutdown(&socket_path, &token_path).await;
    kill_stale_blocking(&cfg.base_dir, &socket_path, &token_path).await;

    // (4)+(5) FORCE re-copy the current signed binary and spawn a fresh daemon.
    spawn_daemon(cfg, &socket_path, &token_path, &pid_path, true).await?;

    Ok(RestartOutcome {
        result: make_result(EnsureOutcome::Replaced, socket_path, token_path),
        prior_session_ids,
    })
}

/// List the daemon's current session ids via a throwaway control probe (design §7).
/// Best-effort: any failure yields an empty list (a wedged/dead daemon has no
/// synthesizable panes we can enumerate — the frontend then relies on its own
/// per-pane state).
async fn list_session_ids(socket_path: &Path, token_path: &Path) -> Vec<String> {
    let Some(token) = read_token(token_path) else {
        return Vec::new();
    };
    let Ok(mut ctl) = RawControl::connect(socket_path, &token, CONNECT_HELLO_DEADLINE).await else {
        return Vec::new();
    };
    let Ok(v) = ctl
        .request("listSessions", Value::Null, PROBE_RPC_TIMEOUT)
        .await
    else {
        return Vec::new();
    };
    v.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.get("sessionId").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Health probe (orca daemon-health.ts checkDaemonHealth)
// ---------------------------------------------------------------------------

/// The four health states, mirroring orca `DaemonHealth`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DaemonHealth {
    /// Hello accepted AND the PTY-spawn probe passed → safe to adopt.
    Healthy,
    /// Hello accepted but the PTY-spawn probe failed (stale cwd / broken helper).
    PtySpawnUnhealthy,
    /// The daemon answered and REFUSED the hello (version/token mismatch).
    Rejected,
    /// Could not connect, or connected but never answered hello in time.
    Unreachable,
}

/// Connect, hello, and (on success) run the `checkPtySpawnHealth` RPC.
async fn probe_health(socket_path: &Path, token_path: &Path) -> DaemonHealth {
    let token = match read_token(token_path) {
        Some(t) => t,
        None => return DaemonHealth::Unreachable,
    };
    let mut ctl = match RawControl::connect(socket_path, &token, CONNECT_HELLO_DEADLINE).await {
        Ok(ctl) => ctl,
        Err(ProbeError::Rejected) => return DaemonHealth::Rejected,
        Err(ProbeError::Unreachable) => return DaemonHealth::Unreachable,
    };
    // A protocol-live daemon with a stale cwd or broken PTY helper answers hello
    // but cannot create terminals; adoption must confirm the spawn path (orca).
    match ctl
        .request("checkPtySpawnHealth", Value::Null, PROBE_RPC_TIMEOUT)
        .await
    {
        Ok(v) => {
            if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                DaemonHealth::Healthy
            } else {
                DaemonHealth::PtySpawnUnhealthy
            }
        }
        // The socket died mid-probe → treat as unreachable (orca onError path).
        Err(_) => DaemonHealth::Unreachable,
    }
}

/// Count live sessions via a throwaway control connection. `None` on ANY failure
/// (unverifiable ⇒ preserve, design L5 / invariant #1).
async fn alive_session_count(socket_path: &Path, token_path: &Path) -> Option<usize> {
    let token = read_token(token_path)?;
    let mut ctl = RawControl::connect(socket_path, &token, CONNECT_HELLO_DEADLINE)
        .await
        .ok()?;
    let v = ctl
        .request("listSessions", Value::Null, PROBE_RPC_TIMEOUT)
        .await
        .ok()?;
    let arr = v.as_array()?;
    Some(
        arr.iter()
            .filter(|s| s.get("isAlive").and_then(Value::as_bool).unwrap_or(false))
            .count(),
    )
}

/// Best-effort graceful shutdown before replacing a healthy-but-stale daemon
/// (orca `cleanupDaemonForProtocol`; the SIGTERM fallback is [`kill_stale`]).
async fn request_shutdown(socket_path: &Path, token_path: &Path) {
    let Some(token) = read_token(token_path) else {
        return;
    };
    if let Ok(mut ctl) = RawControl::connect(socket_path, &token, CONNECT_HELLO_DEADLINE).await {
        let _ = ctl
            .request(
                "shutdown",
                json!({ "killSessions": true }),
                PROBE_RPC_TIMEOUT,
            )
            .await;
    }
}

/// Does the socket accept a raw connect within `deadline`? (orca `probeSocket` /
/// `canConnectSocket`.) The deadline is passed explicitly so the adopt-unresponsive
/// gate can use the roomier [`ADOPT_UNRESPONSIVE_CONNECT_DEADLINE`] while the fast
/// paths stay on [`RAW_CONNECT_DEADLINE`].
async fn probe_socket(socket_path: &Path, deadline: Duration) -> bool {
    if !socket_path.exists() {
        return false;
    }
    matches!(
        tokio::time::timeout(deadline, UnixStream::connect(socket_path)).await,
        Ok(Ok(_))
    )
}

fn read_token(token_path: &Path) -> Option<String> {
    let token = std::fs::read_to_string(token_path).ok()?;
    let token = token.trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

// ---------------------------------------------------------------------------
// A one-shot raw control connection (drops → closes; never leaks a socket)
// ---------------------------------------------------------------------------

enum ProbeError {
    /// The daemon answered and refused the hello.
    Rejected,
    /// Could not connect / no hello reply / io error.
    Unreachable,
}

/// A single control connection used for one probe then dropped. Unlike reusing
/// the full `DaemonClient` (whose reader tasks keep the socket open until the
/// daemon EOFs), dropping this closes both halves immediately — so repeated
/// readiness/health probes never leak connections into the daemon.
struct RawControl {
    reader: BufReader<OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
}

impl RawControl {
    /// Connect + send the control hello + await the ack, all under `deadline`.
    async fn connect(
        socket_path: &Path,
        token: &str,
        deadline: Duration,
    ) -> Result<Self, ProbeError> {
        let fut = async {
            let stream = UnixStream::connect(socket_path)
                .await
                .map_err(|_| ProbeError::Unreachable)?;
            let (r, mut w) = stream.into_split();
            let mut reader = BufReader::new(r);
            let hello = Hello {
                version: GROVE_DAEMON_PROTOCOL_VERSION,
                token: token.to_string(),
                client_id: "grove-supervisor".to_string(),
                kind: ClientKind::Control,
            };
            let line = encode_ndjson_line(&hello).map_err(|_| ProbeError::Unreachable)?;
            w.write_all(line.as_bytes())
                .await
                .map_err(|_| ProbeError::Unreachable)?;
            w.flush().await.map_err(|_| ProbeError::Unreachable)?;

            let mut ack_line = String::new();
            let n = reader
                .read_line(&mut ack_line)
                .await
                .map_err(|_| ProbeError::Unreachable)?;
            if n == 0 {
                return Err(ProbeError::Unreachable);
            }
            let ack: HelloAck =
                decode_ndjson_line(&ack_line).map_err(|_| ProbeError::Unreachable)?;
            if !ack.ok {
                return Err(ProbeError::Rejected);
            }
            Ok(RawControl { reader, writer: w })
        };
        match tokio::time::timeout(deadline, fut).await {
            Ok(res) => res,
            Err(_) => Err(ProbeError::Unreachable),
        }
    }

    /// Send one request (id=1) and read until its reply, under `deadline`.
    async fn request(
        &mut self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, ProbeError> {
        let req = ControlMessage::Request(RpcRequest {
            id: 1,
            method: method.to_string(),
            params,
        });
        let line = encode_ndjson_line(&req).map_err(|_| ProbeError::Unreachable)?;
        let fut = async {
            self.writer
                .write_all(line.as_bytes())
                .await
                .map_err(|_| ProbeError::Unreachable)?;
            self.writer
                .flush()
                .await
                .map_err(|_| ProbeError::Unreachable)?;
            let mut resp = String::new();
            loop {
                resp.clear();
                let n = self
                    .reader
                    .read_line(&mut resp)
                    .await
                    .map_err(|_| ProbeError::Unreachable)?;
                if n == 0 {
                    return Err(ProbeError::Unreachable);
                }
                if let Ok(ControlMessage::Reply(RpcReply { id, result, error })) =
                    decode_ndjson_line::<ControlMessage>(&resp)
                {
                    if id == 1 {
                        if error.is_some() {
                            return Err(ProbeError::Unreachable);
                        }
                        return Ok(result.unwrap_or(Value::Null));
                    }
                }
            }
        };
        match tokio::time::timeout(deadline, fut).await {
            Ok(res) => res,
            Err(_) => Err(ProbeError::Unreachable),
        }
    }
}

// ---------------------------------------------------------------------------
// Spawn (design L1 / L1-sig)
// ---------------------------------------------------------------------------

/// Copy the signed binary, generate the token, detached-spawn the daemon, and
/// poll readiness with child-exit fast-fail (design L1). On ready, write the
/// verified pid file and drop the child handle so the setsid child survives.
async fn spawn_daemon(
    cfg: &EnsureRunningConfig,
    socket_path: &Path,
    token_path: &Path,
    pid_path: &Path,
    force_recopy: bool,
) -> Result<(), SupervisorError> {
    // Generate + persist the token (0600) BEFORE spawn so a client that races the
    // spawn can already authenticate, and an empty/leftover token can never be
    // reused (design P4 item 3).
    let token = generate_token();
    write_secret_file(token_path, token.as_bytes()).map_err(SupervisorError::TokenGen)?;

    let bin = prepare_binary(&cfg.bin_source_path, &cfg.base_dir, force_recopy)?;

    // The detached daemon has no console; tee stdout+stderr to the log file so a
    // module-load crash during startup is captured, not discarded (design L1).
    let log_path = daemon_log_path(&cfg.base_dir);
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(SupervisorError::Io)?;
    let log_err = log.try_clone().map_err(SupervisorError::Io)?;

    let mut cmd = Command::new(&bin);
    cmd.arg("--socket")
        .arg(socket_path)
        .arg("--token")
        .arg(&token)
        .arg("--base-dir")
        .arg(&cfg.base_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .current_dir(&cfg.base_dir);
    // Detach: a new session so the daemon outlives the parent (design L1).
    // SAFETY: setsid is async-signal-safe and the only post-fork action.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }

    let mut child = cmd.spawn().map_err(SupervisorError::Io)?;

    let deadline = Instant::now() + READINESS_DEADLINE;
    loop {
        // Child-exit fast-fail: a crash-looping binary must fail in ~ms, not
        // block the full readiness deadline (design L1).
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(SupervisorError::SpawnFailed {
                    reason: format!("daemon exited during startup with {status}"),
                    log_tail: read_log_tail(&log_path),
                });
            }
            Ok(None) => {}
            Err(e) => return Err(SupervisorError::Io(e)),
        }

        if try_hello(socket_path, &token).await {
            // Ready: write the verified pid file, then DROP the child handle —
            // the setsid child keeps running detached (design L1).
            let _ = write_ready_pid_file(pid_path, child.id(), &bin, &cfg.app_version);
            drop(child);
            return Ok(());
        }

        if Instant::now() >= deadline {
            // Never became connectable and never exited: kill the one WE spawned.
            let _ = child.kill();
            let _ = child.wait();
            return Err(SupervisorError::ReadinessTimeout {
                log_tail: read_log_tail(&log_path),
            });
        }
        tokio::time::sleep(READINESS_POLL_INTERVAL).await;
    }
}

/// A single readiness probe: does connect+hello succeed on the endpoint?
async fn try_hello(socket_path: &Path, token: &str) -> bool {
    RawControl::connect(socket_path, token, RAW_CONNECT_DEADLINE)
        .await
        .is_ok()
}

/// May the supervisor spawn a daemon binary that failed `codesign --verify`?
///
/// In a RELEASE build: NO. The daemon runs detached, owns every PTY, and outlives the
/// app, so an unverifiable binary at that path is exactly the thing signature checking
/// exists to stop — degrading to "spawn it anyway with a warning" turns the check into
/// a log line. Refuse instead.
///
/// In debug/test builds: yes. `cargo build` produces an ad-hoc-signed daemon and the
/// tests spawn it straight out of `target/debug`; a hard gate there would fail the
/// whole dev loop, not catch an attack.
const ALLOW_UNVERIFIED_DAEMON_BINARY: bool = cfg!(debug_assertions);

/// Copy the app bundle's signed daemon binary into `base_dir` and verify it.
/// A byte-identical copy is skipped UNLESS `force` is set. On macOS,
/// `codesign --verify` + a Mach-O magic check GATE the spawn: a release build refuses
/// to run an unverifiable binary, a debug build degrades to the source path with a
/// warning (see [`ALLOW_UNVERIFIED_DAEMON_BINARY`]).
///
/// `force` is set by [`restart_daemon`] (design L1-sig): a "Restart daemon" must
/// re-adopt the CURRENT app bundle's binary even when it happens to be byte-
/// identical to the previously-copied one, so the restart is guaranteed to run
/// code from the running bundle (never a stale copy left by a prior version).
fn prepare_binary(source: &Path, base_dir: &Path, force: bool) -> Result<PathBuf, SupervisorError> {
    prepare_binary_with_policy(source, base_dir, force, ALLOW_UNVERIFIED_DAEMON_BINARY)
}

/// [`prepare_binary`] with the release/debug verification policy injected, so the
/// release GATE itself is testable from a debug test binary.
fn prepare_binary_with_policy(
    source: &Path,
    base_dir: &Path,
    force: bool,
    allow_unverified: bool,
) -> Result<PathBuf, SupervisorError> {
    if !source.exists() {
        return Err(SupervisorError::BinaryVerify(format!(
            "daemon binary source not found: {}",
            source.display()
        )));
    }
    let dest = daemon_bin_path(base_dir);
    if force || !files_identical(source, &dest) {
        std::fs::copy(source, &dest).map_err(SupervisorError::Io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
        }
    }

    #[cfg(target_os = "macos")]
    {
        if verify_codesign(&dest) && is_mach_o(&dest) {
            return Ok(dest);
        }
        if !allow_unverified {
            return Err(SupervisorError::BinaryVerify(format!(
                "daemon binary {} failed codesign/arch verification; refusing to spawn it",
                dest.display()
            )));
        }
        // Degrade (debug/test only): run the source path, which the OS validated when
        // the app itself launched. A warning, not a hard failure (design L1-sig).
        eprintln!(
            "[supervisor] codesign/arch verify failed for {}; spawning daemon from source {}",
            dest.display(),
            source.display()
        );
        Ok(source.to_path_buf())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = allow_unverified;
        Ok(dest)
    }
}

fn files_identical(a: &Path, b: &Path) -> bool {
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(ma), Ok(mb)) if ma.len() == mb.len() => {
            matches!((std::fs::read(a), std::fs::read(b)), (Ok(x), Ok(y)) if x == y)
        }
        _ => false,
    }
}

#[cfg(target_os = "macos")]
fn verify_codesign(path: &Path) -> bool {
    Command::new("codesign")
        .arg("--verify")
        .arg(path)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Confirm `path` begins with a recognized Mach-O (thin or fat) magic. A
/// byte-identical copy of the running app's daemon inherently matches the host
/// arch, so this is a sanity gate on the copy, not full cputype matching.
#[cfg(target_os = "macos")]
fn is_mach_o(path: &Path) -> bool {
    use std::io::Read;
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut magic = [0u8; 4];
    if f.read_exact(&mut magic).is_err() {
        return false;
    }
    matches!(
        magic,
        [0xCF, 0xFA, 0xED, 0xFE] // Mach-O 64 LE
            | [0xCE, 0xFA, 0xED, 0xFE] // Mach-O 32 LE
            | [0xFE, 0xED, 0xFA, 0xCF] // Mach-O 64 BE
            | [0xFE, 0xED, 0xFA, 0xCE] // Mach-O 32 BE
            | [0xCA, 0xFE, 0xBA, 0xBE] // fat BE
            | [0xBE, 0xBA, 0xFE, 0xCA] // fat LE
    )
}

/// 32 random bytes, hex-encoded (64 chars). Fresh on every spawn.
fn generate_token() -> String {
    use rand::Rng;
    let mut bytes = [0u8; 32];
    rand::rng().fill(&mut bytes[..]);
    to_hex(&bytes)
}

fn to_hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn read_log_tail(path: &Path) -> Option<String> {
    let data = std::fs::read(path).ok()?;
    let start = data.len().saturating_sub(LOG_TAIL_BYTES);
    let tail = String::from_utf8_lossy(&data[start..]).trim().to_string();
    if tail.is_empty() {
        None
    } else {
        Some(tail)
    }
}

/// Write the pid file after readiness with pid + start-time + bin_path +
/// app_version (design L1/L4). Start-time source: OS query, falling back to the
/// daemon's own self-reported value already in the pid file.
fn write_ready_pid_file(
    pid_path: &Path,
    pid: u32,
    bin_path: &Path,
    app_version: &str,
) -> io::Result<()> {
    let self_reported = std::fs::read_to_string(pid_path)
        .ok()
        .and_then(|s| parse_pid_file(&s))
        .and_then(|p| p.started_at_ms);
    let started_at_ms = get_process_started_at_ms(pid).or(self_reported);
    let pid_file = DaemonPidFile {
        pid,
        started_at_ms,
        bin_path: Some(bin_path.display().to_string()),
        app_version: Some(app_version.to_string()),
    };
    write_secret_file(pid_path, serialize_pid_file(&pid_file).as_bytes())
}

/// Launch-identity staleness (design L4): the recorded `app_version` differs
/// from the current one. Verifies the pid genuinely IS the daemon first
/// (fail-open: an unverifiable pid is never treated as stale). A pid file with
/// no version marker is replaced once (orca migration behavior).
fn is_stale_for_current(pid_path: &Path, socket_path: &Path, current_app_version: &str) -> bool {
    let parsed = match std::fs::read_to_string(pid_path)
        .ok()
        .and_then(|s| parse_pid_file(&s))
    {
        Some(p) => p,
        None => return false,
    };
    if !is_daemon_process(parsed.pid, socket_path, parsed.started_at_ms) {
        return false;
    }
    match parsed.app_version {
        Some(recorded) => recorded != current_app_version,
        None => true,
    }
}

// ---------------------------------------------------------------------------
// kill-stale + pid identity (design L6)
// ---------------------------------------------------------------------------

async fn kill_stale_blocking(base_dir: &Path, socket_path: &Path, token_path: &Path) -> bool {
    let base_dir = base_dir.to_path_buf();
    let socket_path = socket_path.to_path_buf();
    let token_path = token_path.to_path_buf();
    tokio::task::spawn_blocking(move || kill_stale(&base_dir, &socket_path, &token_path))
        .await
        .unwrap_or(false)
}

/// Kill a stale daemon by verified pid identity, escalating SIGTERM→SIGKILL with
/// a start-time recycle guard, then clean up its pid/socket files (design L6).
/// Returns whether we killed (or confirmed gone) the recorded daemon.
///
/// Fail-open: a pid the identity check cannot positively bind to THIS daemon is
/// never signalled (invariant #1). `token_path` is reserved for parity with
/// orca's cmdline token match; grove keys identity on the unique socket path
/// (which itself embeds the versioned `daemon-v{N}.sock` name).
pub fn kill_stale(base_dir: &Path, socket_path: &Path, token_path: &Path) -> bool {
    let _ = token_path;
    let pid_path = daemon_pid_path(base_dir);
    let mut killed = false;

    if let Some(parsed) = std::fs::read_to_string(&pid_path)
        .ok()
        .and_then(|s| parse_pid_file(&s))
    {
        if is_daemon_process(parsed.pid, socket_path, parsed.started_at_ms) {
            let pid = parsed.pid as i32;
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
            let deadline = Instant::now() + KILL_WAIT;
            let mut exited = false;
            while Instant::now() < deadline {
                if !process_exists(parsed.pid) {
                    exited = true;
                    break;
                }
                std::thread::sleep(KILL_POLL);
            }
            if !exited {
                // Re-verify identity before SIGKILL: the SIGTERM+wait window is
                // long enough for the pid to be recycled onto an unrelated
                // process (design L6 / invariant #2).
                if is_daemon_process(parsed.pid, socket_path, parsed.started_at_ms) {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                    exited = true;
                } else {
                    // Recycled: refuse SIGKILL; the original daemon is gone.
                    exited = true;
                }
            }
            killed = exited;
        }
    }

    let _ = std::fs::remove_file(&pid_path);
    // Unlink the socket only if we killed the daemon or it no longer connects —
    // never yank a socket out from under a live, adopted daemon (design L6).
    let socket_live = std::os::unix::net::UnixStream::connect(socket_path).is_ok();
    if socket_path.exists() && (killed || !socket_live) {
        let _ = std::fs::remove_file(socket_path);
    }
    killed
}

/// Is `pid` alive AND identifiably THIS daemon (cmdline carries the endpoint
/// socket path) AND started at the expected time (recycle guard, fail-open on
/// unreadable start time)? Mirrors orca `isDaemonProcess`.
fn is_daemon_process(pid: u32, socket_path: &Path, expected_started_at_ms: Option<u64>) -> bool {
    if !process_exists(pid) {
        return false;
    }
    let socket_str = socket_path.to_string_lossy();
    let cmdline = match get_cmdline(pid) {
        Some(c) => c,
        None => return false,
    };
    if !cmdline.contains(socket_str.as_ref()) {
        return false;
    }
    start_time_matches(pid, expected_started_at_ms)
}

fn process_exists(pid: u32) -> bool {
    let ret = unsafe { libc::kill(pid as i32, 0) };
    if ret == 0 {
        return true;
    }
    // EPERM means the process exists but we lack signal permission.
    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Fail-open on null: a missing start time (either side) never vetoes an
/// otherwise-matching daemon (design L6 / invariant #2 — adoption safety beats
/// recycle safety).
fn start_time_matches(pid: u32, expected: Option<u64>) -> bool {
    match (get_process_started_at_ms(pid), expected) {
        (Some(actual), Some(expected)) => {
            (actual as i64 - expected as i64).unsigned_abs() <= START_TIME_TOLERANCE_MS
        }
        _ => true,
    }
}

#[cfg(target_os = "linux")]
fn get_cmdline(pid: u32) -> Option<String> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(String::from_utf8_lossy(&bytes).replace('\0', " "))
}

#[cfg(not(target_os = "linux"))]
fn get_cmdline(pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .arg("-p")
        .arg(pid.to_string())
        .arg("-o")
        .arg("command=")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(target_os = "linux")]
fn get_process_started_at_ms(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Field 22 (starttime) is after the possibly-space-containing comm in "()".
    let after = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = after.split_whitespace().collect();
    // After ')', fields[0] is field 3 (state); starttime (field 22) is fields[19].
    let start_ticks: f64 = fields.get(19)?.parse().ok()?;
    let clk_tck = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if clk_tck <= 0 {
        return None;
    }
    let btime = read_btime()?;
    Some(((btime as f64) * 1000.0 + (start_ticks / clk_tck as f64) * 1000.0) as u64)
}

#[cfg(target_os = "linux")]
fn read_btime() -> Option<u64> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    for line in stat.lines() {
        if let Some(rest) = line.strip_prefix("btime ") {
            return rest.trim().parse().ok();
        }
    }
    None
}

/// macOS start time via `ps -o lstart=`. The value is a stable identity token,
/// not a wall-clock epoch: it is parsed TZ-naively, but since both the stored
/// and the re-read value pass through the SAME parser for the SAME process, the
/// constant offset cancels and the recycle guard's equality holds exactly.
#[cfg(target_os = "macos")]
fn get_process_started_at_ms(pid: u32) -> Option<u64> {
    let out = Command::new("ps")
        .arg("-p")
        .arg(pid.to_string())
        .arg("-o")
        .arg("lstart=")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    parse_lstart_to_ms(&s)
}

/// Parse `ps -o lstart=` output ("Sat Jul 12 01:23:45 2026") into ms. See
/// [`get_process_started_at_ms`] for why TZ-naive is acceptable here.
#[cfg(target_os = "macos")]
fn parse_lstart_to_ms(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 5 {
        return None;
    }
    let month = month_index(parts[1])?;
    let day: i64 = parts[2].parse().ok()?;
    let year: i64 = parts[4].parse().ok()?;
    let hms: Vec<&str> = parts[3].split(':').collect();
    if hms.len() != 3 {
        return None;
    }
    let h: i64 = hms[0].parse().ok()?;
    let mi: i64 = hms[1].parse().ok()?;
    let se: i64 = hms[2].parse().ok()?;
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + h * 3_600 + mi * 60 + se;
    if secs < 0 {
        return None;
    }
    Some(secs as u64 * 1_000)
}

#[cfg(target_os = "macos")]
fn month_index(name: &str) -> Option<i64> {
    match name {
        "Jan" => Some(1),
        "Feb" => Some(2),
        "Mar" => Some(3),
        "Apr" => Some(4),
        "May" => Some(5),
        "Jun" => Some(6),
        "Jul" => Some(7),
        "Aug" => Some(8),
        "Sep" => Some(9),
        "Oct" => Some(10),
        "Nov" => Some(11),
        "Dec" => Some(12),
        _ => None,
    }
}

/// Days since the Unix epoch for a civil date (Howard Hinnant's algorithm).
/// `m` in 1..=12.
#[cfg(target_os = "macos")]
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn get_process_started_at_ms(_pid: u32) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_hex_encodes_lowercase() {
        assert_eq!(to_hex(&[0x00, 0x0f, 0xff, 0xa5]), "000fffa5");
    }

    #[test]
    fn generated_token_is_64_hex_chars() {
        let t = generate_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        // Two draws must differ (32 random bytes).
        assert_ne!(generate_token(), t);
    }

    #[test]
    fn start_time_matches_fails_open_on_null() {
        // A live pid (our own) with no expected start time → match (fail-open).
        let me = std::process::id();
        assert!(start_time_matches(me, None));
    }

    #[test]
    fn process_exists_true_for_self_false_for_reserved() {
        assert!(process_exists(std::process::id()));
        // pid 0 addresses the process group, never an individual process here;
        // a very high pid is virtually never live.
        assert!(!process_exists(u32::MAX - 1));
    }

    /// The codesign check must be a GATE, not a log line: a release build that cannot
    /// verify the daemon binary refuses to spawn it instead of degrading to the
    /// unverified source path. (Debug builds still degrade — see
    /// `ALLOW_UNVERIFIED_DAEMON_BINARY` — which is what keeps the dev loop and the
    /// `GROVE_DAEMON_BIN` tests working.)
    #[cfg(target_os = "macos")]
    #[test]
    fn release_refuses_to_spawn_an_unverifiable_daemon_binary() {
        let base = std::env::temp_dir().join(format!("grove-sup-verify-{}", generate_token()));
        std::fs::create_dir_all(&base).unwrap();
        // Not a Mach-O, not signed — `codesign --verify` and the magic check both fail.
        let source = base.join("fake-daemon");
        std::fs::write(&source, b"#!/bin/sh\necho not a daemon\n").unwrap();

        let refused = prepare_binary_with_policy(&source, &base, false, false);
        assert!(
            matches!(refused, Err(SupervisorError::BinaryVerify(_))),
            "an unverifiable binary must be refused in release, got {refused:?}"
        );

        // Debug/dev keeps working: the same binary degrades to the source path.
        let degraded = prepare_binary_with_policy(&source, &base, false, true).unwrap();
        assert_eq!(degraded, source);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn unidentified_pid_is_not_a_daemon() {
        // Our own process is alive but its cmdline does not contain this socket
        // path, so it is never mistaken for the daemon (fail-open identity).
        let socket = Path::new("/tmp/grove-nonexistent-daemon-v1.sock");
        assert!(!is_daemon_process(std::process::id(), socket, None));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn lstart_parse_is_stable_and_ordered() {
        let a = parse_lstart_to_ms("Sat Jul 12 01:23:45 2026").unwrap();
        let b = parse_lstart_to_ms("Sat Jul 12 01:23:46 2026").unwrap();
        // Same string → same value (identity stability); +1s → +1000ms.
        assert_eq!(parse_lstart_to_ms("Sat Jul 12 01:23:45 2026").unwrap(), a);
        assert_eq!(b - a, 1_000);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn days_from_civil_epoch_anchor() {
        // 1970-01-01 is day 0; 1970-01-02 is day 1; 2000-03-01 is a known anchor.
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1970, 1, 2), 1);
        assert_eq!(days_from_civil(2000, 3, 1), 11_017);
    }
}
