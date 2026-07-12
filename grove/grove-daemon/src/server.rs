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
use std::path::PathBuf;
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

use crate::checkpointer::{CheckpointSource, Checkpointer};
use crate::emulator::SnapshotOptions;
use crate::history::{session_dir, ColdRestore, HistoryReader, OwnerLock, SessionMeta};
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

    /// Null the subscriber slot only if it still holds `generation` (fix #2), and
    /// report whether it did. A `true` means THIS stream was the live subscriber
    /// and no newer one replaced it — i.e. the last client for this generation
    /// went away, so the caller eagerly resumes any paused producer (design S14).
    /// A stale stream task whose subscriber was already replaced returns `false`.
    fn clear(&self, generation: u64) -> bool {
        let mut inner = lock(&self.inner);
        if inner.generation == generation {
            inner.tx = None;
            true
        } else {
            false
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
    /// Weak so the reader thread never keeps the checkpointer alive past shutdown;
    /// on a clean child exit it stamps the session's `ended_at` (design D2).
    checkpointer: Weak<Checkpointer>,
}

impl SessionReaper {
    /// A reaper whose map has already been dropped — reaping is a no-op. Used by
    /// `Session`-level unit tests that spawn a session without a full `Daemon`.
    #[cfg(test)]
    pub fn dangling() -> Self {
        Self {
            sessions: Weak::new(),
            checkpointer: Weak::new(),
        }
    }

    /// A reaper wired to a real checkpointer but no session map — for the fix-F2
    /// wiring test, which spawns a real `Session` and asserts its output marks the
    /// checkpointer dirty. Reaping is a no-op (the map is absent).
    #[cfg(test)]
    pub fn with_checkpointer(checkpointer: &Arc<Checkpointer>) -> Self {
        Self {
            sessions: Weak::new(),
            checkpointer: Arc::downgrade(checkpointer),
        }
    }

    /// Bump the session's dirty flag on the checkpointer (design D8, fix F2).
    /// Called from the `Session` reader tee + resize so output/resize arriving
    /// AFTER the first anchor actually gets persisted by the periodic tick — the
    /// wiring the checkpointer relied on but nothing provided. A no-op when the
    /// checkpointer is gone (shutdown) or the session was never registered.
    pub fn mark_dirty(&self, id: &str) {
        if let Some(ckpt) = self.checkpointer.upgrade() {
            ckpt.mark_dirty(id);
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

    /// Stamp `ended_at` + drop the session's history writer (releasing its flock)
    /// on a clean child exit (design D2 teardown table). A no-op when the
    /// checkpointer is gone or the session had no history (never registered /
    /// owned elsewhere).
    pub fn close_history(&self, id: &str, exit_code: Option<i32>) {
        if let Some(ckpt) = self.checkpointer.upgrade() {
            ckpt.close_session(id, exit_code);
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
    /// LIVE count of currently-connected control clients (design §9b): bumped when
    /// a control handshake succeeds, dropped when that connection's `run_control`
    /// returns. Exposed via `getDaemonInfo` so daemon-mode GC can implement "skip
    /// if any app is currently connected" without touching the tmux partition.
    connected_controls: AtomicU64,
    /// Disk-backed history + cold restore (design §5). The tick loop is started in
    /// `serve`; attach/close paths drive it (open/register/reopen/close).
    checkpointer: Arc<Checkpointer>,
    /// The protocol-version-namespaced history root — where the cold-restore reader
    /// probes for an unclean checkpoint under the createOrAttach decision (D12).
    history_root: PathBuf,
    /// Stops the checkpointer tick loop on shutdown (separate from `shutdown`,
    /// which the accept loop waits on).
    checkpointer_shutdown: Arc<TokioNotify>,
}

impl Daemon {
    pub fn new(token: String, history_root: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            version: GROVE_DAEMON_PROTOCOL_VERSION,
            token,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            hub: StreamHub::default(),
            shutdown: TokioNotify::new(),
            shutdown_flag: AtomicBool::new(false),
            control_hellos: AtomicU64::new(0),
            connected_controls: AtomicU64::new(0),
            checkpointer: Checkpointer::new(history_root.clone()),
            history_root,
            checkpointer_shutdown: Arc::new(TokioNotify::new()),
        })
    }

    fn reaper(&self) -> SessionReaper {
        SessionReaper {
            sessions: Arc::downgrade(&self.sessions),
            checkpointer: Arc::downgrade(&self.checkpointer),
        }
    }

    /// Accept connections until a shutdown is triggered (RPC or signal).
    pub async fn serve(self: Arc<Self>, listener: UnixListener) {
        // Start the checkpoint tick loop (design D8). It sleeps until a session is
        // marked dirty, so an idle daemon does no periodic work; `trigger_shutdown`
        // stops it (and a runtime drop cleans it up regardless).
        {
            let ckpt = Arc::clone(&self.checkpointer);
            let stop = Arc::clone(&self.checkpointer_shutdown);
            tokio::spawn(ckpt.run(stop));
        }
        loop {
            // Fix F1 (hardening): `main` now awaits this loop UNCONDITIONALLY (the
            // old `timeout(SHUTDOWN_BUDGET, serve)` masked a missed shutdown by
            // aborting at 5s). `trigger_shutdown` sets this flag BEFORE
            // `notify_waiters`, so checking it at the top of every iteration closes
            // the notify race (a wake delivered while we were in the accept branch
            // is still observed here) — the loop can never spin past a shutdown.
            if self.is_shutting_down() {
                break;
            }
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
        self.checkpointer_shutdown.notify_waiters();
    }

    /// Graceful teardown flush (design D2 teardown table): a final checkpoint for
    /// EVERY session AND stamp `ended_at` — cold-restore INELIGIBLE. Used by the
    /// SIGTERM/SIGINT signal path (main.rs) and the shutdown ("Restart daemon")
    /// RPC. Contrast the client-disconnect flush (`run_control`), which leaves
    /// history UNCLEAN so an unattended crash is still cold-restorable (design L7).
    pub async fn shutdown_history(&self) {
        self.checkpointer.shutdown_all().await;
    }

    /// Flush a final checkpoint for EVERY live session but leave history UNCLEAN —
    /// `ended_at` is NOT stamped (fix F3). This is the SIGTERM/SIGINT path: launchd
    /// SIGTERMs the daemon on a clean macOS reboot, and stamping `ended_at` there
    /// would suppress Tier-B cold restore (regressing vs tmux). Same leave-unclean
    /// semantics as the client-disconnect flush; contrast `shutdown_history`
    /// (the explicit "Restart daemon" RPC), which stamps `ended_at`.
    pub async fn flush_history_unclean(&self) {
        self.checkpointer.flush_all().await;
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
                // Track the LIVE connected-control gauge (design §9b) across the
                // connection's lifetime so `getDaemonInfo` reports an accurate count
                // even if `run_control` returns via error/EOF. `run_control` consumes
                // the `Arc<Self>`, so hold a clone for the post-return decrement.
                self.connected_controls.fetch_add(1, Ordering::SeqCst);
                let gauge = Arc::clone(&self);
                self.run_control(reader, write_half).await;
                gauge.connected_controls.fetch_sub(1, Ordering::SeqCst);
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
        // disconnect-not-kill (design L7 / fix #18): the daemon autonomously writes
        // a final checkpoint for EVERY live session, awaiting any in-flight tick.
        // Sessions keep RUNNING and history stays UNCLEAN (ended_at NOT stamped) so
        // a daemon crash while no app is attached is still cold-restorable. Skipped
        // during a graceful shutdown, whose own flush stamps ended_at.
        if !self.is_shutting_down() {
            self.checkpointer.flush_all().await;
        }
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
        // that replaced us must keep receiving. Eager auto-resume (design S14): if
        // this WAS the live subscriber (no newer stream replaced it), the last
        // client just went away — nobody will send `resumePty`, so a paused shell
        // would sit wedged until its 5s failsafe. Resume every producer now. A
        // reconnecting client that owed a resume re-sends it (P11), idempotently.
        if self.hub.clear(generation) {
            self.resume_all_producers();
        }
    }

    /// Eagerly resume every live session's producer (design S14). Called when the
    /// last stream client disconnects: no host remains to send `resumePty`, so a
    /// paused reader must be unparked here rather than wait out the failsafe.
    fn resume_all_producers(&self) {
        let sessions: Vec<Arc<Session>> = lock(&self.sessions)
            .values()
            .filter_map(|slot| match slot {
                SessionSlot::Live(session) => Some(Arc::clone(session)),
                SessionSlot::Pending => None,
            })
            .collect();
        for session in sessions {
            session.resume_producer();
        }
    }

    async fn dispatch_rpc(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        match method {
            "createOrAttach" => self.rpc_create_or_attach(params).await,
            "kill" => {
                let id = str_param(&params, "sessionId")?;
                if let Some(session) = self.get(&id) {
                    Session::kill(&session);
                }
                // A deliberate close is a clean teardown (design D2 teardown table):
                // stamp ended_at SYNCHRONOUSLY (not via the async reaper) so the
                // pane is cold-restore INELIGIBLE the instant this RPC returns.
                self.checkpointer.close_session(&id, None);
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
            // Clear scrollback history (design item 4): the daemon-native replacement
            // for the tmux `clear-history` shell-out. Drops the byte-exact ring +
            // emulator scrollback view and logs a Clear frame (D4). RPC — the client
            // awaits the ack so it can then clear its own local mirror in order.
            "clearHistory" => {
                let id = str_param(&params, "sessionId")?;
                let session = self.get(&id).ok_or_else(session_not_found)?;
                session.clear_history();
                Ok(json!({}))
            }
            // Bell + AI status poll (design G9): one entry per LIVE session with its
            // pending bell (DRAINED on read — swap-false) and current ai_status (read,
            // NOT drained — it is state, not an event). Replaces the tmux
            // monitor-bell / `@grove_ai_status` shell-outs; the frontend
            // `PtyBellEvent{ptyId,bell,aiStatus}` contract is unchanged (design G9).
            "pollBells" => Ok(self.rpc_poll_bells()),
            // Daemon liveness/attachment info (design §9b): the live connected-control
            // count backs daemon-mode GC's "skip if any app is connected" gate.
            "getDaemonInfo" => Ok(json!({
                "connectedClients": self.connected_controls.load(Ordering::SeqCst),
                "sessionCount": self.session_count(),
            })),
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
            // Sleep/wake (design L12 Tier C): write a final checkpoint for EVERY
            // live session, AWAITING any in-flight tick, WITHOUT stamping `ended_at`
            // — leave-unclean so if a child is killed under power management the
            // wake path can cold-restore it. The host calls this on system suspend
            // before the OS may freeze/kill the daemon's children. Reuses the P7
            // `flush_all` machinery verbatim; replies only once the writes land.
            "checkpointAll" => {
                self.checkpointer.flush_all().await;
                Ok(json!({}))
            }
            "shutdown" => {
                let kill_sessions = params
                    .get("killSessions")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                // Graceful shutdown (design D2/L8): final checkpoint + ended_at for
                // every session (cold-restore INELIGIBLE — the user chose to stop
                // the daemon), before killing children and tearing down.
                self.shutdown_history().await;
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
        // Per-session scrollback ring cap (design D10/§8.X). Absent → the daemon's
        // built-in default. Ignored on a warm adopt (only a fresh/cold spawn reads it).
        let ring_cap_bytes = params
            .get("scrollbackBytes")
            .and_then(Value::as_u64)
            .map(|bytes| bytes as usize);
        let env: Vec<(String, String)> = params
            .get("env")
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default();

        // Fix #4 (TOCTOU) + fix #3 (dead-but-unreaped) + fix #16 (atomic cold
        // restore): resolve the id under the map lock BEFORE the blocking spawn.
        // The winner installs a `Pending` reservation and is the ONLY caller that
        // spawns a PTY; a concurrent caller either attaches to a live session, or
        // waits out the reservation and then attaches — so exactly one PTY is ever
        // spawned per id. The live-vs-not decision is atomic under this lock; once
        // reserved, the disk cold-restore probe (below) is race-free because the id
        // is held and no concurrent path can bring it alive (design invariant #11).
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
                    // "live" under the map lock above; the session was registered
                    // with the checkpointer when it spawned, so no history action.
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
                    // The session is absent and reserved (design D12/fix #16): the
                    // live-vs-cold decision already resolved to "not live", so the
                    // disk probe is race-free — nothing can bring the id alive while
                    // we hold the reservation. An UNCLEAN (ended_at==null) checkpoint
                    // whose flock is acquirable → cold restore; else a fresh spawn.
                    // The probe + VT replay run off the reactor (disk + CPU work).
                    // Fix F4 / R9: the cold-restore probe FIRST tries the dir's
                    // owner flock (non-blocking). A held lock ⇒ a live daemon
                    // (an old, still-running build during an update) OWNS this
                    // session — treat it as NOT restorable → a plain fresh spawn
                    // with NO cold payload and NO history writes; the live owner
                    // wins. We acquire, read the cold data, then RELEASE; the flock
                    // is reacquired by `register_history` below. That release→
                    // reacquire window is benign: within THIS process the
                    // `SessionSlot::Pending` reservation serializes same-id spawns,
                    // and if a cross-version daemon grabs the dir in the window,
                    // `register_history` fails to reacquire and the `persisted` gate
                    // (below) drops any cold payload — so the live owner's scrollback
                    // is never delivered as a duplicate.
                    let cold_restore = {
                        let root = self.history_root.clone();
                        let sid = session_id.clone();
                        tokio::task::spawn_blocking(move || {
                            match OwnerLock::acquire(&session_dir(&root, &sid)) {
                                Ok(_lock) => {
                                    // `_lock` releases at the end of this arm, before
                                    // the spawn + register_history reacquire.
                                    let reader = HistoryReader::new(&root);
                                    if reader.has_restorable_history(&sid) {
                                        // ignore_clean_end: eligibility was
                                        // established, so a clean end racing in must
                                        // not downgrade (design D12).
                                        reader.detect_cold_restore(&sid, true)
                                    } else {
                                        None
                                    }
                                }
                                // Owned elsewhere / io error → not restorable.
                                Err(_) => None,
                            }
                        })
                        .await
                        .ok()
                        .flatten()
                    };

                    // Recovered cwd/cols/rows OVERRIDE the requested geometry (D12).
                    let (spawn_cwd, spawn_cols, spawn_rows) = match &cold_restore {
                        Some(cr) => (
                            cr.cwd.clone().unwrap_or_else(|| cwd.clone()),
                            cr.cols.max(1),
                            cr.rows.max(1),
                        ),
                        None => (cwd.clone(), cols, rows),
                    };

                    let hub = self.hub.clone();
                    let reaper = self.reaper();
                    let spawn_id = session_id.clone();
                    let spawn_cwd_c = spawn_cwd.clone();
                    let env = env.clone();
                    // Why: openpty + spawn_command are blocking; keep them off the
                    // reactor.
                    let spawned = tokio::task::spawn_blocking(move || match ring_cap_bytes {
                        Some(cap) => Session::spawn_with_ring_cap(
                            spawn_id, &spawn_cwd_c, spawn_cols, spawn_rows, &env, hub, reaper, cap,
                        ),
                        None => {
                            Session::spawn(spawn_id, &spawn_cwd_c, spawn_cols, spawn_rows, &env, hub, reaper)
                        }
                    })
                    .await;

                    match spawned {
                        Ok(Ok(session)) => {
                            // Wire disk history (design D9/D10/D11): a fresh session
                            // opens a new writer (unlinks stale); a cold-restored one
                            // re-registers the preserved dir, clears ended_at, and
                            // re-anchors on the next tick with a fresh generation.
                            // `persisted` is false when a live owner elsewhere holds
                            // the flock (fix F4/R9) — the reacquire fails.
                            let persisted = self.register_history(
                                &session,
                                Some(spawn_cwd),
                                spawn_cols,
                                spawn_rows,
                                cold_restore.is_some(),
                            );
                            lock(&self.sessions)
                                .insert(session_id, SessionSlot::Live(session));
                            // Fix F4: deliver a cold payload ONLY if we actually took
                            // ownership of the dir. If a live owner grabbed it in the
                            // probe→register window, `persisted` is false and we
                            // return a plain fresh spawn — delivering the payload
                            // would duplicate the live owner's scrollback (R9).
                            return match cold_restore {
                                Some(cr) if persisted => Ok(cold_restore_reply(&cr)),
                                _ => Ok(json!({ "isNew": true })),
                            };
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

    /// Wire a freshly-spawned session into the disk history subsystem (design
    /// D9/D10/D11/L12). A GENUINELY NEW session opens a fresh writer (unlinks any
    /// stale files, writes clean meta); a COLD-RESTORE-seeded session re-registers
    /// the preserved dir and clears `ended_at` so it is cold-restorable again. On
    /// `OwnedElsewhere`/io error the session runs WITHOUT persistence — a live
    /// owner elsewhere wins and we neither write history nor deliver cold data
    /// (design R9). Only on success do we start the reader's pending-output tee.
    ///
    /// ended_at discipline (design D2 teardown table — every teardown path stamps
    /// or skips `ended_at` deliberately):
    ///   - child self-exit (reader EOF)     → STAMP (SessionReaper::close_history)
    ///   - explicit "kill"/close RPC        → STAMP (dispatch_rpc "kill")
    ///   - kill watchdog force-dispose       → STAMP (via the reader EOF it forces)
    ///   - explicit shutdown ("Restart daemon") RPC → STAMP (shutdown_history)
    ///   - SIGTERM/SIGINT (reboot / dev)     → SKIP  (flush_history_unclean; fix F3)
    ///   - client-disconnect / app-quit      → SKIP  (flush_all; sessions run on)
    ///   - daemon SIGKILL (no chance to run) → SKIP  (stays unclean → cold-restore)
    ///
    /// Returns whether persistence was established (fix F4): `false` when the dir's
    /// flock is held by a live owner elsewhere (`OwnedElsewhere`) or an io error
    /// occurred — the session then runs WITHOUT history and any cold payload the
    /// probe computed must be dropped by the caller (R9).
    fn register_history(
        &self,
        session: &Arc<Session>,
        meta_cwd: Option<String>,
        cols: u16,
        rows: u16,
        cold: bool,
    ) -> bool {
        let session_arc: Arc<Session> = Arc::clone(session);
        let source: Arc<dyn CheckpointSource> = session_arc;
        let outcome = if cold {
            self.checkpointer.reopen_session(source)
        } else {
            let meta = SessionMeta::new(meta_cwd, cols, rows);
            self.checkpointer.open_session(source, &meta)
        };
        if outcome.is_ok() {
            session.enable_history();
            true
        } else {
            false
        }
    }

    /// Live session count (design §9b), reported beside the connected-client gauge.
    fn session_count(&self) -> usize {
        lock(&self.sessions)
            .values()
            .filter(|slot| matches!(slot, SessionSlot::Live(_)))
            .count()
    }

    /// Build the `pollBells` reply (design G9): one `PtyBellEvent`-shaped entry per
    /// LIVE session. The bell is drained (swap-false) here; ai_status is read.
    fn rpc_poll_bells(&self) -> Value {
        let sessions: Vec<Arc<Session>> = lock(&self.sessions)
            .values()
            .filter_map(|slot| match slot {
                SessionSlot::Live(session) => Some(Arc::clone(session)),
                SessionSlot::Pending => None,
            })
            .collect();
        let events: Vec<Value> = sessions
            .iter()
            .map(|session| {
                json!({
                    "ptyId": session.id,
                    "bell": session.take_bell(),
                    "aiStatus": session.ai_status(),
                })
            })
            .collect();
        json!(events)
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
                        // The child shell's pid (design G9): grove's hookless
                        // AI-status reconcile walks the process tree rooted here,
                        // replacing tmux's `#{pane_pid}` readback.
                        "pid": session.pid(),
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
            // Producer flow control (design S14/P11): pause parks the session's PTY
            // reader (kernel backpressure blocks a flooding child); resume wakes it.
            // Fire-and-forget notifies so keystroke/scroll latency is never gated on
            // an ACK; the 5s failsafe + owed-resume-on-reconnect are the correctness
            // backstops against a lost resume.
            "pausePty" => {
                if let Some(id) = params.get("sessionId").and_then(Value::as_str) {
                    if let Some(session) = self.get(id) {
                        Session::pause_producer(&session);
                    }
                }
            }
            "resumePty" => {
                if let Some(id) = params.get("sessionId").and_then(Value::as_str) {
                    if let Some(session) = self.get(id) {
                        session.resume_producer();
                    }
                }
            }
            // Background bookkeeping (design P6 `set_session_background`): stores a
            // flag on the session for later keep-tail thinning; no behavior beyond
            // storage in this cut. Fire-and-forget so a hidden/shown toggle never
            // blocks the UI.
            "setSessionBackground" => {
                if let Some(id) = params.get("sessionId").and_then(Value::as_str) {
                    let background = params
                        .get("background")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if let Some(session) = self.get(id) {
                        session.set_background(background);
                    }
                }
            }
            // AI status injection (design G9): the daemon-native replacement for a
            // hook's `tmux set-option @grove_ai_status`. `aiStatus` absent/null
            // clears the status. Read back via `pollBells`.
            "setAiStatus" => {
                if let Some(id) = params.get("sessionId").and_then(Value::as_str) {
                    let status = params
                        .get("aiStatus")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    if let Some(session) = self.get(id) {
                        session.set_ai_status(status);
                    }
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

/// Build the cold-restore `createOrAttach` reply (design S15 cold variant / D13,
/// fix #16). The fields deserialize into grove-core `ColdRestorePayload`
/// (camelCase): `snapshot` is the land-in-NORMAL body (never `?1049h`), and
/// `isColdRestore: true` makes `DaemonClient`'s sticky cache capture it (P16).
/// Recovered `cols`/`rows` are the geometry the session was re-seeded at (D12).
fn cold_restore_reply(cr: &ColdRestore) -> Value {
    // `from_utf8_lossy` boundary (verifier note): the cold snapshot is carried as a
    // JSON string, so any invalid UTF-8 byte becomes U+FFFD here. This lossy step
    // is STRUCTURALLY FORCED by the JSON reply shape (a JSON string cannot hold a
    // lone continuation byte) and matches tmux `capture-pane` parity, which also
    // hands the renderer a decoded string. The byte-exact history lives in the
    // on-disk log / ring; this reply is a display payload, not the source of truth.
    let snapshot = String::from_utf8_lossy(&cr.cold_snapshot()).into_owned();
    let mut obj = json!({
        "isNew": true,
        "isColdRestore": true,
        "snapshot": snapshot,
        "cols": cr.cols,
        "rows": cr.rows,
        "isAlternateScreen": cr.is_alternate_screen,
    });
    if cr.degraded {
        // Fix F7: the scrollback base was lost (torn checkpoint); only the log tail
        // survived. Surface it so the renderer can note the truncated history.
        obj["degraded"] = json!(true);
    }
    if !cr.pending_escape_tail.is_empty() {
        obj["pendingEscapeTailAnsi"] =
            json!(String::from_utf8_lossy(&cr.pending_escape_tail).into_owned());
    }
    obj
}

/// Build the `createOrAttach`/`getSnapshot` reply payload from a session's warm
/// VT snapshot (design S15). The concatenated `scrollback ++ rehydrate ++ alt`
/// body is the `snapshot` string; siblings (dims, alt flag, kitty flags, pending
/// escape tail, cwd/title, outputSequence) ride BESIDE it. On a poisoned emulator
/// (snapshot == None) it degrades to the byte-exact ring tail (design G4/L11).
fn warm_snapshot_json(session: &Arc<Session>) -> Value {
    match session.snapshot(SnapshotOptions::default()) {
        Some(snap) => {
            // `from_utf8_lossy` boundary (verifier note): the warm payload rides as
            // a JSON string, so invalid UTF-8 → U+FFFD. This is STRUCTURALLY FORCED
            // by the JSON reply shape and matches tmux-capture parity (the renderer
            // is handed a decoded string either way). vt100's serialized output is
            // valid UTF-8; only an exotic pending tail could ever be lossy here.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{Checkpoint, HistoryWriter};
    use std::path::Path;
    use std::sync::atomic::AtomicU64;

    fn temp_root() -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("grove-srv-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn seed_unclean(root: &Path, id: &str, marker: &[u8]) {
        // Seed a restorable (unclean, ended_at=null) session dir, then drop the
        // writer so its flock is released and a fresh daemon COULD cold-restore it
        // — if not for a live owner holding the lock (the F4 scenario).
        let mut w =
            HistoryWriter::open_session(root, id, &SessionMeta::new(Some("/tmp".into()), 80, 24))
                .expect("seed open");
        w.checkpoint(Checkpoint {
            snapshot_ansi: Vec::new(),
            scrollback_ansi: marker.to_vec(),
            rehydrate_sequences: Vec::new(),
            pending_escape_tail: Vec::new(),
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
            is_alternate_screen: false,
            kitty_keyboard_flags: 0,
            last_title: None,
            scrollback_seq: marker.len() as u64,
            generation: 0,
            checkpointed_at_ms: 0,
        })
        .expect("seed checkpoint");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn cold_restore_skipped_when_dir_owned_by_live_daemon() {
        // Fix F4 / R9: a session dir whose `.owner.lock` is held by a LIVE owner
        // must NOT be cold-restored — createOrAttach returns a plain fresh spawn
        // (isNew, no isColdRestore, no snapshot) and writes NO history, so the live
        // owner's scrollback is never duplicated into a second seeded PTY.
        let root = temp_root();
        seed_unclean(&root, "s1", b"LIVE-OWNED-DATA");

        // A live owner elsewhere holds the flock. Same-process second-fd contention
        // is exactly what a second process would see (proven by the history.rs flock
        // tests), so this needs no helper binary.
        let held = OwnerLock::acquire(&session_dir(&root, "s1")).expect("hold owner lock");

        let daemon = Daemon::new("tok".to_string(), root.clone());
        let reply = daemon
            .rpc_create_or_attach(json!({
                "sessionId": "s1", "cwd": "/tmp", "cols": 80, "rows": 24
            }))
            .await
            .expect("createOrAttach ok");

        assert_eq!(reply["isNew"], json!(true), "must be a plain fresh spawn");
        assert_ne!(
            reply["isColdRestore"],
            json!(true),
            "must NOT cold-restore a dir owned by a live daemon"
        );
        assert!(
            reply.get("snapshot").is_none(),
            "a dir owned elsewhere must carry no cold payload: {reply:?}"
        );
        assert_eq!(
            daemon.checkpointer.session_count(),
            0,
            "no history may be registered for a dir owned elsewhere (R9)"
        );

        daemon.kill_all_sessions();
        drop(held);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn poll_bells_drains_bell_and_reports_ai_status() {
        // Design G9: pollBells returns one entry per live session with its pending
        // bell (drained) and current ai_status (read). setAiStatus injects status.
        let root = temp_root();
        let daemon = Daemon::new("tok".to_string(), root.clone());
        daemon
            .rpc_create_or_attach(json!({ "sessionId": "b1", "cwd": "/tmp", "cols": 80, "rows": 24 }))
            .await
            .expect("createOrAttach ok");
        let session = daemon.get("b1").expect("session b1 live");

        // Inject an AI status via the notify, and ring a bell via a teed BEL.
        daemon.dispatch_notify(
            "setAiStatus",
            json!({ "sessionId": "b1", "aiStatus": "codex:running" }),
        );
        session.test_tee(b"beep\x07");

        let events = daemon.rpc_poll_bells();
        let entry = events
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["ptyId"] == json!("b1"))
            .expect("b1 present in pollBells");
        assert_eq!(entry["bell"], json!(true), "teed BEL must report a bell");
        assert_eq!(entry["aiStatus"], json!("codex:running"), "ai_status reported");

        // The bell drained on read; ai_status persists (state, not event).
        let events = daemon.rpc_poll_bells();
        let entry = events
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["ptyId"] == json!("b1"))
            .unwrap();
        assert_eq!(entry["bell"], json!(false), "bell must drain on poll");
        assert_eq!(entry["aiStatus"], json!("codex:running"), "ai_status persists");

        daemon.kill_all_sessions();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn get_daemon_info_reports_session_count_and_zero_clients() {
        // Design §9b: getDaemonInfo exposes the live session count and the
        // connected-control gauge. With no sockets attached the gauge is 0.
        let root = temp_root();
        let daemon = Daemon::new("tok".to_string(), root.clone());
        daemon
            .rpc_create_or_attach(json!({ "sessionId": "d1", "cwd": "/tmp", "cols": 80, "rows": 24 }))
            .await
            .expect("createOrAttach ok");

        let info = daemon
            .dispatch_rpc("getDaemonInfo", Value::Null)
            .await
            .expect("getDaemonInfo ok");
        assert_eq!(info["sessionCount"], json!(1));
        assert_eq!(
            info["connectedClients"],
            json!(0),
            "no socket attached → zero connected controls"
        );

        daemon.kill_all_sessions();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn clear_history_drops_the_byte_exact_ring() {
        // Design item 4: the clearHistory RPC is the daemon-native replacement for
        // the tmux `clear-history` shell-out. It drops the byte-exact ring (the
        // cold-restore source) so a subsequent reattach/cold-restore never replays
        // the pre-clear scrollback.
        let root = temp_root();
        let daemon = Daemon::new("tok".to_string(), root.clone());
        daemon
            .rpc_create_or_attach(json!({
                "sessionId": "c1", "cwd": "/tmp", "cols": 80, "rows": 24
            }))
            .await
            .expect("createOrAttach ok");
        let session = daemon.get("c1").expect("session c1 live");
        session.test_tee(b"PRE-CLEAR-SCROLLBACK");
        assert!(
            session
                .ring_tail()
                .windows(20)
                .any(|w| w == b"PRE-CLEAR-SCROLLBACK"),
            "teed bytes must land in the ring before clear"
        );

        daemon
            .dispatch_rpc("clearHistory", json!({ "sessionId": "c1" }))
            .await
            .expect("clearHistory ok");

        assert!(
            session.ring_tail().is_empty(),
            "clearHistory must drop the byte-exact ring"
        );

        // An unknown session id is a clean not-found error, not a panic.
        let err = daemon
            .dispatch_rpc("clearHistory", json!({ "sessionId": "nope" }))
            .await
            .expect_err("clearHistory on a missing session errors");
        assert_eq!(err.code, session_not_found().code);

        daemon.kill_all_sessions();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn resume_all_producers_unparks_a_paused_session() {
        // Design S14: when the last stream client disconnects, the daemon eagerly
        // resumes every producer so a paused shell can't wedge waiting on a resume
        // no one will send. This drives that server-side path directly.
        let root = temp_root();
        let daemon = Daemon::new("tok".to_string(), root.clone());
        daemon
            .rpc_create_or_attach(json!({
                "sessionId": "p1", "cwd": "/tmp", "cols": 80, "rows": 24
            }))
            .await
            .expect("createOrAttach ok");
        let session = daemon.get("p1").expect("session p1 live");

        Session::pause_producer(&session);
        assert!(session.is_producer_paused(), "session must be paused");

        // The last-client-disconnect hook resumes all producers.
        daemon.resume_all_producers();
        assert!(
            !session.is_producer_paused(),
            "resume_all_producers must unpark the paused session"
        );

        daemon.kill_all_sessions();
        let _ = std::fs::remove_dir_all(&root);
    }
}
