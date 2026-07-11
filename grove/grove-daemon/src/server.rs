//! The daemon server: UnixListener accept loop, hello handshake, the NDJSON
//! control channel (RPC + notify), and the binary stream channel (design P1/P2).
//!
//! Connection model (design P1/P2, first cut): each client connection opens with
//! a bare `Hello`. A `Control` connection then speaks NDJSON `ControlMessage`s;
//! a `Stream` connection registers as the single live subscriber and receives
//! ordered GCKL frames. A single per-stream writer task drains one FIFO queue, so
//! per-session `Data`-before-`Exit` ordering (design P13) is preserved on the
//! wire. Client disconnect is disconnect-not-kill: sessions keep running (L7).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use base64::Engine;
use grove_core::daemon::protocol::{
    decode_ndjson_line, encode_ndjson_line, ClientKind, ControlMessage, Hello, HelloAck, Notify,
    RpcError, RpcReply, RpcRequest, GROVE_DAEMON_PROTOCOL_VERSION,
};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, Notify as TokioNotify};

use crate::emulator::SnapshotOptions;
use crate::lock;
use crate::session::Session;

/// Per-connection hello deadline (design P2). A client that never speaks is
/// dropped rather than holding a connection task open.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// The single-subscriber fan-out for live stream frames. Sessions (running on std
/// reader threads) push already-encoded GCKL frame bytes here; the active stream
/// connection's writer task drains them in FIFO order to the socket. With one
/// active subscriber and one FIFO, per-session Data→Exit ordering is preserved.
#[derive(Default)]
struct HubInner {
    tx: Option<mpsc::UnboundedSender<Vec<u8>>>,
    /// Bumped on every `set`; a `clear` only nulls the slot when it still owns
    /// this generation, so a stale stream's teardown can't wipe a newer one.
    generation: u64,
}

#[derive(Clone, Default)]
pub struct StreamHub {
    inner: Arc<Mutex<HubInner>>,
}

impl StreamHub {
    /// Push an encoded frame to the live stream subscriber, if any. Output while
    /// no client is attached is dropped live (the ring retains it for a later
    /// reattach) — this is the detach-all-on-client-drop behavior.
    pub fn emit(&self, bytes: Vec<u8>) {
        if let Some(tx) = lock(&self.inner).tx.as_ref() {
            let _ = tx.send(bytes);
        }
    }

    /// Install a new subscriber and return its generation token. Fix #2: the
    /// caller passes that token to `clear` on teardown so a slow-disconnecting
    /// older stream can never null out a newer subscriber's tx.
    fn set(&self, tx: mpsc::UnboundedSender<Vec<u8>>) -> u64 {
        let mut inner = lock(&self.inner);
        inner.generation += 1;
        inner.tx = Some(tx);
        inner.generation
    }

    /// Null the subscriber slot only if it still holds `generation` (fix #2). A
    /// stale stream task whose subscriber was already replaced is a no-op here.
    fn clear(&self, generation: u64) {
        let mut inner = lock(&self.inner);
        if inner.generation == generation {
            inner.tx = None;
        }
    }
}

/// One entry in the daemon's session map. `Pending` reserves an id under the
/// map lock while a winning `createOrAttach` spawns its PTY (fix #4); losers see
/// the reservation and attach to the resulting session instead of spawning a
/// duplicate. `Live` holds the running session.
pub enum SessionSlot {
    Pending,
    Live(Arc<Session>),
}

type SessionMap = Mutex<HashMap<String, SessionSlot>>;

/// A capability handed to each `Session` so its reader thread can remove itself
/// from the daemon's map on exit (fix #3). Holds a `Weak` so it never keeps the
/// map (or, transitively, the daemon) alive past shutdown.
#[derive(Clone)]
pub struct SessionReaper {
    sessions: Weak<SessionMap>,
}

impl SessionReaper {
    /// A reaper whose map has already been dropped — reaping is a no-op. Used by
    /// `Session`-level unit tests that spawn a session without a full `Daemon`.
    #[cfg(test)]
    pub fn dangling() -> Self {
        Self {
            sessions: Weak::new(),
        }
    }

    /// Remove `id` from the map only if it still points at `me` (Arc identity).
    /// Fix #3: a session created in the exit→reap race window reuses the id, and
    /// this identity check ensures the dying session never reaps its successor.
    pub fn reap(&self, id: &str, me: &Arc<Session>) {
        let Some(map) = self.sessions.upgrade() else {
            return;
        };
        let mut map = lock(&map);
        if let Some(SessionSlot::Live(current)) = map.get(id) {
            if Arc::ptr_eq(current, me) {
                map.remove(id);
            }
        }
    }
}

pub struct Daemon {
    version: u32,
    token: String,
    sessions: Arc<SessionMap>,
    hub: StreamHub,
    shutdown: TokioNotify,
    shutdown_flag: AtomicBool,
    /// Count of successful CONTROL hello handshakes. Backs the P3 client
    /// integration test that asserts concurrent `ensure_connected` callers
    /// coalesce into exactly ONE control connection (design P7).
    control_hellos: AtomicU64,
}

impl Daemon {
    pub fn new(token: String) -> Arc<Self> {
        Arc::new(Self {
            version: GROVE_DAEMON_PROTOCOL_VERSION,
            token,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            hub: StreamHub::default(),
            shutdown: TokioNotify::new(),
            shutdown_flag: AtomicBool::new(false),
            control_hellos: AtomicU64::new(0),
        })
    }

    fn reaper(&self) -> SessionReaper {
        SessionReaper {
            sessions: Arc::downgrade(&self.sessions),
        }
    }

    /// Accept connections until a shutdown is triggered (RPC or signal).
    pub async fn serve(self: Arc<Self>, listener: UnixListener) {
        loop {
            tokio::select! {
                _ = self.shutdown.notified() => break,
                accepted = listener.accept() => match accepted {
                    Ok((stream, _addr)) => {
                        let daemon = Arc::clone(&self);
                        tokio::spawn(async move { daemon.handle_connection(stream).await; });
                    }
                    Err(_) => break,
                },
            }
        }
    }

    pub fn trigger_shutdown(&self) {
        self.shutdown_flag.store(true, Ordering::SeqCst);
        self.shutdown.notify_waiters();
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutdown_flag.load(Ordering::SeqCst)
    }

    pub fn kill_all_sessions(&self) {
        let sessions: Vec<Arc<Session>> = lock(&self.sessions)
            .values()
            .filter_map(|slot| match slot {
                SessionSlot::Live(session) => Some(Arc::clone(session)),
                SessionSlot::Pending => None,
            })
            .collect();
        for session in sessions {
            Session::kill(&session);
        }
    }

    fn get(&self, id: &str) -> Option<Arc<Session>> {
        match lock(&self.sessions).get(id) {
            Some(SessionSlot::Live(session)) => Some(Arc::clone(session)),
            _ => None,
        }
    }

    async fn handle_connection(self: Arc<Self>, stream: UnixStream) {
        let (read_half, write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut write_half = write_half;

        // First line on every socket is a bare Hello (design P2).
        let mut line = String::new();
        let read = tokio::time::timeout(HELLO_TIMEOUT, reader.read_line(&mut line)).await;
        let hello: Hello = match read {
            Ok(Ok(n)) if n > 0 => match decode_ndjson_line(&line) {
                Ok(h) => h,
                Err(_) => {
                    let _ = write_line(&mut write_half, &HelloAck::reject("malformed hello")).await;
                    return;
                }
            },
            _ => return,
        };

        if hello.version != self.version {
            let _ = write_line(&mut write_half, &HelloAck::reject("version mismatch")).await;
            return;
        }
        // Fix #5: reject an empty token outright (defense in depth — main.rs also
        // refuses to start with one), and compare in constant time so the auth
        // path leaks no timing signal about how many leading bytes matched.
        if hello.token.is_empty()
            || self.token.is_empty()
            || !constant_time_eq(hello.token.as_bytes(), self.token.as_bytes())
        {
            let _ = write_line(&mut write_half, &HelloAck::reject("token mismatch")).await;
            return;
        }
        if write_line(&mut write_half, &HelloAck::ok()).await.is_err() {
            return;
        }

        match hello.kind {
            ClientKind::Control => {
                self.control_hellos.fetch_add(1, Ordering::SeqCst);
                self.run_control(reader, write_half).await
            }
            ClientKind::Stream => self.run_stream(reader, write_half).await,
        }
    }

    async fn run_control(
        self: Arc<Self>,
        mut reader: BufReader<OwnedReadHalf>,
        mut write_half: OwnedWriteHalf,
    ) {
        let mut line = String::new();
        loop {
            line.clear();
            let read = tokio::select! {
                _ = self.shutdown.notified() => break,
                r = reader.read_line(&mut line) => r,
            };
            match read {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let msg: ControlMessage = match decode_ndjson_line(&line) {
                Ok(m) => m,
                Err(_) => continue,
            };
            match msg {
                ControlMessage::Request(RpcRequest { id, method, params }) => {
                    let reply = match self.dispatch_rpc(&method, params).await {
                        Ok(result) => RpcReply::ok(id, result),
                        Err(error) => RpcReply::err(id, error),
                    };
                    if write_line(&mut write_half, &ControlMessage::Reply(reply))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                ControlMessage::Notify(Notify { method, params }) => {
                    self.dispatch_notify(&method, params);
                }
                // A client never sends Hello/HelloAck/Reply on an open control
                // channel; ignore rather than desync.
                _ => {}
            }
        }
        // disconnect-not-kill (design L7): sessions keep running.
    }

    async fn run_stream(
        self: Arc<Self>,
        mut reader: BufReader<OwnedReadHalf>,
        mut write_half: OwnedWriteHalf,
    ) {
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let generation = self.hub.set(tx);
        let mut discard = [0u8; 256];
        loop {
            tokio::select! {
                _ = self.shutdown.notified() => break,
                frame = rx.recv() => match frame {
                    Some(bytes) => {
                        if write_half.write_all(&bytes).await.is_err() {
                            break;
                        }
                        let _ = write_half.flush().await;
                    }
                    None => break,
                },
                // Detect the stream client closing its end.
                r = reader.read(&mut discard) => match r {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                },
            }
        }
        // Fix #2: only clear if we still own the subscriber slot; a newer stream
        // that replaced us must keep receiving.
        self.hub.clear(generation);
    }

    async fn dispatch_rpc(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            "createOrAttach" => self.rpc_create_or_attach(params).await,
            "kill" => {
                let id = str_param(&params, "sessionId")?;
                if let Some(session) = self.get(&id) {
                    Session::kill(&session);
                }
                Ok(json!({}))
            }
            "listSessions" => Ok(self.rpc_list_sessions()),
            "getAppliedSize" => {
                let id = str_param(&params, "sessionId")?;
                let session = self.get(&id).ok_or_else(session_not_found)?;
                let (cols, rows) = session.applied_size();
                Ok(json!({ "cols": cols, "rows": rows }))
            }
            // cwd/title come from the emulator's ModeState OSC scanner (design
            // S11/P15) — no tmux shell-out. Absent → null (session may be pre-OSC).
            "getCwd" => {
                let id = str_param(&params, "sessionId")?;
                let session = self.get(&id).ok_or_else(session_not_found)?;
                Ok(json!({ "cwd": session.cwd() }))
            }
            "getTitle" => {
                let id = str_param(&params, "sessionId")?;
                let session = self.get(&id).ok_or_else(session_not_found)?;
                Ok(json!({ "title": session.title() }))
            }
            "getSnapshot" => {
                let id = str_param(&params, "sessionId")?;
                let session = self.get(&id).ok_or_else(session_not_found)?;
                // Off the reactor (design FIX 6): serializing a warm snapshot is
                // CPU work under the emulator mutex; run it on a blocking thread so
                // it never stalls the async control loop.
                warm_snapshot_json_blocking(session).await
            }
            "checkPtySpawnHealth" => {
                let ok = tokio::task::spawn_blocking(Session::probe_spawn_health)
                    .await
                    .map_err(|e| internal(format!("health probe join: {e}")))?;
                Ok(json!({ "ok": ok }))
            }
            "shutdown" => {
                let kill_sessions = params
                    .get("killSessions")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if kill_sessions {
                    self.kill_all_sessions();
                }
                self.trigger_shutdown();
                Ok(json!({}))
            }
            // Test-only introspection backing the P3 client integration suite.
            // `debugControlHelloCount` proves connect-coalescing (one control
            // hello for N concurrent callers); `debugSleep` is a stalled method
            // for the per-request-timeout + in-flight-rejection tests. Both are
            // cheap and side-effect-free, so they stay compiled in.
            "debugControlHelloCount" => {
                Ok(json!({ "count": self.control_hellos.load(Ordering::SeqCst) }))
            }
            "debugSleep" => {
                let ms = params.get("ms").and_then(Value::as_u64).unwrap_or(0);
                tokio::time::sleep(Duration::from_millis(ms)).await;
                Ok(json!({}))
            }
            other => Err(RpcError {
                code: -32601,
                message: format!("unknown method: {other}"),
            }),
        }
    }

    async fn rpc_create_or_attach(&self, params: Value) -> Result<Value, RpcError> {
        let session_id = str_param(&params, "sessionId")?;

        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or(".")
            .to_string();
        let cols = params.get("cols").and_then(Value::as_u64).unwrap_or(80) as u16;
        let rows = params.get("rows").and_then(Value::as_u64).unwrap_or(24) as u16;
        let env: Vec<(String, String)> = params
            .get("env")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();

        // Fix #4 (TOCTOU) + fix #3 (dead-but-unreaped): resolve the id under the
        // map lock BEFORE the blocking spawn. The winner installs a `Pending`
        // reservation and is the ONLY caller that spawns a PTY; a concurrent
        // caller either attaches to a live session, or waits out the reservation
        // and then attaches — so exactly one PTY is ever spawned per id.
        loop {
            enum Action {
                Attach,
                Spawn,
                WaitPending,
            }
            let action = {
                let mut map = lock(&self.sessions);
                match map.get(&session_id) {
                    Some(SessionSlot::Live(session)) if session.is_alive() => Action::Attach,
                    Some(SessionSlot::Live(_)) => {
                        // Dead but not yet reaped: drop the stale entry (its reader
                        // thread's identity-checked reap will no-op) and take over
                        // the id with a fresh reservation.
                        map.insert(session_id.clone(), SessionSlot::Pending);
                        Action::Spawn
                    }
                    Some(SessionSlot::Pending) => Action::WaitPending,
                    None => {
                        map.insert(session_id.clone(), SessionSlot::Pending);
                        Action::Spawn
                    }
                }
            };

            match action {
                Action::Attach => {
                    // Warm reattach (design P9/S15): return the live VT snapshot so
                    // the renderer rehydrates the current screen + modes. The
                    // atomic live-vs-cold decision (D12) has already resolved to
                    // "live" under the map lock above.
                    let session = self.get(&session_id).ok_or_else(session_not_found)?;
                    // Off the reactor (design FIX 6): same blocking snapshot path
                    // as getSnapshot.
                    let mut reply = warm_snapshot_json_blocking(session).await?;
                    reply["isNew"] = json!(false);
                    return Ok(reply);
                }
                Action::WaitPending => {
                    // The winner is mid-spawn; yield briefly, then re-resolve.
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    continue;
                }
                Action::Spawn => {
                    let hub = self.hub.clone();
                    let reaper = self.reaper();
                    let spawn_id = session_id.clone();
                    let cwd = cwd.clone();
                    let env = env.clone();
                    // Why: openpty + spawn_command are blocking; keep them off the
                    // reactor.
                    let spawned = tokio::task::spawn_blocking(move || {
                        Session::spawn(spawn_id, &cwd, cols, rows, &env, hub, reaper)
                    })
                    .await;

                    match spawned {
                        Ok(Ok(session)) => {
                            lock(&self.sessions)
                                .insert(session_id, SessionSlot::Live(session));
                            return Ok(json!({ "isNew": true }));
                        }
                        Ok(Err(spawn_err)) => {
                            // Release the reservation so a later attempt can retry.
                            lock(&self.sessions).remove(&session_id);
                            return Err(internal(spawn_err));
                        }
                        Err(join_err) => {
                            lock(&self.sessions).remove(&session_id);
                            return Err(internal(format!("spawn join: {join_err}")));
                        }
                    }
                }
            }
        }
    }

    fn rpc_list_sessions(&self) -> Value {
        let list: Vec<Value> = lock(&self.sessions)
            .values()
            .filter_map(|slot| match slot {
                SessionSlot::Live(session) => {
                    let (cols, rows) = session.applied_size();
                    Some(json!({
                        "sessionId": session.id,
                        "isAlive": session.is_alive(),
                        "cols": cols,
                        "rows": rows,
                    }))
                }
                SessionSlot::Pending => None,
            })
            .collect();
        json!(list)
    }

    fn dispatch_notify(&self, method: &str, params: Value) {
        match method {
            "write" => {
                let Some(id) = params.get("sessionId").and_then(Value::as_str) else {
                    return;
                };
                let Some(b64) = params.get("dataB64").and_then(Value::as_str) else {
                    return;
                };
                let Ok(data) = base64::engine::general_purpose::STANDARD.decode(b64) else {
                    return;
                };
                // Why: processed in receive order on this single control task, and
                // handed to the session's per-session FIFO forwarder thread, so a
                // chunked paste body + trailing CR reach the child in exactly the
                // sent order (fix #5) — and the blocking write never stalls a tokio
                // worker (fix #1).
                if let Some(session) = self.get(id) {
                    session.enqueue_write(&data);
                }
            }
            "resize" => {
                let Some(id) = params.get("sessionId").and_then(Value::as_str) else {
                    return;
                };
                let cols = params.get("cols").and_then(Value::as_u64).unwrap_or(0) as u16;
                let rows = params.get("rows").and_then(Value::as_u64).unwrap_or(0) as u16;
                if cols == 0 || rows == 0 {
                    return;
                }
                if let Some(session) = self.get(id) {
                    let _ = session.resize(cols, rows);
                }
            }
            // P16 sticky cold-restore scaffold: the client clears its per-session
            // cache locally and sends this so the daemon can drop any retained
            // cold-restore payload. Accepted no-op until the checkpointer wires
            // real cold restore (design P7/P8); acking a session it never held is
            // harmless.
            "ackColdRestore" => {}
            _ => {}
        }
    }
}

/// Build the `createOrAttach`/`getSnapshot` reply payload from a session's warm
/// VT snapshot (design S15). The concatenated `scrollback ++ rehydrate ++ alt`
/// body is the `snapshot` string; siblings (dims, alt flag, kitty flags, pending
/// escape tail, cwd/title, outputSequence) ride BESIDE it. On a poisoned emulator
/// (snapshot == None) it degrades to the byte-exact ring tail (design G4/L11).
fn warm_snapshot_json(session: &Arc<Session>) -> Value {
    match session.snapshot(SnapshotOptions::default()) {
        Some(snap) => {
            let payload = String::from_utf8_lossy(&snap.warm_payload()).into_owned();
            let mut obj = json!({
                "snapshot": payload,
                "cols": snap.cols,
                "rows": snap.rows,
                "isAlternateScreen": snap.is_alternate_screen,
                "outputSequence": snap.output_sequence,
                "isReattach": true,
            });
            if !snap.pending_escape_tail.is_empty() {
                obj["pendingEscapeTailAnsi"] =
                    json!(String::from_utf8_lossy(&snap.pending_escape_tail).into_owned());
            }
            if snap.kitty_keyboard_flags != 0 {
                obj["snapshotKittyKeyboardFlags"] = json!(snap.kitty_keyboard_flags);
            }
            if let Some(cwd) = snap.cwd {
                obj["cwd"] = json!(cwd);
            }
            if let Some(title) = snap.title {
                obj["lastTitle"] = json!(title);
            }
            obj
        }
        None => {
            // Degraded: the emulator is poisoned; hand back the raw ring bytes so
            // the pane still restores its scrollback tail (byte-exact, no modes).
            let tail = session.ring_tail();
            let (cols, rows) = session.applied_size();
            json!({
                "snapshot": String::from_utf8_lossy(&tail).into_owned(),
                "cols": cols,
                "rows": rows,
                "isAlternateScreen": false,
                "outputSequence": session.output_sequence(),
                "isReattach": true,
                "emulatorDegraded": true,
            })
        }
    }
}

/// Serialize a warm snapshot off the reactor (design FIX 6). `warm_snapshot_json`
/// does CPU-bound VT serialization while holding the emulator mutex; running it on
/// a blocking thread keeps the async control loop responsive. `Session::snapshot`
/// already contains any vt100 panic (catch_unwind), so the join here fails only on
/// runtime shutdown, which surfaces as an internal error.
async fn warm_snapshot_json_blocking(session: Arc<Session>) -> Result<Value, RpcError> {
    tokio::task::spawn_blocking(move || warm_snapshot_json(&session))
        .await
        .map_err(|e| internal(format!("snapshot join: {e}")))
}

async fn write_line<W, T>(writer: &mut W, msg: &T) -> std::io::Result<()>
where
    W: AsyncWriteExt + Unpin,
    T: Serialize,
{
    let line = encode_ndjson_line(msg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    writer.write_all(line.as_bytes()).await?;
    writer.flush().await
}

/// Constant-time byte-slice equality (fix #5). A tiny manual XOR-fold — no new
/// dependency. It never short-circuits: it folds a length mismatch and every byte
/// difference into one accumulator, then compares once, so the running time is
/// independent of how many leading bytes matched. `black_box` prevents the
/// optimizer from re-introducing an early-out branch.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u64;
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= (x ^ y) as u64;
    }
    std::hint::black_box(diff) == 0
}

fn str_param(params: &Value, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: format!("missing param: {key}"),
        })
}

fn session_not_found() -> RpcError {
    RpcError {
        code: -32004,
        message: "SessionNotFound".to_string(),
    }
}

fn internal(message: String) -> RpcError {
    RpcError {
        code: -32000,
        message,
    }
}
