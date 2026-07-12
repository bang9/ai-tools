//! grove-core's PTY **pub API** driven against the REAL daemon binary (design P9
//! cutover, stage 1). This lives in `grove-daemon`'s test crate because only here does
//! `env!("CARGO_BIN_EXE_grove-daemon")` resolve to a freshly-built daemon; grove-core
//! is a lib dependency, so `grove_core::pty::{create,write,resize,…}` are the exact
//! functions the Tauri commands / NAPI addon call.
//!
//! The daemon binary is handed to the supervisor through the documented
//! `GROVE_DAEMON_BIN` override (`grove_core::daemon::DAEMON_BIN_ENV`) — the same knob
//! CI and dev runs use when the app runs from a cargo target dir instead of a signed
//! bundle. Everything else (base dir, `HOME`) is a temp dir, so the test never touches
//! the developer's `~/.grove`.
//!
//! CI note: `cargo test -p grove-daemon` builds the daemon binary automatically
//! (CARGO_BIN_EXE), so nothing has to be pre-built. Run with `--test-threads=1`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use grove_core::daemon::{self, DaemonRuntimeConfig, DAEMON_BIN_ENV};
use grove_core::pty;
use grove_core::{
    AppliedPtySize, CreatePtyInitialHydrationSource, CreatePtyRequest, CreatePtySessionState,
    PtyEventSink,
};

mod support;
use support::TempDir;

#[derive(Default)]
struct CollectingSink {
    bytes: Mutex<Vec<u8>>,
}

impl PtyEventSink for CollectingSink {
    fn on_output(&self, _pty_id: &str, data: &[u8]) {
        self.bytes.lock().unwrap().extend_from_slice(data);
    }
}

impl CollectingSink {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.lock().unwrap()).into_owned()
    }
}

/// Every scratch dir is an RAII `TempDir` (see `support`) — a test run must not leave
/// `/tmp/gv-*` dirs on the developer's machine.
fn unique_dir(prefix: &str) -> TempDir {
    TempDir::new(prefix)
}

/// Regression guard for the harness itself: the dirs the suite makes are removed when
/// they go out of scope, panic or not.
#[test]
fn temp_dirs_are_removed_when_the_test_scope_ends() {
    let path = {
        let dir = unique_dir("drop");
        assert!(dir.path().is_dir());
        std::fs::write(dir.join("leftover"), b"x").unwrap();
        dir.to_path_buf()
    };
    assert!(
        !path.exists(),
        "a test temp dir survived its scope: {} — the suite leaks /tmp/gv-* dirs every run",
        path.display()
    );
}

async fn wait_until(timeout: Duration, label: &str, mut probe: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !probe() {
        assert!(Instant::now() < deadline, "timed out waiting for {label}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Poll the daemon's applied size until it matches, tolerating RPC lag (design
/// OVERLAY 2: a readback taken while a resize is in flight is skipped, not fatal).
async fn wait_for_applied_size(pty_id: &str, expected: AppliedPtySize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let applied = pty::applied_pty_size(pty_id)
            .await
            .expect("applied_pty_size must not error for a live pane");
        if applied == Some(expected) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "applied size never converged on {expected:?} (last: {applied:?})"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// create → write (the echo reaches the sink) → resize (applied size converges) →
/// clear_scrollback → warm reattach (Attached + a DaemonSnapshot hydration carrying the
/// pre-reattach screen) → close.
///
/// One test, not five: `daemon::configure` is a process-wide OnceLock, and the daemon it
/// spawns is DETACHED — it must be shut down exactly once, at the end, or it outlives
/// the test run.
#[tokio::test(flavor = "multi_thread")]
async fn pty_pub_api_lifecycle_and_warm_reattach_against_real_daemon() {
    let home = unique_dir("home");
    let base_dir = unique_dir("dmn");
    let worktree = unique_dir("wt");
    // Hermetic app data: `create` reads GrovePreferences (the scrollback cap) and
    // installs tool hooks, both under HOME.
    unsafe {
        std::env::set_var("HOME", &home);
        // The documented dev/CI override for the daemon binary (design item 1).
        std::env::set_var(DAEMON_BIN_ENV, env!("CARGO_BIN_EXE_grove-daemon"));
    }

    daemon::configure(DaemonRuntimeConfig {
        base_dir: base_dir.to_path_buf(),
        // Deliberately bogus: the GROVE_DAEMON_BIN override must win.
        bin_source_path: base_dir.join("not-a-real-daemon"),
        app_version: "0.0.0-test".to_string(),
    });

    let worktree_path = worktree.to_string_lossy().into_owned();
    let pane_id = "pane-lifecycle".to_string();
    let sink = Arc::new(CollectingSink::default());

    // --- create: a session id the daemon has never seen ⇒ fresh spawn, NO hydration.
    let created = pty::create(
        CreatePtyRequest {
            pty_id: "pty-1".into(),
            pane_id: pane_id.clone(),
            worktree_path: worktree_path.clone(),
            cwd: worktree_path.clone(),
            cols: 80,
            rows: 24,
            restore: None,
        },
        Arc::clone(&sink) as Arc<dyn PtyEventSink>,
    )
    .await
    .expect("create must spawn a daemon session");
    assert_eq!(created.session_state, CreatePtySessionState::Created);
    assert!(
        created.initial_hydration.is_none(),
        "a fresh spawn must carry no hydration — the frontend seeds snapshotFallback"
    );

    // --- write: the shell's echo of our input comes back through the stream sink.
    pty::write("pty-1", b"echo GROVE_MARKER_ONE\r")
        .await
        .expect("write must be accepted");
    {
        let sink = Arc::clone(&sink);
        wait_until(Duration::from_secs(20), "echoed output", move || {
            sink.text().contains("GROVE_MARKER_ONE")
        })
        .await;
    }

    // --- resize: the daemon emulator's applied grid converges on the request.
    pty::resize("pty-1", 120, 40)
        .await
        .expect("resize must be accepted");
    wait_for_applied_size("pty-1", AppliedPtySize { cols: 120, rows: 40 }).await;

    // --- clear_scrollback: acked by the daemon, and the pane keeps working after it.
    pty::clear_scrollback("pty-1")
        .await
        .expect("clear_scrollback must be acked");

    pty::write("pty-1", b"echo GROVE_MARKER_TWO\r")
        .await
        .expect("write after clear must be accepted");
    {
        let sink = Arc::clone(&sink);
        wait_until(Duration::from_secs(20), "post-clear output", move || {
            sink.text().contains("GROVE_MARKER_TWO")
        })
        .await;
    }

    // --- warm reattach. A second pane handle onto the SAME stable session id is what
    // `create` faces after an app relaunch: an empty registry + a live daemon session.
    // (The registry is process-global and private, so an in-process test cannot empty
    // it; the daemon-side decision under test — adopt vs spawn — is identical.)
    let reattach_sink = Arc::new(CollectingSink::default());
    let reattached = pty::create(
        CreatePtyRequest {
            pty_id: "pty-2".into(),
            pane_id: pane_id.clone(),
            worktree_path: worktree_path.clone(),
            cwd: worktree_path.clone(),
            cols: 120,
            rows: 40,
            restore: None,
        },
        Arc::clone(&reattach_sink) as Arc<dyn PtyEventSink>,
    )
    .await
    .expect("create must adopt the live daemon session");

    assert_eq!(reattached.session_state, CreatePtySessionState::Attached);
    let hydration = reattached
        .initial_hydration
        .expect("a warm reattach must carry a DaemonSnapshot hydration");
    assert_eq!(
        hydration.source,
        CreatePtyInitialHydrationSource::DaemonSnapshot
    );
    assert_eq!(hydration.snapshot_cols, Some(120));
    assert_eq!(hydration.snapshot_rows, Some(40));
    assert_eq!(hydration.is_alternate_screen, Some(false));
    assert_eq!(
        hydration.is_cold_restore, None,
        "a LIVE adopt is not a cold restore"
    );
    assert!(
        hydration.text.contains("GROVE_MARKER_TWO"),
        "the warm snapshot must carry the pre-reattach screen; got: {:?}",
        hydration.text
    );

    // The adopted pane is live: input still round-trips, now on the new sink.
    pty::write("pty-2", b"echo GROVE_MARKER_THREE\r")
        .await
        .expect("write to the reattached pane must be accepted");
    {
        let sink = Arc::clone(&reattach_sink);
        wait_until(Duration::from_secs(20), "post-reattach output", move || {
            sink.text().contains("GROVE_MARKER_THREE")
        })
        .await;
    }

    // --- close: kills the daemon session (which stamps ended_at) and drops the pane.
    pty::close("pty-2").await.expect("close must succeed");
    // The stale first handle for the same (now dead) session closes cleanly too.
    pty::close("pty-1").await.expect("close must be idempotent");
    assert_eq!(
        pty::applied_pty_size("pty-2").await.unwrap(),
        None,
        "a closed pane reports no applied size instead of erroring"
    );

    // Tear the DETACHED daemon down so it does not outlive the test run.
    daemon::global_client()
        .expect("the global client is installed by create()")
        .client()
        .shutdown(true)
        .await
        .expect("daemon shutdown");
}
