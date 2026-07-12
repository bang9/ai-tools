//! The agent-status channel, driven over a REAL unix socket against a REAL daemon
//! with a REAL `/bin/sh` PTY session (agent-status design §3.2/§3.3/§5, Step 4).
//!
//! ## What is real here and what is faked, and why
//!
//! Everything on the wire is real: the socket, the `role:"agent"` handshake, the
//! NDJSON envelopes, the `agentClaim`/`agentEvent` RPCs, the session, and the
//! `pollBells` read path the renderer consumes.
//!
//! The KERNEL ORACLE is injected, for one structural reason: the daemon takes the
//! claimant's pid from `getsockopt(LOCAL_PEERPID)`, so the claimant is necessarily
//! THIS TEST PROCESS — and a test process cannot have the pane's controlling
//! terminal, nor can it SIGKILL itself to prove the badge clears.
//!
//! So [`PaneKernel`] rewrites exactly two facts and passes everything else through
//! to the REAL `sysctl`:
//!   - the claimant's and the pane shell's `e_tdev`, so the ctty check has something
//!     to agree (or disagree) about — this is what the real `grove-agent` gets for
//!     free by being a child of the pane's shell;
//!   - the claimant's pid, ALIASED onto a real `/bin/sleep` child we own.
//!
//! That aliasing is what makes the kill test honest: `p_stat`, `p_starttime` and
//! existence all come from the live kernel, so `sigkill_clears_the_badge…` performs a
//! REAL `SIGKILL` on a REAL process and observes the REAL zombie→reaped transition
//! through the REAL `sysctl` path. Nothing in it is simulated except which pid the
//! socket reported.

// macOS-only: these drive the REAL agent socket, whose claim path needs the peer pid
// (LOCAL_PEERPID) and process facts (sysctl KERN_PROC_PID) — both macOS-only, matching
// grove's macOS-only shipping target. The pure map_event/resolve logic is covered on
// every target by the FakeKernel unit tests in `agent.rs`.
#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use grove_core::daemon::protocol::{
    decode_ndjson_line, derive_session_key, encode_ndjson_line, AgentClaimParams, AgentClaimResult,
    AgentEventParams, ClientKind, ControlMessage, Hello, HelloAck, RpcReply, RpcRequest,
    GROVE_DAEMON_PROTOCOL_VERSION as VERSION, METHOD_AGENT_CLAIM, METHOD_AGENT_EVENT,
};
use grove_daemon::kernel::{system_kernel, Kernel, ProcFacts};
use grove_daemon::server::Daemon;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};

const TOKEN: &str = "daemon-token-not-in-any-pane";
/// The pane shell's controlling terminal, as the injected kernel reports it.
const PANE_TDEV: i32 = 0x1000_0006;
/// Some OTHER pane's terminal.
const OTHER_TDEV: i32 = 0x1000_000C;

// ---------------------------------------------------------------------------
// The injected kernel (see the header)
// ---------------------------------------------------------------------------

struct PaneKernel {
    real: Arc<dyn Kernel>,
    /// The pane shell's pid → reported with `PANE_TDEV`. Only known after the session
    /// spawns, so it is a shared cell rather than a constant.
    shell_pid: Arc<std::sync::Mutex<i32>>,
    /// The connecting process's pid (this test) → reported with `claimant_tdev`, and
    /// with the LIVE facts of `proxy_pid` (a real child we can really kill).
    claimant_pid: i32,
    claimant_tdev: i32,
    proxy_pid: i32,
}

impl Kernel for PaneKernel {
    fn facts(&self, pid: i32) -> Option<ProcFacts> {
        if pid == self.claimant_pid {
            // Real stat / real p_starttime / real existence — of a process we own.
            let real = self.real.facts(self.proxy_pid)?;
            return Some(ProcFacts {
                pid: self.claimant_pid,
                tdev: self.claimant_tdev,
                ..real
            });
        }
        let shell = *self.shell_pid.lock().unwrap();
        if shell != 0 && pid == shell {
            let real = self.real.facts(shell)?;
            return Some(ProcFacts {
                tdev: PANE_TDEV,
                ..real
            });
        }
        self.real.facts(pid)
    }
}

/// A `/bin/sleep` we own, so a test can really SIGKILL a really-running process.
struct Sleeper(std::process::Child);

impl Sleeper {
    fn spawn() -> Self {
        Self(
            std::process::Command::new("/bin/sleep")
                .arg("120")
                .spawn()
                .expect("spawn /bin/sleep"),
        )
    }
    fn pid(&self) -> i32 {
        self.0.id() as i32
    }
    fn sigkill(&self) {
        // SAFETY: a pid we spawned and have not reaped.
        unsafe { libc::kill(self.pid(), libc::SIGKILL) };
    }
    fn reap(&mut self) {
        let _ = self.0.wait();
    }
}

impl Drop for Sleeper {
    fn drop(&mut self) {
        self.sigkill();
        self.reap();
    }
}

// ---------------------------------------------------------------------------
// Socket harness
// ---------------------------------------------------------------------------

fn unique_socket_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    // Short path: sun_path caps at ~104 bytes on macOS.
    PathBuf::from(format!(
        "/tmp/grove-agent-it-{}-{n}.sock",
        std::process::id()
    ))
}

async fn write_line<W: AsyncWriteExt + Unpin, T: Serialize>(writer: &mut W, msg: &T) {
    let line = encode_ndjson_line(msg).expect("encode");
    writer.write_all(line.as_bytes()).await.expect("write");
    writer.flush().await.expect("flush");
}

async fn hello(sock: &Path, token: &str, kind: ClientKind) -> Result<Conn, String> {
    let stream = UnixStream::connect(sock).await.expect("connect");
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    write_line(
        &mut write_half,
        &Hello {
            version: VERSION,
            token: token.to_string(),
            client_id: "agent".to_string(),
            kind,
        },
    )
    .await;
    let mut line = String::new();
    reader.read_line(&mut line).await.expect("read ack");
    let ack: HelloAck = decode_ndjson_line(&line).expect("decode ack");
    if ack.ok {
        Ok(Conn {
            reader,
            writer: write_half,
            next_id: 0,
        })
    } else {
        Err(ack.error.unwrap_or_default())
    }
}

struct Conn {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
    next_id: u64,
}

impl Conn {
    /// One correlated RPC, with a hard timeout: NOTHING on the agent's critical path
    /// may hang, so every assertion below also asserts "the daemon answered".
    async fn rpc(&mut self, method: &str, params: Value) -> RpcReply {
        self.next_id += 1;
        let id = self.next_id;
        write_line(
            &mut self.writer,
            &ControlMessage::Request(RpcRequest {
                id,
                method: method.to_string(),
                params,
            }),
        )
        .await;
        let deadline = Duration::from_secs(5);
        loop {
            let mut line = String::new();
            let n = tokio::time::timeout(deadline, self.reader.read_line(&mut line))
                .await
                .unwrap_or_else(|_| {
                    panic!("the daemon never answered {method} — it must NEVER hang")
                })
                .expect("read reply");
            assert!(n > 0, "the daemon closed the connection on {method}");
            if let Ok(ControlMessage::Reply(reply)) = decode_ndjson_line::<ControlMessage>(&line) {
                if reply.id == id {
                    return reply;
                }
            }
        }
    }
}

/// A live daemon on a temp socket, with one real PTY session, and a kernel that
/// reports the claimant as sharing (or not sharing) the pane's terminal.
struct Harness {
    daemon: Arc<Daemon>,
    sock: PathBuf,
    session_id: String,
    key: String,
    sleeper: Sleeper,
    hist_root: PathBuf,
}

impl Harness {
    async fn boot(claimant_tdev: i32) -> Self {
        let sock = unique_socket_path();
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).expect("bind");
        let hist_root = sock.with_extension("hist");
        let session_id = "grove-ab12-p1".to_string();
        let sleeper = Sleeper::spawn();

        let shell_pid = Arc::new(std::sync::Mutex::new(0i32));
        let kernel = Arc::new(PaneKernel {
            real: system_kernel(),
            shell_pid: Arc::clone(&shell_pid),
            claimant_pid: std::process::id() as i32,
            claimant_tdev,
            proxy_pid: sleeper.pid(),
        });

        let daemon = Daemon::with_kernel(
            TOKEN.to_string(),
            hist_root.clone(),
            kernel as Arc<dyn Kernel>,
        );
        let serving = Arc::clone(&daemon);
        tokio::spawn(async move { serving.serve(listener).await });

        // Spawn the pane's real shell, then teach the kernel which pid it is.
        let mut control = hello(&sock, TOKEN, ClientKind::Control)
            .await
            .expect("control hello");
        control
            .rpc(
                "createOrAttach",
                json!({ "sessionId": session_id, "cwd": "/tmp", "cols": 80, "rows": 24 }),
            )
            .await;
        let list = control.rpc("listSessions", Value::Null).await;
        let pid = list.result.as_ref().unwrap()[0]["pid"]
            .as_i64()
            .expect("the session reports its shell pid") as i32;
        *shell_pid.lock().unwrap() = pid;

        Self {
            daemon,
            sock,
            key: derive_session_key(TOKEN, &session_id),
            session_id,
            sleeper,
            hist_root,
        }
    }

    /// A `role:"agent"` connection presenting the pane's derived session key.
    async fn agent(&self) -> Conn {
        hello(&self.sock, &self.key, ClientKind::Agent)
            .await
            .expect("an agent hello is accepted WITHOUT a control client attached")
    }

    async fn claim(&self, tool: &str) -> Result<String, RpcReply> {
        let mut conn = self.agent().await;
        let reply = conn
            .rpc(
                METHOD_AGENT_CLAIM,
                serde_json::to_value(AgentClaimParams {
                    session_id: self.session_id.clone(),
                    tool: tool.to_string(),
                })
                .unwrap(),
            )
            .await;
        match reply.result.clone() {
            Some(v) => Ok(serde_json::from_value::<AgentClaimResult>(v)
                .expect("claim ack")
                .claim_id),
            None => Err(reply),
        }
    }

    async fn event(&self, claim_id: &str, event: &str, tool_name: Option<&str>, at_ns: u64) {
        let mut conn = self.agent().await;
        let reply = conn
            .rpc(
                METHOD_AGENT_EVENT,
                serde_json::to_value(AgentEventParams {
                    session_id: self.session_id.clone(),
                    claim_id: claim_id.to_string(),
                    event: event.to_string(),
                    tool_name: tool_name.map(str::to_string),
                    at_ns,
                })
                .unwrap(),
            )
            .await;
        assert!(
            reply.error.is_none(),
            "an agentEvent must never error back at the agent: {:?}",
            reply.error
        );
    }

    /// The badge, exactly as the renderer would receive it in `PtyBellEvent.aiStatus`.
    async fn badge(&self) -> Option<String> {
        let mut control = hello(&self.sock, TOKEN, ClientKind::Control)
            .await
            .expect("control hello");
        let reply = control.rpc("pollBells", Value::Null).await;
        reply.result.as_ref().unwrap()[0]["aiStatus"]
            .as_str()
            .map(str::to_string)
    }

    fn teardown(&self) {
        self.daemon.kill_all_sessions();
        let _ = std::fs::remove_file(&self.sock);
        let _ = std::fs::remove_dir_all(&self.hist_root);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_claim_and_its_events_drive_the_badge_through_poll_bells() {
    let h = Harness::boot(PANE_TDEV).await;

    // No claim ⇒ no badge. A plain shell can never badge.
    assert_eq!(h.badge().await, None, "an unclaimed pane has no badge");

    let claim_id = h.claim("claude").await.expect("the claim is accepted");
    assert_eq!(
        claim_id.len(),
        32,
        "the daemon mints the capability, not the agent"
    );
    assert_eq!(
        h.badge().await.as_deref(),
        Some("claude:idle"),
        "a fresh claim is idle — the agent has not started working"
    );

    // The captured Claude sequence, over the real socket.
    h.event(&claim_id, "UserPromptSubmit", None, 10).await;
    assert_eq!(h.badge().await.as_deref(), Some("claude:running"));

    h.event(&claim_id, "PreToolUse", Some("Bash"), 20).await;
    assert_eq!(h.badge().await.as_deref(), Some("claude:running"));

    h.event(&claim_id, "PermissionRequest", Some("Bash"), 30)
        .await;
    assert_eq!(
        h.badge().await.as_deref(),
        Some("claude:attention"),
        "PermissionRequest fires at the exact instant the agent blocks on the human"
    );

    // Claude auto-allows AskUserQuestion, so it arrives as a PreToolUse — the one
    // tool NAME the mapping special-cases.
    h.event(&claim_id, "PostToolUse", Some("Bash"), 40).await;
    assert_eq!(h.badge().await.as_deref(), Some("claude:running"));
    h.event(&claim_id, "PreToolUse", Some("AskUserQuestion"), 50)
        .await;
    assert_eq!(h.badge().await.as_deref(), Some("claude:attention"));

    h.event(&claim_id, "Stop", None, 60).await;
    assert_eq!(h.badge().await.as_deref(), Some("claude:idle"));

    h.teardown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_wrong_session_key_is_rejected() {
    let h = Harness::boot(PANE_TDEV).await;

    // The key is per-session and derived from the daemon token. Neither the daemon
    // token itself, nor another pane's key, nor a guess, can claim this pane.
    for bad in [
        TOKEN.to_string(),
        derive_session_key(TOKEN, "grove-ab12-p2"),
        derive_session_key("some-other-daemons-token", &h.session_id),
        "0".repeat(32),
        String::new(),
    ] {
        let mut conn = hello(&h.sock, &bad, ClientKind::Agent)
            .await
            .expect("the hello itself is accepted — the KEY is checked per method");
        let reply = conn
            .rpc(
                METHOD_AGENT_CLAIM,
                json!({ "sessionId": h.session_id, "tool": "claude" }),
            )
            .await;
        assert!(
            reply.error.is_some() && reply.result.is_none(),
            "a claim with key {bad:?} must be REJECTED"
        );
        assert_eq!(h.badge().await, None, "a rejected claim draws no badge");
    }

    // …and an event with a bad key cannot touch a legitimate claim either.
    let claim_id = h.claim("claude").await.expect("the real claim is accepted");
    let mut conn = hello(&h.sock, &"f".repeat(32), ClientKind::Agent)
        .await
        .unwrap();
    let reply = conn
        .rpc(
            METHOD_AGENT_EVENT,
            serde_json::to_value(AgentEventParams {
                session_id: h.session_id.clone(),
                claim_id: claim_id.clone(),
                event: "PermissionRequest".into(),
                tool_name: Some("Bash".into()),
                at_ns: 99,
            })
            .unwrap(),
        )
        .await;
    assert!(
        reply.error.is_some(),
        "an event with a forged key is rejected"
    );
    assert_eq!(
        h.badge().await.as_deref(),
        Some("claude:idle"),
        "the forged event must not have moved the phase"
    );

    h.teardown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_claim_from_another_terminal_is_rejected_even_with_a_valid_key() {
    // THE load-bearing check (agent-status design §5). The claimant holds a VALID key
    // — this is exactly the nested-tmux env-inheritance hole, where a tmux server
    // started in pane A hands pane A's GROVE_SESSION_KEY to a shell the user later
    // opens from pane B. Under any env-carried design (today's status file included)
    // that agent would badge pane A. Here the kernel says its controlling terminal is
    // not this pane's, and the claim dies.
    let h = Harness::boot(OTHER_TDEV).await;

    let err = h
        .claim("claude")
        .await
        .expect_err("a claim from a different tty must be REJECTED");
    assert!(err.error.is_some());
    assert!(err.result.is_none());
    assert_eq!(
        h.badge().await,
        None,
        "no badge may appear on a pane the claimant is not actually in"
    );

    h.teardown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_event_with_an_unknown_claim_id_is_dropped_not_errored() {
    let h = Harness::boot(PANE_TDEV).await;
    let claim_id = h.claim("codex").await.expect("claim");
    h.event(&claim_id, "UserPromptSubmit", None, 10).await;
    assert_eq!(h.badge().await.as_deref(), Some("codex:running"));

    // A claim id the daemon never minted. It is DROPPED — and still ACKED, because
    // this call sits on the agent's critical path (the agent awaits each hook to
    // completion) and an error there would be worse than a missing status update.
    // `h.event` itself asserts the reply carries no error.
    h.event("deadbeef".repeat(4).as_str(), "Stop", None, 20)
        .await;
    assert_eq!(
        h.badge().await.as_deref(),
        Some("codex:running"),
        "an event naming an unknown claim must not move any badge"
    );

    // The monotonic fence: an event that lost the race is dropped too.
    h.event(&claim_id, "Stop", None, 5).await;
    assert_eq!(h.badge().await.as_deref(), Some("codex:running"));
    h.event(&claim_id, "Stop", None, 11).await;
    assert_eq!(h.badge().await.as_deref(), Some("codex:idle"));

    h.teardown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sigkill_clears_the_badge_on_the_next_poll_with_no_ttl() {
    // The single most important property in the design, end to end.
    //
    // The claimant's liveness is the LIVE kernel's view of a REAL `/bin/sleep` child
    // (see the header). We SIGKILL it — which no `trap`, no exit hook and no status
    // file can survive; the old design wedged at `claude:running` FOREVER, across app
    // restart and reboot, because nothing was left alive to clear it — and assert the
    // badge is gone on the very next poll. No sleep, no TTL, no timer, no GC.
    let mut h = Harness::boot(PANE_TDEV).await;

    let claim_id = h.claim("claude").await.expect("claim");
    h.event(&claim_id, "UserPromptSubmit", None, 10).await;
    assert_eq!(h.badge().await.as_deref(), Some("claude:running"));

    h.sleeper.sigkill();

    // Poll IMMEDIATELY. Right now the process is an unreaped ZOMBIE — `sysctl` still
    // lists it. Existence alone would say "still there" and the badge would wedge
    // exactly here; `alive()` excludes SZOMB, so it does not.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if h.badge().await.is_none() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the badge never cleared after SIGKILL — the wedge is back"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    h.sleeper.reap();
    assert_eq!(
        h.badge().await,
        None,
        "reaped ⇒ still no badge. Nothing was persisted that could resurrect it."
    );

    h.teardown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_agent_connection_can_never_write_kill_resize_or_shutdown() {
    // Method restriction (agent-status design §3.2). The capability a pane's env
    // carries is worth exactly two calls. The daemon TOKEN never enters a pane, so a
    // shell in a pane cannot reach these methods even by asking politely.
    let h = Harness::boot(PANE_TDEV).await;
    let mut conn = h.agent().await;

    for method in [
        "write",
        "kill",
        "resize",
        "shutdown",
        "getSnapshot",
        "clearHistory",
        "listSessions",
        "createOrAttach",
        "setAiStatus", // deleted outright — the app is no longer a writer of status
    ] {
        let reply = conn
            .rpc(
                method,
                json!({ "sessionId": h.session_id, "killSessions": true }),
            )
            .await;
        let err = reply.error.expect("must be refused");
        assert_eq!(err.code, -32601, "{method} must be unknown to an agent");
    }

    // The daemon is still alive and the connection still usable afterwards.
    assert!(
        h.claim("claude").await.is_ok(),
        "the daemon survived the probing"
    );

    h.teardown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_adopted_old_daemon_rejects_the_agent_role_and_nothing_hangs() {
    // The DEGRADE-GRACEFULLY path (the reason `role:"agent"` is additive at protocol
    // version 1 instead of a v2 bump: a bump is version-namespaced on both the socket
    // AND the on-disk history root, so it would orphan every shell the user currently
    // has running and lose their scrollback).
    //
    // The cost is this: an already-running OLD daemon that the supervisor adopted
    // cannot parse `role:"agent"` — its `Hello` decode fails and it answers
    // `HelloAck{ok:false}`. We reproduce that answer byte-for-byte here (a malformed
    // hello, which is precisely what an old daemon sees) and pin the two properties
    // `grove-agent` depends on: it gets a PROMPT, EXPLICIT refusal — it never hangs,
    // never blocks the agent — and it can therefore give up silently and exec the real
    // agent, leaving the pane with no badge until that daemon is next restarted.
    let h = Harness::boot(PANE_TDEV).await;

    let stream = UnixStream::connect(&h.sock).await.expect("connect");
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    // An old daemon's ClientKind has no `Agent` variant, so THIS is what it makes of
    // the hello: an unparseable line.
    write_line(&mut write_half, &json!({ "version": VERSION, "token": h.key, "clientId": "agent", "role": "agent-from-the-future" })).await;

    let mut line = String::new();
    let n = tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut line))
        .await
        .expect("the refusal must be PROMPT — a hung handshake would stall the agent")
        .expect("read");
    assert!(n > 0, "the daemon must ANSWER, not just close");
    let ack: HelloAck = decode_ndjson_line(&line).expect("decode ack");
    assert!(!ack.ok, "an unknown role must be refused: {ack:?}");

    // And the refusal is terminal: the socket closes, so a client blocked on a reply
    // is released rather than left waiting forever.
    let mut line = String::new();
    let n = tokio::time::timeout(Duration::from_secs(2), reader.read_line(&mut line))
        .await
        .expect("the connection must not hang after a refusal")
        .expect("read");
    assert_eq!(n, 0, "the daemon closes a refused connection");

    // The daemon is unharmed, and a NEW daemon still speaks the role fine.
    assert!(h.claim("claude").await.is_ok());

    h.teardown();
}
