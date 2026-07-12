//! The agent side of the daemon control socket (`role: "agent"`).
//!
//! Deliberately `std::os::unix::net`, not tokio: this binary is spawned per hook fire and
//! its whole job is one line out, one line back. A runtime would cost more than the RPC.
//! (It is also what keeps `SO_NOSIGPIPE` on the socket, so a write to a daemon that
//! vanished surfaces as `EPIPE` instead of SIGKILLing the wrapper before it can exec.)
//!
//! Every function here is INFALLIBLE by contract: it returns `Option`, never an error,
//! and never panics. A status event we could not deliver is harmless — liveness comes
//! from the kernel and the next event self-corrects. Blocking the agent is not harmless.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

use grove_core::daemon::protocol::{
    decode_ndjson_line, encode_ndjson_line, AgentClaimParams, AgentClaimResult, AgentEventParams,
    ClientKind, ControlMessage, Hello, HelloAck, RpcRequest, GROVE_DAEMON_PROTOCOL_VERSION,
    METHOD_AGENT_CLAIM, METHOD_AGENT_EVENT,
};

/// One agent connection: hello'd, method-restricted to `agentClaim`/`agentEvent`.
struct AgentConn {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl AgentConn {
    /// Connect and hello. `None` covers every failure, and they are all EXPECTED:
    ///
    /// * no socket file / no listener — the daemon is not running (fails fast: `ENOENT`,
    ///   `ECONNREFUSED`; no timeout involved);
    /// * **an OLD daemon the supervisor adopted** — `role:"agent"` is additive at protocol
    ///   v1 (the version is deliberately NOT bumped: the socket and the history root are
    ///   version-namespaced, so a bump would orphan every shell the user has running and
    ///   lose their scrollback). An older build cannot decode the role, so it answers
    ///   `HelloAck{ok:false}` and closes. We give up SILENTLY. The pane shows no badge
    ///   until that daemon is next restarted; the agent is untouched.
    fn open(socket: &Path, session_key: &str, budget: Duration) -> Option<Self> {
        let stream = UnixStream::connect(socket).ok()?;
        let _ = stream.set_read_timeout(Some(budget));
        let _ = stream.set_write_timeout(Some(budget));
        let mut conn = Self {
            reader: BufReader::new(stream.try_clone().ok()?),
            writer: stream,
        };

        conn.write(&Hello {
            version: GROVE_DAEMON_PROTOCOL_VERSION,
            token: session_key.to_string(),
            client_id: "agent".to_string(),
            kind: ClientKind::Agent,
        })?;
        let ack: HelloAck = conn.read()?;
        ack.ok.then_some(conn)
    }

    fn write<T: serde::Serialize>(&mut self, msg: &T) -> Option<()> {
        let line = encode_ndjson_line(msg).ok()?;
        self.writer.write_all(line.as_bytes()).ok()?;
        self.writer.flush().ok()
    }

    fn read<T: serde::de::DeserializeOwned>(&mut self) -> Option<T> {
        let mut line = String::new();
        let read = self.reader.read_line(&mut line).ok()?;
        (read > 0).then(|| decode_ndjson_line(&line).ok())?
    }

    /// One correlated RPC. The reply is awaited (the read timeout is the cap) because the
    /// claim needs its `claimId` — and because an ack proves the daemon actually applied
    /// the event rather than merely buffering it.
    fn rpc(&mut self, method: &str, params: serde_json::Value) -> Option<serde_json::Value> {
        self.write(&ControlMessage::Request(RpcRequest {
            id: 1,
            method: method.to_string(),
            params,
        }))?;
        match self.read::<ControlMessage>()? {
            ControlMessage::Reply(reply) => reply.result,
            _ => None,
        }
    }
}

/// Claim the pane for `tool`, returning the daemon-minted claim id.
///
/// There is no `pid` field on the wire: the daemon reads the connecting pid from the
/// kernel (`getsockopt(LOCAL_PEERPID)`) — and because the launcher EXECS, that pid IS the
/// agent's pid. A claimant cannot lie about who it is, and the claim is fenced by the
/// process's `p_starttime` for its whole life.
pub fn claim(
    socket: &Path,
    session_key: &str,
    session_id: &str,
    tool: &str,
    budget: Duration,
) -> Option<String> {
    let mut conn = AgentConn::open(socket, session_key, budget)?;
    let result = conn.rpc(
        METHOD_AGENT_CLAIM,
        serde_json::to_value(AgentClaimParams {
            session_id: session_id.to_string(),
            tool: tool.to_string(),
        })
        .ok()?,
    )?;
    serde_json::from_value::<AgentClaimResult>(result)
        .ok()
        .map(|ack| ack.claim_id)
}

/// Relay one hook event. ONLY the event name and the tool name cross the wire — no cwd,
/// no `tool_input`, no transcript path. No PII on the socket, and nothing to base64.
#[allow(clippy::too_many_arguments)]
pub fn send_event(
    socket: &Path,
    session_key: &str,
    session_id: &str,
    claim_id: &str,
    event: &str,
    tool_name: Option<&str>,
    at_ns: u64,
    budget: Duration,
) -> Option<()> {
    let mut conn = AgentConn::open(socket, session_key, budget)?;
    conn.rpc(
        METHOD_AGENT_EVENT,
        serde_json::to_value(AgentEventParams {
            session_id: session_id.to_string(),
            claim_id: claim_id.to_string(),
            event: event.to_string(),
            tool_name: tool_name.map(str::to_string),
            at_ns,
        })
        .ok()?,
    )?;
    Some(())
}
