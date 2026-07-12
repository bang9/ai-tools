//! Control-channel protocol types for the PTY daemon: the versioned endpoint
//! layout, the hello handshake, the RPC/notify envelopes, and the pid file.
//!
//! Scope (design P1/P2/P4): the CONTROL socket carries JSON as NDJSON — one
//! JSON object per `\n`-terminated line. Live PTY output does NOT ride here; it
//! travels as binary frames (see [`super::framing`]). These are pure types plus
//! line-level (de)serialization helpers — no sockets.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Wire protocol version. Bump on ANY breaking change to the control envelopes,
/// the stream framing, or the on-disk history layout. Echoed in [`Hello`] and
/// baked into every runtime filename + the history root, so an incompatible
/// build lives on a disjoint endpoint and can never be half-adopted (design L2).
pub const GROVE_DAEMON_PROTOCOL_VERSION: u32 = 1;

/// Max length of one NDJSON control line (design P4). Bounds a corrupt/hostile
/// line from making a line-reader buffer unbounded memory. Control only — the
/// binary stream has its own cap ([`super::framing::MAX_STREAM_FRAME_PAYLOAD`]).
pub const MAX_CONTROL_LINE_BYTES: usize = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Endpoint & on-disk path helpers (design §1.3)
// ---------------------------------------------------------------------------

/// The unix socket path for a protocol version under `base` (typically
/// `app_data_dir()/daemon`). On Windows the endpoint is a named pipe string
/// keyed by a hash of `base` rather than a filesystem path.
pub fn daemon_socket_path(base: &Path) -> DaemonSocket {
    #[cfg(windows)]
    {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(base.to_string_lossy().as_bytes());
        let suffix = hex_lower(&hasher.finalize()[..6]);
        DaemonSocket::Pipe(format!(
            r"\\.\pipe\grove-daemon-v{GROVE_DAEMON_PROTOCOL_VERSION}-{suffix}"
        ))
    }
    #[cfg(not(windows))]
    {
        DaemonSocket::Path(base.join(format!("daemon-v{GROVE_DAEMON_PROTOCOL_VERSION}.sock")))
    }
}

/// The random-token file path (contents chmod 0600, see [`write_secret_file`]).
pub fn daemon_token_path(base: &Path) -> PathBuf {
    base.join(format!("daemon-v{GROVE_DAEMON_PROTOCOL_VERSION}.token"))
}

/// The pid file path (JSON, see [`DaemonPidFile`]).
pub fn daemon_pid_path(base: &Path) -> PathBuf {
    base.join(format!("daemon-v{GROVE_DAEMON_PROTOCOL_VERSION}.pid"))
}

/// The copied, already-signed daemon binary path (design L1-sig).
pub fn daemon_bin_path(base: &Path) -> PathBuf {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    base.join(format!("daemon-bin-v{GROVE_DAEMON_PROTOCOL_VERSION}{ext}"))
}

/// The daemon stderr/log path (the host has no console for the detached child).
pub fn daemon_log_path(base: &Path) -> PathBuf {
    base.join(format!("daemon-v{GROVE_DAEMON_PROTOCOL_VERSION}.log"))
}

/// The protocol-version-namespaced history root (design D1/§5) under `app_data`.
/// Namespacing by version keeps a surviving older daemon's session dirs disjoint
/// from a newer one's during an app update (design R9).
pub fn history_root(app_data: &Path) -> PathBuf {
    app_data
        .join("terminal-history")
        .join(format!("v{GROVE_DAEMON_PROTOCOL_VERSION}"))
}

/// The control socket endpoint: a filesystem path on unix, a named pipe on win.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonSocket {
    Path(PathBuf),
    Pipe(String),
}

impl DaemonSocket {
    /// The filesystem path, if this endpoint is a unix socket.
    pub fn as_path(&self) -> Option<&Path> {
        match self {
            DaemonSocket::Path(p) => Some(p.as_path()),
            DaemonSocket::Pipe(_) => None,
        }
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Write `contents` to `path` with owner-only (0600) permissions. Why: the
/// token gates every socket handshake — a world-readable token would let any
/// local user speak the protocol. On unix the file is created 0600 up front
/// (never widened then narrowed); the mode is a best-effort no-op elsewhere.
pub fn write_secret_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(contents)?;
        f.flush()
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)
    }
}

// ---------------------------------------------------------------------------
// Hello handshake (design P2)
// ---------------------------------------------------------------------------

/// Which socket a client opened. Each host client opens TWO connections keyed by
/// the same `client_id`: a control socket (NDJSON RPC) and a stream socket
/// (binary output frames). Serialized as the orca-compatible `role` field.
///
/// [`ClientKind::Agent`] is the agent-status channel (agent-status design §3.2). It
/// is PURELY ADDITIVE at protocol version 1 — the version is deliberately NOT
/// bumped, because the socket AND the on-disk history root are version-namespaced,
/// so a bump would orphan every shell a user currently has running and lose their
/// scrollback. The cost of staying at v1 is that an OLD, already-running daemon the
/// supervisor adopted cannot parse `role:"agent"`: its `Hello` decode fails and it
/// answers `HelloAck{ok:false}`. That is the designed degradation — the claim fails,
/// `grove-agent` execs the real agent anyway, and the pane simply shows no badge
/// until that daemon is next restarted. Nothing hangs, errors, or blocks the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClientKind {
    Control,
    Stream,
    Agent,
}

/// First line sent on every socket. The server validates: message type,
/// `version == GROVE_DAEMON_PROTOCOL_VERSION` (EXACT, design R4), token match,
/// then a matching control client exists for a `Stream` hello.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub version: u32,
    pub token: String,
    pub client_id: String,
    #[serde(rename = "role")]
    pub kind: ClientKind,
}

/// The server's reply to a [`Hello`]. `ok=false` carries a short reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloAck {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl HelloAck {
    pub fn ok() -> Self {
        Self { ok: true, error: None }
    }

    pub fn reject(reason: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(reason.into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Agent-status channel (agent-status design §3.2/§3.3)
// ---------------------------------------------------------------------------

/// Env var carrying the per-session agent key into a pane (see
/// [`derive_session_key`]). NOT the daemon token — a shell in a pane must never be
/// able to call `kill`/`shutdown`.
pub const GROVE_SESSION_KEY_ENV: &str = "GROVE_SESSION_KEY";
/// Env var carrying the daemon control socket path into a pane, so `grove-agent`
/// can find the endpoint without re-deriving the app data dir.
pub const GROVE_DAEMON_SOCK_ENV: &str = "GROVE_DAEMON_SOCK";
/// Env var carrying the daemon-minted claim id into the AGENT's env (and thus,
/// by inheritance, into its hook subprocesses). This is the capability that
/// authorizes `agentEvent` — a hook has no controlling terminal and often no
/// readable peer pid, so the claim id is the only thing it can prove.
pub const GROVE_CLAIM_ID_ENV: &str = "GROVE_CLAIM_ID";

/// The claim RPC: sent ONCE by `grove-agent launch`, before it execs the real
/// agent. Method name for [`RpcRequest::method`].
pub const METHOD_AGENT_CLAIM: &str = "agentClaim";
/// The per-hook-fire event RPC. Method name for [`RpcRequest::method`].
pub const METHOD_AGENT_EVENT: &str = "agentEvent";

/// Derive a pane's agent key from the daemon token and the session id.
///
/// The key is DERIVED, never stored and never rotated: it authorizes exactly two
/// methods ([`METHOD_AGENT_CLAIM`], [`METHOD_AGENT_EVENT`]) on exactly one session.
/// Leaking it yields no daemon token (SHA-256 preimage), so a pane's env can carry
/// it safely while the daemon token stays out of every pane.
///
/// ONE impl, shared by grove-core (which exports the key into the child env) and
/// grove-daemon (which recomputes it to authorize a call) — they can never drift.
pub fn derive_session_key(daemon_token: &str, session_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("grove-agent-v1:{daemon_token}:{session_id}").as_bytes());
    hex_lower(&digest[..16]) // 32 hex chars
}

/// Mint a fresh, unguessable claim id (128 bits, 32 hex chars). Daemon-side only;
/// it is handed back in [`AgentClaimResult`] and exported as [`GROVE_CLAIM_ID_ENV`].
pub fn new_claim_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    hex_lower(&bytes)
}

/// `agentClaim` params. There is deliberately **no `pid` field**: the daemon reads
/// the peer pid from the kernel (`getsockopt(SOL_LOCAL, LOCAL_PEERPID)`), and
/// because `grove-agent launch` **execs** the real agent, that pid IS the agent's
/// pid. A claimant cannot lie about who it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentClaimParams {
    pub session_id: String,
    /// `"claude"` | `"codex"` — the tool half of the frozen `"<tool>:<status>"`
    /// renderer contract.
    pub tool: String,
}

/// `agentClaim` result: the capability a hook later presents on `agentEvent`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentClaimResult {
    pub claim_id: String,
}

/// `agentEvent` params — one per hook fire. Only `event` and `tool_name` cross the
/// wire: `cwd`, `tool_input` and `transcript_path` do NOT (no PII on the socket).
///
/// `event` is the agent's own `hook_event_name`, verbatim. Both Claude Code and
/// Codex emit CamelCase (`PreToolUse`, `PermissionRequest`, `Stop`, …) — verified
/// on the wire for both — so ONE mapping table serves both agents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventParams {
    pub session_id: String,
    pub claim_id: String,
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// `CLOCK_MONOTONIC` nanos at hook time. The daemon drops any event whose
    /// `at_ns` is not strictly greater than the claim's last accepted one — five
    /// lines that kill the whole reordering class.
    pub at_ns: u64,
}

// ---------------------------------------------------------------------------
// RPC / notify envelopes (design P5/P6)
// ---------------------------------------------------------------------------

/// A correlated request: the client stamps a monotonically increasing `id` and
/// awaits the [`RpcReply`] with the matching id (design P5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// The reply to an [`RpcRequest`], correlated by `id`. Exactly one of
/// `result`/`error` is set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcReply {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcReply {
    pub fn ok(id: u64, result: serde_json::Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: u64, error: RpcError) -> Self {
        Self {
            id,
            result: None,
            error: Some(error),
        }
    }
}

/// A structured RPC error payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

/// A fire-and-forget message: no `id`, no reply. Keystroke-latency-sensitive
/// ops (`write`, `resize`, `pause`, `resume`, `ack_cold_restore`, …) go here so
/// they are not gated on an RPC ACK (design P6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notify {
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// Any message that can appear on the control channel. Internally tagged by a
/// `type` field so a line reader can decode without out-of-band context.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ControlMessage {
    Hello(Hello),
    HelloAck(HelloAck),
    Request(RpcRequest),
    Reply(RpcReply),
    Notify(Notify),
}

// ---------------------------------------------------------------------------
// NDJSON line (de)serialization (design P4)
// ---------------------------------------------------------------------------

/// Errors from NDJSON (de)serialization.
#[derive(Debug)]
pub enum ProtocolError {
    LineTooLong { len: usize, cap: usize },
    Json(serde_json::Error),
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProtocolError::LineTooLong { len, cap } => {
                write!(f, "control line {len} exceeds cap {cap}")
            }
            ProtocolError::Json(e) => write!(f, "control json: {e}"),
        }
    }
}

impl std::error::Error for ProtocolError {}

impl From<serde_json::Error> for ProtocolError {
    fn from(e: serde_json::Error) -> Self {
        ProtocolError::Json(e)
    }
}

/// Serialize `msg` to a single NDJSON line, INCLUDING the trailing `\n`. The
/// value must serialize to a JSON object with no embedded newline — all the
/// envelope types above satisfy this (serde_json does not emit raw newlines).
pub fn encode_ndjson_line<T: Serialize>(msg: &T) -> Result<String, ProtocolError> {
    let mut line = serde_json::to_string(msg)?;
    line.push('\n');
    Ok(line)
}

/// Parse one NDJSON line (with or without its trailing newline) into `T`,
/// enforcing the [`MAX_CONTROL_LINE_BYTES`] cap first.
pub fn decode_ndjson_line<T: DeserializeOwned>(line: &str) -> Result<T, ProtocolError> {
    if line.len() > MAX_CONTROL_LINE_BYTES {
        return Err(ProtocolError::LineTooLong {
            len: line.len(),
            cap: MAX_CONTROL_LINE_BYTES,
        });
    }
    let trimmed = line.trim_end_matches(['\n', '\r']);
    Ok(serde_json::from_str(trimmed)?)
}

// ---------------------------------------------------------------------------
// Pid file (design §1.3, orca daemon-spawner.ts:serializeDaemonPidFile)
// ---------------------------------------------------------------------------

/// The `daemon-v{N}.pid` payload. `started_at_ms` is nullable (orca semantics:
/// process start time may be unreadable — treated as ambiguous, fail-open in the
/// staleness/kill guards, design L4/L6). `bin_path`/`app_version` back the
/// launch-identity staleness check (design L4). Written 0600.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonPidFile {
    pub pid: u32,
    /// Milliseconds since epoch; `None` when the OS start time was unreadable.
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bin_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
}

/// Serialize a pid file to its JSON string (no trailing newline).
pub fn serialize_pid_file(pid_file: &DaemonPidFile) -> String {
    // Why unwrap-safe: the struct is a fixed set of primitives/options.
    serde_json::to_string(pid_file).expect("DaemonPidFile serializes")
}

/// Tolerant parse: a missing / truncated / malformed pid file yields `None`
/// rather than an error, so a corrupt file is treated as "no daemon recorded"
/// (the supervisor then spawns fresh). Unknown extra fields are ignored.
pub fn parse_pid_file(contents: &str) -> Option<DaemonPidFile> {
    serde_json::from_str(contents.trim()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn protocol_version_is_one() {
        assert_eq!(GROVE_DAEMON_PROTOCOL_VERSION, 1);
    }

    #[cfg(not(windows))]
    #[test]
    fn endpoint_paths_are_version_namespaced() {
        let base = Path::new("/tmp/app/daemon");
        assert_eq!(
            daemon_socket_path(base).as_path().unwrap(),
            Path::new("/tmp/app/daemon/daemon-v1.sock")
        );
        assert_eq!(
            daemon_token_path(base),
            Path::new("/tmp/app/daemon/daemon-v1.token")
        );
        assert_eq!(
            daemon_pid_path(base),
            Path::new("/tmp/app/daemon/daemon-v1.pid")
        );
        assert_eq!(
            daemon_bin_path(base),
            Path::new("/tmp/app/daemon/daemon-bin-v1")
        );
        assert_eq!(
            daemon_log_path(base),
            Path::new("/tmp/app/daemon/daemon-v1.log")
        );
    }

    #[test]
    fn history_root_is_version_namespaced() {
        let root = history_root(Path::new("/home/u/.grove"));
        assert_eq!(root, Path::new("/home/u/.grove/terminal-history/v1"));
    }

    #[cfg(unix)]
    #[test]
    fn write_secret_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("grove-tok-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("daemon-v1.token");
        write_secret_file(&path, b"secret-token").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(std::fs::read(&path).unwrap(), b"secret-token");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hello_round_trips_over_ndjson() {
        let hello = Hello {
            version: GROVE_DAEMON_PROTOCOL_VERSION,
            token: "tok-123".into(),
            client_id: "host-a".into(),
            kind: ClientKind::Stream,
        };
        let line = encode_ndjson_line(&hello).unwrap();
        assert!(line.ends_with('\n'));
        assert!(line.contains("\"role\":\"stream\""));
        let back: Hello = decode_ndjson_line(&line).unwrap();
        assert_eq!(back, hello);
    }

    #[test]
    fn hello_ack_omits_error_when_ok() {
        let line = encode_ndjson_line(&HelloAck::ok()).unwrap();
        assert!(!line.contains("error"));
        let reject = encode_ndjson_line(&HelloAck::reject("version mismatch")).unwrap();
        assert!(reject.contains("version mismatch"));
    }

    #[test]
    fn rpc_request_reply_round_trip() {
        let req = RpcRequest {
            id: 7,
            method: "createOrAttach".into(),
            params: serde_json::json!({ "ptyId": "abc", "cols": 80 }),
        };
        let line = encode_ndjson_line(&req).unwrap();
        let back: RpcRequest = decode_ndjson_line(&line).unwrap();
        assert_eq!(back, req);

        let reply = RpcReply::ok(7, serde_json::json!({ "isNew": true }));
        let back: RpcReply = decode_ndjson_line(&encode_ndjson_line(&reply).unwrap()).unwrap();
        assert_eq!(back, reply);
        assert!(back.error.is_none());

        let err = RpcReply::err(
            7,
            RpcError {
                code: -1,
                message: "SessionNotFound".into(),
            },
        );
        let back: RpcReply = decode_ndjson_line(&encode_ndjson_line(&err).unwrap()).unwrap();
        assert_eq!(back, err);
        assert!(back.result.is_none());
    }

    #[test]
    fn notify_round_trip() {
        let notify = Notify {
            method: "write".into(),
            params: serde_json::json!({ "ptyId": "abc", "data": "ls\n" }),
        };
        let back: Notify = decode_ndjson_line(&encode_ndjson_line(&notify).unwrap()).unwrap();
        assert_eq!(back, notify);
    }

    #[test]
    fn control_message_tagged_enum_discriminates() {
        let msgs = vec![
            ControlMessage::Hello(Hello {
                version: 1,
                token: "t".into(),
                client_id: "c".into(),
                kind: ClientKind::Control,
            }),
            ControlMessage::HelloAck(HelloAck::ok()),
            ControlMessage::Request(RpcRequest {
                id: 1,
                method: "listSessions".into(),
                params: serde_json::Value::Null,
            }),
            ControlMessage::Reply(RpcReply::ok(1, serde_json::json!([]))),
            ControlMessage::Notify(Notify {
                method: "resize".into(),
                params: serde_json::json!({ "cols": 100, "rows": 30 }),
            }),
        ];
        for m in msgs {
            let line = encode_ndjson_line(&m).unwrap();
            let back: ControlMessage = decode_ndjson_line(&line).unwrap();
            assert_eq!(back, m);
        }
    }

    #[test]
    fn agent_hello_round_trips_as_role_agent() {
        // The agent role is ADDITIVE at protocol version 1 (no bump — a bump would
        // orphan every running shell). It must serialize as the plain "agent" role.
        let hello = Hello {
            version: GROVE_DAEMON_PROTOCOL_VERSION,
            token: derive_session_key("daemon-tok", "grove-ab12-p1"),
            client_id: "agent".into(),
            kind: ClientKind::Agent,
        };
        let line = encode_ndjson_line(&hello).unwrap();
        assert!(line.contains("\"role\":\"agent\""));
        assert_eq!(decode_ndjson_line::<Hello>(&line).unwrap(), hello);
    }

    #[test]
    fn an_old_daemon_cannot_parse_the_agent_role() {
        // The degrade-gracefully contract, pinned. An ALREADY-RUNNING older daemon
        // (adopted by the supervisor across an app update) has a ClientKind with only
        // Control|Stream. Its `Hello` decode MUST fail on role:"agent" — that is what
        // makes it answer HelloAck{ok:false} instead of misrouting the connection.
        // `grove-agent` sees the rejection, gives up silently, and execs the agent.
        #[derive(Debug, Deserialize)]
        #[serde(rename_all = "camelCase")]
        enum LegacyClientKind {
            #[allow(dead_code)]
            Control,
            #[allow(dead_code)]
            Stream,
        }
        #[derive(Debug, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct LegacyHello {
            #[allow(dead_code)]
            version: u32,
            #[serde(rename = "role")]
            #[allow(dead_code)]
            kind: LegacyClientKind,
        }
        let line = encode_ndjson_line(&Hello {
            version: GROVE_DAEMON_PROTOCOL_VERSION,
            token: "k".into(),
            client_id: "agent".into(),
            kind: ClientKind::Agent,
        })
        .unwrap();
        assert!(
            decode_ndjson_line::<LegacyHello>(&line).is_err(),
            "an old daemon must REJECT role:\"agent\", not silently accept it"
        );
        // …while the control/stream roles it does know keep decoding unchanged, so
        // adding the variant breaks no existing client.
        for kind in [ClientKind::Control, ClientKind::Stream] {
            let line = encode_ndjson_line(&Hello {
                version: GROVE_DAEMON_PROTOCOL_VERSION,
                token: "k".into(),
                client_id: "c".into(),
                kind,
            })
            .unwrap();
            assert!(decode_ndjson_line::<LegacyHello>(&line).is_ok());
        }
    }

    #[test]
    fn derive_session_key_is_stable_scoped_and_32_hex() {
        let key = derive_session_key("daemon-tok", "grove-ab12-p1");
        assert_eq!(key.len(), 32, "32 hex chars");
        assert!(key.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
        // Stable: the daemon recomputes it on every call to authorize; a drift here
        // would silently kill every badge.
        assert_eq!(key, derive_session_key("daemon-tok", "grove-ab12-p1"));
        // Scoped to ONE session (pane A cannot compute pane B's key)…
        assert_ne!(key, derive_session_key("daemon-tok", "grove-ab12-p2"));
        // …and to ONE daemon token (a key from a previous daemon is worthless).
        assert_ne!(key, derive_session_key("other-tok", "grove-ab12-p1"));
        // And it is NOT the token: leaking it yields no daemon token (preimage).
        assert_ne!(key, "daemon-tok");
    }

    #[test]
    fn claim_ids_are_unguessable_and_unique() {
        let a = new_claim_id();
        let b = new_claim_id();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "a claim id is a capability — it must not repeat");
    }

    #[test]
    fn agent_claim_and_event_round_trip_over_the_rpc_envelope() {
        // The agent channel rides the EXISTING RpcRequest/RpcReply envelope, so it
        // inherits correlation, the 16MB line cap, and NDJSON framing for free.
        let claim = AgentClaimParams {
            session_id: "grove-ab12-p1".into(),
            tool: "claude".into(),
        };
        let req = RpcRequest {
            id: 1,
            method: METHOD_AGENT_CLAIM.into(),
            params: serde_json::to_value(&claim).unwrap(),
        };
        let line = encode_ndjson_line(&ControlMessage::Request(req.clone())).unwrap();
        assert!(line.contains("\"sessionId\":\"grove-ab12-p1\""));
        let back: ControlMessage = decode_ndjson_line(&line).unwrap();
        assert_eq!(back, ControlMessage::Request(req));

        let ack = AgentClaimResult {
            claim_id: "a".repeat(32),
        };
        let reply = RpcReply::ok(1, serde_json::to_value(&ack).unwrap());
        let line = encode_ndjson_line(&reply).unwrap();
        assert!(line.contains("\"claimId\""));
        let back: RpcReply = decode_ndjson_line(&line).unwrap();
        let ack_back: AgentClaimResult =
            serde_json::from_value(back.result.unwrap()).expect("claim result decodes");
        assert_eq!(ack_back, ack);

        let event = AgentEventParams {
            session_id: "grove-ab12-p1".into(),
            claim_id: "a".repeat(32),
            event: "PermissionRequest".into(),
            tool_name: Some("Bash".into()),
            at_ns: 19_384_712_345_678,
        };
        let line = encode_ndjson_line(&event).unwrap();
        assert!(line.contains("\"toolName\":\"Bash\""));
        assert!(line.contains("\"atNs\":19384712345678"));
        assert_eq!(decode_ndjson_line::<AgentEventParams>(&line).unwrap(), event);

        // toolName is absent for non-tool events (Stop, SessionStart, …).
        let stop = AgentEventParams {
            session_id: "grove-ab12-p1".into(),
            claim_id: "a".repeat(32),
            event: "Stop".into(),
            tool_name: None,
            at_ns: 2,
        };
        let line = encode_ndjson_line(&stop).unwrap();
        assert!(!line.contains("toolName"), "absent, not null: {line}");
        assert_eq!(decode_ndjson_line::<AgentEventParams>(&line).unwrap(), stop);
    }

    #[test]
    fn line_too_long_is_rejected() {
        let big = "x".repeat(MAX_CONTROL_LINE_BYTES + 1);
        let err = decode_ndjson_line::<Notify>(&big).unwrap_err();
        assert!(matches!(err, ProtocolError::LineTooLong { .. }));
    }

    #[test]
    fn pid_file_round_trips() {
        let pid = DaemonPidFile {
            pid: 4321,
            started_at_ms: Some(1_700_000_000_000),
            bin_path: Some("/apps/grove/daemon-bin-v1".into()),
            app_version: Some("0.9.0".into()),
        };
        let s = serialize_pid_file(&pid);
        assert_eq!(parse_pid_file(&s), Some(pid));
    }

    #[test]
    fn pid_file_tolerates_null_start_time_and_missing_optionals() {
        // orca shape: startedAtMs null, no appVersion/binPath.
        let json = r#"{"pid":100,"startedAtMs":null}"#;
        let parsed = parse_pid_file(json).unwrap();
        assert_eq!(parsed.pid, 100);
        assert_eq!(parsed.started_at_ms, None);
        assert_eq!(parsed.bin_path, None);
        assert_eq!(parsed.app_version, None);
    }

    #[test]
    fn pid_file_ignores_unknown_fields() {
        let json = r#"{"pid":5,"startedAtMs":1,"entryPath":"/x","future":true}"#;
        let parsed = parse_pid_file(json).unwrap();
        assert_eq!(parsed.pid, 5);
        assert_eq!(parsed.started_at_ms, Some(1));
    }

    #[test]
    fn pid_file_parse_is_tolerant_of_garbage() {
        assert_eq!(parse_pid_file(""), None);
        assert_eq!(parse_pid_file("not json"), None);
        assert_eq!(parse_pid_file("{ \"pid\": }"), None);
        // Missing required `pid` → None (not a partial struct).
        assert_eq!(parse_pid_file(r#"{"startedAtMs":1}"#), None);
    }
}
