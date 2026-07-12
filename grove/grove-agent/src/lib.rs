//! `grove-agent` — the launcher and the hook relay (agent-status design §5, Step 5).
//!
//! Two subcommands, both installed at the byte-stable path `~/.grove/bin/grove-agent`:
//!
//! * **`grove-agent launch <tool> -- <args…>`** — resolve the REAL agent binary (PATH
//!   minus `~/.grove/bin`), add the agent's own hook config, claim the pane on the
//!   daemon socket, export `GROVE_CLAIM_ID`, and **`execvp` the real agent**.
//! * **`grove-agent event`** — read one hook's JSON on stdin, extract
//!   `hook_event_name` + `tool_name`, and relay them to the daemon. Nothing else
//!   crosses the wire: no cwd, no `tool_input`, no transcript path. No PII on the socket.
//!
//! ## The two invariants everything here is built around
//!
//! **1. It EXECS. It never becomes a parent.** No `fork`, no `waitpid`, no signal
//! proxying. This is not a style choice: a fork-and-wait wrapper WEDGES the pane on
//! Ctrl-Z. A TUI that self-suspends the textbook way (restore the tty, then
//! `raise(SIGTSTP)` on itself) stops alone; the wrapper stays in the foreground process
//! group blocked in `waitpid`, and the shell never gets the terminal back — a dead pane.
//! With `exec`, the suspended process IS the job, and that failure mode is structurally
//! impossible.
//!
//! **2. It NEVER blocks the agent.** Claude and Codex both run hooks SYNCHRONOUSLY and
//! await each one to completion, so this binary sits on the agent's critical path. Every
//! path is wall-clock capped and every path exits 0. A dropped status event is harmless
//! by design — liveness comes from the kernel and the next event self-corrects — while
//! a stalled agent is not.
//!
//! ## Degradation (agent-status design §3.6)
//!
//! Anything that goes wrong costs the BADGE, never the agent:
//!
//! | Failure | Result |
//! |---|---|
//! | no daemon / stale socket | claim fails fast (`ENOENT`/`ECONNREFUSED`), the agent still execs |
//! | an OLD daemon the supervisor adopted (it cannot parse `role:"agent"`) | it answers `HelloAck{ok:false}` and closes; we give up SILENTLY and exec |
//! | the daemon accepts but never replies | the claim budget expires; we exec anyway |
//! | `grove-agent` itself is missing | the shim execs the real agent directly (see `tool_hooks`) |
//!
//! No hang, no error toast, no broken agent. The pane simply shows no badge.

pub mod event;
pub mod hooks;
pub mod launch;
pub mod resolve;
pub mod rpc;

/// `CLOCK_MONOTONIC` nanoseconds — the `at_ns` fence the daemon uses to drop
/// out-of-order events. Monotonic (not wall-clock) so an NTP step cannot make a later
/// hook look older than an earlier one and silently freeze a pane's badge.
pub fn monotonic_ns() -> u64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `ts` is a valid, fully-initialized timespec; CLOCK_MONOTONIC always exists.
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    (ts.tv_sec as u64)
        .saturating_mul(1_000_000_000)
        .saturating_add(ts.tv_nsec as u64)
}
