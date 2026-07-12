//! The in-process daemon client (design P3 + §2.4 P5–P8 + P16).
//!
//! `DaemonClient` is the async core that slots UNDER `pty.rs`'s pub fns: it owns
//! the two sockets to the daemon (an NDJSON control channel and a binary GCKL
//! stream channel), correlates RPCs by id, routes stream frames to per-session
//! subscribers, and survives a daemon respawn with a generation-guarded,
//! connect-coalesced reconnect that resyncs session state.
//!
//! `ClientHandle` is the blocking bridge: it owns a dedicated tokio runtime so a
//! SYNC grove-core caller (and, later, the NAPI addon) can call the async client
//! WITHOUT ever `block_on`-ing a caller-owned runtime — it refuses (rather than
//! panics) when an ambient runtime is detected (design G1 / R12).
//!
//! Channel discipline (design invariant #9): control carries JSON (RPC/notify);
//! the stream carries raw `Data`/`Exit`/`Resize` binary frames. Raw PTY bytes
//! never traverse a JSON encoder.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, oneshot};

use super::framing::{ExitStatus, SeqTracker, StreamDecoder, StreamFrame, StreamFrameKind};
use super::protocol::{
    decode_ndjson_line, encode_ndjson_line, ClientKind, ControlMessage, Hello, HelloAck, Notify,
    RpcError, RpcRequest, GROVE_DAEMON_PROTOCOL_VERSION,
};

/// Default per-request RPC deadline (design P5). Overridable per call.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Connect + hello handshake deadline (design P2): a stale daemon can accept a
/// socket but never answer hello — without this, `ensure_connected` waits forever.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Everything that can go wrong talking to the daemon.
#[derive(Debug)]
pub enum ClientError {
    /// No live connection and (for notifies) no reconnect was attempted.
    NotConnected,
    /// The socket died with the request in flight — the RPC is rejected rather
    /// than left to hang (design P7).
    ConnectionLost,
    /// The per-request deadline elapsed with no reply (design P5).
    Timeout { method: String, ms: u64 },
    /// The daemon replied with a structured error.
    Rpc(RpcError),
    /// A malformed wire message / hello rejection / stream desync.
    Protocol(String),
    /// Socket / filesystem I/O (connect refused, token unreadable, …).
    Io(std::io::Error),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::NotConnected => write!(f, "daemon client: not connected"),
            ClientError::ConnectionLost => write!(f, "daemon client: connection lost"),
            ClientError::Timeout { method, ms } => {
                write!(f, "daemon client: {method} timed out after {ms}ms")
            }
            ClientError::Rpc(e) => write!(f, "daemon rpc error {}: {}", e.code, e.message),
            ClientError::Protocol(m) => write!(f, "daemon client protocol: {m}"),
            ClientError::Io(e) => write!(f, "daemon client io: {e}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<std::io::Error> for ClientError {
    fn from(e: std::io::Error) -> Self {
        ClientError::Io(e)
    }
}

// ---------------------------------------------------------------------------
// Stream subscribers (design P3 stream row)
// ---------------------------------------------------------------------------

/// Sink for one session's live stream events. The client decodes GCKL frames off
/// the stream socket and fans them out to the subscriber registered for that
/// session id. This is the seam `NapiEventSink`/`TauriEventSink` bind onto (G1);
/// callbacks run on the client's stream-reader task and must not block.
pub trait StreamSubscriber: Send + Sync {
    /// A batch of raw PTY output. `seq` is the session's absolute BYTE sequence
    /// (design S3/OVERLAY 2.5). Never valid-UTF-8-guaranteed.
    fn on_data(&self, seq: u64, data: &[u8]);
    /// The session's child exited. Delivered AFTER the final `on_data` (P13), or
    /// synthesized on reconnect for a session that died while disconnected (P8).
    fn on_exit(&self, status: ExitStatus);
    /// A resize acknowledged by the daemon emulator (design P15/G8). Default no-op.
    fn on_resize(&self, _cols: u16, _rows: u16) {}
}

// ---------------------------------------------------------------------------
// Sticky cold-restore cache (design P16 / R11)
// ---------------------------------------------------------------------------

/// The payload a cold restore seeds into the renderer. A scaffold today: P5–P8
/// fill the real fields (VT snapshot, modes, kitty flags). Extra daemon-sent
/// fields default so the shape can grow without a protocol bump on this side.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColdRestorePayload {
    #[serde(default)]
    pub snapshot: String,
    #[serde(default)]
    pub cols: u16,
    #[serde(default)]
    pub rows: u16,
    #[serde(default)]
    pub is_alternate_screen: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_escape_tail_ansi: Option<String>,
}

impl ColdRestorePayload {
    /// Best-effort parse from a `createOrAttach` result object; unknown/absent
    /// fields default (the daemon does not yet emit these — P5–P8).
    fn from_result(result: &Value) -> Self {
        serde_json::from_value(result.clone()).unwrap_or_default()
    }
}

/// Upper bound on retained cold-restore payloads (design P16 / FIX 3). A payload
/// is deliberately NOT evicted when its session dies (a cold-restore seed
/// describes a dead session by definition), so the cache is instead bounded by
/// insertion order: the oldest entry is dropped once this many are retained. 64
/// comfortably exceeds any realistic count of concurrently-restoring panes while
/// capping worst-case memory if acks are somehow never delivered.
const COLD_CACHE_MAX_ENTRIES: usize = 64;

/// Insertion-ordered inner state of [`ColdRestoreCache`]. `order` mirrors the
/// keys of `entries` in insertion order (each key appears at most once) so the
/// bound can evict the oldest without a full scan.
#[derive(Default)]
struct ColdCacheInner {
    entries: HashMap<String, ColdRestorePayload>,
    order: VecDeque<String>,
}

impl ColdCacheInner {
    /// Drop a key from both the map and the order index (keeps the bound exact).
    fn remove(&mut self, id: &str) {
        if self.entries.remove(id).is_some() {
            self.order.retain(|k| k != id);
        }
    }
}

/// Per-session sticky cache of the cold-restore payload (design P16). A payload
/// is retained after it is first returned so a second `createOrAttach` (React
/// StrictMode double-mount, or a reconnect before the fresh session writes its
/// own checkpoint) re-yields the SAME payload instead of losing it. Cleared only
/// on an explicit `ack_cold_restore` or the session's first fresh output — never
/// on session Exit (see the Why in `dispatch_frame`), so the cache is bounded by
/// insertion order instead (design P16 / FIX 3).
#[derive(Default)]
pub struct ColdRestoreCache {
    inner: Mutex<ColdCacheInner>,
}

impl ColdRestoreCache {
    /// Retain (or replace) the sticky payload for `id`, evicting the oldest entry
    /// if the insertion-order bound is exceeded (design P16 / FIX 3).
    pub fn set(&self, id: String, payload: ColdRestorePayload) {
        let mut inner = lock(&self.inner);
        if inner.entries.insert(id.clone(), payload).is_none() {
            // A genuinely new key: track its order and enforce the bound. A
            // re-set of an existing key updates in place without reordering.
            inner.order.push_back(id);
            while inner.order.len() > COLD_CACHE_MAX_ENTRIES {
                if let Some(oldest) = inner.order.pop_front() {
                    inner.entries.remove(&oldest);
                }
            }
        }
    }

    /// The sticky payload for `id`, if one is retained. Non-consuming — repeated
    /// reads return the same payload until it is cleared (the R11 guarantee).
    pub fn get(&self, id: &str) -> Option<ColdRestorePayload> {
        lock(&self.inner).entries.get(id).cloned()
    }

    /// Clear on the renderer's explicit ack (design P6 `ack_cold_restore`).
    pub fn ack(&self, id: &str) {
        lock(&self.inner).remove(id);
    }

    /// Clear on the session's first fresh output — the disk seed is now stale
    /// relative to live state (design P16). Idempotent.
    pub fn on_fresh_data(&self, id: &str) {
        lock(&self.inner).remove(id);
    }

    /// Is a payload currently retained for `id`? (diagnostics/tests)
    pub fn contains(&self, id: &str) -> bool {
        lock(&self.inner).entries.contains_key(id)
    }

    /// How many payloads are currently retained (diagnostics/tests).
    pub fn len(&self) -> usize {
        lock(&self.inner).entries.len()
    }

    /// Whether the cache is empty (diagnostics/tests).
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

// ---------------------------------------------------------------------------
// Public request/response shapes
// ---------------------------------------------------------------------------

/// A `createOrAttach` request (design P9). `cwd`/geometry/env seed a fresh PTY;
/// on adopt the daemon ignores them and returns the live session.
#[derive(Debug, Clone, Default)]
pub struct CreateOrAttach {
    pub session_id: String,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub env: Vec<(String, String)>,
    /// Per-session scrollback ring cap in bytes (design D10/§8.X), sourced from
    /// `GrovePreferences::daemon_scrollback_bytes`. `None` leaves the daemon on its
    /// built-in default. Ignored by the daemon on a warm adopt (the live session
    /// keeps the cap it was spawned with).
    pub scrollback_bytes: Option<u64>,
}

/// The warm-reattach payload the daemon returns when `createOrAttach` adopts a
/// LIVE session (design P9/S15): the current VT snapshot plus the dims/modes the
/// renderer needs to rehydrate the screen exactly. `snapshot` is the daemon's
/// pre-concatenated `scrollback ++ rehydrate ++ body` string. Every field past the
/// core five is optional so a minimal or degraded reply still parses;
/// `emulator_degraded` defaults false — only the poisoned-emulator branch sets it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WarmReattach {
    pub snapshot: String,
    pub cols: u16,
    pub rows: u16,
    pub is_alternate_screen: bool,
    pub output_sequence: u64,
    pub pending_escape_tail_ansi: Option<String>,
    /// The daemon emits this as `snapshotKittyKeyboardFlags` (not the camelCase of
    /// the field name), so it is renamed explicitly.
    #[serde(rename = "snapshotKittyKeyboardFlags")]
    pub kitty_keyboard_flags: Option<u32>,
    pub cwd: Option<String>,
    pub last_title: Option<String>,
    pub emulator_degraded: bool,
}

impl WarmReattach {
    /// Parse a warm-reattach payload from a `createOrAttach` reply, gated on the
    /// daemon's `isReattach: true` marker. Returns `None` for a fresh-spawn reply
    /// (no marker); tolerates missing optional fields on a live/degraded reply.
    fn from_result(result: &Value) -> Option<Self> {
        let is_reattach = result
            .get("isReattach")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !is_reattach {
            return None;
        }
        serde_json::from_value(result.clone()).ok()
    }
}

/// The resolved `createOrAttach` outcome. `is_cold_restore` + `cold_restore` are
/// the P16 cold-seed surface; `warm_reattach` is `Some` iff the daemon adopted a
/// LIVE session (reply `isReattach: true`) and carries its warm VT snapshot (P9).
#[derive(Debug, Clone)]
pub struct CreateOrAttachResult {
    pub is_new: bool,
    pub is_cold_restore: bool,
    pub cold_restore: Option<ColdRestorePayload>,
    pub warm_reattach: Option<WarmReattach>,
}

/// One entry of `listSessions` (design L3 adoption / P8 resync).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub is_alive: bool,
    #[serde(default)]
    pub cols: u16,
    #[serde(default)]
    pub rows: u16,
    /// The session's child-shell pid — the daemon replacement for tmux's `#{pane_pid}`.
    /// Used by terminal GC (the leftover-process sweep after a session kill). It is NOT a
    /// status input: the process-tree walk that once inferred a running agent from it
    /// phantom-badged on `vim /tmp/codex` and is deleted. `default` so an older daemon
    /// that does not send it degrades to "no pid", exactly as a missing tmux pane pid did.
    #[serde(default)]
    pub pid: Option<u32>,
}

// ---------------------------------------------------------------------------
// DaemonClient
// ---------------------------------------------------------------------------

/// Options to construct a [`DaemonClient`].
#[derive(Debug, Clone)]
pub struct DaemonClientOptions {
    pub socket_path: PathBuf,
    pub token_path: PathBuf,
    pub version: u32,
    pub request_timeout: Duration,
    pub client_id: String,
}

impl DaemonClientOptions {
    /// Defaults: current protocol version, 30s timeout, a random client id.
    pub fn new(socket_path: PathBuf, token_path: PathBuf) -> Self {
        Self {
            socket_path,
            token_path,
            version: GROVE_DAEMON_PROTOCOL_VERSION,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            client_id: uuid::Uuid::new_v4().to_string(),
        }
    }
}

/// A pending in-flight RPC awaiting its correlated reply.
struct Pending {
    tx: oneshot::Sender<Result<Value, ClientError>>,
    /// The connection generation this request belongs to. On disconnect the
    /// matching generation's pending are rejected (design P7).
    generation: u64,
}

/// Mutable connection state. A std mutex with only non-awaiting critical sections.
#[derive(Default)]
struct ConnState {
    connected: bool,
    /// Outbound control-channel queue drained by the per-connection writer task.
    /// `None` while disconnected. Sending here never blocks the caller.
    control_tx: Option<mpsc::UnboundedSender<Vec<u8>>>,
}

struct Shared {
    socket_path: PathBuf,
    token_path: PathBuf,
    version: u32,
    client_id: String,
    request_timeout: Duration,

    state: Mutex<ConnState>,
    /// Coalesces concurrent connects: exactly one `do_connect` runs; the losers
    /// wait, then observe `connected == true` and return (design P7).
    connect_lock: tokio::sync::Mutex<()>,
    /// Monotonic connection generation. A reconnect increments it; a stale reader
    /// task's disconnect for an older generation is ignored (design P7).
    generation: AtomicU64,

    pending: Mutex<HashMap<u64, Pending>>,
    request_counter: AtomicU64,

    subscribers: Mutex<HashMap<String, Arc<dyn StreamSubscriber>>>,
    cold_cache: ColdRestoreCache,
    seq: Mutex<HashMap<String, SeqTracker>>,
    /// Sessions the client believes are alive (created/attached/seen live). On
    /// reconnect, any believed-alive session absent from `listSessions` died
    /// while disconnected → synthesize its `Exit` (design P8).
    known_alive: Mutex<HashSet<String>>,
    /// Sessions the client has paused and not yet resumed (design P11). On a socket
    /// disconnect these move into `producer_resumes_owed`; an exited session leaves
    /// this set (via `dispatch_frame`/`resync`).
    producer_paused: Mutex<HashSet<String>>,
    /// Producer resumes OWED across a reconnect (design P11): sessions that were
    /// paused when the socket dropped. On the next fresh connect the client re-sends
    /// `resumePty` for each so a reconnect never leaves a reader parked. An exited
    /// session leaves this set.
    producer_resumes_owed: Mutex<HashSet<String>>,
    /// Sessions marked sleep-restorable by the caller for Tier-C wake (design L12,
    /// orca `sleepRestoreSessionIds`). Purely client-side bookkeeping the host
    /// populates around `checkpoint_all` on suspend and consults on resume; the
    /// client never mutates it except through the public accessors.
    sleep_restore_session_ids: Mutex<HashSet<String>>,
}

/// The async daemon client. Cheap to clone (`Arc` inside); every clone shares one
/// connection, one pending map, and one subscriber table.
#[derive(Clone)]
pub struct DaemonClient {
    shared: Arc<Shared>,
}

impl DaemonClient {
    pub fn new(opts: DaemonClientOptions) -> Self {
        Self {
            shared: Arc::new(Shared {
                socket_path: opts.socket_path,
                token_path: opts.token_path,
                version: opts.version,
                client_id: opts.client_id,
                request_timeout: opts.request_timeout,
                state: Mutex::new(ConnState::default()),
                connect_lock: tokio::sync::Mutex::new(()),
                generation: AtomicU64::new(0),
                pending: Mutex::new(HashMap::new()),
                request_counter: AtomicU64::new(0),
                subscribers: Mutex::new(HashMap::new()),
                cold_cache: ColdRestoreCache::default(),
                seq: Mutex::new(HashMap::new()),
                known_alive: Mutex::new(HashSet::new()),
                producer_paused: Mutex::new(HashSet::new()),
                producer_resumes_owed: Mutex::new(HashSet::new()),
                sleep_restore_session_ids: Mutex::new(HashSet::new()),
            }),
        }
    }

    /// Is there a live connection right now? (Reconnect is lazy on the next op.)
    pub fn is_connected(&self) -> bool {
        lock(&self.shared.state).connected
    }

    /// Access the sticky cold-restore cache (design P16).
    pub fn cold_restore_cache(&self) -> &ColdRestoreCache {
        &self.shared.cold_cache
    }

    /// Register (or replace) the stream subscriber for a session id. Subscriptions
    /// persist across reconnects, so a reattached session keeps streaming (P8).
    pub fn subscribe(&self, session_id: impl Into<String>, subscriber: Arc<dyn StreamSubscriber>) {
        lock(&self.shared.subscribers).insert(session_id.into(), subscriber);
    }

    /// Drop a session's subscriber.
    pub fn unsubscribe(&self, session_id: &str) {
        lock(&self.shared.subscribers).remove(session_id);
    }

    // -- connection lifecycle ----------------------------------------------

    /// Ensure a live control+stream connection, coalescing concurrent callers and
    /// resyncing session state on a fresh connect (design P7/P8).
    pub async fn ensure_connected(&self) -> Result<(), ClientError> {
        if lock(&self.shared.state).connected {
            return Ok(());
        }
        // Coalesce: the first caller connects; the rest wait then re-check.
        let _guard = self.shared.connect_lock.lock().await;
        if lock(&self.shared.state).connected {
            return Ok(());
        }
        self.do_connect().await?;
        // do_connect flipped `connected = true`, so the resync RPCs below reuse
        // this connection instead of recursing into another connect.
        self.resync().await;
        Ok(())
    }

    async fn do_connect(&self) -> Result<(), ClientError> {
        let token = tokio::fs::read_to_string(&self.shared.token_path)
            .await?
            .trim()
            .to_string();

        // Control socket: send hello, await ack.
        let control = UnixStream::connect(&self.shared.socket_path).await?;
        let (cr, mut cw) = control.into_split();
        let mut cr = BufReader::new(cr);
        self.send_hello(&mut cw, ClientKind::Control, &token).await?;
        read_hello_ack(&mut cr).await?;

        // Stream socket: send hello, await ack. The write half is kept alive for
        // the connection's life (dropping it would EOF the daemon's stream reader
        // and evict our subscription).
        let stream = UnixStream::connect(&self.shared.socket_path).await?;
        let (sr, mut sw) = stream.into_split();
        let mut sr = BufReader::new(sr);
        self.send_hello(&mut sw, ClientKind::Stream, &token).await?;
        read_hello_ack(&mut sr).await?;

        let generation = self.shared.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (ctx, crx) = mpsc::unbounded_channel::<Vec<u8>>();
        {
            let mut st = lock(&self.shared.state);
            st.connected = true;
            st.control_tx = Some(ctx);
        }

        // Control writer: drains the outbound queue to the socket.
        tokio::spawn(control_writer(crx, cw));
        // Control reader: routes replies to the pending map; on EOF, disconnects.
        {
            let shared = Arc::clone(&self.shared);
            tokio::spawn(control_reader(shared, cr, generation));
        }
        // Stream reader: decodes GCKL frames to subscribers; holds `sw` so the
        // stream connection's write direction stays open for the reader's life
        // (dropping it would EOF the daemon's stream reader and evict our
        // subscription). On EOF/desync, it disconnects.
        {
            let shared = Arc::clone(&self.shared);
            tokio::spawn(async move {
                // Held to end of scope — i.e. until after the reader returns.
                let _stream_write = sw;
                stream_reader(Arc::clone(&shared), sr, generation).await;
            });
        }
        Ok(())
    }

    async fn send_hello(
        &self,
        w: &mut OwnedWriteHalf,
        kind: ClientKind,
        token: &str,
    ) -> Result<(), ClientError> {
        let hello = Hello {
            version: self.shared.version,
            token: token.to_string(),
            client_id: self.shared.client_id.clone(),
            kind,
        };
        let line =
            encode_ndjson_line(&hello).map_err(|e| ClientError::Protocol(e.to_string()))?;
        w.write_all(line.as_bytes()).await?;
        w.flush().await?;
        Ok(())
    }

    /// Fresh-connect resync (design P8): pull the live session list, synthesize
    /// `Exit` for any believed-alive session that died while disconnected, and
    /// refresh the believed-alive set. Best-effort — a failed list leaves state.
    async fn resync(&self) {
        let live: HashSet<String> = match self.list_sessions_raw().await {
            Ok(sessions) => sessions.into_iter().map(|s| s.session_id).collect(),
            Err(_) => return,
        };

        // Sessions we thought were alive but the fresh daemon no longer has →
        // they died in the gap; re-deliver their Exit exactly once (P8).
        let gone: Vec<String> = {
            let known = lock(&self.shared.known_alive);
            known.iter().filter(|id| !live.contains(*id)).cloned().collect()
        };
        for id in gone {
            // FIX 2: the `known_alive` removal is the atomic claim — only the
            // remover delivers the synthetic Exit. A stream `Exit` frame for the
            // same session racing this resync claims the identical way (see
            // `dispatch_frame`), so exactly ONE `on_exit` is delivered per session.
            if !lock(&self.shared.known_alive).remove(&id) {
                continue;
            }
            // FIX 3: prune per-session bookkeeping now the session is dead — the
            // seq tracker is meaningless past Exit and would otherwise leak one
            // entry per session that ever died while disconnected.
            lock(&self.shared.seq).remove(&id);
            // P11: an exited session leaves both producer sets, so we never send a
            // stray resume for a session that died in the disconnected gap.
            lock(&self.shared.producer_paused).remove(&id);
            lock(&self.shared.producer_resumes_owed).remove(&id);
            let sub = lock(&self.shared.subscribers).get(&id).cloned();
            if let Some(sub) = sub {
                sub.on_exit(ExitStatus { code: None, signal: None });
            }
        }

        {
            let mut known = lock(&self.shared.known_alive);
            for id in live {
                known.insert(id);
            }
        }

        // Flush owed producer resumes (design P11): every session paused when the
        // socket dropped gets a fresh `resumePty` on this new connection, so a
        // reconnect can never leave a reader parked. Dead sessions were already
        // pruned above, so only live ones remain here. Sent on the CURRENT
        // connection (send_notify_raw — no re-entrant ensure_connected). We clear
        // both sets: the session is no longer paused after the resume lands.
        let owed: Vec<String> = {
            let mut owed = lock(&self.shared.producer_resumes_owed);
            owed.drain().collect()
        };
        for id in owed {
            let _ = self.send_notify_raw("resumePty", json!({ "sessionId": id }));
            lock(&self.shared.producer_paused).remove(&id);
        }
    }

    // -- RPC / notify -------------------------------------------------------

    /// A correlated RPC with the default timeout.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, ClientError> {
        self.request_with_timeout(method, params, self.shared.request_timeout)
            .await
    }

    /// A correlated RPC with a per-call timeout override (design P5).
    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, ClientError> {
        self.ensure_connected().await?;
        self.request_raw(method, params, timeout).await
    }

    /// Send an RPC on the CURRENT connection without triggering a connect. Used by
    /// `resync` (already inside `ensure_connected`) to avoid re-entrancy.
    async fn request_raw(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, ClientError> {
        let id = self.shared.request_counter.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();

        let msg = ControlMessage::Request(RpcRequest {
            id,
            method: method.to_string(),
            params,
        });
        let line =
            encode_ndjson_line(&msg).map_err(|e| ClientError::Protocol(e.to_string()))?;

        // FIX 1: stamp the Pending with the generation observed ATOMICALLY at the
        // send point. The generation and the control sender are read under ONE
        // state-lock section, and the Pending is inserted before that lock is
        // released. `handle_disconnect` takes the state lock before it drains the
        // pending map, so this insert is serialized against it: either the
        // disconnect ran fully first (and we observe `control_tx == None` here and
        // bail), or it runs after (and finds — then rejects — our Pending, stamped
        // with the SAME generation it is tearing down). A fast reconnect can no
        // longer leave this RPC in flight on a live socket while stamped with a
        // dead generation that `handle_disconnect` would skip.
        {
            let st = lock(&self.shared.state);
            let control_tx = match st.control_tx.as_ref() {
                Some(tx) => tx.clone(),
                None => return Err(ClientError::NotConnected),
            };
            let generation = self.shared.generation.load(Ordering::SeqCst);
            lock(&self.shared.pending).insert(id, Pending { tx, generation });
            if control_tx.send(line.into_bytes()).is_err() {
                lock(&self.shared.pending).remove(&id);
                return Err(ClientError::NotConnected);
            }
        }

        match tokio::time::timeout(timeout, rx).await {
            // Reply routed by the control reader.
            Ok(Ok(result)) => result,
            // oneshot dropped without a value — should not happen (disconnect
            // sends ConnectionLost), but treat as a lost connection.
            Ok(Err(_)) => Err(ClientError::ConnectionLost),
            // Deadline elapsed: reclaim the pending slot so a late reply is dropped.
            Err(_) => {
                lock(&self.shared.pending).remove(&id);
                Err(ClientError::Timeout {
                    method: method.to_string(),
                    ms: timeout.as_millis() as u64,
                })
            }
        }
    }

    /// A fire-and-forget notify (design P6). Ensures a connection first so a
    /// keystroke right after a respawn still lands, then sends without awaiting
    /// an ack. A drop while disconnected is tolerated by per-mechanism failsafes.
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), ClientError> {
        self.ensure_connected().await?;
        let msg = ControlMessage::Notify(Notify {
            method: method.to_string(),
            params,
        });
        let line =
            encode_ndjson_line(&msg).map_err(|e| ClientError::Protocol(e.to_string()))?;
        self.send_control(line.into_bytes())
    }

    fn send_control(&self, bytes: Vec<u8>) -> Result<(), ClientError> {
        let st = lock(&self.shared.state);
        match st.control_tx.as_ref() {
            Some(tx) => tx.send(bytes).map_err(|_| ClientError::NotConnected),
            None => Err(ClientError::NotConnected),
        }
    }

    /// Encode + send a notify on the CURRENT connection WITHOUT `ensure_connected`
    /// (design P8). Used by `resync`, which already runs inside `ensure_connected`
    /// on a freshly-established connection — calling the public `notify` there would
    /// re-enter connection setup.
    fn send_notify_raw(&self, method: &str, params: Value) -> Result<(), ClientError> {
        let msg = ControlMessage::Notify(Notify {
            method: method.to_string(),
            params,
        });
        let line =
            encode_ndjson_line(&msg).map_err(|e| ClientError::Protocol(e.to_string()))?;
        self.send_control(line.into_bytes())
    }

    // -- typed operations ---------------------------------------------------

    /// `createOrAttach` (design P9) with sticky cold-restore handling (P16). A
    /// retained cold-restore payload short-circuits and is re-yielded so a
    /// double-mount / early reconnect never loses it.
    pub async fn create_or_attach(
        &self,
        req: CreateOrAttach,
    ) -> Result<CreateOrAttachResult, ClientError> {
        if let Some(payload) = self.shared.cold_cache.get(&req.session_id) {
            return Ok(CreateOrAttachResult {
                is_new: false,
                is_cold_restore: true,
                cold_restore: Some(payload),
                warm_reattach: None,
            });
        }

        let env_obj: serde_json::Map<String, Value> = req
            .env
            .iter()
            .map(|(k, v)| (k.clone(), Value::String(v.clone())))
            .collect();
        let mut params = json!({
            "sessionId": req.session_id,
            "cwd": req.cwd.clone().unwrap_or_else(|| ".".to_string()),
            "cols": req.cols,
            "rows": req.rows,
            "env": env_obj,
        });
        if let Some(bytes) = req.scrollback_bytes {
            params["scrollbackBytes"] = json!(bytes);
        }

        let result = self.request("createOrAttach", params).await?;
        let is_new = result.get("isNew").and_then(Value::as_bool).unwrap_or(false);
        let is_cold = result
            .get("isColdRestore")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        // The session now exists in the daemon (fresh or adopted) → track it so a
        // later reconnect can synthesize its Exit if it dies in the gap (P8).
        lock(&self.shared.known_alive).insert(req.session_id.clone());

        let cold_restore = if is_cold {
            let payload = ColdRestorePayload::from_result(&result);
            self.shared.cold_cache.set(req.session_id.clone(), payload.clone());
            Some(payload)
        } else {
            None
        };

        // Warm reattach (design P9/S15): the daemon marks a live-session adopt with
        // `isReattach: true` and rides the VT snapshot beside it. Absent on a fresh
        // spawn (`isNew: true`, no marker), so `warm_reattach` stays None there.
        let warm_reattach = WarmReattach::from_result(&result);

        Ok(CreateOrAttachResult {
            is_new,
            is_cold_restore: is_cold,
            cold_restore,
            warm_reattach,
        })
    }

    /// The daemon's live session list (design L3/P8).
    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>, ClientError> {
        self.ensure_connected().await?;
        self.list_sessions_raw().await
    }

    async fn list_sessions_raw(&self) -> Result<Vec<SessionInfo>, ClientError> {
        let result = self
            .request_raw("listSessions", Value::Null, self.shared.request_timeout)
            .await?;
        serde_json::from_value(result).map_err(|e| ClientError::Protocol(e.to_string()))
    }

    /// The daemon emulator's applied size (design G8/P15) — replaces the tmux
    /// `applied_pty_size` shell-out.
    pub async fn applied_size(&self, session_id: &str) -> Result<(u16, u16), ClientError> {
        let result = self
            .request("getAppliedSize", json!({ "sessionId": session_id }))
            .await?;
        let cols = result.get("cols").and_then(Value::as_u64).unwrap_or(0) as u16;
        let rows = result.get("rows").and_then(Value::as_u64).unwrap_or(0) as u16;
        Ok((cols, rows))
    }

    /// The session's OSC7-tracked cwd (design S11/P15/G8) — replaces the tmux cwd
    /// shell-out. Served from the emulator's ModeState without composing a full
    /// snapshot; `None` when the shell has emitted no OSC 7 yet.
    pub async fn cwd(&self, session_id: &str) -> Result<Option<String>, ClientError> {
        let result = self.request("getCwd", json!({ "sessionId": session_id })).await?;
        Ok(result
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    /// Clear a session's scrollback history (design item 4) — the daemon-native
    /// replacement for the tmux `clear-history` shell-out `pty::clear_scrollback`
    /// used to run. Drops the daemon's byte-exact ring + emulator scrollback and logs
    /// a Clear frame. RPC: awaits the daemon ack so the caller can then clear its own
    /// local mirror in order.
    pub async fn clear_history(&self, session_id: &str) -> Result<(), ClientError> {
        self.request("clearHistory", json!({ "sessionId": session_id }))
            .await?;
        Ok(())
    }

    /// Poll pending bell + current agent status, one row per live session (design G9).
    ///
    /// Each session's bell is DRAINED daemon-side on this read. `ai_status` is DERIVED
    /// daemon-side, right now, from (the agent's own hook events × the live kernel) — the
    /// app is not a writer of status and has no `setAiStatus` to call: ONE writer, ONE
    /// owner. The frontend `PtyBellEvent` contract is unchanged.
    pub async fn poll_bells(&self) -> Result<Vec<crate::PtyBellEvent>, ClientError> {
        let result = self.request("pollBells", Value::Null).await?;
        serde_json::from_value(result).map_err(|e| ClientError::Protocol(e.to_string()))
    }

    /// Flag a session background/foreground (design P6 `set_session_background`):
    /// pure daemon-side bookkeeping for later keep-tail thinning. Notify.
    pub async fn set_session_background(
        &self,
        session_id: &str,
        background: bool,
    ) -> Result<(), ClientError> {
        self.notify(
            "setSessionBackground",
            json!({ "sessionId": session_id, "background": background }),
        )
        .await
    }

    /// The daemon's LIVE connected-control count (design §9b) — backs daemon-mode
    /// GC's "skip if any app is connected" gate. Note the caller's own control
    /// connection is included in the count.
    pub async fn connected_clients(&self) -> Result<u64, ClientError> {
        let result = self.request("getDaemonInfo", Value::Null).await?;
        Ok(result
            .get("connectedClients")
            .and_then(Value::as_u64)
            .unwrap_or(0))
    }

    /// Kill a session's child (design L8/S14 semantics live daemon-side).
    pub async fn kill(&self, session_id: &str) -> Result<(), ClientError> {
        self.request("kill", json!({ "sessionId": session_id })).await?;
        Ok(())
    }

    /// A trivial PTY spawn+reap health probe (design L3 adoption gate).
    pub async fn check_pty_spawn_health(&self) -> Result<bool, ClientError> {
        let result = self.request("checkPtySpawnHealth", Value::Null).await?;
        Ok(result.get("ok").and_then(Value::as_bool).unwrap_or(false))
    }

    /// Ask the daemon to shut down (design L8). Only the explicit "Restart daemon"
    /// action and dev teardown use this — never normal quit (that's disconnect).
    pub async fn shutdown(&self, kill_sessions: bool) -> Result<(), ClientError> {
        self.request("shutdown", json!({ "killSessions": kill_sessions }))
            .await?;
        Ok(())
    }

    /// Send input bytes (design P6 notify). Base64-framed on the JSON control
    /// channel; the daemon's per-session FIFO preserves paste-body-then-CR order.
    pub async fn write(&self, session_id: &str, data: &[u8]) -> Result<(), ClientError> {
        let b64 = base64::engine::general_purpose::STANDARD.encode(data);
        self.notify(
            "write",
            json!({ "sessionId": session_id, "dataB64": b64 }),
        )
        .await
    }

    /// Resize a session (design P6 notify).
    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), ClientError> {
        self.notify(
            "resize",
            json!({ "sessionId": session_id, "cols": cols, "rows": rows }),
        )
        .await
    }

    /// Acknowledge a cold restore (design P16): clears the local sticky cache and
    /// tells the daemon to drop any retained payload.
    pub async fn ack_cold_restore(&self, session_id: &str) -> Result<(), ClientError> {
        self.shared.cold_cache.ack(session_id);
        self.notify("ackColdRestore", json!({ "sessionId": session_id }))
            .await
    }

    /// Pause a session's PTY producer (design S14/P11 notify): the daemon parks the
    /// reader so a flooding child hits kernel backpressure. Records the session as
    /// paused so a socket drop before the matching resume queues an owed resume
    /// (`producer_resumes_owed`) that is re-sent on the next fresh connect. The
    /// paused flag is only recorded once the notify was actually queued — if the
    /// send failed the daemon never paused, so there is nothing to owe.
    pub async fn pause_pty(&self, session_id: &str) -> Result<(), ClientError> {
        self.notify("pausePty", json!({ "sessionId": session_id }))
            .await?;
        lock(&self.shared.producer_paused).insert(session_id.to_string());
        Ok(())
    }

    /// Resume a session's PTY producer (design S14/P11 notify). Clears the local
    /// paused + owed state regardless of the send outcome: the intent is now
    /// "running", and the daemon's own eager auto-resume on last-client-disconnect
    /// plus the 5s failsafe cover a dropped notify.
    pub async fn resume_pty(&self, session_id: &str) -> Result<(), ClientError> {
        let result = self
            .notify("resumePty", json!({ "sessionId": session_id }))
            .await;
        lock(&self.shared.producer_paused).remove(session_id);
        lock(&self.shared.producer_resumes_owed).remove(session_id);
        result
    }

    /// Checkpoint EVERY live session without ending them (design L12 Tier C): the
    /// daemon writes a final checkpoint per session, awaiting any in-flight tick,
    /// and does NOT stamp `ended_at` — so a child killed under power management can
    /// still cold-restore on wake. The host calls this on system suspend. Awaits
    /// the daemon reply, so on return the checkpoints are durable.
    pub async fn checkpoint_all(&self) -> Result<(), ClientError> {
        self.request("checkpointAll", Value::Null).await?;
        Ok(())
    }

    /// Mark a session sleep-restorable for the Tier-C wake path (design L12). Pure
    /// client-side bookkeeping the host populates on suspend (alongside
    /// `checkpoint_all`) and consults on resume; see orca `sleepRestoreSessionIds`.
    pub fn mark_sleep_restore(&self, session_id: &str) {
        lock(&self.shared.sleep_restore_session_ids).insert(session_id.to_string());
    }

    /// Drop a session's sleep-restore mark (design L12): the host clears it once the
    /// pane has been reattached/cold-restored on wake, or on an explicit close.
    pub fn clear_sleep_restore(&self, session_id: &str) {
        lock(&self.shared.sleep_restore_session_ids).remove(session_id);
    }

    /// Is a session currently marked sleep-restorable (design L12)?
    pub fn is_sleep_restore(&self, session_id: &str) -> bool {
        lock(&self.shared.sleep_restore_session_ids).contains(session_id)
    }

    /// Force the current connection down so the NEXT op reconnects (design P7/P11).
    /// This is exactly what a transient socket drop does — it rejects in-flight
    /// RPCs with `ConnectionLost`, tears down both sockets, and (via
    /// `handle_disconnect`) moves any paused sessions into `producer_resumes_owed`.
    /// Used to recover a wedged connection and to simulate a transient drop in
    /// tests; harmless in production (a reconnect follows on the next op).
    pub fn reset_connection(&self) {
        let generation = self.shared.generation.load(Ordering::SeqCst);
        handle_disconnect(&self.shared, generation);
    }

    /// The set of sessions with an owed producer-resume (diagnostics/tests).
    pub fn producer_resumes_owed_len(&self) -> usize {
        lock(&self.shared.producer_resumes_owed).len()
    }

    /// Is a session currently locally recorded as paused (diagnostics/tests)?
    pub fn is_producer_paused(&self, session_id: &str) -> bool {
        lock(&self.shared.producer_paused).contains(session_id)
    }
}

// ---------------------------------------------------------------------------
// Connection tasks (free fns so they own their halves and hold no client ref
// beyond an Arc<Shared>)
// ---------------------------------------------------------------------------

async fn control_writer(mut rx: mpsc::UnboundedReceiver<Vec<u8>>, mut w: OwnedWriteHalf) {
    while let Some(bytes) = rx.recv().await {
        if w.write_all(&bytes).await.is_err() || w.flush().await.is_err() {
            break;
        }
    }
}

async fn control_reader(shared: Arc<Shared>, mut r: BufReader<OwnedReadHalf>, generation: u64) {
    let mut line = String::new();
    loop {
        line.clear();
        match r.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if let Ok(ControlMessage::Reply(reply)) = decode_ndjson_line::<ControlMessage>(&line) {
            let pending = lock(&shared.pending).remove(&reply.id);
            if let Some(pending) = pending {
                let res = match reply.error {
                    Some(err) => Err(ClientError::Rpc(err)),
                    None => Ok(reply.result.unwrap_or(Value::Null)),
                };
                let _ = pending.tx.send(res);
            }
        }
        // Non-reply control messages are not expected from the daemon; ignore.
    }
    handle_disconnect(&shared, generation);
}

async fn stream_reader(shared: Arc<Shared>, mut r: BufReader<OwnedReadHalf>, generation: u64) {
    let mut dec = StreamDecoder::new();
    let mut buf = [0u8; 8192];
    'outer: loop {
        let n = match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        dec.feed(&buf[..n]);
        loop {
            match dec.next_frame() {
                Ok(Some(frame)) => dispatch_frame(&shared, frame),
                Ok(None) => break,
                // A desync is unrecoverable on a socket — tear the stream down.
                Err(_) => break 'outer,
            }
        }
    }
    handle_disconnect(&shared, generation);
}

fn dispatch_frame(shared: &Arc<Shared>, frame: StreamFrame) {
    match frame.kind {
        StreamFrameKind::Data => {
            {
                let mut seq = lock(&shared.seq);
                seq.entry(frame.session_id.clone())
                    .or_default()
                    .observe(frame.seq);
            }
            // First fresh output supersedes any retained cold-restore seed (P16).
            shared.cold_cache.on_fresh_data(&frame.session_id);
            let sub = lock(&shared.subscribers).get(&frame.session_id).cloned();
            if let Some(sub) = sub {
                sub.on_data(frame.seq, &frame.payload);
            }
        }
        StreamFrameKind::Exit => {
            let status = frame.as_exit().unwrap_or(ExitStatus {
                code: None,
                signal: None,
            });
            // FIX 2: the `known_alive` removal is the atomic claim shared with the
            // resync synthetic-Exit path (see `resync`). Only the path that
            // actually removed the session delivers `on_exit`, so a stream Exit
            // and a reconnect-synthesized Exit can never double-deliver — exactly
            // one `on_exit` per session, ever.
            if !lock(&shared.known_alive).remove(&frame.session_id) {
                return;
            }
            // FIX 3: prune the per-session seq tracker now the session is dead;
            // past Exit it is meaningless and would otherwise leak per session.
            lock(&shared.seq).remove(&frame.session_id);
            // P11: an exited session leaves both producer sets — never re-send a
            // resume for a session whose child is gone.
            lock(&shared.producer_paused).remove(&frame.session_id);
            lock(&shared.producer_resumes_owed).remove(&frame.session_id);
            // Why the cold-restore cache is NOT evicted here: a cold-restore
            // payload describes a DEAD session by definition — it is the disk seed
            // the renderer replays for a session whose daemon-side child is gone.
            // Dropping it on Exit would race (and lose) that replay. The payload is
            // cleared only on the renderer's explicit `ack_cold_restore` or the
            // session's first fresh output; unbounded growth is instead bounded by
            // `ColdRestoreCache`'s insertion-order cap (design P16 / FIX 3).
            let sub = lock(&shared.subscribers).get(&frame.session_id).cloned();
            if let Some(sub) = sub {
                sub.on_exit(status);
            }
        }
        StreamFrameKind::Resize => {
            if let Some((cols, rows)) = frame.as_resize() {
                let sub = lock(&shared.subscribers).get(&frame.session_id).cloned();
                if let Some(sub) = sub {
                    sub.on_resize(cols, rows);
                }
            }
        }
    }
}

/// Tear down the connection for `generation`, rejecting its in-flight RPCs.
/// Generation-guarded (design P7): a stale reader from an older connection whose
/// generation no longer matches is a no-op, so it can't evict a fresh reconnect.
fn handle_disconnect(shared: &Arc<Shared>, generation: u64) {
    {
        let mut st = lock(&shared.state);
        if shared.generation.load(Ordering::SeqCst) != generation {
            return; // stale generation
        }
        if !st.connected {
            return; // already handled by the sibling reader
        }
        st.connected = false;
        st.control_tx = None; // dropping the sender ends the writer task
    }
    // Owed-resume (design P11): every session paused when this socket dropped moves
    // into `producer_resumes_owed` so the next fresh connect re-sends its resume. A
    // session that exits while disconnected is pruned from the owed set on the
    // reconnect resync (or an Exit frame), so no stray resume is ever sent.
    {
        let paused: Vec<String> = {
            let mut paused = lock(&shared.producer_paused);
            paused.drain().collect()
        };
        if !paused.is_empty() {
            let mut owed = lock(&shared.producer_resumes_owed);
            for id in paused {
                owed.insert(id);
            }
        }
    }
    // Reject the in-flight RPCs bound to THIS generation so no caller hangs on a
    // dead socket. A request registered against a newer generation (already
    // reconnected) is left intact — belt-and-braces with the generation guard
    // above, which already blocks a stale reader from reaching here (design P7).
    let rejected: Vec<Pending> = {
        let mut pending = lock(&shared.pending);
        let ids: Vec<u64> = pending
            .iter()
            .filter(|(_, p)| p.generation == generation)
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter().filter_map(|id| pending.remove(&id)).collect()
    };
    for pending in rejected {
        let _ = pending.tx.send(Err(ClientError::ConnectionLost));
    }
}

async fn read_hello_ack(r: &mut BufReader<OwnedReadHalf>) -> Result<(), ClientError> {
    let mut line = String::new();
    let read = tokio::time::timeout(HELLO_TIMEOUT, r.read_line(&mut line)).await;
    let n = match read {
        Ok(inner) => inner?,
        Err(_) => {
            return Err(ClientError::Timeout {
                method: "hello".to_string(),
                ms: HELLO_TIMEOUT.as_millis() as u64,
            })
        }
    };
    if n == 0 {
        return Err(ClientError::ConnectionLost);
    }
    let ack: HelloAck =
        decode_ndjson_line(&line).map_err(|e| ClientError::Protocol(e.to_string()))?;
    if ack.ok {
        Ok(())
    } else {
        Err(ClientError::Protocol(
            ack.error.unwrap_or_else(|| "hello rejected".to_string()),
        ))
    }
}

/// Recover a poisoned lock rather than propagate the panic (mirrors grove-core
/// pty.rs / the daemon): the guarded maps are structurally valid after a panic.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ---------------------------------------------------------------------------
// ClientHandle — the blocking bridge (design G1 / R12)
// ---------------------------------------------------------------------------

/// Errors from the blocking bridge.
#[derive(Debug)]
pub enum BridgeError {
    /// A blocking method was called from within a caller-owned tokio runtime.
    /// The bridge REFUSES (rather than `block_on`-ing an ambient runtime, which
    /// would deadlock/panic and — for NAPI — freeze the Node main thread, R12).
    AmbientRuntime,
    /// The underlying async client failed.
    Client(ClientError),
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BridgeError::AmbientRuntime => write!(
                f,
                "daemon client: refusing to block on an ambient tokio runtime"
            ),
            BridgeError::Client(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for BridgeError {}

/// Owns a dedicated multi-thread tokio runtime and drives the async
/// [`DaemonClient`] from SYNC callers. The runtime is the client's OWN — a
/// blocking call from a plain thread runs the future here; a blocking call made
/// from inside another runtime is refused (never blocks a caller-owned runtime).
pub struct ClientHandle {
    runtime: tokio::runtime::Runtime,
    client: DaemonClient,
}

impl ClientHandle {
    /// Build the bridge and its dedicated runtime (one worker thread is plenty —
    /// the client is I/O-bound, and the reader/writer tasks run on it).
    pub fn new(opts: DaemonClientOptions) -> std::io::Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("grove-daemon-client")
            .enable_all()
            .build()?;
        let client = DaemonClient::new(opts);
        Ok(Self { runtime, client })
    }

    /// The underlying async client (for callers already on a runtime).
    pub fn client(&self) -> &DaemonClient {
        &self.client
    }

    /// Run a client future to completion on the OWNED runtime, refusing if the
    /// caller is inside an ambient runtime (the R12 assertion).
    fn block<T>(
        &self,
        fut: impl Future<Output = Result<T, ClientError>>,
    ) -> Result<T, BridgeError> {
        if tokio::runtime::Handle::try_current().is_ok() {
            return Err(BridgeError::AmbientRuntime);
        }
        self.runtime.block_on(fut).map_err(BridgeError::Client)
    }

    pub fn ensure_connected_blocking(&self) -> Result<(), BridgeError> {
        self.block(self.client.ensure_connected())
    }

    pub fn create_or_attach_blocking(
        &self,
        req: CreateOrAttach,
    ) -> Result<CreateOrAttachResult, BridgeError> {
        self.block(self.client.create_or_attach(req))
    }

    pub fn list_sessions_blocking(&self) -> Result<Vec<SessionInfo>, BridgeError> {
        self.block(self.client.list_sessions())
    }

    pub fn applied_size_blocking(&self, session_id: &str) -> Result<(u16, u16), BridgeError> {
        self.block(self.client.applied_size(session_id))
    }

    pub fn cwd_blocking(&self, session_id: &str) -> Result<Option<String>, BridgeError> {
        self.block(self.client.cwd(session_id))
    }

    pub fn clear_history_blocking(&self, session_id: &str) -> Result<(), BridgeError> {
        self.block(self.client.clear_history(session_id))
    }

    pub fn poll_bells_blocking(&self) -> Result<Vec<crate::PtyBellEvent>, BridgeError> {
        self.block(self.client.poll_bells())
    }

    pub fn set_session_background_blocking(
        &self,
        session_id: &str,
        background: bool,
    ) -> Result<(), BridgeError> {
        self.block(self.client.set_session_background(session_id, background))
    }

    pub fn connected_clients_blocking(&self) -> Result<u64, BridgeError> {
        self.block(self.client.connected_clients())
    }

    pub fn write_blocking(&self, session_id: &str, data: &[u8]) -> Result<(), BridgeError> {
        self.block(self.client.write(session_id, data))
    }

    pub fn resize_blocking(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), BridgeError> {
        self.block(self.client.resize(session_id, cols, rows))
    }

    pub fn ack_cold_restore_blocking(&self, session_id: &str) -> Result<(), BridgeError> {
        self.block(self.client.ack_cold_restore(session_id))
    }

    pub fn pause_pty_blocking(&self, session_id: &str) -> Result<(), BridgeError> {
        self.block(self.client.pause_pty(session_id))
    }

    pub fn resume_pty_blocking(&self, session_id: &str) -> Result<(), BridgeError> {
        self.block(self.client.resume_pty(session_id))
    }

    pub fn checkpoint_all_blocking(&self) -> Result<(), BridgeError> {
        self.block(self.client.checkpoint_all())
    }

    pub fn kill_blocking(&self, session_id: &str) -> Result<(), BridgeError> {
        self.block(self.client.kill(session_id))
    }

    pub fn shutdown_blocking(&self, kill_sessions: bool) -> Result<(), BridgeError> {
        self.block(self.client.shutdown(kill_sessions))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cold_cache_is_sticky_until_ack() {
        let cache = ColdRestoreCache::default();
        let payload = ColdRestorePayload {
            snapshot: "hello".into(),
            cols: 80,
            rows: 24,
            ..Default::default()
        };
        cache.set("s1".into(), payload.clone());
        // Sticky: repeated reads yield the same payload (R11 — not consumed).
        assert_eq!(cache.get("s1"), Some(payload.clone()));
        assert_eq!(cache.get("s1"), Some(payload));
        assert!(cache.contains("s1"));
        // Explicit ack clears it.
        cache.ack("s1");
        assert_eq!(cache.get("s1"), None);
        assert!(!cache.contains("s1"));
    }

    #[test]
    fn cold_cache_cleared_by_first_fresh_data() {
        let cache = ColdRestoreCache::default();
        cache.set("s1".into(), ColdRestorePayload::default());
        assert!(cache.contains("s1"));
        cache.on_fresh_data("s1");
        assert!(!cache.contains("s1"));
        // Idempotent — a second fresh-data clear on an absent id is harmless.
        cache.on_fresh_data("s1");
        assert!(!cache.contains("s1"));
    }

    #[test]
    fn cold_cache_ack_and_fresh_data_are_isolated_per_session() {
        let cache = ColdRestoreCache::default();
        cache.set("a".into(), ColdRestorePayload::default());
        cache.set("b".into(), ColdRestorePayload::default());
        cache.ack("a");
        assert!(!cache.contains("a"));
        assert!(cache.contains("b"));
        cache.on_fresh_data("b");
        assert!(!cache.contains("b"));
    }

    #[test]
    fn cold_cache_evicts_oldest_beyond_bound() {
        // FIX 3: the cache is bounded by insertion order (it is never evicted on
        // Exit). Filling past the cap drops the oldest entries and keeps the
        // newest `COLD_CACHE_MAX_ENTRIES`.
        let cache = ColdRestoreCache::default();
        for i in 0..(COLD_CACHE_MAX_ENTRIES + 10) {
            cache.set(format!("s{i}"), ColdRestorePayload::default());
        }
        assert_eq!(cache.len(), COLD_CACHE_MAX_ENTRIES, "cache must be bounded");
        assert!(!cache.contains("s0"), "oldest entry must be evicted");
        assert!(!cache.contains("s9"), "the 10 oldest entries must be evicted");
        assert!(cache.contains("s10"), "the first surviving entry is retained");
        assert!(
            cache.contains(&format!("s{}", COLD_CACHE_MAX_ENTRIES + 9)),
            "the newest entry is retained"
        );
    }

    #[test]
    fn cold_cache_reset_updates_in_place_without_reordering() {
        // Re-setting an existing key updates the payload without moving it in the
        // eviction order or growing the cache (FIX 3).
        let cache = ColdRestoreCache::default();
        for i in 0..COLD_CACHE_MAX_ENTRIES {
            cache.set(format!("s{i}"), ColdRestorePayload::default());
        }
        let updated = ColdRestorePayload {
            snapshot: "updated".into(),
            ..Default::default()
        };
        cache.set("s0".to_string(), updated.clone());
        assert_eq!(cache.len(), COLD_CACHE_MAX_ENTRIES, "re-set must not grow the cache");
        assert_eq!(cache.get("s0"), Some(updated), "re-set updates the payload in place");
        // s0 stayed the oldest, so the next genuinely-new insert evicts it.
        cache.set("s-new".to_string(), ColdRestorePayload::default());
        assert_eq!(cache.len(), COLD_CACHE_MAX_ENTRIES);
        assert!(
            !cache.contains("s0"),
            "s0 remained oldest and is evicted by the new insert"
        );
        assert!(cache.contains("s-new"));
    }

    #[derive(Default)]
    struct ExitCounter {
        exits: AtomicU64,
    }

    impl ExitCounter {
        fn count(&self) -> u64 {
            self.exits.load(Ordering::SeqCst)
        }
    }

    impl StreamSubscriber for ExitCounter {
        fn on_data(&self, _seq: u64, _data: &[u8]) {}
        fn on_exit(&self, _status: ExitStatus) {
            self.exits.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn exit_is_delivered_at_most_once_per_session() {
        // FIX 2: a stream Exit and a reconnect-synthesized Exit both claim the
        // session by removing it from `known_alive`; only the winner delivers
        // `on_exit`. Two Exit frames for the same session must fire it exactly
        // once. FIX 3: the seq bookkeeping is pruned on that Exit.
        let client = DaemonClient::new(dead_endpoint_options());
        let counter = Arc::new(ExitCounter::default());
        client.subscribe("s1", counter.clone());
        lock(&client.shared.known_alive).insert("s1".to_string());
        lock(&client.shared.seq)
            .entry("s1".to_string())
            .or_default()
            .observe(10);

        let exit = StreamFrame::exit("s1", 10, &ExitStatus { code: Some(0), signal: None });
        dispatch_frame(&client.shared, exit.clone());
        dispatch_frame(&client.shared, exit);

        assert_eq!(counter.count(), 1, "on_exit must fire exactly once per session");
        assert!(
            !lock(&client.shared.seq).contains_key("s1"),
            "seq bookkeeping must be pruned on Exit (FIX 3)"
        );
        assert!(
            !lock(&client.shared.known_alive).contains("s1"),
            "the dead session must be dropped from known_alive"
        );
    }

    #[test]
    fn cold_restore_payload_defaults_from_partial_result() {
        // A result missing the (not-yet-emitted) cold-restore fields defaults.
        let result = json!({ "isNew": true });
        let payload = ColdRestorePayload::from_result(&result);
        assert_eq!(payload, ColdRestorePayload::default());
    }

    #[test]
    fn warm_reattach_parses_full_reply() {
        // A full live-adopt reply: every field, including the daemon's
        // `snapshotKittyKeyboardFlags` alias, maps onto the struct.
        let result = json!({
            "isNew": false,
            "isReattach": true,
            "snapshot": "BODY",
            "cols": 120,
            "rows": 40,
            "isAlternateScreen": true,
            "outputSequence": 4096,
            "pendingEscapeTailAnsi": "\x1b[?10",
            "snapshotKittyKeyboardFlags": 5,
            "cwd": "/tmp/work",
            "lastTitle": "vim",
        });
        let warm = WarmReattach::from_result(&result).expect("full reply must parse");
        assert_eq!(warm.snapshot, "BODY");
        assert_eq!(warm.cols, 120);
        assert_eq!(warm.rows, 40);
        assert!(warm.is_alternate_screen);
        assert_eq!(warm.output_sequence, 4096);
        assert_eq!(warm.pending_escape_tail_ansi.as_deref(), Some("\x1b[?10"));
        assert_eq!(warm.kitty_keyboard_flags, Some(5));
        assert_eq!(warm.cwd.as_deref(), Some("/tmp/work"));
        assert_eq!(warm.last_title.as_deref(), Some("vim"));
        assert!(!warm.emulator_degraded);
    }

    #[test]
    fn warm_reattach_parses_minimal_reply() {
        // The daemon omits the optional fields for a primary-screen session with no
        // modes/title/cwd/pending tail — those default; the core five survive.
        let result = json!({
            "isNew": false,
            "isReattach": true,
            "snapshot": "SCROLLBACK",
            "cols": 80,
            "rows": 24,
            "isAlternateScreen": false,
            "outputSequence": 12,
        });
        let warm = WarmReattach::from_result(&result).expect("minimal reply must parse");
        assert_eq!(warm.snapshot, "SCROLLBACK");
        assert_eq!(warm.cols, 80);
        assert_eq!(warm.rows, 24);
        assert!(!warm.is_alternate_screen);
        assert_eq!(warm.output_sequence, 12);
        assert!(warm.pending_escape_tail_ansi.is_none());
        assert!(warm.kitty_keyboard_flags.is_none());
        assert!(warm.cwd.is_none());
        assert!(warm.last_title.is_none());
        assert!(!warm.emulator_degraded);
    }

    #[test]
    fn warm_reattach_parses_degraded_reply() {
        // The poisoned-emulator branch: raw ring tail as snapshot + the
        // `emulatorDegraded` flag, still marked `isReattach`.
        let result = json!({
            "isNew": false,
            "isReattach": true,
            "snapshot": "RAW-RING-TAIL",
            "cols": 80,
            "rows": 24,
            "isAlternateScreen": false,
            "outputSequence": 99,
            "emulatorDegraded": true,
        });
        let warm = WarmReattach::from_result(&result).expect("degraded reply must parse");
        assert_eq!(warm.snapshot, "RAW-RING-TAIL");
        assert!(warm.emulator_degraded);
        assert!(warm.pending_escape_tail_ansi.is_none());
    }

    #[test]
    fn warm_reattach_absent_without_reattach_marker() {
        // A fresh-spawn reply carries no `isReattach`, so there is no warm payload.
        assert_eq!(WarmReattach::from_result(&json!({ "isNew": true })), None);
        // An explicit `isReattach: false` is likewise not a warm reattach.
        assert_eq!(
            WarmReattach::from_result(&json!({ "isReattach": false, "snapshot": "x" })),
            None
        );
    }

    #[test]
    fn global_ack_cold_restore_is_noop_without_global_client() {
        // Contract item 2: `daemon::ack_cold_restore` forwards to the process-global
        // client if one is installed, else no-ops. No global is set in this test
        // binary, so the call must return without panicking.
        crate::daemon::ack_cold_restore("no-such-session");
    }

    #[test]
    fn disconnect_moves_paused_into_owed() {
        // Design P11: sessions paused when the socket drops move into the owed set
        // so the next fresh connect re-sends their resume. `reset_connection` drives
        // the exact `handle_disconnect` teardown a transient socket drop triggers.
        let client = DaemonClient::new(dead_endpoint_options());
        // Simulate a live connection so handle_disconnect runs its teardown (it
        // early-returns when already disconnected).
        lock(&client.shared.state).connected = true;
        lock(&client.shared.producer_paused).insert("s1".to_string());
        lock(&client.shared.producer_paused).insert("s2".to_string());

        client.reset_connection();

        assert!(
            lock(&client.shared.producer_paused).is_empty(),
            "paused set must drain into owed on disconnect"
        );
        let owed = lock(&client.shared.producer_resumes_owed);
        assert!(
            owed.contains("s1") && owed.contains("s2"),
            "both paused sessions must owe a resume after disconnect"
        );
    }

    #[test]
    fn exit_prunes_producer_sets() {
        // Design P11: an exited session leaves BOTH producer sets so no stray resume
        // is ever sent for a session whose child is gone.
        let client = DaemonClient::new(dead_endpoint_options());
        lock(&client.shared.known_alive).insert("s1".to_string());
        lock(&client.shared.producer_paused).insert("s1".to_string());
        lock(&client.shared.producer_resumes_owed).insert("s1".to_string());

        let exit = StreamFrame::exit("s1", 0, &ExitStatus { code: Some(0), signal: None });
        dispatch_frame(&client.shared, exit);

        assert!(!lock(&client.shared.producer_paused).contains("s1"));
        assert!(!lock(&client.shared.producer_resumes_owed).contains("s1"));
    }

    #[test]
    fn sleep_restore_ids_are_caller_managed() {
        // Design L12: the sleep-restore set is pure client-side bookkeeping the host
        // populates on suspend and clears on wake.
        let client = DaemonClient::new(dead_endpoint_options());
        assert!(!client.is_sleep_restore("s1"));
        client.mark_sleep_restore("s1");
        assert!(client.is_sleep_restore("s1"));
        client.clear_sleep_restore("s1");
        assert!(!client.is_sleep_restore("s1"));
    }

    fn dead_endpoint_options() -> DaemonClientOptions {
        // A socket/token that will never exist → connect fails fast with an I/O
        // error, letting us assert the bridge actually ran block_on (not refused).
        DaemonClientOptions::new(
            PathBuf::from("/tmp/grove-nonexistent-daemon-xyz.sock"),
            PathBuf::from("/tmp/grove-nonexistent-daemon-xyz.token"),
        )
    }

    #[test]
    fn blocking_bridge_runs_off_runtime() {
        // From a plain thread (no ambient runtime), the bridge drives its own
        // runtime: connecting to a dead endpoint yields a Client error, NOT
        // AmbientRuntime — proving block_on executed.
        let handle = ClientHandle::new(dead_endpoint_options()).unwrap();
        let err = handle.ensure_connected_blocking().unwrap_err();
        assert!(
            matches!(err, BridgeError::Client(_)),
            "expected a Client error off-runtime, got {err:?}"
        );
    }

    #[test]
    fn blocking_bridge_refuses_ambient_runtime() {
        // Inside a caller-owned runtime, the bridge must REFUSE rather than
        // block_on (which would panic/deadlock). It returns before touching its
        // own runtime, so no panic occurs (R12).
        let handle = ClientHandle::new(dead_endpoint_options()).unwrap();
        let ambient = tokio::runtime::Runtime::new().unwrap();
        let err = ambient.block_on(async { handle.ensure_connected_blocking() });
        assert!(
            matches!(err, Err(BridgeError::AmbientRuntime)),
            "expected AmbientRuntime refusal, got {err:?}"
        );
    }
}
