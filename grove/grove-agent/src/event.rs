//! `grove-agent event` — relay one hook fire to the daemon, then get out of the way.
//!
//! Claude and Codex **await each hook to completion** before continuing, so this process
//! is measured in the agent's own latency. Every exit is 0 and every path is capped by a
//! watchdog. Dropping a status event is harmless by design; stalling the agent is not.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use grove_core::daemon::protocol::{
    GROVE_CLAIM_ID_ENV, GROVE_DAEMON_SOCK_ENV, GROVE_SESSION_KEY_ENV,
};

use crate::monotonic_ns;
use crate::rpc;

/// The hard wall-clock cap on one hook relay.
///
/// A healthy round trip is ~0.3ms of socket time inside a ~2.5ms process (the floor is
/// pure spawn+exit; the socket is free), so this is ~50x headroom. It only ever pays out
/// against a WEDGED daemon — one that accepts the connection and never answers, or whose
/// listen backlog is full — and in that case the agent is stalled by 150ms per hook
/// instead of the design's original 500ms. That trade is one-sided: a dropped status
/// event self-corrects on the next hook, a stalled agent is felt by the human.
const BUDGET: Duration = Duration::from_millis(150);

/// The stdin cap. A hook payload carries `tool_input`, which can hold a whole file — we
/// read at most this much and parse what we got. We only need two short fields from the
/// head of the object, and an agent that hands us a gigabyte must not make us swap.
const MAX_STDIN: u64 = 1024 * 1024;

/// Relay the event. Always exits 0 — the caller is the agent.
pub fn run() -> ! {
    watchdog();

    if let Some((event, tool_name)) = read_hook_event() {
        if let (Some(socket), Ok(key), Ok(session_id), Ok(claim_id)) = (
            std::env::var_os(GROVE_DAEMON_SOCK_ENV).map(PathBuf::from),
            std::env::var(GROVE_SESSION_KEY_ENV),
            std::env::var("GROVE_SESSION_ID"),
            // No claim id ⇒ this agent was never claimed (an old daemon rejected the
            // role, or it was launched outside grove's wrapper). Nothing to report it
            // against, so there is nothing to say.
            std::env::var(GROVE_CLAIM_ID_ENV),
        ) {
            rpc::send_event(
                &socket,
                &key,
                &session_id,
                &claim_id,
                &event,
                tool_name.as_deref(),
                monotonic_ns(),
                BUDGET,
            );
        }
    }

    std::process::exit(0)
}

/// The only thing that makes "never blocks the agent" TRUE.
///
/// A read timeout cannot save you from a blocked `connect()` (a full listen backlog
/// accepts nothing and times out nothing), and neither can a write timeout. A watchdog
/// can: it exits the process, from the outside, on the clock. `_exit` (not
/// `std::process::exit`) so it cannot deadlock on an atexit handler or a lock the main
/// thread is holding.
fn watchdog() {
    std::thread::spawn(|| {
        std::thread::sleep(BUDGET + Duration::from_millis(10));
        // SAFETY: `_exit` is async-signal-safe and runs no destructors, which is exactly
        // what we want from a thread that has no idea what the main thread is holding.
        unsafe { libc::_exit(0) };
    });
}

/// The two fields that cross the wire, from the hook JSON on stdin. Everything else the
/// agent sends us — `cwd`, `tool_input`, `transcript_path`, `session_id`, the model name —
/// is READ AND DROPPED. No PII reaches the socket, so no PII can reach a log, a crash
/// dump, or a future feature that forgets what this payload contained.
fn read_hook_event() -> Option<(String, Option<String>)> {
    let mut raw = String::new();
    std::io::stdin()
        .take(MAX_STDIN)
        .read_to_string(&mut raw)
        .ok()?;
    parse_hook_event(&raw)
}

/// Garbage in ⇒ `None` ⇒ nothing said. Never a panic: this runs inside the agent's turn.
fn parse_hook_event(raw: &str) -> Option<(String, Option<String>)> {
    let payload: serde_json::Value = serde_json::from_str(raw).ok()?;
    let event = payload.get("hook_event_name")?.as_str()?.to_string();
    let tool_name = payload
        .get("tool_name")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    Some((event, tool_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A REAL payload, captured live from claude 2.1.207 at a permission block. Only two
    /// fields survive the parse — the pane's cwd, the command the agent wants to run, and
    /// the transcript path are read and DROPPED. No PII can reach the socket, so none can
    /// reach a log, a crash dump, or a future feature that forgot what this contained.
    #[test]
    fn only_the_event_and_the_tool_name_survive_the_parse() {
        let claude = r#"{"session_id":"019f","transcript_path":"/Users/u/.claude/x.jsonl",
            "cwd":"/Users/u/secret-project","hook_event_name":"PermissionRequest",
            "tool_name":"Bash","tool_input":{"command":"rm -rf /"}}"#;
        let (event, tool) = parse_hook_event(claude).expect("the payload parses");
        assert_eq!(event, "PermissionRequest");
        assert_eq!(tool.as_deref(), Some("Bash"));

        let wire = serde_json::json!({ "event": event, "toolName": tool }).to_string();
        assert!(!wire.contains("secret-project"));
        assert!(!wire.contains("rm -rf"));
        assert!(!wire.contains("transcript"));
    }

    /// `hook_event_name` is CamelCase on the wire for BOTH agents (codex 0.144.1 and
    /// claude 2.1.207 — measured), which is why ONE mapping table in the daemon serves
    /// both and this parser needs no per-tool knowledge at all.
    #[test]
    fn a_non_tool_event_has_no_tool_name_and_garbage_is_dropped() {
        for (json, expected) in [
            // Codex, on the wire.
            (
                r#"{"session_id":"019f","turn_id":"019f","cwd":"/x","hook_event_name":"PreToolUse","model":"gpt-5.6-terra","tool_name":"Bash"}"#,
                Some(("PreToolUse".to_string(), Some("Bash".to_string()))),
            ),
            (
                r#"{"hook_event_name":"Stop","stop_hook_active":false}"#,
                Some(("Stop".to_string(), None)),
            ),
            (
                r#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion"}"#,
                Some((
                    "PreToolUse".to_string(),
                    Some("AskUserQuestion".to_string()),
                )),
            ),
            // Not JSON, no event name, wrong type: nothing to say, and nothing that panics.
            ("not json at all", None),
            (r#"{"tool_name":"Bash"}"#, None),
            (r#"{"hook_event_name":42}"#, None),
            ("", None),
        ] {
            assert_eq!(parse_hook_event(json), expected, "{json}");
        }
    }
}
