//! `grove-agent launch`, driven as a REAL process against a REAL unix socket.
//!
//! Nothing here is mocked except the daemon's *replies*: the binary under test is the
//! shipped one (`CARGO_BIN_EXE_grove-agent`), it really resolves a binary off a real
//! PATH, really claims over a real socket, and really `execvp`s.
//!
//! The four properties pinned here are the four that, if they broke, would each be
//! catastrophic in a different way:
//!
//! 1. **It execs** — the wrapper pid IS the agent pid. A fork-and-wait wrapper wedges the
//!    pane on Ctrl-Z, and the daemon's whole pid fence is built on the claimant's pid
//!    being the agent's.
//! 2. **A dead daemon still runs the agent** — no daemon, no badge, but never a broken
//!    `claude`.
//! 3. **An ADOPTED OLD DAEMON still runs the agent** — `role:"agent"` is additive at
//!    protocol v1 (bumping the version would orphan every shell the user has running and
//!    lose their scrollback), so an older daemon the supervisor adopted rejects the hello.
//!    That must degrade SILENTLY.
//! 4. **Ctrl-Z under a real PTY returns the prompt** — the pane is not wedged.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const AGENT: &str = env!("CARGO_BIN_EXE_grove-agent");
const SESSION: &str = "grove-ab12-p1";
const KEY: &str = "0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------
// Scratch tree
// ---------------------------------------------------------------------------

struct Tree(PathBuf);

impl Tree {
    fn new(name: &str) -> Self {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "grove-agent-it-{name}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("grove")).unwrap();
        Self(dir)
    }

    /// A fake `claude` that reports the pid it is running as, plus the argv it was handed.
    /// The pid is the whole point: if `grove-agent` forked, this pid is a CHILD of the
    /// process we spawned, and the exec assertion fails.
    fn fake_claude(&self) -> PathBuf {
        let out = self.0.join("claude-ran.txt");
        let script = format!(
            "#!/bin/sh\nprintf 'pid=%s\\n' \"$$\" > '{}'\nfor a in \"$@\"; do printf 'arg=%s\\n' \"$a\" >> '{}'; done\nexit 0\n",
            out.display(),
            out.display()
        );
        let path = self.0.join("bin").join("claude");
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        out
    }

    fn grove_bin(&self) -> PathBuf {
        self.0.join("grove")
    }
    fn path(&self) -> String {
        format!(
            "{}:{}:/usr/bin:/bin",
            self.grove_bin().display(),
            self.0.join("bin").display()
        )
    }
    fn socket(&self) -> PathBuf {
        self.0.join("d.sock")
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `grove-agent launch claude -- <args>`, wired at a tree and a socket.
fn launch(tree: &Tree, socket: Option<&Path>, args: &[&str]) -> std::process::Child {
    let mut cmd = Command::new(AGENT);
    cmd.arg("launch")
        .arg("claude")
        .arg("--")
        .args(args)
        .env("PATH", tree.path())
        .env("GROVE_BIN_DIR", tree.grove_bin())
        .env("HOME", &tree.0)
        .env("GROVE_SESSION_ID", SESSION)
        .env("GROVE_SESSION_KEY", KEY)
        .env_remove("GROVE_CLAIM_ID")
        .env_remove("GROVE_AGENT_SKIP")
        .env_remove("GROVE_AGENT_DEPTH");
    match socket {
        Some(sock) => cmd.env("GROVE_DAEMON_SOCK", sock),
        None => cmd.env_remove("GROVE_DAEMON_SOCK"),
    };
    cmd.spawn().expect("spawn grove-agent")
}

fn ran(out: &Path, within: Duration) -> String {
    let deadline = Instant::now() + within;
    loop {
        if let Ok(text) = std::fs::read_to_string(out) {
            if text.contains("pid=") {
                return text;
            }
        }
        assert!(
            Instant::now() < deadline,
            "the real agent never ran — grove-agent must ALWAYS exec it"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn pid_of(report: &str) -> u32 {
    report
        .lines()
        .find_map(|l| l.strip_prefix("pid="))
        .expect("the fake agent reports its pid")
        .trim()
        .parse()
        .unwrap()
}

// ---------------------------------------------------------------------------
// A fake daemon: one connection, one hello, one reply.
// ---------------------------------------------------------------------------

/// What the daemon on the other end does with the agent's hello.
#[derive(Clone, Copy, PartialEq)]
enum Daemon {
    /// A current daemon: accepts `role:"agent"` and mints a claim id.
    Modern,
    /// An OLDER daemon the supervisor adopted across an app update. It cannot decode
    /// `role:"agent"` at all, so its `Hello` parse fails and it answers `ok:false`, then
    /// closes. (Pinned daemon-side by `an_adopted_old_daemon_rejects_the_agent_role…`.)
    Adopted,
}

/// Serve exactly one connection, then send the claim's params back to the test.
fn fake_daemon(socket: &Path, kind: Daemon) -> mpsc::Receiver<Option<serde_json::Value>> {
    let listener = UnixListener::bind(socket).expect("bind");
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let Ok((stream, _)) = listener.accept() else {
            let _ = tx.send(None);
            return;
        };
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);

        let mut hello = String::new();
        let _ = reader.read_line(&mut hello);
        assert!(
            hello.contains(r#""role":"agent""#),
            "the launcher must open the AGENT role: {hello}"
        );

        if kind == Daemon::Adopted {
            // An old build's ClientKind has no `agent` variant, so the hello does not
            // decode and it refuses — promptly, and terminally.
            let _ = writer.write_all(b"{\"ok\":false,\"error\":\"malformed hello\"}\n");
            drop(writer);
            let _ = tx.send(None);
            return;
        }

        let _ = writer.write_all(b"{\"ok\":true}\n");
        let mut request = String::new();
        let _ = reader.read_line(&mut request);
        let request: serde_json::Value = serde_json::from_str(&request).unwrap_or_default();
        let _ = writer.write_all(
            format!(
                r#"{{"type":"reply","id":{},"result":{{"claimId":"deadbeefdeadbeefdeadbeefdeadbeef"}}}}"#,
                request["id"].as_u64().unwrap_or(1)
            )
            .as_bytes(),
        );
        let _ = writer.write_all(b"\n");
        let _ = writer.flush();
        let _ = tx.send(Some(request));
        // Hold the connection open briefly: the launcher must not need us to close.
        std::thread::sleep(Duration::from_millis(50));
    });
    rx
}

// ---------------------------------------------------------------------------

/// THE structural property. The wrapper does not spawn the agent — it BECOMES it.
///
/// Asserted by pid identity, because that is the only thing a fork-and-wait wrapper
/// cannot fake: the pid we spawned must be the pid the agent is running as. (The
/// "Ctrl-Z returns the prompt" test below does NOT prove this on its own — a fork-and-wait
/// wrapper passes it with today's claude, because claude suspends its whole process group.
/// It is the pid that is load-bearing: the daemon fences the claim on the CLAIMANT's pid
/// and start time, so if the agent were a child, the badge would fence the wrong process.)
#[test]
fn launch_execs_the_real_agent_the_wrapper_pid_is_the_agent_pid() {
    let tree = Tree::new("exec");
    let out = tree.fake_claude();
    let rx = fake_daemon(&tree.socket(), Daemon::Modern);

    let mut child = launch(&tree, Some(&tree.socket()), &["-p", "hi"]);
    let wrapper_pid = child.id();
    let status = child.wait().expect("wait");

    let report = ran(&out, Duration::from_secs(5));
    assert_eq!(
        pid_of(&report),
        wrapper_pid,
        "grove-agent must EXECVP the agent, not fork it: the wrapper pid IS the agent pid"
    );
    assert!(status.success(), "the agent's own exit status flows through");

    // The user's args survive, and grove's hook config rides in front of them.
    assert!(report.contains("arg=-p"));
    assert!(report.contains("arg=hi"));
    assert!(
        report.contains("arg=--settings") || report.contains("arg=--plugin-dir"),
        "the agent must be launched with grove's hooks: {report}"
    );

    // …and the claim really happened, on the real socket, naming this pane and this tool.
    let claim = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the daemon saw a connection")
        .expect("the launcher sent agentClaim");
    assert_eq!(claim["method"], "agentClaim");
    assert_eq!(claim["params"]["sessionId"], SESSION);
    assert_eq!(claim["params"]["tool"], "claude");
    // No pid on the wire: the daemon reads the peer pid from the KERNEL, and the launcher
    // execs, so that pid is the agent's. A claimant cannot lie about who it is.
    assert!(claim["params"].get("pid").is_none());
}

/// No daemon at all (a stale socket path, a daemon that died). The claim fails in
/// microseconds — `ENOENT`, no timeout involved — and the agent runs anyway.
#[test]
fn a_claim_to_a_dead_socket_still_execs_the_agent() {
    let tree = Tree::new("deadsock");
    let out = tree.fake_claude();
    let dead = tree.0.join("not-a-socket.sock");

    let started = Instant::now();
    let mut child = launch(&tree, Some(&dead), &[]);
    let wrapper_pid = child.id();
    assert!(child.wait().unwrap().success());

    let report = ran(&out, Duration::from_secs(5));
    assert_eq!(pid_of(&report), wrapper_pid);
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "a dead socket must fail FAST, not burn the claim budget: {:?}",
        started.elapsed()
    );
}

/// The orchestrator's degrade-gracefully requirement, end to end.
///
/// An older daemon the supervisor ADOPTED (grove just shipped "your shells survive app
/// quit and reboot" — we do not get to orphan them by bumping the protocol) cannot parse
/// `role:"agent"`. It answers `HelloAck{ok:false}` and closes. The launcher must give up
/// SILENTLY: no hang, no error toast, no stderr noise, and the agent runs. The pane simply
/// shows no badge until that daemon is next restarted.
#[test]
fn an_adopted_old_daemon_rejects_the_role_and_the_agent_still_runs_silently() {
    let tree = Tree::new("adopted");
    let out = tree.fake_claude();
    let rx = fake_daemon(&tree.socket(), Daemon::Adopted);

    let started = Instant::now();
    let mut child = Command::new(AGENT)
        .arg("launch")
        .arg("claude")
        .arg("--")
        .env("PATH", tree.path())
        .env("GROVE_BIN_DIR", tree.grove_bin())
        .env("HOME", &tree.0)
        .env("GROVE_SESSION_ID", SESSION)
        .env("GROVE_SESSION_KEY", KEY)
        .env("GROVE_DAEMON_SOCK", tree.socket())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn");
    let wrapper_pid = child.id();

    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    let status = child.wait().unwrap();

    let report = ran(&out, Duration::from_secs(5));
    assert_eq!(
        pid_of(&report),
        wrapper_pid,
        "a rejected claim must STILL exec the agent"
    );
    assert!(status.success());
    assert_eq!(
        stderr, "",
        "the rejection must be SILENT — nothing may be printed into the agent's terminal"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "the refusal is prompt and terminal; nothing may hang: {:?}",
        started.elapsed()
    );
    assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());

    // And with no claim id, a hook has nothing to authorize with — it must say nothing at
    // all rather than guess. (`grove-agent event` with no GROVE_CLAIM_ID: exits 0, sends
    // nothing, and cannot hang.)
    let event = Command::new(AGENT)
        .arg("event")
        .env("GROVE_SESSION_ID", SESSION)
        .env("GROVE_SESSION_KEY", KEY)
        .env("GROVE_DAEMON_SOCK", tree.socket())
        .env_remove("GROVE_CLAIM_ID")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(br#"{"hook_event_name":"Stop"}"#)?;
            child.wait_with_output()
        })
        .expect("grove-agent event runs");
    assert!(event.status.success(), "a hook relay ALWAYS exits 0");
    assert!(event.stderr.is_empty());
}

/// `grove-agent event` is on the agent's critical path — Claude awaits each hook to
/// completion. Every pathology must be capped and every exit must be 0.
#[test]
fn the_event_relay_is_capped_and_always_exits_zero() {
    let tree = Tree::new("eventcap");

    // A daemon that ACCEPTS and then never answers. A read timeout alone cannot save you
    // here in the general case (a full listen backlog blocks `connect` itself), which is
    // why the relay carries a watchdog that exits the process from the outside.
    let socket = tree.socket();
    let listener = UnixListener::bind(&socket).unwrap();
    std::thread::spawn(move || {
        let mut held = Vec::new();
        while let Ok((stream, _)) = listener.accept() {
            held.push(stream); // accept, then stonewall
        }
    });

    for stdin in [
        r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash"}"#,
        "garbage, not even json",
        "",
    ] {
        let started = Instant::now();
        let output = Command::new(AGENT)
            .arg("event")
            .env("GROVE_SESSION_ID", SESSION)
            .env("GROVE_SESSION_KEY", KEY)
            .env("GROVE_DAEMON_SOCK", &socket)
            .env("GROVE_CLAIM_ID", "deadbeefdeadbeefdeadbeefdeadbeef")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                child.stdin.take().unwrap().write_all(stdin.as_bytes())?;
                child.wait_with_output()
            })
            .expect("grove-agent event runs");

        assert!(output.status.success(), "exit 0, always ({stdin})");
        assert!(output.stderr.is_empty(), "silent, always ({stdin})");
        assert!(
            started.elapsed() < Duration::from_millis(900),
            "a wedged daemon must not stall the agent: took {:?} on {stdin}",
            started.elapsed()
        );
    }
}

/// Ctrl-Z under a REAL PTY, driving a REAL interactive zsh.
///
/// The wedge this guards against is not hypothetical: a wrapper that forks and waits
/// leaves the agent stopped while the WRAPPER stays in the foreground blocked in
/// `waitpid`, so the shell never regains the terminal — the pane is dead, and only a kill
/// gets it back. With `exec`, the suspended process IS the job.
#[test]
fn ctrl_z_under_a_real_pty_suspends_the_agent_and_returns_the_prompt() {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    let tree = Tree::new("ctrlz");
    // A "TUI" that ignores nothing and just sleeps: whatever it does, ^Z must return the
    // prompt, because the thing the shell stops is the wrapper ITSELF.
    let claude = tree.0.join("bin").join("claude");
    std::fs::write(&claude, "#!/bin/sh\nexec sleep 120\n").unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();

    let pty = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("openpty");

    let mut shell = CommandBuilder::new("/bin/zsh");
    shell.args(["-f", "-i"]); // no user rc, interactive ⇒ real job control
    shell.env("PATH", tree.path());
    shell.env("HOME", tree.0.to_string_lossy().into_owned());
    shell.env("GROVE_BIN_DIR", tree.grove_bin().to_string_lossy().into_owned());
    shell.env("GROVE_SESSION_ID", SESSION);
    shell.env("GROVE_SESSION_KEY", KEY);
    shell.env("PS1", "READY%% ");
    shell.env("TERM", "dumb");
    let mut child = pty.slave.spawn_command(shell).expect("spawn zsh");
    drop(pty.slave);

    let mut reader = pty.master.try_clone_reader().expect("reader");
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut writer = pty.master.take_writer().expect("writer");

    let mut screen = String::new();
    let wait_for = |needle: &str, screen: &mut String, what: &str| {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !screen.contains(needle) {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(bytes) => screen.push_str(&String::from_utf8_lossy(&bytes)),
                Err(_) => assert!(Instant::now() < deadline, "timed out waiting for {what}"),
            }
        }
    };

    // The agent, launched through grove's wrapper exactly as a user would.
    writer
        .write_all(format!("{AGENT} launch claude -- --model opus\r").as_bytes())
        .unwrap();
    writer.flush().unwrap();
    std::thread::sleep(Duration::from_millis(800));

    // ^Z. If the wrapper had forked and waited, the shell would never get the tty back and
    // NOTHING below this line would ever appear.
    writer.write_all(&[0x1a]).unwrap();
    writer.flush().unwrap();
    screen.clear();
    writer.write_all(b"echo PROMPT_IS_BACK\r").unwrap();
    writer.flush().unwrap();
    wait_for("PROMPT_IS_BACK", &mut screen, "the prompt after ^Z");

    // The agent is STOPPED, not dead — it is a suspended job the user can `fg`. (The
    // daemon reads exactly this from the kernel and badges it `idle`: a suspended agent is
    // never "working" and never "needs you".)
    screen.clear();
    writer.write_all(b"jobs\r").unwrap();
    writer.flush().unwrap();
    wait_for("suspended", &mut screen, "a suspended job");

    writer.write_all(b"kill %1; exit\r").unwrap();
    writer.flush().unwrap();
    let _ = child.wait();
}
