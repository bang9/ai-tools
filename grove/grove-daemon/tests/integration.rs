//! grove-daemon integration tests (design P2 daemon-mode gate).
//!
//! Each test starts a real daemon on a temp unix socket in-process and drives it
//! with a raw NDJSON control client + a binary GCKL stream client, exercising a
//! real `/bin/sh` PTY. No external deps — always runnable, like the tmux suite.
//!
//! Covered: echo round-trip; Exit ordered strictly after last Data; bracketed-
//! paste multi-chunk body + trailing CR in order (fix #5); version-mismatch
//! rejected; token-mismatch rejected; concurrent sessions isolated.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine;
use grove_core::daemon::framing::{StreamDecoder, StreamFrame, StreamFrameKind};
use grove_core::daemon::protocol::{
    decode_ndjson_line, encode_ndjson_line, ClientKind, ControlMessage, Hello, HelloAck, Notify,
    RpcReply, RpcRequest, GROVE_DAEMON_PROTOCOL_VERSION as VERSION,
};
use grove_daemon::server::Daemon;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};

// --- harness -------------------------------------------------------------

fn unique_socket_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    // Why /tmp not the scratchpad: unix socket paths have a ~104-byte limit; a
    // short path keeps bind() from failing with ENAMETOOLONG.
    PathBuf::from(format!(
        "/tmp/grove-daemon-it-{}-{n}.sock",
        std::process::id()
    ))
}

async fn setup(token: &str) -> (std::sync::Arc<Daemon>, PathBuf) {
    let sock = unique_socket_path();
    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock).expect("bind temp socket");
    // A unique temp history root per daemon (design §5); derived from the socket
    // path so parallel tests never share a tree.
    let hist_root = sock.with_extension("hist");
    let daemon = Daemon::new(token.to_string(), hist_root);
    let serving = std::sync::Arc::clone(&daemon);
    tokio::spawn(async move { serving.serve(listener).await });
    (daemon, sock)
}

async fn write_line<W: AsyncWriteExt + Unpin, T: Serialize>(writer: &mut W, msg: &T) {
    let line = encode_ndjson_line(msg).expect("encode ndjson");
    writer.write_all(line.as_bytes()).await.expect("write line");
    writer.flush().await.expect("flush");
}

/// Connect + hello; returns the split halves on ok, or the reject reason.
async fn connect_hello(
    sock: &Path,
    version: u32,
    token: &str,
    kind: ClientKind,
) -> Result<(BufReader<OwnedReadHalf>, OwnedWriteHalf), String> {
    let stream = UnixStream::connect(sock).await.expect("connect");
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    let hello = Hello {
        version,
        token: token.to_string(),
        client_id: "test".to_string(),
        kind,
    };
    write_line(&mut write_half, &hello).await;
    let mut line = String::new();
    reader.read_line(&mut line).await.expect("read ack");
    let ack: HelloAck = decode_ndjson_line(&line).expect("decode ack");
    if ack.ok {
        Ok((reader, write_half))
    } else {
        Err(ack.error.unwrap_or_default())
    }
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

async fn notify(writer: &mut OwnedWriteHalf, method: &str, params: Value) {
    let msg = ControlMessage::Notify(Notify {
        method: method.to_string(),
        params,
    });
    write_line(writer, &msg).await;
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

async fn write_pty(writer: &mut OwnedWriteHalf, session_id: &str, data: &[u8]) {
    notify(
        writer,
        "write",
        json!({ "sessionId": session_id, "dataB64": b64(data) }),
    )
    .await;
}

/// Pump the stream socket until `done` is satisfied or the deadline elapses.
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

// --- tests ---------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn echo_round_trip_through_real_pty() {
    let (_daemon, sock) = setup("tok-echo").await;
    let (mut sreader, _swriter) =
        connect_hello(&sock, VERSION, "tok-echo", ClientKind::Stream)
            .await
            .expect("stream hello ok");
    // Let the server register the stream subscriber before output starts.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) =
        connect_hello(&sock, VERSION, "tok-echo", ClientKind::Control)
            .await
            .expect("control hello ok");

    let reply = rpc(
        &mut creader,
        &mut cwriter,
        1,
        "createOrAttach",
        json!({ "sessionId": "s1", "cwd": "/tmp", "cols": 80, "rows": 24 }),
    )
    .await;
    assert_eq!(reply.result.expect("result")["isNew"], json!(true));

    write_pty(&mut cwriter, "s1", b"echo GROVE_MARKER_9137\n").await;

    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    let ok = pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
        data_string_for(fs, "s1").contains("GROVE_MARKER_9137")
    })
    .await;
    assert!(
        ok,
        "did not observe echoed marker; got: {:?}",
        data_string_for(&frames, "s1")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exit_frame_is_ordered_after_last_data() {
    let (_daemon, sock) = setup("tok-exit").await;
    let (mut sreader, _swriter) = connect_hello(&sock, VERSION, "tok-exit", ClientKind::Stream)
        .await
        .expect("stream hello ok");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&sock, VERSION, "tok-exit", ClientKind::Control)
        .await
        .expect("control hello ok");

    rpc(
        &mut creader,
        &mut cwriter,
        1,
        "createOrAttach",
        json!({ "sessionId": "s1", "cwd": "/tmp", "cols": 80, "rows": 24 }),
    )
    .await;

    // Print a marker, then exit 7. The Exit frame must land AFTER the marker Data.
    write_pty(&mut cwriter, "s1", b"printf 'BYE_TOKEN_42\\n'; exit 7\n").await;

    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    let ok = pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
        fs.iter()
            .any(|f| f.kind == StreamFrameKind::Exit && f.session_id == "s1")
    })
    .await;
    assert!(ok, "no Exit frame observed");

    let exit_pos = frames
        .iter()
        .position(|f| f.kind == StreamFrameKind::Exit && f.session_id == "s1")
        .expect("exit frame present");

    // The marker must appear in Data BEFORE the Exit frame — never after.
    let before_exit: Vec<StreamFrame> = frames[..exit_pos].to_vec();
    assert!(
        data_string_for(&before_exit, "s1").contains("BYE_TOKEN_42"),
        "marker did not precede Exit; before-exit data: {:?}",
        data_string_for(&before_exit, "s1")
    );
    assert!(
        !frames[exit_pos + 1..]
            .iter()
            .any(|f| f.kind == StreamFrameKind::Data && f.session_id == "s1"),
        "Data frame arrived AFTER Exit — ordering violated"
    );

    let status = frames[exit_pos].as_exit().expect("decode exit status");
    assert_eq!(status.code, Some(7), "exit code should be 7");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bracketed_paste_multi_chunk_body_and_cr_arrive_in_order() {
    let (_daemon, sock) = setup("tok-paste").await;
    let (mut sreader, _swriter) = connect_hello(&sock, VERSION, "tok-paste", ClientKind::Stream)
        .await
        .expect("stream hello ok");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&sock, VERSION, "tok-paste", ClientKind::Control)
        .await
        .expect("control hello ok");

    rpc(
        &mut creader,
        &mut cwriter,
        1,
        "createOrAttach",
        json!({ "sessionId": "s1", "cwd": "/tmp", "cols": 80, "rows": 24 }),
    )
    .await;

    // A bracketed paste delivered as SEPARATE write notifies: start marker, two
    // body chunks, end marker, then the trailing CR. The SHARED PtyWriter FIFO
    // must deliver them to the child in exactly this order, so the tty echo shows
    // the two body chunks contiguous (fix #5).
    write_pty(&mut cwriter, "s1", b"\x1b[200~").await;
    write_pty(&mut cwriter, "s1", b"PASTE_BODY_ONE-").await;
    write_pty(&mut cwriter, "s1", b"PASTE_BODY_TWO-").await;
    write_pty(&mut cwriter, "s1", b"\x1b[201~").await;
    write_pty(&mut cwriter, "s1", b"\r").await;

    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    let ok = pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
        data_string_for(fs, "s1").contains("PASTE_BODY_ONE-PASTE_BODY_TWO-")
    })
    .await;
    assert!(
        ok,
        "multi-chunk paste body not contiguous / in order; got: {:?}",
        data_string_for(&frames, "s1")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hello_with_wrong_version_is_rejected() {
    let (_daemon, sock) = setup("tok-ver").await;
    let err = connect_hello(&sock, VERSION + 1, "tok-ver", ClientKind::Control)
        .await
        .expect_err("version mismatch must be rejected");
    assert!(err.contains("version"), "reason was: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hello_with_wrong_token_is_rejected() {
    let (_daemon, sock) = setup("tok-real").await;
    let err = connect_hello(&sock, VERSION, "tok-wrong", ClientKind::Control)
        .await
        .expect_err("token mismatch must be rejected");
    assert!(err.contains("token"), "reason was: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn killing_one_session_leaves_siblings_unaffected() {
    let (_daemon, sock) = setup("tok-iso").await;
    let (mut sreader, _swriter) = connect_hello(&sock, VERSION, "tok-iso", ClientKind::Stream)
        .await
        .expect("stream hello ok");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&sock, VERSION, "tok-iso", ClientKind::Control)
        .await
        .expect("control hello ok");

    for id in ["s1", "s2"] {
        rpc(
            &mut creader,
            &mut cwriter,
            1,
            "createOrAttach",
            json!({ "sessionId": id, "cwd": "/tmp", "cols": 80, "rows": 24 }),
        )
        .await;
    }

    // Kill s1; its Exit must appear on the stream.
    let reply = rpc(&mut creader, &mut cwriter, 2, "kill", json!({ "sessionId": "s1" })).await;
    assert!(reply.error.is_none(), "kill errored: {:?}", reply.error);

    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    let saw_exit = pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
        fs.iter()
            .any(|f| f.kind == StreamFrameKind::Exit && f.session_id == "s1")
    })
    .await;
    assert!(saw_exit, "s1 did not emit Exit after kill");

    // The sibling s2 is unaffected: it still echoes.
    write_pty(&mut cwriter, "s2", b"echo SIB_ALIVE_55\n").await;
    let alive = pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
        data_string_for(fs, "s2").contains("SIB_ALIVE_55")
    })
    .await;
    assert!(alive, "sibling s2 stopped responding after s1 was killed");

    // And listSessions still reports s2 alive.
    let reply = rpc(&mut creader, &mut cwriter, 3, "listSessions", Value::Null).await;
    let sessions = reply.result.expect("listSessions result");
    let s2 = sessions
        .as_array()
        .expect("array")
        .iter()
        .find(|s| s["sessionId"] == json!("s2"))
        .expect("s2 present");
    assert_eq!(s2["isAlive"], json!(true), "s2 should still be alive");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn burst_of_writes_preserves_order_with_slow_consumer() {
    // Fix #1: a burst of ordered `write` notifies must reach the child in exactly
    // the sent order, even while the foreground child is busy (slow to consume).
    // The dedicated per-session forwarder thread drains the FIFO in receive order,
    // so the tty echo shows the pasted chunks contiguous and in sequence — a
    // strengthening of the fix-#5 paste test with many chunks + a slow consumer.
    let (_daemon, sock) = setup("tok-burst").await;
    let (mut sreader, _swriter) = connect_hello(&sock, VERSION, "tok-burst", ClientKind::Stream)
        .await
        .expect("stream hello ok");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&sock, VERSION, "tok-burst", ClientKind::Control)
        .await
        .expect("control hello ok");

    rpc(
        &mut creader,
        &mut cwriter,
        1,
        "createOrAttach",
        json!({ "sessionId": "s1", "cwd": "/tmp", "cols": 200, "rows": 24 }),
    )
    .await;

    // Make the foreground shell busy so it drains input slowly; the tty line
    // discipline still echoes the pasted bytes in the order they are written.
    write_pty(&mut cwriter, "s1", b"sleep 0.4\n").await;

    // Blast many chunks as a single bracketed paste, each a distinct ordered
    // token, with NO trailing CR so the pasted line is echoed but never executed.
    let n = 48usize;
    let mut expected = String::new();
    write_pty(&mut cwriter, "s1", b"\x1b[200~").await;
    for i in 0..n {
        let tok = format!("Q{i:02}-");
        expected.push_str(&tok);
        write_pty(&mut cwriter, "s1", tok.as_bytes()).await;
    }
    write_pty(&mut cwriter, "s1", b"\x1b[201~").await;

    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    let expected_for_done = expected.clone();
    let ok = pump_frames(
        &mut sreader,
        &mut dec,
        &mut frames,
        Duration::from_secs(8),
        move |fs| data_string_for(fs, "s1").contains(&expected_for_done),
    )
    .await;
    assert!(
        ok,
        "burst of writes not contiguous / in order under a slow consumer; got: {:?}",
        data_string_for(&frames, "s1")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn new_stream_keeps_receiving_after_old_stream_teardown() {
    // Fix #2: an older stream connection tearing down must not wipe a newer
    // subscriber. Connect A, then B (B becomes the live subscriber), drop A, and
    // assert B still receives session output after A's teardown ran clear().
    let (_daemon, sock) = setup("tok-gen").await;

    let (a_reader, a_writer) = connect_hello(&sock, VERSION, "tok-gen", ClientKind::Stream)
        .await
        .expect("stream A hello ok");
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (mut breader, _bwriter) = connect_hello(&sock, VERSION, "tok-gen", ClientKind::Stream)
        .await
        .expect("stream B hello ok");
    // B is now the current subscriber (higher generation than A).
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Drop A entirely; the server detects EOF and runs A's teardown clear(genA),
    // which must NOT null B's subscriber slot.
    drop(a_reader);
    drop(a_writer);
    tokio::time::sleep(Duration::from_millis(150)).await;

    let (mut creader, mut cwriter) = connect_hello(&sock, VERSION, "tok-gen", ClientKind::Control)
        .await
        .expect("control hello ok");
    rpc(
        &mut creader,
        &mut cwriter,
        1,
        "createOrAttach",
        json!({ "sessionId": "s1", "cwd": "/tmp", "cols": 80, "rows": 24 }),
    )
    .await;

    write_pty(&mut cwriter, "s1", b"echo GEN_SURVIVOR_88\n").await;

    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    let ok = pump_frames(
        &mut breader,
        &mut dec,
        &mut frames,
        Duration::from_secs(5),
        |fs| data_string_for(fs, "s1").contains("GEN_SURVIVOR_88"),
    )
    .await;
    assert!(
        ok,
        "newer stream stopped receiving after older stream teardown; got: {:?}",
        data_string_for(&frames, "s1")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dead_session_is_reaped_and_id_recreated_fresh() {
    // Fix #3: after a child exits, the session must emit Exit, drop its master fd,
    // and be reaped from the map so the same id createOrAttaches fresh (isNew=true)
    // — and repeated create/exit cycles must not leak fds.
    let (_daemon, sock) = setup("tok-reap").await;
    let (mut sreader, _swriter) = connect_hello(&sock, VERSION, "tok-reap", ClientKind::Stream)
        .await
        .expect("stream hello ok");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&sock, VERSION, "tok-reap", ClientKind::Control)
        .await
        .expect("control hello ok");

    let fd_count = || std::fs::read_dir("/dev/fd").map(|d| d.count()).unwrap_or(0);
    // Warm up one cycle before measuring so lazy allocations don't skew the count.
    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();

    let cycles = 8usize;
    let mut baseline = 0usize;
    for cycle in 0..cycles {
        let id = format!("reap-{cycle}");
        let reply = rpc(
            &mut creader,
            &mut cwriter,
            (10 + cycle) as u64,
            "createOrAttach",
            json!({ "sessionId": id, "cwd": "/tmp", "cols": 80, "rows": 24 }),
        )
        .await;
        assert_eq!(
            reply.result.expect("result")["isNew"],
            json!(true),
            "cycle {cycle}: fresh id should be new"
        );

        // Exit the child; its Exit frame must appear on the stream.
        write_pty(&mut cwriter, &id, b"exit 0\n").await;
        let idc = id.clone();
        let saw_exit = pump_frames(
            &mut sreader,
            &mut dec,
            &mut frames,
            Duration::from_secs(5),
            move |fs| {
                fs.iter()
                    .any(|f| f.kind == StreamFrameKind::Exit && f.session_id == idc)
            },
        )
        .await;
        assert!(saw_exit, "cycle {cycle}: no Exit frame after child exit");

        // Poll until the reaper has removed the dead session from the map.
        let mut reaped = false;
        for _ in 0..100 {
            let reply = rpc(
                &mut creader,
                &mut cwriter,
                (1000 + cycle) as u64,
                "listSessions",
                Value::Null,
            )
            .await;
            let present = reply
                .result
                .expect("listSessions result")
                .as_array()
                .expect("array")
                .iter()
                .any(|s| s["sessionId"] == json!(id));
            if !present {
                reaped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(reaped, "cycle {cycle}: dead session {id} was never reaped");

        if cycle == 0 {
            baseline = fd_count();
        }
    }

    // fd count must be stable across cycles — a leaked master fd per cycle would
    // grow it by ~`cycles`. Allow a small margin for runtime/socket churn.
    let after = fd_count();
    assert!(
        after <= baseline + 4,
        "fd count grew from {baseline} to {after} across {cycles} create/exit cycles (leak?)"
    );

    // Recreating a reaped id must spawn fresh, not attach to a corpse.
    let reply = rpc(
        &mut creader,
        &mut cwriter,
        9000,
        "createOrAttach",
        json!({ "sessionId": "reap-0", "cwd": "/tmp", "cols": 80, "rows": 24 }),
    )
    .await;
    assert_eq!(
        reply.result.expect("result")["isNew"],
        json!(true),
        "recreating a reaped id must be a fresh create"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_create_or_attach_spawns_exactly_one_pty() {
    // Fix #4 (TOCTOU): two concurrent createOrAttach for the same id must spawn
    // exactly ONE pty and both callers must get coherent replies (one isNew=true,
    // one isNew=false — never two trues, which would signal a duplicate spawn).
    let (_daemon, sock) = setup("tok-race").await;
    let (mut c1r, mut c1w) = connect_hello(&sock, VERSION, "tok-race", ClientKind::Control)
        .await
        .expect("control 1 hello ok");
    let (mut c2r, mut c2w) = connect_hello(&sock, VERSION, "tok-race", ClientKind::Control)
        .await
        .expect("control 2 hello ok");

    let params = json!({ "sessionId": "dup", "cwd": "/tmp", "cols": 80, "rows": 24 });
    let p1 = params.clone();
    let p2 = params.clone();
    let fut1 = async move {
        rpc(&mut c1r, &mut c1w, 1, "createOrAttach", p1).await
    };
    let fut2 = async move {
        rpc(&mut c2r, &mut c2w, 1, "createOrAttach", p2).await
    };
    let (r1, r2) = tokio::join!(fut1, fut2);

    let is_new = |r: &RpcReply| -> bool {
        r.result
            .as_ref()
            .and_then(|v| v.get("isNew"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    assert!(r1.error.is_none(), "caller 1 errored: {:?}", r1.error);
    assert!(r2.error.is_none(), "caller 2 errored: {:?}", r2.error);
    let new_count = [is_new(&r1), is_new(&r2)].iter().filter(|b| **b).count();
    assert_eq!(
        new_count, 1,
        "exactly one caller must spawn the pty (isNew=true); got r1={:?} r2={:?}",
        r1.result, r2.result
    );

    // Exactly one session must exist in the map.
    let (mut cr, mut cw) = connect_hello(&sock, VERSION, "tok-race", ClientKind::Control)
        .await
        .expect("control 3 hello ok");
    let reply = rpc(&mut cr, &mut cw, 2, "listSessions", Value::Null).await;
    let dup_count = reply
        .result
        .expect("listSessions result")
        .as_array()
        .expect("array")
        .iter()
        .filter(|s| s["sessionId"] == json!("dup"))
        .count();
    assert_eq!(dup_count, 1, "exactly one 'dup' session must exist");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hello_with_empty_token_is_rejected() {
    // Fix #5: an empty token must be rejected at Hello (defense in depth).
    let (_daemon, sock) = setup("tok-nonempty").await;
    let err = connect_hello(&sock, VERSION, "", ClientKind::Control)
        .await
        .expect_err("empty token must be rejected");
    assert!(err.contains("token"), "reason was: {err}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn check_pty_spawn_health_probe_succeeds() {
    let (_daemon, sock) = setup("tok-health").await;
    let (mut creader, mut cwriter) = connect_hello(&sock, VERSION, "tok-health", ClientKind::Control)
        .await
        .expect("control hello ok");
    let reply = rpc(
        &mut creader,
        &mut cwriter,
        1,
        "checkPtySpawnHealth",
        Value::Null,
    )
    .await;
    assert_eq!(reply.result.expect("result")["ok"], json!(true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn warm_reattach_returns_vt_snapshot_with_screen_and_dims() {
    // Design P5/P9/S15: after output has landed, a second createOrAttach for the
    // same id returns isNew=false with a warm VT snapshot carrying the current
    // screen, the applied dims, and isReattach=true — the DaemonSnapshot payload.
    let (_daemon, sock) = setup("tok-warm").await;
    let (mut sreader, _swriter) = connect_hello(&sock, VERSION, "tok-warm", ClientKind::Stream)
        .await
        .expect("stream hello ok");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&sock, VERSION, "tok-warm", ClientKind::Control)
        .await
        .expect("control hello ok");

    let reply = rpc(
        &mut creader,
        &mut cwriter,
        1,
        "createOrAttach",
        json!({ "sessionId": "w1", "cwd": "/tmp", "cols": 90, "rows": 30 }),
    )
    .await;
    assert_eq!(reply.result.expect("result")["isNew"], json!(true));

    write_pty(&mut cwriter, "w1", b"echo WARM_SNAP_5521\n").await;
    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    let ok = pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_secs(5), |fs| {
        data_string_for(fs, "w1").contains("WARM_SNAP_5521")
    })
    .await;
    assert!(ok, "did not observe echoed marker before deadline");
    // Let the shell settle so the marker is on the emulator's screen.
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Re-attach: warm snapshot path.
    let reply = rpc(
        &mut creader,
        &mut cwriter,
        2,
        "createOrAttach",
        json!({ "sessionId": "w1", "cwd": "/tmp", "cols": 90, "rows": 30 }),
    )
    .await;
    let result = reply.result.expect("attach result");
    assert_eq!(result["isNew"], json!(false), "second attach must be warm");
    assert_eq!(result["isReattach"], json!(true));
    assert_eq!(result["cols"], json!(90));
    assert_eq!(result["rows"], json!(30));
    let snapshot = result["snapshot"].as_str().expect("snapshot string");
    assert!(
        snapshot.contains("WARM_SNAP_5521"),
        "warm snapshot missing the on-screen marker: {snapshot:?}"
    );

    // getSnapshot RPC returns the same shape.
    let snap_rpc = rpc(&mut creader, &mut cwriter, 3, "getSnapshot", json!({ "sessionId": "w1" })).await;
    let snap_res = snap_rpc.result.expect("getSnapshot result");
    assert_eq!(snap_res["cols"], json!(90));
    assert!(snap_res["snapshot"].as_str().unwrap().contains("WARM_SNAP_5521"));

    // getAppliedSize reflects the emulator dims (design G8).
    let size = rpc(&mut creader, &mut cwriter, 4, "getAppliedSize", json!({ "sessionId": "w1" })).await;
    let size_res = size.result.expect("size result");
    assert_eq!(size_res["cols"], json!(90));
    assert_eq!(size_res["rows"], json!(30));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_cwd_and_title_read_from_mode_state() {
    // Design S11/P15: the daemon reports cwd (OSC 7) + title (OSC 0/2) parsed by
    // the emulator's ModeState — no tmux shell-out. Drive OSC bytes through the
    // PTY via `printf` so the emulator scans real cwd/title escapes.
    let (_daemon, sock) = setup("tok-osc").await;
    let (mut sreader, _swriter) = connect_hello(&sock, VERSION, "tok-osc", ClientKind::Stream)
        .await
        .expect("stream hello ok");
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (mut creader, mut cwriter) = connect_hello(&sock, VERSION, "tok-osc", ClientKind::Control)
        .await
        .expect("control hello ok");
    // TERM=dumb keeps shell rc files from repainting the title at every prompt
    // (Ubuntu's default bashrc PS1 emits OSC 0 under TERM=xterm*, which would
    // overwrite the printf'd title before the poll below observes it).
    rpc(
        &mut creader,
        &mut cwriter,
        1,
        "createOrAttach",
        json!({ "sessionId": "o1", "cwd": "/tmp", "cols": 80, "rows": 24, "env": { "TERM": "dumb" } }),
    )
    .await;

    // printf emits the OSC 7 cwd + OSC 2 title escapes to the PTY.
    write_pty(
        &mut cwriter,
        "o1",
        b"printf '\\033]7;file://host/tmp/grovecwd\\007\\033]2;grove-title\\007'\n",
    )
    .await;

    let mut dec = StreamDecoder::new();
    let mut frames = Vec::new();
    // Wait for the shell to have echoed/executed; then poll the RPC.
    let mut got_cwd = String::new();
    let mut got_title = String::new();
    for attempt in 0..40 {
        let _ = pump_frames(&mut sreader, &mut dec, &mut frames, Duration::from_millis(100), |_| false).await;
        let cwd = rpc(&mut creader, &mut cwriter, 10 + attempt, "getCwd", json!({ "sessionId": "o1" })).await;
        got_cwd = cwd.result.expect("cwd result")["cwd"].as_str().unwrap_or("").to_string();
        let title = rpc(&mut creader, &mut cwriter, 100 + attempt, "getTitle", json!({ "sessionId": "o1" })).await;
        got_title = title.result.expect("title result")["title"].as_str().unwrap_or("").to_string();
        if got_cwd == "/tmp/grovecwd" && got_title == "grove-title" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(got_cwd, "/tmp/grovecwd", "OSC 7 cwd not tracked");
    assert_eq!(got_title, "grove-title", "OSC 2 title not tracked");
}
