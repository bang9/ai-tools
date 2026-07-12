//! Agent status: the mapping table and the resolver (agent-status design §3.4/§3.5).
//!
//! PURE. No PTY, no socket, no clock, no I/O. The only impurity in the whole status
//! system is the [`Kernel`] trait object handed to [`resolve`], and it is a trait
//! precisely so this file is unit-testable with zero PTYs.
//!
//! ## The thesis
//!
//! Status has exactly two inputs and no others:
//!
//! - **What the agent says it is doing** — its own structured hook events (S2). The
//!   agents ship official hooks, including `PermissionRequest`, which fires at the
//!   exact instant the agent blocks on a human. That is a machine-defined event, not
//!   a human-facing string we reverse-engineer.
//! - **Whether the agent still exists** — the kernel, queried at READ time (S3).
//!
//! Not the OSC title (proven incapable: Claude's BLOCKED title and its IDLE title
//! carry the same U+2733 glyph — an information-theoretic gap no parser fixes, and
//! oh-my-zsh sets OSC 2 to the command line, so a plain shell would badge as an
//! agent). Not the process table (`vim /tmp/codex` phantom-badges; `exec -a` forges
//! it). Not output silence (a *blocked* codex repaints its spinner continuously, so
//! an output timer says `working` precisely when the human is being waited on).
//!
//! Below a hooked agent there is **no inference rung**: we show NO badge rather than
//! a wrong one. One wrong badge poisons trust in every correct one.

use crate::kernel::Kernel;

/// The agent's phase, as the agent itself last reported it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Working,
    /// Blocked on a human. The state the badge exists for.
    Waiting,
    Idle,
}

/// One agent claimed a pane. Recorded by `agentClaim`, mutated by `agentEvent`,
/// read by [`resolve`]. Never persisted: status is derived at read time, so there
/// is nothing to GC, nothing to wedge across a reboot, and nothing to spoof by
/// `cat`ing a file.
#[derive(Debug, Clone)]
pub struct AgentClaim {
    /// The daemon-minted capability a hook must present on `agentEvent`.
    pub claim_id: String,
    /// `"claude"` | `"codex"` — the tool half of the frozen `"<tool>:<status>"`.
    pub tool: String,
    /// The AGENT's pid. `grove-agent launch` execs the real agent, so the pid that
    /// connected IS the pid that is now running claude/codex.
    pub pid: i32,
    /// `p_starttime` at claim time — the PID-reuse fence, re-verified on every read.
    pub start_us: u64,
    /// The last mapped event. Starts [`Phase::Idle`]: a claim with no events yet is
    /// an agent that has not started working.
    pub phase: Phase,
    /// The monotonic fence: an event whose `at_ns` is not strictly greater is
    /// dropped, which kills the whole reordering class in five lines.
    pub last_at_ns: u64,
}

/// Map one hook event to a phase. **This is the ONE place agent-specific knowledge
/// lives in the entire system** — ~40 lines, pure, no regex.
///
/// ## Why there is no `tool` discriminant
///
/// Codex's hook event names are CamelCase and byte-identical to Claude Code's, both
/// in the config keys and in `hook_event_name` on the wire (measured live against
/// codex 0.144.1: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`). ONE
/// table serves both agents. A per-tool `match` would be two copies of one truth.
///
/// ## The `AskUserQuestion` row
///
/// Claude auto-allows `AskUserQuestion`, so a question to the user arrives as
/// `PreToolUse{tool_name:"AskUserQuestion"}` and NEVER as `PermissionRequest`. We
/// special-case that one tool NAME — a machine identifier, not prose. Together with
/// the `PermissionRequest` row, that is the entire "attention" logic: two rows.
///
/// ## Unknown ⇒ `None` ⇒ phase UNCHANGED. Never a guess.
///
/// `Notification`, `SubagentStart`/`SubagentStop`, `PreCompact`/`PostCompact`,
/// `SessionEnd` and anything a future release invents are deliberately unmapped. A
/// new agent version that adds an event is a no-op, not a wrong badge. That is the
/// whole forward-compat story and it costs zero lines.
///
/// (`Notification` is dropped on purpose, not by omission: it is redundant with
/// `PermissionRequest`, its `notification_type` enum is unstable across versions,
/// and mapping it blanket-to-attention would produce a STICKY false attention after
/// `Stop` with nothing left to clear it.)
pub fn map_event(event: &str, tool_name: Option<&str>) -> Option<Phase> {
    match event {
        "SessionStart" => Some(Phase::Idle),
        "UserPromptSubmit" => Some(Phase::Working),
        "PreToolUse" => Some(match tool_name {
            Some("AskUserQuestion") => Phase::Waiting,
            _ => Phase::Working,
        }),
        // Fires at the exact instant the agent blocks on a human. Measured for both
        // agents; for codex it lands +20ms after PreToolUse, with the approval prompt
        // already on screen.
        "PermissionRequest" => Some(Phase::Waiting),
        // The moment the user approves, the tool runs → attention clears by itself.
        "PostToolUse" | "PostToolUseFailure" => Some(Phase::Working),
        "Stop" | "StopFailure" => Some(Phase::Idle),
        _ => None,
    }
}

/// Derive a pane's status string, or `None` for no badge. Called at READ time from
/// `pollBells` — the status is never stored, so it cannot lie.
///
/// 1. Prune dead claims: the pid is gone, it is a ZOMBIE, or `p_starttime` no longer
///    matches (PID reuse).
/// 2. Of the live claims, take the MOST RECENT (a pane may host several agents over
///    its life; the one that is still running and claimed last is the one on screen).
/// 3. A SUSPENDED agent (Ctrl-Z) is `idle` — never `working`, never `attention`.
/// 4. Otherwise map the phase the agent itself last reported.
/// 5. No live claim ⇒ `None` ⇒ no badge.
///
/// This single function is the answer to the SIGKILL wedge, the TTL question and the
/// reattach question, simultaneously — and it has no timer, no timeout, and no
/// persisted state:
///
/// | Scenario | Result | Why |
/// |---|---|---|
/// | agent exits cleanly / SIGTERM / pane closed | badge clears | pid gone at the next read |
/// | **agent SIGKILL / OOM** | **badge clears** | pid gone. No trap. No TTL. No wedge. |
/// | agent Ctrl-Z'd | `idle` | `p_stat == SSTOP` |
/// | a `Stop` event is dropped on the wire | self-corrects on the next event; it CANNOT outlive the process | liveness is not derived from events |
/// | app quit for an hour, then reopened | correct | events kept arriving into the live daemon; this runs fresh against the live kernel on the first poll |
/// | daemon dies / reboot | badge clears | the PTY died with it, so the agent died with it — and nothing was persisted to resurrect a claim |
pub fn resolve(agents: &[AgentClaim], kernel: &dyn Kernel) -> Option<String> {
    for claim in agents.iter().rev() {
        let Some(facts) = kernel.facts(claim.pid) else {
            continue; // dead → prune
        };
        if !facts.alive() {
            continue; // SZOMB: SIGKILLed and not yet reaped. Still listed. Not alive.
        }
        if facts.start_us != claim.start_us {
            continue; // PID reuse → this is somebody else's process
        }
        let status = if facts.stopped() {
            "idle"
        } else {
            match claim.phase {
                Phase::Working => "running",
                Phase::Waiting => "attention",
                Phase::Idle => "idle",
            }
        };
        return Some(format!("{}:{status}", claim.tool));
    }
    None
}

/// Drop claims the kernel says are gone. Called when a new claim is recorded, purely
/// to bound the `Vec` — correctness does not depend on it, because [`resolve`]
/// re-checks liveness on every read. (That is the point: there is no GC to get wrong.)
pub fn prune(agents: &mut Vec<AgentClaim>, kernel: &dyn Kernel) {
    agents.retain(|claim| {
        kernel
            .facts(claim.pid)
            .is_some_and(|f| f.alive() && f.start_us == claim.start_us)
    });
}

/// Apply one hook event to the claim it names. Returns whether the event was
/// accepted (an unknown claim id, or an out-of-order event, is DROPPED — silently,
/// because a status event is best-effort by design: liveness comes from the kernel
/// and the next event self-corrects, so dropping one is harmless while stalling the
/// agent is not).
pub fn apply_event(
    agents: &mut [AgentClaim],
    claim_id: &str,
    event: &str,
    tool_name: Option<&str>,
    at_ns: u64,
) -> bool {
    let Some(claim) = agents.iter_mut().find(|c| c.claim_id == claim_id) else {
        return false;
    };
    // The monotonic fence. Measured: Claude awaits each hook to completion before
    // firing the next, so events arrive in order today — this is cheap insurance for
    // Codex and for future agents that do not serialize their hooks.
    if at_ns <= claim.last_at_ns {
        return false;
    }
    claim.last_at_ns = at_ns;
    // Unknown event ⇒ phase UNCHANGED. Never a guess.
    if let Some(phase) = map_event(event, tool_name) {
        claim.phase = phase;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::{FakeKernel, ProcFacts};

    const PID: i32 = 4242;
    const START: u64 = 1_783_849_467_685_000;

    fn claim(phase: Phase) -> AgentClaim {
        AgentClaim {
            claim_id: "c1".into(),
            tool: "claude".into(),
            pid: PID,
            start_us: START,
            phase,
            last_at_ns: 0,
        }
    }

    fn live_kernel() -> FakeKernel {
        let k = FakeKernel::new();
        k.insert(PID, START, 7);
        k
    }

    // ---- map_event ---------------------------------------------------------

    #[test]
    fn the_captured_claude_sequence_drives_idle_working_waiting() {
        // The live capture, Claude 2.1.207 under a real PTY, asked to run `rm -f …`:
        //   SessionStart → UserPromptSubmit → PreToolUse{Bash} → PermissionRequest{Bash}
        // PermissionRequest fires AT THE MOMENT THE AGENT BLOCKS. That is the event
        // the entire design hinges on.
        let mut agents = vec![claim(Phase::Idle)];
        let k = live_kernel();

        let script: &[(&str, Option<&str>, &str)] = &[
            ("SessionStart", None, "claude:idle"),
            ("UserPromptSubmit", None, "claude:running"),
            ("PreToolUse", Some("Bash"), "claude:running"),
            ("PermissionRequest", Some("Bash"), "claude:attention"),
            // The user approves → the tool runs → attention clears by itself.
            ("PostToolUse", Some("Bash"), "claude:running"),
            ("Stop", None, "claude:idle"),
        ];
        for (i, (event, tool, expected)) in script.iter().enumerate() {
            let accepted = apply_event(&mut agents, "c1", event, *tool, i as u64 + 1);
            assert!(accepted, "{event} must be accepted");
            assert_eq!(
                resolve(&agents, &k).as_deref(),
                Some(*expected),
                "after {event}"
            );
        }
    }

    #[test]
    fn the_captured_codex_sequence_uses_the_same_table() {
        // Codex 0.144.1 emits CamelCase `hook_event_name` on the wire, byte-identical
        // to Claude's. ONE table, both agents — no `tool` discriminant.
        let mut agents = vec![AgentClaim {
            tool: "codex".into(),
            ..claim(Phase::Idle)
        }];
        let k = live_kernel();
        for (i, (event, expected)) in [
            ("SessionStart", "codex:idle"),
            ("UserPromptSubmit", "codex:running"),
            ("PreToolUse", "codex:running"),
            ("PermissionRequest", "codex:attention"),
            ("PostToolUse", "codex:running"),
            ("Stop", "codex:idle"),
        ]
        .iter()
        .enumerate()
        {
            apply_event(&mut agents, "c1", event, Some("Bash"), i as u64 + 1);
            assert_eq!(resolve(&agents, &k).as_deref(), Some(*expected), "{event}");
        }
    }

    #[test]
    fn ask_user_question_is_waiting_because_claude_auto_allows_it() {
        // Claude auto-allows AskUserQuestion, so a question to the user arrives as a
        // PreToolUse and NEVER as a PermissionRequest. Without this row, asking the
        // user a question would badge `running` — the agent would sit blocked with a
        // "working" badge, which is the single worst failure this design can have.
        assert_eq!(
            map_event("PreToolUse", Some("AskUserQuestion")),
            Some(Phase::Waiting)
        );
        assert_eq!(map_event("PreToolUse", Some("Bash")), Some(Phase::Working));
        assert_eq!(map_event("PreToolUse", None), Some(Phase::Working));
    }

    #[test]
    fn an_unknown_event_leaves_the_phase_unchanged() {
        // Forward-compat: a new agent release that adds an event is a NO-OP, never a
        // wrong badge. Notification is unmapped ON PURPOSE — mapping it to attention
        // would leave a sticky false attention after Stop with nothing to clear it.
        for event in [
            "Notification",
            "SubagentStart",
            "SubagentStop",
            "PreCompact",
            "PostCompact",
            "SessionEnd",
            "TeammateIdle",
            "SomethingClaude3WillInventIn2027",
            "",
        ] {
            assert_eq!(
                map_event(event, Some("Bash")),
                None,
                "{event} must be unmapped"
            );
        }

        let mut agents = vec![claim(Phase::Waiting)];
        let k = live_kernel();
        assert!(
            apply_event(&mut agents, "c1", "Notification", None, 5),
            "an unknown event is still ACCEPTED (it advances the fence)"
        );
        assert_eq!(
            resolve(&agents, &k).as_deref(),
            Some("claude:attention"),
            "an unknown event must not disturb the phase — the agent is still blocked"
        );
    }

    #[test]
    fn an_out_of_order_event_is_dropped_by_the_monotonic_fence() {
        let mut agents = vec![claim(Phase::Idle)];
        assert!(apply_event(
            &mut agents,
            "c1",
            "UserPromptSubmit",
            None,
            100
        ));
        // A `Stop` that was reordered behind it must NOT clear the running badge.
        assert!(!apply_event(&mut agents, "c1", "Stop", None, 50));
        assert!(
            !apply_event(&mut agents, "c1", "Stop", None, 100),
            "not strictly greater"
        );
        assert_eq!(agents[0].phase, Phase::Working);
        assert!(apply_event(&mut agents, "c1", "Stop", None, 101));
        assert_eq!(agents[0].phase, Phase::Idle);
    }

    #[test]
    fn an_event_for_an_unknown_claim_is_dropped() {
        let mut agents = vec![claim(Phase::Idle)];
        assert!(!apply_event(
            &mut agents,
            "not-a-claim",
            "PermissionRequest",
            None,
            9
        ));
        assert_eq!(agents[0].phase, Phase::Idle, "no claim, no badge change");
    }

    // ---- resolve, against the kernel ---------------------------------------

    #[test]
    fn no_claim_means_no_badge() {
        assert_eq!(resolve(&[], &live_kernel()), None);
    }

    #[test]
    fn a_dead_pid_clears_the_badge() {
        let agents = vec![claim(Phase::Working)];
        let k = live_kernel();
        assert_eq!(resolve(&agents, &k).as_deref(), Some("claude:running"));
        k.remove(PID);
        assert_eq!(resolve(&agents, &k), None, "pid gone ⇒ no badge");
    }

    #[test]
    fn a_sigkilled_agent_clears_the_badge_with_no_ttl() {
        // THE property. A SIGKILL cannot be trapped, so no exit hook, no `trap`, and
        // no status file can ever clear a status the old design wrote — it wedged at
        // `claude:running` FOREVER, across app restart and reboot. Here the badge is
        // derived, so it clears on the very next read, with NO timer and NO TTL.
        let agents = vec![claim(Phase::Working)];
        let k = live_kernel();
        assert_eq!(resolve(&agents, &k).as_deref(), Some("claude:running"));

        // Immediately after SIGKILL the process is a ZOMBIE — sysctl STILL LISTS IT.
        // If we only checked existence, the badge would wedge exactly here.
        k.zombify(PID);
        assert_eq!(
            resolve(&agents, &k),
            None,
            "a SIGKILLed-but-unreaped agent (SZOMB) must clear the badge"
        );

        // …and once reaped, still nothing. No state elsewhere can resurrect it.
        k.remove(PID);
        assert_eq!(resolve(&agents, &k), None);
    }

    #[test]
    fn a_reused_pid_clears_the_badge() {
        // The pid is live again — but it is somebody else's process. Without the
        // start-time fence, a random new process inheriting the pid would inherit a
        // dead agent's badge.
        let agents = vec![claim(Phase::Waiting)];
        let k = live_kernel();
        assert_eq!(resolve(&agents, &k).as_deref(), Some("claude:attention"));
        k.reuse_pid(PID, START + 1);
        assert_eq!(
            resolve(&agents, &k),
            None,
            "start_us mismatch ⇒ PID reuse ⇒ no badge"
        );
    }

    #[test]
    fn a_suspended_agent_is_idle_never_running_and_never_attention() {
        let k = live_kernel();
        for (phase, running_status) in [
            (Phase::Working, "claude:running"),
            (Phase::Waiting, "claude:attention"),
            (Phase::Idle, "claude:idle"),
        ] {
            let agents = vec![claim(phase)];
            k.insert(PID, START, 7); // (re)arm as SRUN
            assert_eq!(resolve(&agents, &k).as_deref(), Some(running_status));
            k.suspend(PID);
            assert_eq!(
                resolve(&agents, &k).as_deref(),
                Some("claude:idle"),
                "Ctrl-Z'd from {phase:?}: a suspended agent is not working and is not \
                 waiting on the human — the human is waiting on the shell"
            );
        }
    }

    #[test]
    fn the_most_recent_live_claim_wins_and_dead_ones_are_skipped() {
        // A pane hosts several agents over its life. The one still running and
        // claimed last is the one on screen.
        let k = FakeKernel::new();
        k.insert(10, 100, 7).insert(20, 200, 7);
        let agents = vec![
            AgentClaim {
                claim_id: "old".into(),
                tool: "claude".into(),
                pid: 10,
                start_us: 100,
                phase: Phase::Working,
                last_at_ns: 1,
            },
            AgentClaim {
                claim_id: "new".into(),
                tool: "codex".into(),
                pid: 20,
                start_us: 200,
                phase: Phase::Waiting,
                last_at_ns: 1,
            },
        ];
        assert_eq!(resolve(&agents, &k).as_deref(), Some("codex:attention"));

        // The newest dies → we fall back to the older one that is STILL RUNNING…
        k.remove(20);
        assert_eq!(resolve(&agents, &k).as_deref(), Some("claude:running"));
        // …and when that dies too, no badge. Never a stale one.
        k.remove(10);
        assert_eq!(resolve(&agents, &k), None);
    }

    #[test]
    fn prune_drops_dead_claims_but_never_live_ones() {
        let k = FakeKernel::new();
        k.insert(10, 100, 7).insert(20, 200, 7).insert(30, 300, 7);
        let mut agents = vec![
            AgentClaim {
                claim_id: "a".into(),
                tool: "claude".into(),
                pid: 10,
                start_us: 100,
                phase: Phase::Idle,
                last_at_ns: 0,
            },
            AgentClaim {
                claim_id: "b".into(),
                tool: "claude".into(),
                pid: 20,
                start_us: 200,
                phase: Phase::Idle,
                last_at_ns: 0,
            },
            AgentClaim {
                claim_id: "c".into(),
                tool: "codex".into(),
                pid: 30,
                start_us: 300,
                phase: Phase::Idle,
                last_at_ns: 0,
            },
        ];
        k.remove(10); // exited
        k.reuse_pid(20, 999); // pid reused by somebody else
        prune(&mut agents, &k);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].claim_id, "c");

        // A zombie is pruned too.
        k.put(ProcFacts {
            pid: 30,
            start_us: 300,
            stat: crate::kernel::SZOMB,
            tdev: 7,
        });
        prune(&mut agents, &k);
        assert!(agents.is_empty());
    }
}
