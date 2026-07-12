//! PTY daemon protocol surface (design §1 / §2.4 / P1).
//!
//! This module is the wire contract shared by the daemon binary and the
//! in-process client that will slot under `pty.rs`'s pub fns. It is split by
//! channel to enforce design invariant #9 ("binary on the hot path, JSON on the
//! control path"):
//!
//! - [`protocol`] — the CONTROL channel: versioned endpoint paths, the hello
//!   handshake, RPC/notify envelopes, and the pid file, serialized as NDJSON.
//! - [`framing`] — the STREAM channel: the length-prefixed binary GCKL frame
//!   codec for `Data`/`Exit`/`Resize`. Raw PTY bytes NEVER ride NDJSON.
//!
//! P3 adds [`client`] — the in-process DaemonClient (control+stream sockets,
//! RPC correlation, generation-guarded reconnect, sticky cold-restore cache) plus
//! the blocking bridge. It is unix-only (the endpoint is a unix socket; the
//! Windows named-pipe transport lands with the supervisor).
//!
//! P4 adds [`supervisor`] — the connect-or-spawn adoption gate (signed-bin copy,
//! detached spawn + readiness, pid-identity kill-stale). Also unix-only.

pub mod framing;
pub mod protocol;

#[cfg(unix)]
pub mod client;

/// Daemon-mode terminal GC partition helpers (design §9). Unix-only: keyed off the
/// unix-only [`client::SessionInfo`] liveness snapshot.
#[cfg(unix)]
pub mod gc;

#[cfg(unix)]
pub mod supervisor;

/// Process-global daemon client slot (design P9 cutover seam). Unix-only because
/// [`client::ClientHandle`] is; a non-unix `ack_cold_restore` no-op stub below
/// keeps the public entry point resolvable on every target.
#[cfg(unix)]
mod global;

pub use framing::{
    seq_is_monotonic, ExitStatus, FrameError, SeqTracker, StreamDecoder, StreamFrame,
    StreamFrameKind, MAX_SESSION_ID_BYTES, MAX_STREAM_FRAME_PAYLOAD, STREAM_FRAME_HEADER_BYTES,
    STREAM_FRAME_MAGIC,
};
pub use protocol::{
    daemon_bin_path, daemon_log_path, daemon_pid_path, daemon_socket_path, daemon_token_path,
    decode_ndjson_line, encode_ndjson_line, history_root, parse_pid_file, serialize_pid_file,
    write_secret_file, ClientKind, ControlMessage, DaemonPidFile, DaemonSocket, Hello, HelloAck,
    Notify, ProtocolError, RpcError, RpcReply, RpcRequest, GROVE_DAEMON_PROTOCOL_VERSION,
    MAX_CONTROL_LINE_BYTES,
};

#[cfg(unix)]
pub use client::{
    BridgeError, ClientError, ClientHandle, ColdRestoreCache, ColdRestorePayload, CreateOrAttach,
    CreateOrAttachResult, DaemonClient, DaemonClientOptions, SessionInfo, StreamSubscriber,
    WarmReattach, DEFAULT_REQUEST_TIMEOUT,
};

#[cfg(unix)]
pub use global::{
    ack_cold_restore, checkpoint_all_sessions, checkpoint_all_sessions_blocking, configure,
    configure_default, default_bin_source_path, get_or_init_client, global_client, is_configured,
    runtime_base_dir, set_global_client, DaemonRuntimeConfig, DAEMON_BIN_ENV,
};

/// Non-unix stub for the P9 cold-restore ack entry point. The daemon client is
/// unix-only, so off-unix there is never a global client to forward to — this
/// keeps `daemon::ack_cold_restore` resolvable for callers that stay portable.
#[cfg(not(unix))]
pub fn ack_cold_restore(_session_id: &str) {}

#[cfg(unix)]
pub use gc::{
    known_session_ids, live_session_ids, plan_history_gc, HistoryDirInfo, HistoryGcInput,
    GC_MIN_AGE,
};

#[cfg(unix)]
pub use supervisor::{
    ensure_running, kill_stale, restart_daemon, EnsureOutcome, EnsureResult, EnsureRunningConfig,
    RestartOutcome, Supervisor, SupervisorError,
};
