//! `grove-agent launch <tool> -- <args…>` — claim the pane, then **become** the agent.

use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use grove_core::daemon::protocol::{
    GROVE_CLAIM_ID_ENV, GROVE_DAEMON_SOCK_ENV, GROVE_SESSION_KEY_ENV,
};
use grove_core::tool_hooks;

use crate::hooks;
use crate::resolve::{self, ResolveCtx, DEPTH_ENV, SKIP_ENV};
use crate::rpc;

/// How long the claim may take before we stop waiting and exec the agent anyway.
///
/// The claim is on the AGENT'S STARTUP path, so this is a hard cap on how much grove may
/// ever cost a user who types `claude`. A healthy claim measures ~0.3ms of socket time;
/// a dead socket fails in microseconds. This budget only ever pays out for a daemon that
/// accepted the connection and then wedged — and even then, the agent still starts. The
/// only casualty is the badge.
const CLAIM_BUDGET: Duration = Duration::from_millis(200);

/// Run the launcher. Only ever returns to `main` in order to exit — the success path
/// **replaces this process image with the agent's**.
pub fn run(args: &[String]) -> ! {
    let Some(tool) = args.first().cloned() else {
        eprintln!("usage: grove-agent launch <tool> -- <args...>");
        std::process::exit(2);
    };
    // Everything after `--` is the user's. (No `--` at all: treat the remainder as the
    // user's args anyway — a shim that loses the user's arguments is worse than useless.)
    let rest = &args[1..];
    let user_args: Vec<String> = match rest.iter().position(|a| a == "--") {
        Some(i) => rest[i + 1..].to_vec(),
        None => rest.to_vec(),
    };

    let ctx = ResolveCtx::from_env();
    let Some(real) = resolve::find_real_binary(&tool, &ctx) else {
        // The same message and the same exit code the shell would have produced. grove is
        // invisible in the failure, exactly as it is in the success.
        eprintln!("{tool}: not found");
        std::process::exit(127);
    };

    let agent_bin = agent_bin_path();
    let plugin = tool_hooks::claude_plugin_is_installed()
        .then(tool_hooks::claude_plugin_dir)
        .flatten();
    let argv = hooks::plan_argv(&tool, &user_args, &agent_bin, plugin.as_deref());

    // Claim BEFORE the exec: the claim's peer pid is this process's pid, and after the
    // exec that pid IS the agent's. A claim that fails for ANY reason (no daemon, an
    // adopted old daemon that rejects `role:"agent"`, a stale socket, a wedged daemon)
    // costs the badge and nothing else — we exec regardless.
    if let Some(claim_id) = claim(&tool) {
        // SAFETY: single-threaded at this point (the claim's worker thread has either
        // answered or been abandoned, and neither reads the environment). Inherited by the
        // agent, and thence by every hook subprocess it spawns — this claim id is the
        // capability that authorizes `agentEvent`.
        unsafe { std::env::set_var(GROVE_CLAIM_ID_ENV, claim_id) };
    }

    exec(&real, &tool, &argv, &ctx)
}

/// `~/.grove/bin/grove-agent` — the path baked into the hook commands we hand the agent.
/// NEVER `current_exe()`: codex's hook TRUST hash covers the command string, so a path
/// that changed between builds would re-show its "Hooks need review" modal every upgrade.
fn agent_bin_path() -> PathBuf {
    resolve::grove_bin_dir()
        .map(|dir| dir.join("grove-agent"))
        .unwrap_or_else(|| PathBuf::from("grove-agent"))
}

/// The claim, wall-clock capped.
///
/// Run on a worker thread with a `recv_timeout` rather than a socket timeout, because a
/// socket timeout cannot save you from a blocked `connect()` (a daemon whose listen
/// backlog is full accepts nothing and times out nothing). The worker is simply abandoned
/// if it overruns; `execvp` reaps it along with every other thread.
fn claim(tool: &str) -> Option<String> {
    let socket = PathBuf::from(std::env::var_os(GROVE_DAEMON_SOCK_ENV)?);
    let key = std::env::var(GROVE_SESSION_KEY_ENV).ok()?;
    let session_id = std::env::var("GROVE_SESSION_ID").ok()?;
    let tool = tool.to_string();

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(rpc::claim(&socket, &key, &session_id, &tool, CLAIM_BUDGET));
    });
    rx.recv_timeout(CLAIM_BUDGET).ok().flatten()
}

/// Become the agent.
///
/// `execvp`, never fork-and-wait. A wrapper that forks and waits WEDGES the pane on
/// Ctrl-Z: a TUI that self-suspends with the textbook idiom (restore the tty, then
/// `raise(SIGTSTP)` on itself) stops alone, while the wrapper stays foreground blocked in
/// `waitpid` and the shell never regains the terminal. With `exec` the suspended process
/// IS the job, so the wedge is structurally impossible — and the wrapper's pid IS the
/// agent's pid, which is exactly what makes the claim's kernel pid fence mean something.
fn exec(real: &Path, tool: &str, argv: &[String], ctx: &ResolveCtx) -> ! {
    // Loop guards for the child (see `resolve`): remember what we exec'd, count the hops,
    // and — only at the cap — take grove's bin dir off the child's PATH.
    // SAFETY: single-threaded; nothing else reads the environment.
    unsafe {
        std::env::set_var(DEPTH_ENV, (ctx.depth + 1).to_string());
        if let Some(skip) = resolve::child_skip(ctx, real) {
            std::env::set_var(SKIP_ENV, skip);
        }
        if let Some(path) = resolve::child_path(ctx) {
            std::env::set_var("PATH", path);
        }
        // Rust's runtime ignores SIGPIPE process-wide, and an ignored disposition SURVIVES
        // exec. Restore the default so the agent we become behaves exactly as it would
        // have if the shell had exec'd it directly (a pipeline that closes early must kill
        // it, not hand it an EPIPE it never expected).
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }

    // argv[0] is the NAME the user typed, not the resolved path — that is what the agent
    // prints in its own usage/errors, and what a version manager expects to see.
    let mut c_argv: Vec<CString> = Vec::with_capacity(argv.len() + 2);
    c_argv.push(cstring(tool));
    c_argv.extend(argv.iter().map(|arg| cstring(arg)));
    let mut ptrs: Vec<*const libc::c_char> = c_argv.iter().map(|a| a.as_ptr()).collect();
    ptrs.push(std::ptr::null());

    let path = cstring(&real.to_string_lossy());
    // SAFETY: `path` and `ptrs` are NUL-terminated and outlive the call; `ptrs` is
    // NULL-terminated. On success this never returns.
    unsafe { libc::execv(path.as_ptr(), ptrs.as_ptr()) };

    // Only reachable if execv failed (the binary vanished between the resolve and now, or
    // it is not a valid image).
    let error = std::io::Error::last_os_error();
    eprintln!("{tool}: {error}");
    std::process::exit(126);
}

/// NULs cannot appear in an argv the shell handed us; if one somehow does, drop the tail
/// rather than panic — this process must never abort on the agent's critical path.
fn cstring(value: &str) -> CString {
    CString::new(value).unwrap_or_else(|error| {
        let bytes = value.as_bytes()[..error.nul_position()].to_vec();
        CString::new(bytes).unwrap_or_default()
    })
}
