//! Cold-restore + history E2E tests (design D2/D12/D13/L7, fix #16/#18, P16).
//!
//! Each test spawns the REAL daemon binary (`env!("CARGO_BIN_EXE_grove-daemon")`)
//! on a temp socket + base dir, drives it with raw NDJSON control + binary GCKL
//! stream sockets (so a control DISCONNECT and a process SIGKILL are precisely
//! controllable), and inspects the on-disk history tree. The atomic-decision and
//! sticky-cache tests additionally drive the grove-core `DaemonClient`.
//!
//! Covered: cold restore after a daemon SIGKILL; a clean close suppressing cold
//! restore (ended_at stamped); the client-disconnect autonomous checkpoint flush
//! (L7/fix #18); an alt-screen session landing in the NORMAL screen (no ?1049h,
//! D13); the fix-#16 atomic "session dead → cold payload, never fresh-unseeded"
//! gate; and the P16 sticky cold-restore cache across a double mount.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use base64::Engine;
use grove_core::daemon::client::{CreateOrAttach, DaemonClient, DaemonClientOptions};
use grove_core::daemon::framing::{StreamDecoder, StreamFrame, StreamFrameKind};
use grove_core::daemon::protocol::{
    daemon_token_path, decode_ndjson_line, encode_ndjson_line, history_root, ClientKind,
    ControlMessage, Hello, HelloAck, Notify, RpcReply, RpcRequest,
    GROVE_DAEMON_PROTOCOL_VERSION as VERSION,
};
use grove_daemon::history::session_dir;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::UnixStream;

// --- process harness -----------------------------------------------------

/// A spawned daemon binary; SIGKILLed on drop so a failing assert never leaks it.
struct DaemonProc {
    child: std::process::Child,
}

impl DaemonProc {
    /// SIGKILL (the child dies with no chance to write ended_at → history stays
    /// unclean → cold-restorable, the Tier-B / fix-#16 scenario).
    fn sigkill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    /// SIGTERM (the launchd clean-reboot path, fix F3) — distinct from SIGKILL so
    /// the daemon's signal handler actually RUNS (flush a final checkpoint, leave
    /// history unclean, exit). Sent via `kill` so no libc dep is needed here.
    fn sigterm(&self) {
        let _ = Command::new("kill")
            .arg("-TERM")
            .arg(self.child.id().to_string())
            .status();
    }

    /// Poll for the child to exit within `timeout`.
    async fn wait_exit(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        matches!(self.child.try_wait(), Ok(Some(_)))
    }
}

impl Drop for DaemonProc {
    fn drop(&mut self) {
        self.sigkill();
    }
}

fn unique_paths() -> (PathBuf, PathBuf) {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id();
    // Unix socket paths cap ~104 bytes → keep them short and in /tmp.
    let socket = PathBuf::from(format!("/tmp/grove-cold-{pid}-{n}.sock"));
    let base_dir = PathBuf::from(format!("/tmp/grove-cold-{pid}-{n}.d"));
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
        if token_file.exists() && UnixStream::connect(socket).await.is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    false
}

async fn wait_until<F: Fn() -> bool>(f: F, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if f() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    f()
}

// --- raw NDJSON control + GCKL stream helpers ----------------------------

async fn write_line<W: AsyncWriteExt + Unpin, T: Serialize>(writer: &mut W, msg: &T) {
    let line = encode_ndjson_line(msg).expect("encode ndjson");
    writer.write_all(line.as_bytes()).await.expect("write line");
    writer.flush().await.expect("flush");
}

/// Connect + hello for a given role; returns the split halves.
async fn connect_hello(
    sock: &Path,
    token: &str,
    kind: ClientKind,
) -> (BufReader<OwnedReadHalf>, OwnedWriteHalf) {
    let stream = UnixStream::connect(sock).await.expect("connect");
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let hello = Hello {
        version: VERSION,
        token: token.to_string(),
        client_id: "cold-test".to_string(),
        kind,
    };
    write_line(&mut write_half, &hello).await;
    let mut line = String::new();
    reader.read_line(&mut line).await.expect("read ack");
    let ack: HelloAck = decode_ndjson_line(&line).expect("decode ack");
    assert!(ack.ok, "hello rejected: {:?}", ack.error);
    (reader, write_half)
}

async fn rpc(
    reader: &mut BufReader<OwnedReadHalf>,
    writer: &mut OwnedWriteHalf,
    id: u64,
    method: &str,
    params: Value,
) -> RpcReply {
    let req = ControlMessage::Request(RpcRequest {
        id,
        method: method.to_string(),
        params,
    });
    write_line(writer, &req).await;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("read reply");
        if let Ok(ControlMessage::Reply(reply)) = decode_ndjson_line::<ControlMessage>(&line) {
            if reply.id == id {
                return reply;
            }
        }
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

async fn write_pty(writer: &mut OwnedWriteHalf, session_id: &str, data: &[u8]) {
    let msg = ControlMessage::Notify(Notify {
        method: "write".to_string(),
        params: json!({ "sessionId": session_id, "dataB64": b64(data) }),
    });
    write_line(writer, &msg).await;
}

async fn create_or_attach(
    reader: &mut BufReader<OwnedReadHalf>,
    writer: &mut OwnedWriteHalf,
    id: u64,
    session_id: &str,
) -> Value {
    rpc(
        reader,
        writer,
        id,
        "createOrAttach",
        json!({ "sessionId": session_id, "cwd": "/tmp", "cols": 80, "rows": 24 }),
    )
    .await
    .result
    .expect("createOrAttach result")
}

async fn pump_frames(
    reader: &mut BufReader<OwnedReadHalf>,
    dec: &mut StreamDecoder,
    frames: &mut Vec<StreamFrame>,
    deadline: Duration,
    mut done: impl FnMut(&[StreamFrame]) -> bool,
) -> bool {
    let pumped = tokio::time::timeout(deadline, async {
        let mut buf = [0u8; 4096];
        loop {
            if done(frames) {
                return;
            }
            match reader.read(&mut buf).await {
                Ok(0) => tokio::time::sleep(Duration::from_millis(5)).await,
                Ok(n) => {
                    dec.feed(&buf[..n]);
                    while let Some(frame) = dec.next_frame().expect("frame decode") {
                        frames.push(frame);
                    }
                }
                Err(_) => return,
            }
        }
    })
    .await;
    pumped.is_ok() && done(frames)
}

fn data_string_for(frames: &[StreamFrame], session_id: &str) -> String {
    let mut out = Vec::new();
    for frame in frames {
        if frame.kind == StreamFrameKind::Data && frame.session_id == session_id {
            out.extend_from_slice(&frame.payload);
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// --- disk inspection helpers ---------------------------------------------

fn checkpoint_path(base_dir: &Path, session_id: &str) -> PathBuf {
    session_dir(&history_root(base_dir), session_id).join("checkpoint.json")
}

fn meta_ended_is_null(base_dir: &Path, session_id: &str) -> Option<bool> {
    let path = session_dir(&history_root(base_dir), session_id).join("meta.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    Some(v.get("endedAtMs").map(Value::is_null).unwrap_or(true))
}

// --- tests ---------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cold_restore_after_daemon_kill() {
    let (socket, base_dir) = unique_paths();
    let token = "tok-cold";
    let mut daemon_a = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    // Seed: stream first (so the subscriber is registered before output), control,
    // create, emit a distinctive marker, confirm it streamed (⇒ it is in the ring).
    let (mut sreader, _swriter) = connect_hello(&socket, token, ClientKind::Stream).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;

    let r = create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
    assert_eq!(r["isNew"], json!(true));
    write_pty(&mut cwriter, "s1", b"echo COLD_MARKER_7788\n").await;
    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    assert!(
        pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
            data_string_for(fs, "s1").contains("COLD_MARKER_7788")
        })
        .await,
        "marker never streamed"
    );

    // Force a checkpoint via a CONTROL disconnect (L7 autonomous flush) — no 5s
    // wait. The daemon keeps running; sessions stay unclean.
    drop(creader);
    drop(cwriter);
    assert!(
        wait_until(|| checkpoint_path(&base_dir, "s1").exists(), Duration::from_secs(5)).await,
        "disconnect flush never wrote checkpoint.json"
    );

    // SIGKILL the daemon: the child dies with it, ended_at never stamped.
    daemon_a.sigkill();
    drop(sreader);

    // A fresh daemon on the same endpoint cold-restores s1.
    let _daemon_b = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);
    let (mut sreader, _swriter) = connect_hello(&socket, token, ClientKind::Stream).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;

    let r = create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
    assert_eq!(r["isNew"], json!(true), "cold restore seeds a fresh PTY");
    assert_eq!(r["isColdRestore"], json!(true), "must be a cold restore");
    let snap = r["snapshot"].as_str().expect("cold snapshot string");
    assert!(
        snap.contains("COLD_MARKER_7788"),
        "cold payload lost the distinctive bytes: {snap:?}"
    );

    // The freshly-seeded shell works: a write/echo round-trip on the new PTY.
    write_pty(&mut cwriter, "s1", b"echo FRESH_9911\n").await;
    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    assert!(
        pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
            data_string_for(fs, "s1").contains("FRESH_9911")
        })
        .await,
        "cold-restored shell does not echo fresh input"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn clean_close_suppresses_cold_restore() {
    let (socket, base_dir) = unique_paths();
    let token = "tok-clean";
    let mut daemon_a = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;
    let r = create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
    assert_eq!(r["isNew"], json!(true));

    // A deliberate close (kill RPC) is a clean teardown (design D2): it stamps
    // ended_at AND self-reaps the whole per-session history dir (design §9), so no
    // meta remains — the session is cold-restore INELIGIBLE by absence.
    let reply = rpc(&mut creader, &mut cwriter, 2, "kill", json!({ "sessionId": "s1" })).await;
    assert!(reply.error.is_none(), "kill errored: {:?}", reply.error);
    assert_eq!(
        meta_ended_is_null(&base_dir, "s1"),
        None,
        "a clean close must self-reap the session dir (design §9)"
    );
    assert!(
        !session_dir(&history_root(&base_dir), "s1").exists(),
        "a clean close removes the whole per-session history dir"
    );

    daemon_a.sigkill();
    drop(creader);
    drop(cwriter);

    // A fresh daemon must NOT cold-restore a cleanly-closed session.
    let _daemon_b = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);
    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;
    let r = create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
    assert_eq!(r["isNew"], json!(true), "must be a plain fresh spawn");
    assert_ne!(r["isColdRestore"], json!(true), "cleanly-closed session must not cold-restore");
    assert!(r.get("snapshot").is_none(), "a plain spawn carries no cold snapshot");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn client_disconnect_flushes_checkpoint() {
    let (socket, base_dir) = unique_paths();
    let token = "tok-disc";
    let _daemon = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let (mut sreader, _swriter) = connect_hello(&socket, token, ClientKind::Stream).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;
    let r = create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
    assert_eq!(r["isNew"], json!(true));
    write_pty(&mut cwriter, "s1", b"echo DISC_MARKER_31\n").await;
    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    assert!(
        pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
            data_string_for(fs, "s1").contains("DISC_MARKER_31")
        })
        .await,
        "marker never streamed"
    );

    // Disconnect only the CONTROL socket — well under the 5s tick. The daemon must
    // autonomously write the final checkpoint (L7/fix #18).
    drop(creader);
    drop(cwriter);
    assert!(
        wait_until(|| checkpoint_path(&base_dir, "s1").exists(), Duration::from_secs(4)).await,
        "control disconnect did not produce checkpoint.json before the 5s tick"
    );
    // Sessions keep running → history stays UNCLEAN (still cold-restorable).
    assert_eq!(
        meta_ended_is_null(&base_dir, "s1"),
        Some(true),
        "disconnect must NOT stamp ended_at"
    );

    // Reconnect: the session is still alive → a warm reattach still works.
    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;
    let r = create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
    assert_eq!(r["isNew"], json!(false), "surviving session warm-reattaches");
    assert_eq!(r["isReattach"], json!(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn alt_screen_cold_restore_lands_normal() {
    let (socket, base_dir) = unique_paths();
    let token = "tok-alt";
    let mut daemon_a = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let (mut sreader, _swriter) = connect_hello(&socket, token, ClientKind::Stream).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;
    create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;

    // Enter the alternate screen and paint a marker — and STAY in alt (no ?1049l),
    // so the session is in alt at checkpoint time.
    write_pty(
        &mut cwriter,
        "s1",
        b"printf '\\033[?1049h\\033[H\\033[?25lALT_LANDS_NORMAL'\n",
    )
    .await;
    // Wait for printf's ACTUAL output — the REAL alt-enter ESC byte — not the tty
    // echo of the typed command line (which contains the literal text `\033` and
    // "ALT_LANDS_NORMAL" before printf ever runs). The real `\x1b[?1049h` only
    // appears once the child executes printf, which is when the emulator enters
    // alt.
    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    assert!(
        pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
            data_string_for(fs, "s1").contains("\x1b[?1049h")
        })
        .await,
        "real alt-enter never streamed"
    );
    // Let the printf output fully settle into the emulator before the flush reads
    // its alt state.
    tokio::time::sleep(Duration::from_millis(150)).await;

    drop(creader);
    drop(cwriter);
    assert!(
        wait_until(|| checkpoint_path(&base_dir, "s1").exists(), Duration::from_secs(5)).await,
        "no checkpoint written for the alt session"
    );
    daemon_a.sigkill();
    drop(sreader);

    let _daemon_b = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);
    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;
    let r = create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
    assert_eq!(r["isColdRestore"], json!(true));
    assert_eq!(r["isAlternateScreen"], json!(true), "session was in alt at kill time");
    let snap = r["snapshot"].as_str().expect("cold snapshot");
    // The cold payload must land in NORMAL screen: no alt-enter (design D13).
    assert!(
        !snap.contains("\x1b[?1049h"),
        "alt cold restore must not re-enter alt: {snap:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_exits_during_relaunch_keeps_scrollback() {
    // fix #16 gate: a checkpoint exists AND the session is dead (the child died
    // with the SIGKILLed daemon — portable_pty children die with the daemon). The
    // atomic createOrAttach decision must deliver the cold payload, NEVER a
    // fresh-unseeded spawn.
    let (socket, base_dir) = unique_paths();
    let token = "tok-relaunch";
    let mut daemon_a = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let (mut sreader, _swriter) = connect_hello(&socket, token, ClientKind::Stream).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;
    create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
    write_pty(&mut cwriter, "s1", b"echo RELAUNCH_MARK_62\n").await;
    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    assert!(
        pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
            data_string_for(fs, "s1").contains("RELAUNCH_MARK_62")
        })
        .await
    );
    drop(creader);
    drop(cwriter);
    assert!(
        wait_until(|| checkpoint_path(&base_dir, "s1").exists(), Duration::from_secs(5)).await,
        "no checkpoint before kill"
    );
    daemon_a.sigkill();
    drop(sreader);

    let _daemon_b = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);
    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;
    // The VERY FIRST decision on the dead-but-checkpointed session must be a cold
    // restore carrying the scrollback — the atomic-decision guarantee (fix #16).
    let r = create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
    assert_eq!(r["isColdRestore"], json!(true), "dead+checkpointed ⇒ cold restore");
    assert!(
        r["snapshot"].as_str().unwrap_or("").contains("RELAUNCH_MARK_62"),
        "scrollback lost across relaunch: {:?}",
        r["snapshot"]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn double_mount_sticky_payload() {
    // P16: after a cold restore, a second create_or_attach for the same id returns
    // the SAME client-cached payload (a StrictMode double-mount / early reconnect
    // must not lose it), and ack_cold_restore clears the sticky cache.
    let (socket, base_dir) = unique_paths();
    let token = "tok-sticky";
    let mut daemon_a = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    // Seed a checkpoint on daemon A via raw sockets, then SIGKILL it.
    {
        let (mut sreader, _swriter) = connect_hello(&socket, token, ClientKind::Stream).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;
        create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
        write_pty(&mut cwriter, "s1", b"echo STICKY_MARKER_50\n").await;
        let mut dec = StreamDecoder::new();
        let mut frames = Vec::new();
        assert!(
            pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
                data_string_for(fs, "s1").contains("STICKY_MARKER_50")
            })
            .await
        );
        drop(creader);
        drop(cwriter);
        assert!(
            wait_until(|| checkpoint_path(&base_dir, "s1").exists(), Duration::from_secs(5)).await,
            "no checkpoint before kill"
        );
    }
    daemon_a.sigkill();

    // Fresh daemon B; drive it through the grove-core DaemonClient (the sticky
    // cache lives client-side).
    let _daemon_b = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);
    let client = DaemonClient::new(DaemonClientOptions::new(
        socket.clone(),
        daemon_token_path(&base_dir),
    ));
    let req = || CreateOrAttach {
        session_id: "s1".to_string(),
        cwd: Some("/tmp".to_string()),
        cols: 80,
        rows: 24,
        ..Default::default()
    };

    // First mount: cold restore, cached client-side.
    let first = client.create_or_attach(req()).await.expect("first create_or_attach");
    assert!(first.is_cold_restore, "first mount must cold-restore");
    let first_payload = first.cold_restore.clone().expect("cold payload");
    assert!(
        first_payload.snapshot.contains("STICKY_MARKER_50"),
        "cold payload lost the marker: {:?}",
        first_payload.snapshot
    );
    assert!(client.cold_restore_cache().contains("s1"));

    // Second mount (back-to-back, before any fresh output can invalidate): the
    // SAME cached payload is re-yielded WITHOUT another daemon round-trip.
    let second = client.create_or_attach(req()).await.expect("second create_or_attach");
    assert!(second.is_cold_restore, "double-mount must re-yield the cold payload");
    assert_eq!(
        second.cold_restore, first.cold_restore,
        "the second mount must return the identical sticky payload"
    );

    // ack clears the sticky cache (design P6/P16).
    client.ack_cold_restore("s1").await.expect("ack");
    assert!(
        !client.cold_restore_cache().contains("s1"),
        "ack_cold_restore must clear the sticky payload"
    );
}

/// Fix F1: the daemon must NOT self-terminate ~5s after launch. The old
/// `timeout(SHUTDOWN_BUDGET, serve)` bounded the ENTIRE serve loop, so every
/// process died ~5s in and unlinked its socket. Spawn the real binary, wait PAST
/// that budget, and assert the socket is still connectable and a session still
/// echoes. Slow (>6s) but MUST run in the normal suite — it is the direct guard.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn daemon_survives_past_shutdown_budget() {
    let (socket, base_dir) = unique_paths();
    let token = "tok-live";
    let _daemon = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let (mut sreader, _swriter) = connect_hello(&socket, token, ClientKind::Stream).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;
    let r = create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
    assert_eq!(r["isNew"], json!(true));

    // Wait well past the 5s budget that used to SIGKILL the daemon from the inside.
    tokio::time::sleep(Duration::from_secs(7)).await;

    // The socket must still be connectable (the old bug unlinked it at ~5s), and
    // the session must still be alive and echo fresh input.
    let (_creader2, mut cwriter2) = connect_hello(&socket, token, ClientKind::Control).await;
    write_pty(&mut cwriter2, "s1", b"echo STILL_ALIVE_9090\n").await;
    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    assert!(
        pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
            data_string_for(fs, "s1").contains("STILL_ALIVE_9090")
        })
        .await,
        "session did not echo after 7s — the daemon self-terminated (F1 regression)"
    );
    // `_daemon` drops → SIGKILL cleanup, so a live daemon never leaks.
}

/// Fix F3: a SIGTERM (launchd on a clean macOS reboot) must flush a final
/// checkpoint but leave history UNCLEAN (`ended_at` null) so the session stays
/// Tier-B cold-restorable — the old signal path stamped `ended_at`, suppressing
/// cold restore and regressing vs tmux.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sigterm_leaves_history_unclean_and_cold_restorable() {
    let (socket, base_dir) = unique_paths();
    let token = "tok-term";
    let mut daemon_a = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);

    let (mut sreader, _swriter) = connect_hello(&socket, token, ClientKind::Stream).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;
    let r = create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
    assert_eq!(r["isNew"], json!(true));
    write_pty(&mut cwriter, "s1", b"echo TERM_MARKER_4242\n").await;
    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    assert!(
        pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
            data_string_for(fs, "s1").contains("TERM_MARKER_4242")
        })
        .await,
        "marker never streamed"
    );

    // SIGTERM the daemon — the signal handler RUNS (flush unclean, then exit).
    daemon_a.sigterm();
    assert!(
        daemon_a.wait_exit(Duration::from_secs(8)).await,
        "daemon did not exit after SIGTERM"
    );
    drop(sreader);

    // F3 crux: SIGTERM must NOT stamp ended_at, and must have flushed a checkpoint.
    assert_eq!(
        meta_ended_is_null(&base_dir, "s1"),
        Some(true),
        "SIGTERM must leave history UNCLEAN — stamping ended_at suppresses cold restore (F3)"
    );
    assert!(
        checkpoint_path(&base_dir, "s1").exists(),
        "SIGTERM must flush a final checkpoint before exit"
    );

    // A fresh daemon on the same endpoint cold-restores the SIGTERM'd session.
    let _daemon_b = spawn_daemon(&socket, token, &base_dir);
    assert!(wait_ready(&socket, &daemon_token_path(&base_dir), Duration::from_secs(5)).await);
    let (mut creader, mut cwriter) = connect_hello(&socket, token, ClientKind::Control).await;
    let r = create_or_attach(&mut creader, &mut cwriter, 1, "s1").await;
    assert_eq!(
        r["isColdRestore"],
        json!(true),
        "a SIGTERM-terminated session must cold-restore (F3)"
    );
    let snap = r["snapshot"].as_str().expect("cold snapshot string");
    assert!(
        snap.contains("TERM_MARKER_4242"),
        "cold payload lost the distinctive bytes: {snap:?}"
    );
}
