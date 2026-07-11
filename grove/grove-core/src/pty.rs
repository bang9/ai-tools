use crate::{
    config,
    process_env::{enriched_path, preferred_ssh_auth_sock, subprocess_env_pairs},
    tool_hooks::{self, TMUX_GROVE_AI_STATUS_OPTION},
    worktree_lifecycle::WorktreeResource,
    CreatePtyInitialHydration, CreatePtyInitialHydrationSource, CreatePtyRequest, CreatePtyRestore,
    CreatePtyResult, CreatePtySessionState, PtyBellEvent, SaveTerminalSessionSnapshotRequest,
    TerminalGcReport, TerminalPaneSnapshot, TerminalPaneSnapshotInput, TerminalRestoreCwdSource,
    TerminalSessionSnapshot,
};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::env;
use std::fmt::Write as _;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Output};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread::sleep;
use std::time::{Duration, Instant};

const MAX_SCROLLBACK_BYTES: usize = 256 * 1024;
/// Coalesce PTY reads into a time/size-windowed batch before emitting to the
/// sink, mirroring Orca's 8ms output batching. A flooding process produces
/// thousands of ~4KB reads/sec; without batching each pays the full
/// encode→IPC→decode→xterm.write cost. Flushing on an 8ms window or a 64KB
/// buffer collapses that into ~120Hz emits while adding ≤8ms latency.
const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const OUTPUT_FLUSH_SIZE: usize = 64 * 1024;
/// Hard ceiling on the coalescer's pending buffer. The flusher normally drains
/// every 8ms or 64KB, so `pending` only grows without bound when the sink
/// stalls (IPC backpressure) while a process floods output. Cap at 64× the
/// flush size (4 MiB) — orders of magnitude above any single 8ms window's worth
/// of reads, so normal use NEVER truncates; past it we drop oldest bytes
/// (keep-tail) so a runaway producer can't OOM the process. Sized off
/// OUTPUT_FLUSH_SIZE so it tracks the flush window if that constant changes.
const MAX_PENDING_BYTES: usize = OUTPUT_FLUSH_SIZE * 64;
const TMUX_NOT_FOUND_ERROR: &str = "tmux is required but was not found in PATH";
const TMUX_GROVE_MANAGED_OPTION: &str = "@grove_managed";
const TMUX_GROVE_WORKTREE_OPTION: &str = "@grove_worktree";
const TMUX_GROVE_PANE_ID_OPTION: &str = "@grove_pane_id";
const TMUX_STATUS_OPTION: &str = "status";
const TMUX_STATUS_OFF_VALUE: &str = "off";
const TMUX_MOUSE_OPTION: &str = "mouse";
const TMUX_MOUSE_ON_VALUE: &str = "on";
const TMUX_MONITOR_BELL_OPTION: &str = "monitor-bell";
const TMUX_MONITOR_BELL_ON_VALUE: &str = "on";
const TMUX_ESCAPE_TIME_OPTION: &str = "escape-time";
const TMUX_ESCAPE_TIME_VALUE: &str = "100";
const WORKTREE_HASH_LEN: usize = 12;
const PANE_PREFIX_LEN: usize = 8;
const PANE_HASH_LEN: usize = 4;
const CODEX_OUTPUT_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const HOOKLESS_ATTENTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const TERMINAL_GC_PROCESS_EXIT_GRACE: Duration = Duration::from_millis(250);

pub trait PtyEventSink: Send + Sync + 'static {
    fn on_output(&self, pty_id: &str, data: &[u8]);
}

#[derive(Clone, Debug)]
struct PtyRuntimeState {
    launch_cwd: String,
    process_id: Option<u32>,
    session_name: String,
    last_known_cwd: Option<String>,
    scrollback: VecDeque<u8>,
    scrollback_truncated: bool,
    last_bell_flag: bool,
    last_ai_status: Option<String>,
    last_output_at: Option<Instant>,
    /// Set when a hookless tool transitions running→idle. Used for attention timeout.
    idle_since: Option<Instant>,
    /// Set by read_pty_output on exit (EOF, read error, or contained panic).
    /// A live session with an exited reader gets no output until re-attach;
    /// terminal GC reports these instead of silently leaving a frozen pane.
    reader_exited: bool,
}

impl PtyRuntimeState {
    fn new(
        launch_cwd: String,
        process_id: Option<u32>,
        session_name: String,
        restore: Option<&CreatePtyRestore>,
        initial_hydration: Option<&TmuxCapturedContent>,
    ) -> Self {
        let mut state = Self {
            launch_cwd,
            process_id,
            session_name,
            last_known_cwd: None,
            scrollback: VecDeque::new(),
            scrollback_truncated: false,
            last_bell_flag: false,
            last_ai_status: None,
            last_output_at: None,
            idle_since: None,
            reader_exited: false,
        };

        if let Some(restore) = restore {
            state.last_known_cwd = restore
                .last_known_cwd
                .as_deref()
                .map(str::trim)
                .filter(|cwd| !cwd.is_empty())
                .map(str::to_string);
            state.scrollback_truncated = restore.scrollback_truncated.unwrap_or(false);
            if let Some(scrollback) = restore.scrollback.as_deref() {
                state.append_scrollback(scrollback.as_bytes());
            }
        }

        if let Some(initial_hydration) = initial_hydration {
            state.scrollback_truncated = initial_hydration.truncated;
            state.append_scrollback(&initial_hydration.bytes);
        }

        state
    }

    fn append_scrollback(&mut self, chunk: &[u8]) {
        append_scrollback_capped(
            &mut self.scrollback,
            &mut self.scrollback_truncated,
            chunk,
            MAX_SCROLLBACK_BYTES,
        );
    }
}

#[derive(Clone, Debug)]
struct PtyRuntimeSnapshot {
    launch_cwd: String,
    process_id: Option<u32>,
    session_name: String,
    last_known_cwd: Option<String>,
    scrollback: Vec<u8>,
    scrollback_truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessSnapshot {
    pid: u32,
    ppid: u32,
    command_line: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TerminalGcSessionInfo {
    session_name: String,
    worktree_path: String,
    attached: bool,
    pane_pid: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
struct TerminalGcPlan {
    stale_worktree_paths: Vec<String>,
    stale_session_names: Vec<String>,
    stale_session_pane_pids: Vec<u32>,
    skipped_attached_worktree_paths: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TmuxCaptureScope {
    History,
    AlternateScreen,
    ModeScreen,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TmuxCapturedContent {
    bytes: Vec<u8>,
    truncated: bool,
}

struct PtyInstance {
    session_name: String,
    worktree_path: String,
    /// Behind its own per-instance lock so a stalled `write_all` (tmux input
    /// buffer full) only blocks writes to THIS pty, not every unrelated pty
    /// serializing on the global registry lock.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    tracked: Arc<Mutex<PtyRuntimeState>>,
}

struct CoalescerInner {
    pending: Vec<u8>,
    first_byte_at: Option<Instant>,
    closed: bool,
    /// Set when the pending cap forced a keep-tail drop. Internal only — never
    /// surfaced to the sink; a visible marker would corrupt the xterm stream.
    #[cfg_attr(not(test), allow(dead_code))]
    truncated: bool,
}

struct CoalescerShared {
    state: Mutex<CoalescerInner>,
    cvar: Condvar,
    sink: Arc<dyn PtyEventSink>,
    id: String,
}

/// Time/size-windowed coalescing buffer sitting between the PTY read loop and
/// `sink.on_output`. The reader thread only appends bytes (`push`); a single
/// dedicated flusher thread is the SOLE emitter, so bytes always reach the sink
/// in read order with no cross-thread interleaving. Emits happen off the lock.
struct OutputCoalescer {
    shared: Arc<CoalescerShared>,
}

impl OutputCoalescer {
    fn new(sink: Arc<dyn PtyEventSink>, id: String) -> Self {
        let shared = Arc::new(CoalescerShared {
            state: Mutex::new(CoalescerInner {
                pending: Vec::new(),
                first_byte_at: None,
                closed: false,
                truncated: false,
            }),
            cvar: Condvar::new(),
            sink,
            id,
        });
        let flusher_shared = Arc::clone(&shared);
        std::thread::spawn(move || run_output_flusher(flusher_shared));
        Self { shared }
    }

    fn push(&self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let mut state = lock_recover(&self.shared.state);
        if state.closed {
            return;
        }
        state.pending.extend_from_slice(data);
        if state.pending.len() > MAX_PENDING_BYTES {
            // Why: a stalled sink can't drain; keep the newest tail so xterm
            // still gets the latest screen rather than letting pending grow
            // unbounded and OOM the process.
            let mut overflow = state.pending.len() - MAX_PENDING_BYTES;
            // Why: dropping mid-codepoint would hand xterm a stray UTF-8
            // continuation byte; extend the drop to the next lead byte.
            // Mid-escape cuts remain an accepted above-cap tradeoff.
            while state
                .pending
                .get(overflow)
                .is_some_and(|b| (b & 0xC0) == 0x80)
            {
                overflow += 1;
            }
            state.pending.drain(..overflow);
            state.truncated = true;
        }
        if state.first_byte_at.is_none() {
            state.first_byte_at = Some(Instant::now());
        }
        self.shared.cvar.notify_one();
    }

    fn close(&self) {
        let mut state = lock_recover(&self.shared.state);
        state.closed = true;
        self.shared.cvar.notify_all();
    }
}

impl Drop for OutputCoalescer {
    fn drop(&mut self) {
        // Guarantee the flusher thread terminates even if `close` was never
        // called explicitly (e.g. panic on the reader thread).
        self.close();
    }
}

/// Sole emitter for a PTY's coalesced output. Wakes on new bytes or the 8ms
/// window, drains the pending buffer under the lock, then calls `on_output`
/// OUTSIDE the lock so IPC never blocks the reader thread's appends. Exits once
/// `closed` is set and any final tail has been flushed.
fn run_output_flusher(shared: Arc<CoalescerShared>) {
    let mut guard = lock_recover(&shared.state);
    loop {
        while !guard.closed && guard.pending.is_empty() {
            guard = shared
                .cvar
                .wait(guard)
                .unwrap_or_else(|error| error.into_inner());
        }

        if guard.closed {
            // Flush any final tail on teardown before exiting.
            let drained = std::mem::take(&mut guard.pending);
            guard.first_byte_at = None;
            drop(guard);
            if !drained.is_empty() {
                shared.sink.on_output(&shared.id, &drained);
            }
            return;
        }

        let first = guard.first_byte_at.unwrap_or_else(Instant::now);
        let elapsed = first.elapsed();
        if guard.pending.len() >= OUTPUT_FLUSH_SIZE || elapsed >= OUTPUT_FLUSH_INTERVAL {
            let drained = std::mem::take(&mut guard.pending);
            guard.first_byte_at = None;
            drop(guard);
            shared.sink.on_output(&shared.id, &drained);
            guard = lock_recover(&shared.state);
        } else {
            let remaining = OUTPUT_FLUSH_INTERVAL - elapsed;
            guard = shared
                .cvar
                .wait_timeout(guard, remaining)
                .unwrap_or_else(|error| error.into_inner())
                .0;
        }
    }
}

fn registry() -> &'static Mutex<HashMap<String, PtyInstance>> {
    static PTY_REGISTRY: OnceLock<Mutex<HashMap<String, PtyInstance>>> = OnceLock::new();
    PTY_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Recover a poisoned lock instead of propagating the panic. A panic while a
/// thread held one of the hot PTY locks (registry, per-instance writer/tracked,
/// coalescer state) leaves the guarded data structurally valid, so bricking
/// every future PTY op on the poison flag is strictly worse than continuing.
/// Mirrors the idiom in test_support::env_lock.
fn lock_recover<T>(lock: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|error| error.into_inner())
}

/// Install a process-wide panic hook that routes thread panics through
/// grove-core's logger. Idempotent; each shell may call it at init. Without it
/// a panic on a detached PTY reader/flusher thread unwinds and vanishes (the
/// default hook only touches stderr), leaving no trace on the app's log surface.
pub fn install_panic_hook() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    if INSTALLED.set(()).is_err() {
        return;
    }

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|loc| format!("{}:{}", loc.file(), loc.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        crate::logger::emit_log("error", "panic", &format!("thread panic at {location}: {message}"));
        previous(info);
    }));
}

fn is_utf8_locale(locale: &str) -> bool {
    let upper = locale.to_ascii_uppercase();
    upper.contains("UTF-8") || upper.contains("UTF8")
}

fn preferred_utf8_locale() -> String {
    for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
        if let Ok(value) = env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() && is_utf8_locale(trimmed) && is_usable_locale(trimmed) {
                return trimmed.to_string();
            }
        }
    }

    "C.UTF-8".to_string()
}

/// Bare "UTF-8" / "UTF8" are not valid POSIX locale names and cause tools
/// like zsh and tmux to mishandle multi-byte input. Require a proper locale
/// prefix (e.g. "en_US.UTF-8", "C.UTF-8").
fn is_usable_locale(locale: &str) -> bool {
    let upper = locale.to_ascii_uppercase();
    upper != "UTF-8" && upper != "UTF8"
}

pub fn create(
    request: CreatePtyRequest,
    sink: Arc<dyn PtyEventSink>,
) -> Result<CreatePtyResult, String> {
    tool_hooks::ensure_installed();

    let CreatePtyRequest {
        pty_id,
        pane_id,
        worktree_path,
        cwd,
        cols,
        rows,
        restore,
    } = request;

    let pty_id = required_arg("ptyId", &pty_id)?;
    let pane_id = required_arg("paneId", &pane_id)?;
    let worktree_path = required_arg("worktreePath", &worktree_path)?;
    let cwd = required_arg("cwd", &cwd)?;

    {
        let reg = lock_recover(registry());
        if reg.contains_key(pty_id.as_str()) {
            return Err(format!("PTY already exists: {pty_id}"));
        }
    }

    let session_name = grove_tmux_session_name(&worktree_path, &pane_id);
    let session_state = ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &cwd)?;
    let initial_hydration_capture = match session_state {
        CreatePtySessionState::Attached => Some(capture_tmux_content_with_fallback(
            &session_name,
            tmux_capture_scope(
                tmux_pane_in_mode(&session_name)?,
                tmux_pane_alternate_on(&session_name)?,
            ),
        )?),
        CreatePtySessionState::Created => None,
    };
    let initial_hydration = initial_hydration_capture
        .as_ref()
        .map(create_tmux_initial_hydration);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new("tmux");
    cmd.arg("-u");
    cmd.arg("attach-session");
    cmd.arg("-t");
    cmd.arg(&session_name);
    cmd.cwd(&worktree_path);
    apply_portable_terminal_env(&mut cmd);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let restore_seed = runtime_restore_seed(session_state, restore.as_ref());
    let tracked = Arc::new(Mutex::new(PtyRuntimeState::new(
        cwd.clone(),
        child.process_id(),
        session_name.clone(),
        restore_seed,
        initial_hydration_capture.as_ref(),
    )));
    drop(pair.slave);

    let reader_id = pty_id.clone();
    let tracked_for_reader = Arc::clone(&tracked);
    let coalescer = OutputCoalescer::new(sink, reader_id);
    std::thread::spawn(move || {
        read_pty_output(reader, coalescer, tracked_for_reader);
    });

    let instance = PtyInstance {
        session_name,
        worktree_path,
        writer: Arc::new(Mutex::new(writer)),
        master: pair.master,
        child,
        tracked,
    };

    lock_recover(registry()).insert(pty_id, instance);

    Ok(CreatePtyResult {
        session_state,
        initial_hydration,
    })
}

fn read_pty_output(
    mut reader: Box<dyn Read + Send>,
    coalescer: OutputCoalescer,
    tracked: Arc<Mutex<PtyRuntimeState>>,
) {
    enum ReadStep {
        Continue,
        Stop,
    }

    let mut buf = [0u8; 4096];
    loop {
        // Why: a panic anywhere in the read path (e.g. scrollback bookkeeping)
        // must never escape this detached thread. catch_unwind contains it so
        // the flusher is still torn down cleanly below; the diagnostic goes to
        // the logger ONLY — emitting through the sink would render the panic
        // text as visible garbage in xterm.
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match reader.read(&mut buf) {
                Ok(0) => ReadStep::Stop,
                Ok(n) => {
                    // Raw-path bookkeeping stays per-read: append_scrollback and
                    // last_output_at must reflect every read (the hookless idle
                    // state machine in poll_bell_events depends on per-read
                    // freshness), independent of when output is coalesced/emitted.
                    {
                        let mut state = lock_recover(&tracked);
                        state.append_scrollback(&buf[..n]);
                        state.last_output_at = Some(Instant::now());
                    }
                    coalescer.push(&buf[..n]);
                    ReadStep::Continue
                }
                Err(_) => ReadStep::Stop,
            }
        }));

        match outcome {
            Ok(ReadStep::Continue) => continue,
            Ok(ReadStep::Stop) => break,
            Err(_) => {
                crate::logger::emit_log(
                    "error",
                    "pty",
                    "read loop panicked; terminating reader thread",
                );
                break;
            }
        }
    }
    lock_recover(&tracked).reader_exited = true;
    // Flush any pending tail and terminate the flusher thread on EOF/Err/panic.
    coalescer.close();
}

pub fn write(id: &str, data: &[u8]) -> Result<(), String> {
    // Clone the per-instance handles under a short registry lock, then release
    // it before write_all so a stalled write only blocks this pty, not every
    // unrelated write/create/close serializing on the global registry lock.
    let (writer, tracked) = {
        let reg = lock_recover(registry());
        let instance = reg.get(id).ok_or_else(|| format!("PTY not found: {}", id))?;
        (Arc::clone(&instance.writer), Arc::clone(&instance.tracked))
    };

    lock_recover(&writer)
        .write_all(data)
        .map_err(|e| e.to_string())?;

    // Detect Enter for hookless-tool idle→running transition.
    // Also reset last_output_at so the idle timeout starts from Enter,
    // not from the previous output (which could be minutes ago).
    let transition_session = if data.contains(&b'\r') {
        let mut state = lock_recover(&tracked);
        let status = state.last_ai_status.clone();
        let s = status.as_deref();
        if tool_hooks::needs_idle_detection(s) && !tool_hooks::is_running(s) {
            state.last_output_at = Some(Instant::now());
            Some((
                state.session_name.clone(),
                tool_hooks::to_running(s.unwrap()),
            ))
        } else {
            None
        }
    } else {
        None
    };

    // Set tmux option outside of registry lock to avoid holding locks during shell-out.
    if let Some((session_name, running_status)) = transition_session {
        let _ = tmux_set_option(&session_name, TMUX_GROVE_AI_STATUS_OPTION, &running_status);
    }

    Ok(())
}

pub fn resize(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let reg = lock_recover(registry());
    let instance = reg
        .get(id)
        .ok_or_else(|| format!("PTY not found: {}", id))?;
    instance
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

pub fn clear_scrollback(id: &str) -> Result<(), String> {
    let (session_name, tracked) = {
        let reg = lock_recover(registry());
        let instance = reg
            .get(id)
            .ok_or_else(|| format!("PTY not found: {}", id))?;
        (instance.session_name.clone(), Arc::clone(&instance.tracked))
    };

    clear_tmux_history(&session_name)?;

    let mut state = lock_recover(&tracked);
    state.scrollback.clear();
    state.scrollback_truncated = false;

    Ok(())
}

fn reap_child_after_close(mut child: Box<dyn portable_pty::Child + Send + Sync>) {
    match child.try_wait() {
        Ok(Some(_)) => return,
        Ok(None) => {}
        Err(error) => {
            eprintln!("Warning: failed to poll PTY child before close: {error}");
        }
    }

    let kill_error = child.kill().err();
    if let Err(wait_error) = child.wait() {
        if let Some(kill_error) = kill_error {
            eprintln!(
                "Warning: failed to terminate PTY child during close: {kill_error}; failed to reap child: {wait_error}"
            );
        } else {
            eprintln!("Warning: failed to reap PTY child during close: {wait_error}");
        }
    }
}

pub fn close(id: &str) -> Result<(), String> {
    let session_name = {
        let reg = lock_recover(registry());
        reg.get(id)
            .map(|instance| instance.session_name.clone())
            .ok_or_else(|| format!("PTY not found: {}", id))?
    };

    kill_tmux_session_if_exists(&session_name)?;

    let mut reg = lock_recover(registry());
    if let Some(instance) = reg.remove(id) {
        std::thread::spawn(move || {
            reap_child_after_close(instance.child);
        });
    }

    Ok(())
}

pub fn close_ptys_for_worktree(worktree_path: &str) -> Result<(), String> {
    let matching_ids: Vec<String> = {
        let reg = lock_recover(registry());
        reg.iter()
            .filter(|(_, instance)| instance.worktree_path == worktree_path)
            .map(|(id, _)| id.clone())
            .collect()
    };

    for id in &matching_ids {
        if let Err(e) = close(id) {
            eprintln!("Warning: failed to close PTY {id} for worktree {worktree_path}: {e}");
        }
    }

    close_orphaned_tmux_sessions_for_worktree(worktree_path)?;

    Ok(())
}

pub fn run_terminal_gc(dry_run: bool) -> Result<TerminalGcReport, String> {
    let referenced_paths = collect_referenced_worktree_paths()?;
    let grove_sessions = list_grove_tmux_sessions()?;
    let session_infos = collect_terminal_gc_session_infos(&grove_sessions)?;
    let plan = build_terminal_gc_plan(referenced_paths, &session_infos);

    let registry_snapshot: Vec<RegistryReapEntry> = {
        let reg = lock_recover(registry());
        reg.iter()
            .map(|(id, instance)| RegistryReapEntry {
                pty_id: id.clone(),
                session_name: instance.session_name.clone(),
                reader_exited: lock_recover(&instance.tracked).reader_exited,
            })
            .collect()
    };
    let live_sessions: HashSet<String> = grove_sessions.iter().cloned().collect();
    let reap_plan = build_registry_reap_plan(&registry_snapshot, &live_sessions);

    let mut report = TerminalGcReport {
        stale_worktree_paths: plan.stale_worktree_paths.clone(),
        stale_session_names: plan.stale_session_names.clone(),
        skipped_attached_worktree_paths: plan.skipped_attached_worktree_paths.clone(),
        dead_reader_pty_ids: reap_plan.dead_reader_pty_ids.clone(),
        ..TerminalGcReport::default()
    };

    for pty_id in &reap_plan.dead_reader_pty_ids {
        crate::logger::emit_log(
            "warn",
            "pty",
            &format!("terminal GC: PTY {pty_id} has a live session but an exited reader"),
        );
    }

    if dry_run {
        report.reaped_pty_ids = reap_plan
            .reap_candidates
            .iter()
            .map(|candidate| candidate.pty_id.clone())
            .collect();
        return Ok(report);
    }

    report.reaped_pty_ids = reap_dead_registry_entries(&reap_plan.reap_candidates);

    let leftover_candidates = collect_process_tree_candidates(&plan.stale_session_pane_pids);

    for worktree_path in &plan.stale_worktree_paths {
        config::remove_terminal_layouts_for_worktree(worktree_path)?;
        config::remove_terminal_session_snapshot_for_worktree(worktree_path)?;
        config::remove_panel_layouts_for_worktree(worktree_path)?;
        report.pruned_worktree_paths.push(worktree_path.clone());
    }

    for session_name in &plan.stale_session_names {
        match close_grove_session_by_name(session_name) {
            Ok(()) => report.killed_session_names.push(session_name.clone()),
            Err(error) => eprintln!(
                "Warning: failed to close stale Grove tmux session {session_name}: {error}"
            ),
        }
    }

    report.leftover_process_ids = terminate_leftover_processes(&leftover_candidates);

    Ok(report)
}

struct RegistryReapEntry {
    pty_id: String,
    session_name: String,
    reader_exited: bool,
}

struct RegistryReapPlan {
    reap_candidates: Vec<RegistryReapCandidate>,
    dead_reader_pty_ids: Vec<String>,
}

struct RegistryReapCandidate {
    pty_id: String,
    session_name: String,
}

/// Removes confirmed-dead registry entries and returns the reaped PTY ids.
fn reap_dead_registry_entries(candidates: &[RegistryReapCandidate]) -> Vec<String> {
    let mut reaped = Vec::new();
    for candidate in candidates {
        // Why: the session list predates the registry snapshot, so a session
        // created in between would look missing; only reap after tmux itself
        // confirms the session is gone.
        match tmux_session_exists(&candidate.session_name) {
            Ok(false) => {}
            Ok(true) | Err(_) => continue,
        }
        let removed = lock_recover(registry()).remove(&candidate.pty_id);
        if let Some(instance) = removed {
            std::thread::spawn(move || {
                reap_child_after_close(instance.child);
            });
            crate::logger::emit_log(
                "info",
                "pty",
                &format!(
                    "terminal GC: reaped PTY {} (tmux session {} no longer exists)",
                    candidate.pty_id, candidate.session_name
                ),
            );
            reaped.push(candidate.pty_id.clone());
        }
    }
    reaped
}

/// Partitions a registry snapshot against the live grove tmux session set.
/// Grove PTYs only exist inside grove-managed tmux sessions, so an entry whose
/// session vanished (external kill, tmux server restart, pane exit) is dead:
/// its master fd, writer, and child handle leak until reaped. An entry whose
/// session is alive but whose reader exited is report-only — the session (and
/// the user's shell) must survive; re-attach is a separate concern.
fn build_registry_reap_plan(
    snapshot: &[RegistryReapEntry],
    live_sessions: &HashSet<String>,
) -> RegistryReapPlan {
    let mut reap_candidates = Vec::new();
    let mut dead_reader_pty_ids = Vec::new();

    for entry in snapshot {
        if !live_sessions.contains(&entry.session_name) {
            reap_candidates.push(RegistryReapCandidate {
                pty_id: entry.pty_id.clone(),
                session_name: entry.session_name.clone(),
            });
        } else if entry.reader_exited {
            dead_reader_pty_ids.push(entry.pty_id.clone());
        }
    }

    RegistryReapPlan {
        reap_candidates,
        dead_reader_pty_ids,
    }
}

pub fn cleanup_stale_tmux_sessions_on_startup() -> Result<(), String> {
    run_terminal_gc(false).map(|_| ())
}

#[cfg(test)]
#[allow(dead_code)]
fn cleanup_stale_tmux_sessions<I>(
    session_names: I,
    preserved_sessions: &HashSet<String>,
) -> Result<(), String>
where
    I: IntoIterator<Item = String>,
{
    let live_sessions: HashSet<String> = {
        let reg = lock_recover(registry());
        reg.values()
            .map(|instance| instance.session_name.clone())
            .collect()
    };

    for session_name in session_names {
        if live_sessions.contains(&session_name) || preserved_sessions.contains(&session_name) {
            continue;
        }

        let managed = match tmux_session_option(&session_name, TMUX_GROVE_MANAGED_OPTION) {
            Ok(value) => value,
            Err(error) if tmux_session_missing(&error) => continue,
            Err(error) => {
                eprintln!(
                    "Warning: failed to inspect tmux session {session_name} during startup cleanup: {error}"
                );
                continue;
            }
        };
        if managed.as_deref() != Some("1") {
            continue;
        }

        let attached_clients = match tmux_session_attached_count(&session_name) {
            Ok(value) => value,
            Err(error) if tmux_session_missing(&error) => continue,
            Err(error) => {
                eprintln!(
                    "Warning: failed to inspect attached tmux clients for {session_name} during startup cleanup: {error}"
                );
                continue;
            }
        };
        if attached_clients > 0 {
            continue;
        }

        if let Err(error) = kill_tmux_session_if_exists(&session_name) {
            eprintln!(
                "Warning: failed to clean up stale tmux session {session_name} during startup cleanup: {error}"
            );
        }
    }

    Ok(())
}

fn collect_referenced_worktree_paths() -> Result<Vec<String>, String> {
    let mut paths = BTreeSet::new();

    let terminal_layouts: serde_json::Map<String, Value> =
        serde_json::from_str(&config::load_terminal_layouts_impl()?)
            .map_err(|error| format!("Failed to parse terminal-layouts.json: {error}"))?;
    paths.extend(terminal_layouts.keys().cloned());

    let panel_layouts: serde_json::Map<String, Value> =
        serde_json::from_str(&config::load_panel_layouts_impl()?)
            .map_err(|error| format!("Failed to parse panel-layouts.json: {error}"))?;
    paths.extend(
        panel_layouts
            .keys()
            .filter(|key| Path::new(key).is_absolute())
            .cloned(),
    );

    let snapshot_store = config::load_terminal_session_snapshot_store()?;
    paths.extend(snapshot_store.worktrees.into_keys());

    Ok(paths.into_iter().collect())
}

fn collect_terminal_gc_session_infos(
    grove_sessions: &[String],
) -> Result<Vec<TerminalGcSessionInfo>, String> {
    let mut sessions = Vec::new();

    for session_name in grove_sessions.iter().cloned() {
        let managed = match tmux_session_option(&session_name, TMUX_GROVE_MANAGED_OPTION) {
            Ok(value) => value,
            Err(error) if tmux_session_missing(&error) => continue,
            Err(error) => {
                eprintln!(
                    "Warning: failed to inspect tmux session {session_name} during terminal GC: {error}"
                );
                continue;
            }
        };
        if managed.as_deref() != Some("1") {
            continue;
        }

        let worktree_path = match tmux_session_option(&session_name, TMUX_GROVE_WORKTREE_OPTION) {
            Ok(Some(value)) if !value.trim().is_empty() => value,
            Ok(_) => continue,
            Err(error) if tmux_session_missing(&error) => continue,
            Err(error) => {
                eprintln!(
                    "Warning: failed to inspect tmux worktree metadata for {session_name} during terminal GC: {error}"
                );
                continue;
            }
        };

        let attached = match tmux_session_attached_count(&session_name) {
            Ok(value) => value > 0,
            Err(error) if tmux_session_missing(&error) => continue,
            Err(error) => {
                eprintln!(
                    "Warning: failed to inspect attached client count for {session_name} during terminal GC: {error}"
                );
                continue;
            }
        };

        sessions.push(TerminalGcSessionInfo {
            pane_pid: tmux_pane_pid(&session_name).ok().flatten(),
            session_name,
            worktree_path,
            attached,
        });
    }

    Ok(sessions)
}

fn build_terminal_gc_plan(
    referenced_paths: Vec<String>,
    session_infos: &[TerminalGcSessionInfo],
) -> TerminalGcPlan {
    let mut missing_paths = BTreeSet::new();
    let mut sessions_by_worktree: BTreeMap<String, Vec<&TerminalGcSessionInfo>> = BTreeMap::new();

    for worktree_path in referenced_paths {
        if !Path::new(&worktree_path).exists() {
            missing_paths.insert(worktree_path);
        }
    }

    for session in session_infos {
        if !Path::new(&session.worktree_path).exists() {
            missing_paths.insert(session.worktree_path.clone());
        }
        sessions_by_worktree
            .entry(session.worktree_path.clone())
            .or_default()
            .push(session);
    }

    let mut stale_worktree_paths = Vec::new();
    let mut stale_session_names = BTreeSet::new();
    let mut stale_session_pane_pids = BTreeSet::new();
    let mut skipped_attached_worktree_paths = Vec::new();

    for worktree_path in missing_paths {
        let attached_sessions = sessions_by_worktree
            .get(&worktree_path)
            .is_some_and(|sessions| sessions.iter().any(|session| session.attached));

        if attached_sessions {
            skipped_attached_worktree_paths.push(worktree_path);
            continue;
        }

        stale_worktree_paths.push(worktree_path.clone());

        if let Some(sessions) = sessions_by_worktree.get(&worktree_path) {
            for session in sessions.iter().filter(|session| !session.attached) {
                stale_session_names.insert(session.session_name.clone());
                if let Some(pane_pid) = session.pane_pid {
                    stale_session_pane_pids.insert(pane_pid);
                }
            }
        }
    }

    TerminalGcPlan {
        stale_worktree_paths,
        stale_session_names: stale_session_names.into_iter().collect(),
        stale_session_pane_pids: stale_session_pane_pids.into_iter().collect(),
        skipped_attached_worktree_paths,
    }
}

fn close_grove_session_by_name(session_name: &str) -> Result<(), String> {
    kill_tmux_session_if_exists(session_name)?;

    let mut removed_instances = Vec::new();
    {
        let mut reg = lock_recover(registry());
        let matching_ids: Vec<String> = reg
            .iter()
            .filter(|(_, instance)| instance.session_name == session_name)
            .map(|(id, _)| id.clone())
            .collect();

        for id in matching_ids {
            if let Some(instance) = reg.remove(&id) {
                removed_instances.push(instance);
            }
        }
    }

    for instance in removed_instances {
        std::thread::spawn(move || {
            reap_child_after_close(instance.child);
        });
    }

    Ok(())
}

fn collect_process_tree_candidates(root_pids: &[u32]) -> BTreeSet<u32> {
    let processes = match list_process_snapshots() {
        Ok(processes) => processes,
        Err(error) => {
            eprintln!("Warning: failed to collect process tree for terminal GC: {error}");
            return BTreeSet::new();
        }
    };

    let children_by_pid: HashMap<u32, Vec<u32>> =
        processes.iter().fold(HashMap::new(), |mut acc, process| {
            acc.entry(process.ppid).or_default().push(process.pid);
            acc
        });

    let mut candidates = BTreeSet::new();
    for root_pid in root_pids {
        let mut stack = vec![*root_pid];
        while let Some(pid) = stack.pop() {
            if !candidates.insert(pid) {
                continue;
            }
            if let Some(children) = children_by_pid.get(&pid) {
                stack.extend(children.iter().copied());
            }
        }
    }

    candidates
}

fn terminate_leftover_processes(candidate_pids: &BTreeSet<u32>) -> Vec<u32> {
    if candidate_pids.is_empty() {
        return Vec::new();
    }

    sleep(TERMINAL_GC_PROCESS_EXIT_GRACE);

    let live_after_tmux_kill = match list_process_snapshots() {
        Ok(processes) => processes
            .into_iter()
            .map(|process| process.pid)
            .collect::<HashSet<_>>(),
        Err(error) => {
            eprintln!("Warning: failed to inspect leftover processes after terminal GC: {error}");
            return Vec::new();
        }
    };

    let leftover: Vec<u32> = candidate_pids
        .iter()
        .copied()
        .filter(|pid| live_after_tmux_kill.contains(pid))
        .collect();
    if leftover.is_empty() {
        return leftover;
    }

    if let Err(error) = signal_processes(&leftover, "-TERM") {
        eprintln!("Warning: failed to terminate leftover processes after terminal GC: {error}");
        return leftover;
    }

    sleep(TERMINAL_GC_PROCESS_EXIT_GRACE);

    let still_running = match list_process_snapshots() {
        Ok(processes) => {
            let live = processes
                .into_iter()
                .map(|process| process.pid)
                .collect::<HashSet<_>>();
            leftover
                .iter()
                .copied()
                .filter(|pid| live.contains(pid))
                .collect::<Vec<_>>()
        }
        Err(error) => {
            eprintln!(
                "Warning: failed to re-check leftover processes after SIGTERM during terminal GC: {error}"
            );
            return leftover;
        }
    };

    if !still_running.is_empty() {
        if let Err(error) = signal_processes(&still_running, "-KILL") {
            eprintln!("Warning: failed to SIGKILL leftover processes after terminal GC: {error}");
        }
    }

    leftover
}

fn signal_processes(pids: &[u32], signal: &str) -> Result<(), String> {
    for pid in pids {
        let output = Command::new("kill")
            .args([signal, &pid.to_string()])
            .output()
            .map_err(|error| format!("failed to execute kill {signal} {pid}: {error}"))?;

        if !output.status.success() {
            let message = tmux_output_message(&output);
            if message.contains("No such process") {
                continue;
            }
            return Err(format!("kill {signal} {pid} failed: {message}"));
        }
    }

    Ok(())
}

#[cfg(test)]
#[allow(dead_code)]
fn restorable_grove_tmux_sessions_from_layouts(raw: &str) -> Result<HashSet<String>, String> {
    let layouts: serde_json::Map<String, Value> = serde_json::from_str(raw)
        .map_err(|error| format!("Failed to parse terminal-layouts.json: {error}"))?;
    let mut session_names = HashSet::new();

    for (worktree_path, layout) in layouts {
        collect_restorable_tmux_sessions(&worktree_path, &layout, &mut session_names);
    }

    Ok(session_names)
}

#[cfg(test)]
#[allow(dead_code)]
fn restorable_grove_tmux_sessions_from_panel_layouts(raw: &str) -> Result<HashSet<String>, String> {
    let panels: Value = serde_json::from_str(raw)
        .map_err(|error| format!("Failed to parse panel-layouts.json: {error}"))?;

    let mut session_names = HashSet::new();
    let base_dir = config::load_app_config().base_dir;

    if let Some(tabs) = panels
        .get("globalTerminal")
        .and_then(|gt| gt.get("tabs"))
        .and_then(Value::as_array)
    {
        for tab in tabs {
            if tab.get("mirrorPtyId").and_then(Value::as_str).is_some() {
                continue;
            }
            if let Some(pane_id) = tab.get("paneId").and_then(Value::as_str) {
                session_names.insert(grove_tmux_session_name(&base_dir, pane_id));
            }
        }
    }

    Ok(session_names)
}

#[cfg(test)]
#[allow(dead_code)]
fn collect_restorable_tmux_sessions(
    worktree_path: &str,
    node: &Value,
    session_names: &mut HashSet<String>,
) {
    let Some(object) = node.as_object() else {
        return;
    };

    let node_type = object.get("type").and_then(Value::as_str);
    if node_type == Some("horizontal") || node_type == Some("vertical") {
        if let Some(children) = object.get("children").and_then(Value::as_array) {
            for child in children {
                collect_restorable_tmux_sessions(worktree_path, child, session_names);
            }
        }
        return;
    }

    if let Some(pane_id) = object.get("id").and_then(Value::as_str) {
        session_names.insert(grove_tmux_session_name(worktree_path, pane_id));
    }
}

fn reconcile_hookless_ai_status(
    current_ai_status: Option<&str>,
    live_tool: Option<&str>,
    last_ai_status: Option<&str>,
    last_output_at: Option<Instant>,
) -> Option<String> {
    let Some(live_tool) = live_tool else {
        return current_ai_status.map(str::to_string);
    };

    let current_tool = current_ai_status.and_then(|status| status.split(':').next());
    if current_tool == Some(live_tool) {
        return current_ai_status.map(str::to_string);
    }

    Some(recover_hookless_ai_status(
        live_tool,
        last_ai_status,
        last_output_at,
    ))
}

fn recover_hookless_ai_status(
    tool: &str,
    last_ai_status: Option<&str>,
    last_output_at: Option<Instant>,
) -> String {
    if let Some(previous) = last_ai_status {
        let previous_tool = previous.split(':').next().unwrap_or_default();
        if previous_tool == tool && !previous.ends_with(":attention") {
            return previous.to_string();
        }
    }

    if last_output_at.is_some_and(|t| t.elapsed() < CODEX_OUTPUT_IDLE_TIMEOUT) {
        format!("{tool}:running")
    } else {
        format!("{tool}:idle")
    }
}

fn detect_live_hookless_tool_in_session_from_processes(
    pane_pid: Option<u32>,
    processes: &[ProcessSnapshot],
) -> Option<&'static str> {
    detect_hookless_tool_from_process_tree(pane_pid?, processes)
}

fn tmux_pane_pid(session_name: &str) -> Result<Option<u32>, String> {
    Ok(tmux_display_message_value(session_name, "#{pane_pid}")?
        .and_then(|value| value.parse::<u32>().ok()))
}

fn list_process_snapshots() -> Result<Vec<ProcessSnapshot>, String> {
    let output = Command::new("ps")
        .args(["-Ao", "pid=,ppid=,command="])
        .output()
        .map_err(|error| format!("failed to list processes: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "failed to list processes: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(parse_process_snapshots(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn parse_process_snapshots(output: &str) -> Vec<ProcessSnapshot> {
    output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }

            let mut parts = trimmed.split_whitespace();
            let pid = parts.next()?.parse::<u32>().ok()?;
            let ppid = parts.next()?.parse::<u32>().ok()?;
            let command_line = parts.collect::<Vec<_>>().join(" ");
            if command_line.is_empty() {
                return None;
            }

            Some(ProcessSnapshot {
                pid,
                ppid,
                command_line,
            })
        })
        .collect()
}

fn detect_hookless_tool_from_process_tree(
    pane_pid: u32,
    processes: &[ProcessSnapshot],
) -> Option<&'static str> {
    let parent_by_pid: HashMap<u32, u32> = processes
        .iter()
        .map(|process| (process.pid, process.ppid))
        .collect();

    for process in processes {
        let Some(tool) = ["codex"]
            .into_iter()
            .find(|tool| process_line_mentions_tool(&process.command_line, tool))
            .filter(|tool| tool_hooks::is_hookless_tool(tool))
        else {
            continue;
        };

        let mut current = Some(process.pid);
        while let Some(pid) = current {
            if pid == pane_pid {
                return Some(tool);
            }
            current = parent_by_pid
                .get(&pid)
                .copied()
                .filter(|parent| *parent > 1 && *parent != pid);
        }
    }

    None
}

fn process_line_mentions_tool(command_line: &str, tool: &str) -> bool {
    command_line.split_whitespace().any(|token| {
        let token = token.trim_matches(|ch| matches!(ch, '"' | '\'' | '`'));
        let basename = token.rsplit('/').next().unwrap_or(token);
        basename == tool
    })
}

/// `tmux list-windows -a -F '#{session_name} #{window_active} #{window_bell_flag}'`
/// collapsed to one fork. Keyed to each session's ACTIVE window to match the
/// previous per-session `display-message #{window_bell_flag}` semantics (the
/// active window's flag, not an OR across every window). tmux-not-found and
/// no-server degrade to an empty map so every tracked session reads bell=false,
/// mirroring the old per-session `tmux_session_missing` fallback; any other hard
/// failure aborts the poll exactly as the per-session read did.
fn collect_active_window_bell_flags() -> Result<HashMap<String, bool>, String> {
    let output = match tmux_output([
        "list-windows",
        "-a",
        "-F",
        "#{session_name} #{window_active} #{window_bell_flag}",
    ]) {
        Ok(output) => output,
        Err(error) if error == TMUX_NOT_FOUND_ERROR => return Ok(HashMap::new()),
        Err(error) => return Err(error),
    };
    if !output.status.success() {
        let message = tmux_output_message(&output);
        if tmux_session_missing(&message) {
            return Ok(HashMap::new());
        }
        return Err(format!("failed to poll tmux bell state: {message}"));
    }

    Ok(parse_active_window_bell_flags(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

fn parse_active_window_bell_flags(output: &str) -> HashMap<String, bool> {
    let mut flags = HashMap::new();
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let (Some(session_name), Some(window_active), Some(bell_flag)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if window_active != "1" {
            continue;
        }
        flags.insert(session_name.to_string(), bell_flag == "1");
    }
    flags
}

/// `tmux list-sessions -F '#{session_name} #{@grove_ai_status}'` collapsed to one
/// fork. The user option renders empty when unset (mapped to None), and any tmux
/// failure degrades to an empty map so every session reads None — matching the
/// old per-session `tmux_session_option(..)` where errors were swallowed to None.
fn collect_session_ai_statuses() -> HashMap<String, Option<String>> {
    let output = match tmux_output(["list-sessions", "-F", "#{session_name} #{@grove_ai_status}"]) {
        Ok(output) if output.status.success() => output,
        _ => return HashMap::new(),
    };

    parse_session_ai_statuses(&String::from_utf8_lossy(&output.stdout))
}

fn parse_session_ai_statuses(output: &str) -> HashMap<String, Option<String>> {
    let mut statuses = HashMap::new();
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let Some(session_name) = parts.next() else {
            continue;
        };
        // @grove_ai_status has no spaces; an unset option renders empty and is
        // dropped by split_whitespace, yielding None.
        let status = parts.next().map(str::to_string);
        statuses.insert(session_name.to_string(), status);
    }
    statuses
}

/// `tmux list-panes -a -F '#{session_name} #{pane_active} #{pane_pid}'` collapsed
/// to one fork. Keyed to each session's ACTIVE pane to match the previous
/// per-session `display-message #{pane_pid}`. Only consulted for sessions that
/// need live hookless-tool probing; any tmux failure degrades to an empty map
/// (no pid → no live-tool detection), mirroring `tmux_pane_pid(..).ok().flatten()`.
fn collect_active_pane_pids() -> HashMap<String, u32> {
    let output = match tmux_output([
        "list-panes",
        "-a",
        "-F",
        "#{session_name} #{pane_active} #{pane_pid}",
    ]) {
        Ok(output) if output.status.success() => output,
        _ => return HashMap::new(),
    };

    parse_active_pane_pids(&String::from_utf8_lossy(&output.stdout))
}

fn parse_active_pane_pids(output: &str) -> HashMap<String, u32> {
    let mut pids = HashMap::new();
    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let (Some(session_name), Some(pane_active), Some(pane_pid)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if pane_active != "1" {
            continue;
        }
        if let Ok(pane_pid) = pane_pid.parse::<u32>() {
            pids.insert(session_name.to_string(), pane_pid);
        }
    }
    pids
}

pub fn poll_bell_events() -> Result<Vec<PtyBellEvent>, String> {
    let tracked_sessions = {
        let reg = lock_recover(registry());
        reg.iter()
            .map(|(pty_id, instance)| {
                (
                    pty_id.clone(),
                    instance.session_name.clone(),
                    Arc::clone(&instance.tracked),
                )
            })
            .collect::<Vec<_>>()
    };

    if tracked_sessions.is_empty() {
        return Ok(Vec::new());
    }

    // Batch the per-session tmux reads into single aggregate forks per tick,
    // keyed by session_name and intersected with the tracked registry below.
    let bell_flags = collect_active_window_bell_flags()?;
    let ai_statuses = collect_session_ai_statuses();

    let mut events = Vec::new();
    let mut cached_process_snapshots: Option<Vec<ProcessSnapshot>> = None;
    let mut cached_pane_pids: Option<HashMap<String, u32>> = None;
    let mut process_snapshots_loaded = false;

    for (pty_id, session_name, tracked) in tracked_sessions {
        // Sessions absent from the aggregate (killed/missing) read as false,
        // matching the previous per-session tmux_session_missing fallback.
        let bell_flag = bell_flags.get(&session_name).copied().unwrap_or(false);

        let ai_status = ai_statuses.get(&session_name).cloned().flatten();
        let current_tool = ai_status
            .as_deref()
            .and_then(|status| status.split(':').next());
        let should_probe_live_hookless_tool = ai_status.is_none()
            || current_tool.is_some_and(|tool| !tool_hooks::is_hookless_tool(tool));

        let ai_status = if should_probe_live_hookless_tool {
            if !process_snapshots_loaded {
                cached_process_snapshots = list_process_snapshots().ok();
                cached_pane_pids = Some(collect_active_pane_pids());
                process_snapshots_loaded = true;
            }

            let pane_pid = cached_pane_pids
                .as_ref()
                .and_then(|pids| pids.get(&session_name).copied());
            let live_tool = cached_process_snapshots.as_deref().and_then(|processes| {
                detect_live_hookless_tool_in_session_from_processes(pane_pid, processes)
            });
            let (last_ai_status, last_output_at) = {
                let state = lock_recover(&tracked);
                (state.last_ai_status.clone(), state.last_output_at)
            };

            let reconciled = reconcile_hookless_ai_status(
                ai_status.as_deref(),
                live_tool,
                last_ai_status.as_deref(),
                last_output_at,
            );

            if reconciled.as_deref() != ai_status.as_deref() {
                if let Some(status) = reconciled.as_deref() {
                    let _ = tmux_set_option(&session_name, TMUX_GROVE_AI_STATUS_OPTION, status);
                }
            }

            reconciled
        } else {
            ai_status
        };

        // Hookless tool idle/attention state machine:
        // running → [output idle > 3s] → idle → [30s elapsed] → attention
        // TUI apps produce periodic screen refreshes so we don't revalidate
        // after transitions — the next Enter re-asserts running.
        let ai_ref = ai_status.as_deref();
        let is_hookless = tool_hooks::needs_idle_detection(ai_ref);

        let ai_status = if is_hookless && tool_hooks::is_running(ai_ref) {
            let should_idle = match lock_recover(&tracked).last_output_at {
                Some(t) => t.elapsed() >= CODEX_OUTPUT_IDLE_TIMEOUT,
                None => true, // no output tracked (e.g. after app restart)
            };
            if should_idle {
                let idle_status = tool_hooks::to_idle(ai_ref.unwrap());
                let _ = tmux_set_option(&session_name, TMUX_GROVE_AI_STATUS_OPTION, &idle_status);
                Some(idle_status)
            } else {
                ai_status
            }
        } else if is_hookless && tool_hooks::is_idle(ai_ref) {
            let should_attention = lock_recover(&tracked)
                .idle_since
                .is_some_and(|t| t.elapsed() >= HOOKLESS_ATTENTION_TIMEOUT);
            if should_attention {
                let attn_status =
                    format!("{}:attention", ai_ref.unwrap().split(':').next().unwrap());
                let _ = tmux_set_option(&session_name, TMUX_GROVE_AI_STATUS_OPTION, &attn_status);
                Some(attn_status)
            } else {
                ai_status
            }
        } else {
            ai_status
        };

        let mut state = lock_recover(&tracked);
        let bell = consume_bell_edge(&mut state.last_bell_flag, bell_flag);
        let ai_changed = ai_status != state.last_ai_status;
        if ai_changed {
            // Track running→idle transition for attention timeout.
            let prev = state.last_ai_status.as_deref();
            let next = ai_status.as_deref();
            if tool_hooks::needs_idle_detection(next)
                && tool_hooks::is_idle(next)
                && tool_hooks::is_running(prev)
            {
                state.idle_since = Some(Instant::now());
            } else {
                state.idle_since = None;
            }
            state.last_ai_status = ai_status.clone();
        }
        if bell || ai_changed {
            events.push(PtyBellEvent {
                pty_id,
                bell,
                ai_status,
            });
        }
    }

    Ok(events)
}

pub struct PtySessionResource;

impl WorktreeResource for PtySessionResource {
    fn name(&self) -> &str {
        "PTY sessions"
    }

    fn on_remove(&self, worktree_path: &str) -> Result<(), String> {
        close_ptys_for_worktree(worktree_path)
    }
}

pub fn save_terminal_session_snapshot(
    request: SaveTerminalSessionSnapshotRequest,
) -> Result<TerminalSessionSnapshot, String> {
    let worktree_path = request.worktree_path.trim();
    if worktree_path.is_empty() {
        return Err("worktreePath is required".to_string());
    }

    if request.panes.is_empty() {
        config::remove_terminal_session_snapshot_for_worktree(worktree_path)?;
        return Ok(TerminalSessionSnapshot {
            worktree_path: worktree_path.to_string(),
            panes: Vec::new(),
        });
    }

    let mut seen_pane_ids = HashSet::new();
    let mut panes = Vec::with_capacity(request.panes.len());
    for pane in &request.panes {
        let pane_id = pane.pane_id.trim();
        if pane_id.is_empty() {
            return Err("paneId is required for every terminal snapshot pane".to_string());
        }
        if !seen_pane_ids.insert(pane_id.to_string()) {
            return Err(format!(
                "Duplicate paneId in terminal snapshot request: {pane_id}"
            ));
        }
        panes.push(build_pane_snapshot(pane)?);
    }

    let snapshot = TerminalSessionSnapshot {
        worktree_path: worktree_path.to_string(),
        panes,
    };

    config::update_terminal_session_snapshot_store(|store| {
        store
            .worktrees
            .insert(worktree_path.to_string(), snapshot.clone());
        Ok(())
    })?;

    Ok(snapshot)
}

pub fn load_terminal_session_snapshot(
    worktree_path: &str,
) -> Result<Option<TerminalSessionSnapshot>, String> {
    let store = config::load_terminal_session_snapshot_store()?;
    Ok(store.worktrees.get(worktree_path).cloned())
}

fn build_pane_snapshot(input: &TerminalPaneSnapshotInput) -> Result<TerminalPaneSnapshot, String> {
    let runtime_state = input
        .pty_id
        .as_deref()
        .filter(|pty_id| !pty_id.trim().is_empty())
        .map(runtime_snapshot_for_pty)
        .transpose()?
        .flatten();

    let launch_cwd = match runtime_state.as_ref() {
        Some(runtime_state) => runtime_state.launch_cwd.clone(),
        None => input
            .launch_cwd
            .as_deref()
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                format!(
                    "launchCwd is required when pane {} has no live ptyId",
                    input.pane_id
                )
            })?,
    };

    let last_known_cwd = runtime_state
        .as_ref()
        .and_then(resolve_live_cwd)
        .or_else(|| {
            runtime_state
                .as_ref()
                .and_then(|state| state.last_known_cwd.clone())
        });

    if let (Some(pty_id), Some(cwd)) = (input.pty_id.as_deref(), last_known_cwd.as_deref()) {
        cache_last_known_cwd(pty_id, cwd)?;
    }

    let scrollback = runtime_state
        .as_ref()
        .map(|state| String::from_utf8_lossy(&state.scrollback).into_owned())
        .unwrap_or_default();
    let scrollback_truncated = runtime_state
        .as_ref()
        .map(|state| state.scrollback_truncated)
        .unwrap_or(false);

    let (restore_cwd, restore_cwd_source) = match last_known_cwd.clone() {
        Some(cwd) => (cwd, TerminalRestoreCwdSource::LastKnownCwd),
        None => (launch_cwd.clone(), TerminalRestoreCwdSource::LaunchCwd),
    };

    Ok(TerminalPaneSnapshot {
        pane_id: input.pane_id.trim().to_string(),
        scrollback,
        scrollback_truncated,
        launch_cwd,
        last_known_cwd,
        restore_cwd,
        restore_cwd_source,
    })
}

fn runtime_snapshot_for_pty(pty_id: &str) -> Result<Option<PtyRuntimeSnapshot>, String> {
    let tracked = {
        let reg = lock_recover(registry());
        reg.get(pty_id)
            .map(|instance| Arc::clone(&instance.tracked))
    };

    let Some(tracked) = tracked else {
        return Ok(None);
    };

    let state = lock_recover(&tracked);
    Ok(Some(PtyRuntimeSnapshot {
        launch_cwd: state.launch_cwd.clone(),
        process_id: state.process_id,
        session_name: state.session_name.clone(),
        last_known_cwd: state.last_known_cwd.clone(),
        scrollback: Vec::from(state.scrollback.clone()),
        scrollback_truncated: state.scrollback_truncated,
    }))
}

fn cache_last_known_cwd(pty_id: &str, cwd: &str) -> Result<(), String> {
    let tracked = {
        let reg = lock_recover(registry());
        reg.get(pty_id)
            .map(|instance| Arc::clone(&instance.tracked))
    };

    let Some(tracked) = tracked else {
        return Ok(());
    };

    let mut state = lock_recover(&tracked);
    state.last_known_cwd = Some(cwd.to_string());
    Ok(())
}

fn append_scrollback_capped(
    scrollback: &mut VecDeque<u8>,
    scrollback_truncated: &mut bool,
    chunk: &[u8],
    limit: usize,
) {
    if limit == 0 || chunk.is_empty() {
        return;
    }

    scrollback.extend(chunk.iter().copied());
    if scrollback.len() > limit {
        // VecDeque front-prefix drain is O(overflow), not the O(cap) memmove a
        // Vec::drain(..overflow) would pay per chunk under sustained flood.
        let overflow = scrollback.len() - limit;
        scrollback.drain(..overflow);
        *scrollback_truncated = true;
    }
}

fn runtime_restore_seed<'a>(
    session_state: CreatePtySessionState,
    restore: Option<&'a CreatePtyRestore>,
) -> Option<&'a CreatePtyRestore> {
    match session_state {
        CreatePtySessionState::Created => restore,
        CreatePtySessionState::Attached => None,
    }
}

fn create_tmux_initial_hydration(capture: &TmuxCapturedContent) -> CreatePtyInitialHydration {
    CreatePtyInitialHydration {
        text: String::from_utf8_lossy(&capture.bytes).into_owned(),
        truncated: capture.truncated,
        source: CreatePtyInitialHydrationSource::TmuxCapture,
    }
}

fn tmux_capture_scope(pane_in_mode: bool, alternate_on: bool) -> TmuxCaptureScope {
    if pane_in_mode {
        TmuxCaptureScope::ModeScreen
    } else if alternate_on {
        TmuxCaptureScope::AlternateScreen
    } else {
        TmuxCaptureScope::History
    }
}

fn capture_tmux_content_with_fallback(
    session_name: &str,
    preferred_scope: TmuxCaptureScope,
) -> Result<TmuxCapturedContent, String> {
    match preferred_scope {
        TmuxCaptureScope::History => capture_tmux_content(session_name, TmuxCaptureScope::History),
        TmuxCaptureScope::AlternateScreen | TmuxCaptureScope::ModeScreen => {
            capture_tmux_content(session_name, preferred_scope)
                .or_else(|_| capture_tmux_content(session_name, TmuxCaptureScope::History))
        }
    }
}

fn capture_tmux_content(
    session_name: &str,
    scope: TmuxCaptureScope,
) -> Result<TmuxCapturedContent, String> {
    let output = match scope {
        TmuxCaptureScope::History => tmux_output([
            "capture-pane",
            "-e",
            "-p",
            "-J",
            "-S",
            "-",
            "-t",
            session_name,
        ])?,
        TmuxCaptureScope::AlternateScreen => {
            tmux_output(["capture-pane", "-a", "-e", "-p", "-J", "-t", session_name])?
        }
        TmuxCaptureScope::ModeScreen => {
            tmux_output(["capture-pane", "-M", "-e", "-p", "-J", "-t", session_name])?
        }
    };
    if !output.status.success() {
        return Err(format!(
            "failed to capture tmux pane for {session_name}: {}",
            tmux_output_message(&output)
        ));
    }

    let mut bytes: VecDeque<u8> = VecDeque::new();
    let mut truncated = false;
    append_scrollback_capped(
        &mut bytes,
        &mut truncated,
        output.stdout.as_slice(),
        MAX_SCROLLBACK_BYTES,
    );

    Ok(TmuxCapturedContent {
        bytes: Vec::from(bytes),
        truncated,
    })
}

fn required_arg(name: &str, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{name} is required"));
    }

    Ok(trimmed.to_string())
}

fn apply_portable_terminal_env(cmd: &mut CommandBuilder) {
    for (key, value) in subprocess_env_pairs() {
        cmd.env(&key, &value);
    }
    cmd.env("TERM", "xterm-256color");
    let locale = preferred_utf8_locale();
    cmd.env("LC_ALL", &locale);
    cmd.env("LANG", &locale);
    cmd.env("LC_CTYPE", &locale);
}

fn apply_tmux_command_env(cmd: &mut Command) {
    for (key, value) in subprocess_env_pairs() {
        cmd.env(key, value);
    }
    let locale = preferred_utf8_locale();
    cmd.env("LC_ALL", &locale);
    cmd.env("LANG", &locale);
    cmd.env("LC_CTYPE", &locale);
}

fn grove_tmux_session_name(worktree_path: &str, pane_id: &str) -> String {
    format!(
        "grove-{}-{}",
        short_hash(worktree_path, WORKTREE_HASH_LEN),
        pane_short_id(pane_id)
    )
}

fn pane_short_id(pane_id: &str) -> String {
    let prefix: String = pane_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .take(PANE_PREFIX_LEN)
        .collect();
    let hash = short_hash(pane_id, PANE_HASH_LEN);

    if prefix.is_empty() {
        hash
    } else {
        format!("{prefix}{hash}")
    }
}

fn short_hash(input: &str, len: usize) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex.truncate(len);
    hex
}

fn ensure_grove_tmux_session(
    session_name: &str,
    worktree_path: &str,
    pane_id: &str,
    cwd: &str,
) -> Result<CreatePtySessionState, String> {
    if tmux_session_exists(session_name)? {
        verify_grove_tmux_session(session_name, worktree_path, pane_id)?;
        return Ok(CreatePtySessionState::Attached);
    }

    let created_session = create_tmux_session(session_name, cwd)?;
    if created_session {
        if let Err(error) = set_grove_tmux_metadata(session_name, worktree_path, pane_id) {
            let _ = kill_tmux_session_if_exists(session_name);
            return Err(error);
        }

        verify_grove_tmux_session(session_name, worktree_path, pane_id)?;
        return Ok(CreatePtySessionState::Created);
    }

    verify_grove_tmux_session(session_name, worktree_path, pane_id)?;
    Ok(CreatePtySessionState::Attached)
}

fn grove_tmux_environment(session_name: &str) -> Vec<(&'static str, String)> {
    let locale = preferred_utf8_locale();
    let mut vars = vec![
        ("GROVE_TMUX_SESSION", session_name.to_string()),
        ("PATH", enriched_path().to_string()),
        ("LANG", locale.clone()),
        ("LC_CTYPE", locale),
    ];
    if let Some(ssh_auth_sock) = preferred_ssh_auth_sock() {
        vars.push(("SSH_AUTH_SOCK", ssh_auth_sock));
    }
    if let Some(zdotdir) = tool_hooks::grove_zdotdir() {
        vars.push(("GROVE_REAL_ZDOTDIR", grove_real_zdotdir()));
        vars.push(("ZDOTDIR", zdotdir));
    }
    vars
}

fn grove_real_zdotdir() -> String {
    let real_zdotdir = env::var("ZDOTDIR").unwrap_or_default();
    let grove_zsh = tool_hooks::grove_zdotdir();

    // If ZDOTDIR is set and it's NOT our own Grove zsh dir, honour it.
    if !real_zdotdir.is_empty() && grove_zsh.as_deref() != Some(real_zdotdir.as_str()) {
        return real_zdotdir;
    }

    dirs::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn create_tmux_session(session_name: &str, cwd: &str) -> Result<bool, String> {
    let mut command = Command::new("tmux");
    command.args(["-u", "new-session", "-d", "-s", session_name, "-c", cwd]);
    for (key, value) in grove_tmux_environment(session_name) {
        command.arg("-e").arg(format!("{key}={value}"));
    }
    apply_tmux_command_env(&mut command);
    let output = command.output().map_err(tmux_command_error)?;
    if output.status.success() {
        return Ok(true);
    }

    let message = tmux_output_message(&output);
    if message.contains("duplicate session") {
        return Ok(false);
    }

    Err(format!(
        "failed to create tmux session {session_name}: {message}"
    ))
}

fn set_grove_tmux_metadata(
    session_name: &str,
    worktree_path: &str,
    pane_id: &str,
) -> Result<(), String> {
    tmux_set_option(session_name, TMUX_GROVE_MANAGED_OPTION, "1")?;
    tmux_set_option(session_name, TMUX_GROVE_WORKTREE_OPTION, worktree_path)?;
    tmux_set_option(session_name, TMUX_GROVE_PANE_ID_OPTION, pane_id)?;
    refresh_grove_tmux_environment(session_name)?;
    enforce_grove_tmux_options(session_name)?;
    Ok(())
}

fn refresh_grove_tmux_environment(session_name: &str) -> Result<(), String> {
    for (key, value) in grove_tmux_environment(session_name) {
        tmux_set_session_environment(session_name, key, &value)?;
    }
    Ok(())
}

/// Options that must be applied on every session open — both new and existing.
/// Adding a new enforced option here guarantees it takes effect on the next
/// attach even for sessions created before the option existed.
fn enforce_grove_tmux_options(session_name: &str) -> Result<(), String> {
    tmux_set_option(session_name, TMUX_STATUS_OPTION, TMUX_STATUS_OFF_VALUE)?;
    tmux_set_option(session_name, TMUX_MOUSE_OPTION, TMUX_MOUSE_ON_VALUE)?;
    tmux_set_window_option(
        session_name,
        TMUX_MONITOR_BELL_OPTION,
        TMUX_MONITOR_BELL_ON_VALUE,
    )?;
    tmux_set_server_option(TMUX_ESCAPE_TIME_OPTION, TMUX_ESCAPE_TIME_VALUE)?;
    Ok(())
}

fn verify_grove_tmux_session(
    session_name: &str,
    worktree_path: &str,
    pane_id: &str,
) -> Result<(), String> {
    let managed = tmux_session_option(session_name, TMUX_GROVE_MANAGED_OPTION)?;
    if managed.as_deref() != Some("1") {
        return Err(format!(
            "tmux session {session_name} exists but is not a matching Grove-managed session"
        ));
    }

    let actual_worktree = tmux_session_option(session_name, TMUX_GROVE_WORKTREE_OPTION)?;
    if actual_worktree.as_deref() != Some(worktree_path) {
        return Err(format!(
            "tmux session {session_name} exists but belongs to a different worktree"
        ));
    }

    let actual_pane_id = tmux_session_option(session_name, TMUX_GROVE_PANE_ID_OPTION)?;
    if actual_pane_id.as_deref() != Some(pane_id) {
        return Err(format!(
            "tmux session {session_name} exists but belongs to a different pane"
        ));
    }

    refresh_grove_tmux_environment(session_name)?;
    enforce_grove_tmux_options(session_name)?;

    Ok(())
}

fn tmux_session_exists(session_name: &str) -> Result<bool, String> {
    let output = tmux_output(["has-session", "-t", session_name])?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(format!(
            "failed to query tmux session {session_name}: {}",
            tmux_output_message(&output)
        )),
    }
}

fn tmux_set_server_option(option: &str, value: &str) -> Result<(), String> {
    let output = tmux_output(["set-option", "-sg", option, value])?;
    if output.status.success() {
        return Ok(());
    }

    Err(format!(
        "failed to set tmux server option {option}: {}",
        tmux_output_message(&output)
    ))
}

fn clear_tmux_history(target: &str) -> Result<(), String> {
    let output = tmux_output(["clear-history", "-t", target])?;
    if output.status.success() {
        return Ok(());
    }

    Err(format!(
        "failed to clear tmux history for {target}: {}",
        tmux_output_message(&output)
    ))
}

fn tmux_set_option(session_name: &str, option: &str, value: &str) -> Result<(), String> {
    let output = tmux_output(["set-option", "-q", "-t", session_name, option, value])?;
    if output.status.success() {
        return Ok(());
    }
    let message = tmux_output_message(&output);
    if tmux_session_missing(&message) {
        return Ok(());
    }
    Err(format!(
        "failed to set tmux option {option} on {session_name}: {message}"
    ))
}

fn tmux_set_session_environment(session_name: &str, key: &str, value: &str) -> Result<(), String> {
    let output = tmux_output(["set-environment", "-t", session_name, key, value])?;
    if output.status.success() {
        return Ok(());
    }

    Err(format!(
        "failed to set tmux environment {key} on {session_name}: {}",
        tmux_output_message(&output)
    ))
}

#[cfg(test)]
fn tmux_session_environment_value(session_name: &str, key: &str) -> Result<Option<String>, String> {
    let output = tmux_output(["show-environment", "-t", session_name, key])?;
    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if let Some((_, raw)) = value.split_once('=') {
            return if raw.is_empty() {
                Ok(None)
            } else {
                Ok(Some(raw.to_string()))
            };
        }

        return if value.is_empty() {
            Ok(None)
        } else {
            Ok(Some(value))
        };
    }

    let message = tmux_output_message(&output);
    if output.status.code() == Some(1)
        && (message.contains(format!("unknown variable: {key}").as_str()) || message.is_empty())
    {
        return Ok(None);
    }

    Err(format!(
        "failed to query tmux environment {key} on {session_name}: {message}"
    ))
}

fn tmux_set_window_option(session_name: &str, option: &str, value: &str) -> Result<(), String> {
    let output = tmux_output(["set-window-option", "-q", "-t", session_name, option, value])?;
    if output.status.success() {
        return Ok(());
    }

    Err(format!(
        "failed to set tmux window option {option} on {session_name}: {}",
        tmux_output_message(&output)
    ))
}

fn tmux_session_option(session_name: &str, option: &str) -> Result<Option<String>, String> {
    let output = tmux_output(["show-options", "-qv", "-t", session_name, option])?;
    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return if value.is_empty() {
            Ok(None)
        } else {
            Ok(Some(value))
        };
    }

    let message = tmux_output_message(&output);
    if output.status.code() == Some(1)
        && (message.contains("invalid option")
            || message.contains("unknown option")
            || message.contains("no option")
            || message.is_empty())
    {
        return Ok(None);
    }

    Err(format!(
        "failed to query tmux option {option} on {session_name}: {message}"
    ))
}

fn tmux_session_attached_count(session_name: &str) -> Result<u32, String> {
    let attached = tmux_display_message_value(session_name, "#{session_attached}")?
        .unwrap_or_else(|| "0".to_string());
    attached.parse::<u32>().map_err(|error| {
        format!("failed to parse attached client count for {session_name}: {attached} ({error})")
    })
}

fn kill_tmux_session_if_exists(session_name: &str) -> Result<(), String> {
    let output = tmux_output(["kill-session", "-t", session_name])?;
    if output.status.success() {
        return Ok(());
    }

    let message = tmux_output_message(&output);
    if output.status.code() == Some(1)
        && (message.contains("can't find session") || message.contains("no server running"))
    {
        return Ok(());
    }

    Err(format!(
        "failed to kill tmux session {session_name}: {message}"
    ))
}

fn close_orphaned_tmux_sessions_for_worktree(worktree_path: &str) -> Result<(), String> {
    for session_name in list_grove_tmux_sessions()? {
        let managed = match tmux_session_option(&session_name, TMUX_GROVE_MANAGED_OPTION) {
            Ok(value) => value,
            Err(error) if tmux_session_missing(&error) => continue,
            Err(error) => {
                eprintln!(
                    "Warning: failed to inspect tmux session {session_name} for worktree {worktree_path}: {error}"
                );
                continue;
            }
        };
        if managed.as_deref() != Some("1") {
            continue;
        }

        let session_worktree = match tmux_session_option(&session_name, TMUX_GROVE_WORKTREE_OPTION)
        {
            Ok(value) => value,
            Err(error) if tmux_session_missing(&error) => continue,
            Err(error) => {
                eprintln!(
                    "Warning: failed to inspect tmux session {session_name} for worktree {worktree_path}: {error}"
                );
                continue;
            }
        };
        if session_worktree.as_deref() != Some(worktree_path) {
            continue;
        }

        if let Err(error) = kill_tmux_session_if_exists(&session_name) {
            eprintln!(
                "Warning: failed to close orphaned tmux session {session_name} for worktree {worktree_path}: {error}"
            );
        }
    }

    Ok(())
}

fn list_grove_tmux_sessions() -> Result<Vec<String>, String> {
    let output = match tmux_output(["list-sessions", "-F", "#{session_name}"]) {
        Ok(output) => output,
        Err(error) if error == TMUX_NOT_FOUND_ERROR => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    if !output.status.success() {
        let message = tmux_output_message(&output);
        if message.contains("no server running") {
            return Ok(Vec::new());
        }

        return Err(format!("failed to list tmux sessions: {message}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|session_name| !session_name.is_empty() && session_name.starts_with("grove-"))
        .map(str::to_string)
        .collect())
}

fn tmux_session_missing(error: &str) -> bool {
    error.contains("can't find session") || error.contains("no server running")
}

fn tmux_output<const N: usize>(args: [&str; N]) -> Result<Output, String> {
    Command::new("tmux")
        .args(args)
        .env("PATH", enriched_path())
        .output()
        .map_err(tmux_command_error)
}

fn tmux_command_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        TMUX_NOT_FOUND_ERROR.to_string()
    } else {
        format!("failed to execute tmux: {error}")
    }
}

fn tmux_output_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }

    format!("tmux exited with status {}", output.status)
}

fn tmux_pane_in_mode(session_name: &str) -> Result<bool, String> {
    Ok(tmux_display_message_value(session_name, "#{pane_in_mode}")?.as_deref() == Some("1"))
}

fn tmux_pane_alternate_on(session_name: &str) -> Result<bool, String> {
    Ok(tmux_display_message_value(session_name, "#{alternate_on}")?.as_deref() == Some("1"))
}

fn tmux_display_message_value(session_name: &str, format: &str) -> Result<Option<String>, String> {
    let output = tmux_output(["display-message", "-p", "-t", session_name, format])?;
    if !output.status.success() {
        return Err(format!(
            "failed to read tmux display message for {session_name}: {}",
            tmux_output_message(&output)
        ));
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

fn resolve_live_cwd(runtime_state: &PtyRuntimeSnapshot) -> Option<String> {
    resolve_tmux_session_cwd(&runtime_state.session_name)
        .or_else(|| resolve_process_cwd(runtime_state.process_id))
}

fn resolve_tmux_session_cwd(session_name: &str) -> Option<String> {
    tmux_display_message_value(session_name, "#{pane_current_path}")
        .ok()
        .flatten()
}

fn resolve_process_cwd(process_id: Option<u32>) -> Option<String> {
    let process_id = process_id?;

    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{process_id}/cwd"))
            .ok()
            .map(|path| path.to_string_lossy().into_owned())
    }

    #[cfg(target_os = "macos")]
    {
        let output = Command::new("lsof")
            .args(["-a", "-d", "cwd", "-Fn", "-p", &process_id.to_string()])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }

        String::from_utf8(output.stdout)
            .ok()?
            .lines()
            .find_map(|line| line.strip_prefix('n').map(str::to_string))
            .filter(|cwd| !cwd.trim().is_empty())
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        None
    }
}

fn consume_bell_edge(previous_flag: &mut bool, current_flag: bool) -> bool {
    let triggered = current_flag && !*previous_flag;
    *previous_flag = current_flag;
    triggered
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::env_lock;
    use crate::TerminalPaneSnapshotInput;
    use std::fmt;
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};
    use std::process::Output;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread::sleep;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use uuid::Uuid;

    const ZDOTDIR_CHILD_ENV: &str = "GROVE_PTY_ZDOTDIR_CHILD";

    fn unique_test_dir(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()))
    }

    fn assert_subprocess_success(output: &Output, context: &str) {
        if output.status.success() {
            return;
        }

        panic!(
            "{context} failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn shell_single_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\"'\"'"))
    }

    fn wait_for_file_contents(path: &Path) -> String {
        for _ in 0..20 {
            if let Ok(contents) = fs::read_to_string(path) {
                let trimmed = contents.trim().to_string();
                if !trimmed.is_empty() {
                    return trimmed;
                }
            }
            sleep(Duration::from_millis(100));
        }

        panic!("timed out waiting for {}", path.display());
    }

    fn wait_for_atomic(counter: &AtomicUsize, expected: usize, context: &str) {
        for _ in 0..20 {
            if counter.load(Ordering::SeqCst) == expected {
                return;
            }
            sleep(Duration::from_millis(25));
        }

        panic!(
            "timed out waiting for {context}; expected {expected}, got {}",
            counter.load(Ordering::SeqCst)
        );
    }

    struct TestHome {
        root: PathBuf,
        original_home: Option<String>,
    }

    impl TestHome {
        fn new() -> Self {
            let root = unique_test_dir("grove-pty-home");
            fs::create_dir_all(&root).unwrap();

            let original_home = std::env::var("HOME").ok();
            unsafe {
                std::env::set_var("HOME", &root);
            }

            Self {
                root,
                original_home,
            }
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            match &self.original_home {
                Some(original_home) => unsafe {
                    std::env::set_var("HOME", original_home);
                },
                None => unsafe {
                    std::env::remove_var("HOME");
                },
            }

            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn terminal_gc_plan_prunes_missing_paths_and_unattached_sessions() {
        let existing_path = unique_test_dir("grove-terminal-gc-existing");
        fs::create_dir_all(&existing_path).unwrap();

        let missing_path = unique_test_dir("grove-terminal-gc-missing");
        let existing_path_str = existing_path.to_string_lossy().into_owned();
        let missing_path_str = missing_path.to_string_lossy().into_owned();

        let plan = build_terminal_gc_plan(
            vec![existing_path_str.clone(), missing_path_str.clone()],
            &[TerminalGcSessionInfo {
                session_name: "grove-stale-session".into(),
                worktree_path: missing_path_str.clone(),
                attached: false,
                pane_pid: Some(4242),
            }],
        );

        assert_eq!(plan.stale_worktree_paths, vec![missing_path_str]);
        assert_eq!(plan.stale_session_names, vec!["grove-stale-session"]);
        assert_eq!(plan.stale_session_pane_pids, vec![4242]);
        assert!(plan.skipped_attached_worktree_paths.is_empty());

        let _ = fs::remove_dir_all(existing_path);
    }

    #[test]
    fn terminal_gc_plan_skips_missing_paths_with_attached_sessions() {
        let missing_path = unique_test_dir("grove-terminal-gc-attached");
        let missing_path_str = missing_path.to_string_lossy().into_owned();

        let plan = build_terminal_gc_plan(
            vec![missing_path_str.clone()],
            &[TerminalGcSessionInfo {
                session_name: "grove-attached-session".into(),
                worktree_path: missing_path_str.clone(),
                attached: true,
                pane_pid: Some(99),
            }],
        );

        assert!(plan.stale_worktree_paths.is_empty());
        assert!(plan.stale_session_names.is_empty());
        assert!(plan.stale_session_pane_pids.is_empty());
        assert_eq!(plan.skipped_attached_worktree_paths, vec![missing_path_str]);
    }

    #[test]
    fn terminal_gc_plan_prunes_missing_layout_paths_without_sessions() {
        let missing_path = unique_test_dir("grove-terminal-gc-layout-only");
        let missing_path_str = missing_path.to_string_lossy().into_owned();

        let plan = build_terminal_gc_plan(vec![missing_path_str.clone()], &[]);

        assert_eq!(plan.stale_worktree_paths, vec![missing_path_str]);
        assert!(plan.stale_session_names.is_empty());
        assert!(plan.stale_session_pane_pids.is_empty());
        assert!(plan.skipped_attached_worktree_paths.is_empty());
    }

    #[test]
    fn empty_snapshot_request_removes_saved_snapshot_for_worktree() {
        let _env = env_lock();
        let _home = TestHome::new();
        let worktree_path = unique_test_dir("grove-terminal-snapshot-clear");
        fs::create_dir_all(&worktree_path).unwrap();
        let worktree_path_str = worktree_path.to_string_lossy().into_owned();

        save_terminal_session_snapshot(SaveTerminalSessionSnapshotRequest {
            worktree_path: worktree_path_str.clone(),
            panes: vec![TerminalPaneSnapshotInput {
                pane_id: "pane-1".into(),
                pty_id: None,
                launch_cwd: Some(worktree_path_str.clone()),
            }],
        })
        .unwrap();
        assert!(load_terminal_session_snapshot(&worktree_path_str)
            .unwrap()
            .is_some());

        let cleared = save_terminal_session_snapshot(SaveTerminalSessionSnapshotRequest {
            worktree_path: worktree_path_str.clone(),
            panes: Vec::new(),
        })
        .unwrap();

        assert_eq!(cleared.worktree_path, worktree_path_str);
        assert!(cleared.panes.is_empty());
        assert!(load_terminal_session_snapshot(&worktree_path_str)
            .unwrap()
            .is_none());

        let _ = fs::remove_dir_all(worktree_path);
    }

    struct TmuxSessionGuard {
        session_name: String,
    }

    impl TmuxSessionGuard {
        fn new(session_name: String) -> Self {
            Self { session_name }
        }
    }

    impl Drop for TmuxSessionGuard {
        fn drop(&mut self) {
            let _ = kill_tmux_session_if_exists(&self.session_name);
        }
    }

    struct NoopSink;

    impl PtyEventSink for NoopSink {
        fn on_output(&self, _pty_id: &str, _data: &[u8]) {}
    }

    #[derive(Default)]
    struct CollectingSink {
        calls: Mutex<Vec<Vec<u8>>>,
    }

    impl PtyEventSink for CollectingSink {
        fn on_output(&self, _pty_id: &str, data: &[u8]) {
            self.calls.lock().unwrap().push(data.to_vec());
        }
    }

    /// Read implementation that yields a fixed script of chunks then EOF.
    struct ScriptedReader {
        chunks: Vec<Vec<u8>>,
        idx: usize,
    }

    impl io::Read for ScriptedReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.idx >= self.chunks.len() {
                return Ok(0);
            }
            let chunk = &self.chunks[self.idx];
            self.idx += 1;
            let n = chunk.len().min(buf.len());
            buf[..n].copy_from_slice(&chunk[..n]);
            Ok(n)
        }
    }

    /// Write implementation whose `write` blocks until a gate is released,
    /// used to simulate a stalled `write_all` (tmux input buffer full).
    struct BlockingWriter {
        gate: Arc<(Mutex<bool>, Condvar)>,
    }

    impl Write for BlockingWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let (lock, cvar) = &*self.gate;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = cvar.wait(released).unwrap();
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn new_mock_master() -> Box<dyn MasterPty + Send> {
        native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap()
            .master
    }

    #[test]
    fn coalesces_burst_within_window_into_single_output() {
        let sink = Arc::new(CollectingSink::default());
        let coalescer =
            OutputCoalescer::new(Arc::clone(&sink) as Arc<dyn PtyEventSink>, "pty-burst".into());

        // Several sub-threshold reads back-to-back, well within the 8ms window.
        coalescer.push(b"aa");
        coalescer.push(b"bb");
        coalescer.push(b"cc");

        // Wait past the flush interval for the single coalesced emit.
        sleep(Duration::from_millis(40));

        let calls = sink.calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "burst should coalesce into one on_output");
        assert_eq!(calls[0], b"aabbcc");
    }

    #[test]
    fn flushes_small_tail_within_window_and_on_eof() {
        let sink = Arc::new(CollectingSink::default());
        let coalescer =
            OutputCoalescer::new(Arc::clone(&sink) as Arc<dyn PtyEventSink>, "pty-eof".into());
        let tracked = Arc::new(Mutex::new(PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            None,
            None,
        )));
        let reader = Box::new(ScriptedReader {
            chunks: vec![b"tail".to_vec()],
            idx: 0,
        });

        // Drives push then EOF → close(); the flusher emits the pending tail.
        read_pty_output(reader, coalescer, Arc::clone(&tracked));

        // Give the flusher thread a moment to emit the final tail.
        sleep(Duration::from_millis(20));

        let calls = sink.calls.lock().unwrap();
        assert_eq!(calls.concat(), b"tail");
        // Raw-path bookkeeping stayed per-read despite coalescing.
        let state = tracked.lock().unwrap();
        assert_eq!(Vec::from(state.scrollback.clone()), b"tail");
        assert!(state.last_output_at.is_some());
    }

    #[test]
    fn write_to_one_pty_does_not_block_writes_to_another() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let blocking = Box::new(BlockingWriter {
            gate: Arc::clone(&gate),
        });
        let a = register_mock_pty_with_writer(
            MockChild {
                mode: MockChildMode::Running,
                state: Arc::new(MockChildState::default()),
            },
            format!("grove-test-write-a-{}", Uuid::new_v4().simple()),
            blocking,
            new_mock_master(),
        );
        let b = register_mock_pty_with_writer(
            MockChild {
                mode: MockChildMode::Running,
                state: Arc::new(MockChildState::default()),
            },
            format!("grove-test-write-b-{}", Uuid::new_v4().simple()),
            Box::new(io::sink()),
            new_mock_master(),
        );

        // Stall a write to A inside write_all (holding only A's writer lock).
        let a_id = a.clone();
        let a_handle = std::thread::spawn(move || write(&a_id, b"blocked"));
        // Let A's write reach write_all and block on the gate.
        sleep(Duration::from_millis(50));

        // B's write must complete even though A is stuck: with the old code
        // (write_all under the global registry lock) B would block here.
        let (tx, rx) = std::sync::mpsc::channel();
        let b_id = b.clone();
        std::thread::spawn(move || {
            let _ = tx.send(write(&b_id, b"ok"));
        });
        let received = rx.recv_timeout(Duration::from_secs(2));
        assert!(
            received.is_ok(),
            "write to B blocked while A's write_all was stalled"
        );
        assert!(received.unwrap().is_ok());

        // Release A and clean up registry entries.
        {
            let (lock, cvar) = &*gate;
            *lock.lock().unwrap() = true;
            cvar.notify_all();
        }
        let _ = a_handle.join();
        registry().lock().unwrap().remove(&a);
        registry().lock().unwrap().remove(&b);
    }

    #[derive(Clone, Copy)]
    enum MockChildMode {
        Running,
        Exited,
    }

    #[derive(Default)]
    struct MockChildState {
        try_wait_calls: AtomicUsize,
        kill_calls: AtomicUsize,
        wait_calls: AtomicUsize,
    }

    struct MockChild {
        mode: MockChildMode,
        state: Arc<MockChildState>,
    }

    impl fmt::Debug for MockChild {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("MockChild").finish_non_exhaustive()
        }
    }

    impl portable_pty::ChildKiller for MockChild {
        fn kill(&mut self) -> io::Result<()> {
            self.state.kill_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(Self {
                mode: self.mode,
                state: Arc::clone(&self.state),
            })
        }
    }

    impl portable_pty::Child for MockChild {
        fn try_wait(&mut self) -> io::Result<Option<portable_pty::ExitStatus>> {
            self.state.try_wait_calls.fetch_add(1, Ordering::SeqCst);
            match self.mode {
                MockChildMode::Running => Ok(None),
                MockChildMode::Exited => Ok(Some(portable_pty::ExitStatus::with_exit_code(0))),
            }
        }

        fn wait(&mut self) -> io::Result<portable_pty::ExitStatus> {
            self.state.wait_calls.fetch_add(1, Ordering::SeqCst);
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            Some(42)
        }
    }

    fn register_mock_pty(child: MockChild, session_name: String) -> String {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let writer = pair.master.take_writer().unwrap();
        register_mock_pty_with_writer(child, session_name, writer, pair.master)
    }

    fn register_mock_pty_with_writer(
        child: MockChild,
        session_name: String,
        writer: Box<dyn Write + Send>,
        master: Box<dyn MasterPty + Send>,
    ) -> String {
        let pty_id = format!("pty-{}", Uuid::new_v4().simple());
        let tracked = Arc::new(Mutex::new(PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            Some(42),
            session_name.clone(),
            None,
            None,
        )));

        registry().lock().unwrap().insert(
            pty_id.clone(),
            PtyInstance {
                session_name,
                worktree_path: "/tmp/grove/worktree".into(),
                writer: Arc::new(Mutex::new(writer)),
                master,
                child: Box::new(child),
                tracked,
            },
        );

        pty_id
    }

    fn run_zdotdir_tmux_child_assertions() {
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let home = dirs::home_dir().unwrap();
        let real_zdotdir = PathBuf::from(env::var("ZDOTDIR").unwrap());
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&real_zdotdir).unwrap();

        let grove_bin = home.join(".grove").join("bin");
        fs::create_dir_all(&grove_bin).unwrap();
        tool_hooks::install_zdotdir(&home).unwrap();

        let real_bin = real_zdotdir.join("bin");
        let real_bin_str = real_bin.to_string_lossy();
        fs::write(
            real_zdotdir.join(".zshrc"),
            format!("export PATH=\"{real_bin_str}:$PATH\"\n"),
        )
        .unwrap();

        let session_name = format!("grove-test-zdotdir-{}", Uuid::new_v4().simple());
        let worktree_path = env::current_dir().unwrap();
        let worktree_path = worktree_path.to_string_lossy().into_owned();
        let pane_id = format!("pane-{}", Uuid::new_v4().simple());
        let grove_zdotdir = home.join(".grove").join("zsh");
        let grove_zdotdir_str = grove_zdotdir.to_string_lossy().into_owned();
        let real_zdotdir_str = real_zdotdir.to_string_lossy().into_owned();

        let _session_guard = TmuxSessionGuard::new(session_name.clone());

        let first =
            ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &worktree_path)
                .unwrap();
        assert_eq!(first, CreatePtySessionState::Created);
        assert_eq!(
            tmux_session_environment_value(&session_name, "ZDOTDIR")
                .unwrap()
                .as_deref(),
            Some(grove_zdotdir_str.as_str())
        );
        assert_eq!(
            tmux_session_environment_value(&session_name, "GROVE_REAL_ZDOTDIR")
                .unwrap()
                .as_deref(),
            Some(real_zdotdir_str.as_str())
        );

        tmux_set_session_environment(&session_name, "ZDOTDIR", "/tmp/stale-zdotdir").unwrap();
        tmux_set_session_environment(
            &session_name,
            "GROVE_REAL_ZDOTDIR",
            "/tmp/stale-real-zdotdir",
        )
        .unwrap();

        let second =
            ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &worktree_path)
                .unwrap();
        assert_eq!(second, CreatePtySessionState::Attached);
        assert_eq!(
            tmux_session_environment_value(&session_name, "ZDOTDIR")
                .unwrap()
                .as_deref(),
            Some(grove_zdotdir_str.as_str())
        );
        assert_eq!(
            tmux_session_environment_value(&session_name, "GROVE_REAL_ZDOTDIR")
                .unwrap()
                .as_deref(),
            Some(real_zdotdir_str.as_str())
        );

        let zsh = ["/bin/zsh", "/usr/bin/zsh"]
            .into_iter()
            .find(|path| Path::new(path).exists())
            .unwrap_or("zsh");
        if Command::new(zsh)
            .arg("-i")
            .arg("-c")
            .arg("exit")
            .output()
            .is_err()
        {
            return;
        }

        let path_output = home.join("shell-path.txt");
        let command = format!(
            "OUTPUT={}; {zsh} -i -c 'print -r -- \"$PATH\"' > \"$OUTPUT\"",
            shell_single_quote(path_output.to_string_lossy().as_ref()),
        );
        tmux_output(["send-keys", "-t", &session_name, &command, "Enter"]).unwrap();

        let actual_path = wait_for_file_contents(&path_output);
        let expected_prefix = format!("{}:{}", grove_bin.display(), real_bin.display());
        assert!(
            actual_path.starts_with(&expected_prefix),
            "expected shell PATH to start with {expected_prefix}, got {actual_path}"
        );
    }

    #[test]
    fn detects_utf8_locale_variants() {
        assert!(is_utf8_locale("ko_KR.UTF-8"));
        assert!(is_utf8_locale("en_US.UTF8"));
        assert!(!is_utf8_locale("C"));
    }

    #[test]
    fn rejects_bare_utf8_as_unusable_locale() {
        assert!(!is_usable_locale("UTF-8"));
        assert!(!is_usable_locale("UTF8"));
        assert!(!is_usable_locale("utf-8"));
        assert!(is_usable_locale("en_US.UTF-8"));
        assert!(is_usable_locale("ko_KR.UTF-8"));
        assert!(is_usable_locale("C.UTF-8"));
    }

    #[test]
    fn detect_hookless_tool_from_process_tree_matches_wrapper_descendants() {
        let processes = vec![
            ProcessSnapshot {
                pid: 100,
                ppid: 1,
                command_line: "-zsh".into(),
            },
            ProcessSnapshot {
                pid: 110,
                ppid: 100,
                command_line: "bash /Users/airenkang/.grove/bin/codex --yolo".into(),
            },
            ProcessSnapshot {
                pid: 120,
                ppid: 110,
                command_line: "node /Users/airenkang/.nvm/versions/node/v23.7.0/bin/codex --yolo"
                    .into(),
            },
            ProcessSnapshot {
                pid: 130,
                ppid: 120,
                command_line:
                    "/Users/airenkang/.nvm/.../vendor/aarch64-apple-darwin/codex/codex --yolo"
                        .into(),
            },
        ];

        assert_eq!(
            detect_hookless_tool_from_process_tree(100, &processes),
            Some("codex")
        );
    }

    #[test]
    fn recover_hookless_ai_status_uses_recent_output_when_previous_status_is_missing() {
        assert_eq!(
            recover_hookless_ai_status("codex", None, Some(Instant::now())),
            "codex:running"
        );
        assert_eq!(
            recover_hookless_ai_status("codex", None, None),
            "codex:idle"
        );
    }

    #[test]
    fn recover_hookless_ai_status_drops_stale_attention_to_idle() {
        assert_eq!(
            recover_hookless_ai_status("codex", Some("codex:attention"), None),
            "codex:idle"
        );
        assert_eq!(
            recover_hookless_ai_status("codex", Some("codex:idle"), None),
            "codex:idle"
        );
    }

    #[test]
    fn reconcile_hookless_ai_status_recovers_stale_non_hookless_provider() {
        assert_eq!(
            reconcile_hookless_ai_status(
                Some("claude:running"),
                Some("codex"),
                Some("claude:running"),
                Some(Instant::now()),
            ),
            Some("codex:running".into())
        );
    }

    #[test]
    fn reconcile_hookless_ai_status_preserves_matching_hookless_status() {
        assert_eq!(
            reconcile_hookless_ai_status(
                Some("codex:attention"),
                Some("codex"),
                Some("codex:attention"),
                None,
            ),
            Some("codex:attention".into())
        );
    }

    #[test]
    fn reconcile_hookless_ai_status_keeps_existing_status_without_live_hookless_tool() {
        assert_eq!(
            reconcile_hookless_ai_status(
                Some("claude:running"),
                None,
                Some("claude:running"),
                Some(Instant::now()),
            ),
            Some("claude:running".into())
        );
    }

    #[test]
    fn scrollback_cap_discards_oldest_bytes() {
        let mut scrollback: VecDeque<u8> = b"abc".iter().copied().collect();
        let mut truncated = false;

        append_scrollback_capped(&mut scrollback, &mut truncated, b"def", 4);

        assert_eq!(Vec::from(scrollback), b"cdef");
        assert!(truncated);
    }

    #[test]
    fn scrollback_ring_boundaries_never_panic_and_stay_capped() {
        // Property fuzz over the ring: random-sized chunks of random bytes and
        // deliberately split multibyte UTF-8 must never panic and must keep the
        // ring within `limit`. Why documented-not-fixed: the ring is a raw-byte
        // tail drained oldest-first with no boundary alignment, so truncation
        // can land mid-UTF-8/mid-escape — restore relies on from_utf8_lossy
        // downstream (roadmap: snapshot/preamble rehydrate on restore). This
        // asserts the invariants AS THEY ARE, not UTF-8 boundary preservation.
        let limit = 64usize;
        // xorshift32 for deterministic, dependency-free pseudo-random input.
        let mut rng = 0x1234_5678u32;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            rng
        };
        let multibyte = "你好🟢é".as_bytes().to_vec();
        let mut scrollback: VecDeque<u8> = VecDeque::new();
        let mut truncated = false;
        let mut total_appended: usize = 0;
        for _ in 0..5000 {
            let chunk: Vec<u8> = if next() % 3 == 0 {
                // Tail slice of a multibyte string starting at a random byte
                // offset — feeds a lone continuation byte at the chunk head.
                let cut = (next() as usize) % (multibyte.len() + 1);
                multibyte[cut..].to_vec()
            } else {
                let len = (next() as usize) % 40;
                (0..len).map(|_| (next() & 0xff) as u8).collect()
            };
            total_appended += chunk.len();
            append_scrollback_capped(&mut scrollback, &mut truncated, &chunk, limit);
            assert!(scrollback.len() <= limit, "ring exceeded cap");
            if truncated {
                // Once truncation begins the ring stays exactly full.
                assert_eq!(scrollback.len(), limit);
            }
        }
        assert_eq!(truncated, total_appended > limit);
    }

    #[test]
    fn pane_snapshot_falls_back_to_launch_cwd_without_live_pty() {
        let snapshot = build_pane_snapshot(&TerminalPaneSnapshotInput {
            pane_id: "pane-1".into(),
            pty_id: None,
            launch_cwd: Some("/tmp/grove/worktree".into()),
        })
        .unwrap();

        assert_eq!(snapshot.pane_id, "pane-1");
        assert_eq!(snapshot.launch_cwd, "/tmp/grove/worktree");
        assert_eq!(snapshot.restore_cwd, "/tmp/grove/worktree");
        assert_eq!(
            snapshot.restore_cwd_source,
            TerminalRestoreCwdSource::LaunchCwd
        );
        assert!(snapshot.last_known_cwd.is_none());
        assert!(snapshot.scrollback.is_empty());
        assert!(!snapshot.scrollback_truncated);
    }

    #[test]
    fn runtime_state_seeds_restore_scrollback_before_live_output() {
        let restore = CreatePtyRestore {
            last_known_cwd: None,
            scrollback: Some("abc".into()),
            scrollback_truncated: Some(false),
        };
        let mut state = PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            Some(&restore),
            None,
        );

        state.append_scrollback(b"def");

        assert_eq!(Vec::from(state.scrollback.clone()), b"abcdef");
        assert!(!state.scrollback_truncated);
    }

    #[test]
    fn runtime_state_preserves_restore_seed_truncation_metadata() {
        let restore = CreatePtyRestore {
            last_known_cwd: None,
            scrollback: Some("abc".into()),
            scrollback_truncated: Some(true),
        };
        let state = PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            Some(&restore),
            None,
        );

        assert_eq!(Vec::from(state.scrollback.clone()), b"abc");
        assert!(state.scrollback_truncated);
    }

    #[test]
    fn consume_bell_edge_only_triggers_on_rising_edge() {
        let mut previous = false;

        assert!(consume_bell_edge(&mut previous, true));
        assert!(!consume_bell_edge(&mut previous, true));
        assert!(!consume_bell_edge(&mut previous, false));
        assert!(consume_bell_edge(&mut previous, true));
    }

    #[test]
    fn parse_active_window_bell_flags_keeps_only_active_windows() {
        let output = "\
grove-a 1 1
grove-a 0 0
grove-b 0 1
grove-b 1 0
grove-c 1 0
";
        let flags = parse_active_window_bell_flags(output);

        // grove-a: active window has the bell set.
        assert_eq!(flags.get("grove-a"), Some(&true));
        // grove-b: the ringing window is inactive, so the active window wins (no OR).
        assert_eq!(flags.get("grove-b"), Some(&false));
        assert_eq!(flags.get("grove-c"), Some(&false));
        assert_eq!(flags.len(), 3);
    }

    #[test]
    fn parse_active_window_bell_flags_ignores_malformed_lines() {
        let output = "\n   \ngrove-a 1\ngrove-b 1 1\n";
        let flags = parse_active_window_bell_flags(output);

        assert_eq!(flags.get("grove-b"), Some(&true));
        assert_eq!(flags.len(), 1);
    }

    #[test]
    fn parse_session_ai_statuses_maps_unset_option_to_none() {
        let output = "\
grove-a codex:running
grove-b
grove-c
";
        let statuses = parse_session_ai_statuses(output);

        assert_eq!(statuses.get("grove-a"), Some(&Some("codex:running".into())));
        assert_eq!(statuses.get("grove-b"), Some(&None));
        assert_eq!(statuses.get("grove-c"), Some(&None));
        assert_eq!(statuses.len(), 3);
    }

    #[test]
    fn parse_active_pane_pids_keeps_only_active_panes() {
        let output = "\
grove-a 1 4242
grove-a 0 111
grove-b 0 222
grove-c 1 notapid
";
        let pids = parse_active_pane_pids(output);

        assert_eq!(pids.get("grove-a"), Some(&4242));
        assert_eq!(pids.get("grove-b"), None);
        assert_eq!(pids.get("grove-c"), None);
        assert_eq!(pids.len(), 1);
    }

    #[test]
    fn detect_live_hookless_tool_returns_none_without_pane_pid() {
        let processes = vec![ProcessSnapshot {
            pid: 100,
            ppid: 1,
            command_line: "codex --yolo".into(),
        }];

        assert_eq!(
            detect_live_hookless_tool_in_session_from_processes(None, &processes),
            None
        );
        assert_eq!(
            detect_live_hookless_tool_in_session_from_processes(Some(100), &processes),
            Some("codex")
        );
    }

    #[test]
    fn runtime_state_applies_cap_after_seeded_and_live_output_combine() {
        let restore = CreatePtyRestore {
            last_known_cwd: None,
            scrollback: Some(format!("0123{}", "a".repeat(MAX_SCROLLBACK_BYTES - 6))),
            scrollback_truncated: Some(false),
        };
        let mut state = PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            Some(&restore),
            None,
        );

        state.append_scrollback(b"bcde");

        let scrollback_bytes = Vec::from(state.scrollback.clone());
        let scrollback = String::from_utf8_lossy(&scrollback_bytes);
        assert_eq!(state.scrollback.len(), MAX_SCROLLBACK_BYTES);
        assert!(scrollback.starts_with("23"));
        assert!(scrollback.ends_with("bcde"));
        assert!(state.scrollback_truncated);
    }

    #[test]
    fn runtime_state_seeds_last_known_cwd_from_restore_metadata() {
        let restore = CreatePtyRestore {
            last_known_cwd: Some("/tmp/grove/restored".into()),
            scrollback: None,
            scrollback_truncated: None,
        };
        let state = PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            Some(&restore),
            None,
        );

        assert_eq!(state.last_known_cwd.as_deref(), Some("/tmp/grove/restored"));
        assert!(state.scrollback.is_empty());
        assert!(!state.scrollback_truncated);
    }

    #[test]
    fn grove_tmux_session_name_is_stable_and_namespaced() {
        let session_name = grove_tmux_session_name(
            "/tmp/grove/worktree",
            "550e8400-e29b-41d4-a716-446655440000",
        );

        assert!(session_name.starts_with("grove-"));
        assert_eq!(session_name, "grove-40c3d931f1d8-550e8400a3a9".to_string());
    }

    #[test]
    fn pane_short_id_falls_back_to_hash_when_sanitized_prefix_is_empty() {
        assert_eq!(pane_short_id("---"), short_hash("---", PANE_HASH_LEN));
    }

    #[test]
    fn runtime_restore_seed_only_applies_to_new_sessions() {
        let restore = CreatePtyRestore {
            last_known_cwd: Some("/tmp/grove/restored".into()),
            scrollback: Some("seed".into()),
            scrollback_truncated: Some(true),
        };

        assert!(runtime_restore_seed(CreatePtySessionState::Attached, Some(&restore)).is_none());
        assert_eq!(
            runtime_restore_seed(CreatePtySessionState::Created, Some(&restore))
                .and_then(|seed| seed.scrollback.as_deref()),
            Some("seed")
        );
    }

    #[test]
    fn runtime_state_seeds_attached_scrollback_from_initial_hydration() {
        let capture = TmuxCapturedContent {
            bytes: b"live tmux buffer".to_vec(),
            truncated: true,
        };

        let state = PtyRuntimeState::new(
            "/tmp/grove".into(),
            Some(123),
            "grove-session".into(),
            None,
            Some(&capture),
        );

        assert_eq!(Vec::from(state.scrollback.clone()), b"live tmux buffer");
        assert!(state.scrollback_truncated);
    }

    #[test]
    fn tmux_capture_scope_prefers_mode_then_alternate_then_history() {
        assert_eq!(tmux_capture_scope(true, true), TmuxCaptureScope::ModeScreen);
        assert_eq!(
            tmux_capture_scope(false, true),
            TmuxCaptureScope::AlternateScreen
        );
        assert_eq!(tmux_capture_scope(false, false), TmuxCaptureScope::History);
    }

    #[test]
    fn create_tmux_initial_hydration_returns_live_tmux_content() {
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let session_name = format!("grove-test-hydration-{nonce}");
        let worktree_path = env::current_dir().unwrap();
        let worktree_path = worktree_path.to_string_lossy().into_owned();
        let pane_id = format!("pane-{nonce}");
        let marker = format!("hydrate-{nonce}");

        let _ = kill_tmux_session_if_exists(&session_name);
        ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &worktree_path).unwrap();

        sleep(Duration::from_millis(150));
        tmux_output([
            "send-keys",
            "-t",
            &session_name,
            &format!("printf '{marker}\\n'"),
            "Enter",
        ])
        .unwrap();
        sleep(Duration::from_millis(150));

        let hydration = create_tmux_initial_hydration(
            &capture_tmux_content_with_fallback(&session_name, TmuxCaptureScope::History).unwrap(),
        );
        assert_eq!(
            hydration.source,
            CreatePtyInitialHydrationSource::TmuxCapture
        );
        assert!(!hydration.truncated);
        assert!(hydration.text.contains(&marker));

        kill_tmux_session_if_exists(&session_name).unwrap();
    }

    #[test]
    fn ensure_grove_tmux_session_reports_created_then_attached_and_forces_status_off() {
        if env::var_os(ZDOTDIR_CHILD_ENV).is_some() {
            run_zdotdir_tmux_child_assertions();
            return;
        }

        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let session_name = format!("grove-test-{nonce}");
        let worktree_path = env::current_dir().unwrap();
        let worktree_path = worktree_path.to_string_lossy().into_owned();
        let pane_id = format!("pane-{nonce}");

        let _ = kill_tmux_session_if_exists(&session_name);

        let first =
            ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &worktree_path)
                .unwrap();
        assert_eq!(first, CreatePtySessionState::Created);
        assert_eq!(
            tmux_session_option(&session_name, TMUX_STATUS_OPTION)
                .unwrap()
                .as_deref(),
            Some(TMUX_STATUS_OFF_VALUE)
        );
        assert_eq!(
            tmux_session_option(&session_name, TMUX_MOUSE_OPTION)
                .unwrap()
                .as_deref(),
            Some(TMUX_MOUSE_ON_VALUE)
        );
        assert_eq!(
            tmux_session_environment_value(&session_name, "GROVE_TMUX_SESSION")
                .unwrap()
                .as_deref(),
            Some(session_name.as_str())
        );
        assert_eq!(
            tmux_session_environment_value(&session_name, "PATH")
                .unwrap()
                .as_deref(),
            Some(enriched_path())
        );

        tmux_set_option(&session_name, TMUX_STATUS_OPTION, "on").unwrap();
        tmux_set_session_environment(&session_name, "GROVE_TMUX_SESSION", "stale-session").unwrap();
        tmux_set_session_environment(&session_name, "PATH", "/tmp/stale-path").unwrap();

        let second =
            ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &worktree_path)
                .unwrap();
        assert_eq!(second, CreatePtySessionState::Attached);
        assert_eq!(
            tmux_session_option(&session_name, TMUX_STATUS_OPTION)
                .unwrap()
                .as_deref(),
            Some(TMUX_STATUS_OFF_VALUE)
        );
        assert_eq!(
            tmux_session_option(&session_name, TMUX_MOUSE_OPTION)
                .unwrap()
                .as_deref(),
            Some(TMUX_MOUSE_ON_VALUE)
        );
        assert_eq!(
            tmux_session_environment_value(&session_name, "GROVE_TMUX_SESSION")
                .unwrap()
                .as_deref(),
            Some(session_name.as_str())
        );
        assert_eq!(
            tmux_session_environment_value(&session_name, "PATH")
                .unwrap()
                .as_deref(),
            Some(enriched_path())
        );

        kill_tmux_session_if_exists(&session_name).unwrap();

        let child_root = unique_test_dir("grove-pty-zdotdir");
        let child_home = child_root.join("home");
        let child_real_zdotdir = child_root.join("real-zdotdir");
        fs::create_dir_all(&child_home).unwrap();
        fs::create_dir_all(&child_real_zdotdir).unwrap();

        let output = Command::new(env::current_exe().unwrap())
            .arg("--exact")
            .arg("pty::tests::ensure_grove_tmux_session_reports_created_then_attached_and_forces_status_off")
            .arg("--nocapture")
            .env(ZDOTDIR_CHILD_ENV, "1")
            .env("HOME", &child_home)
            .env("ZDOTDIR", &child_real_zdotdir)
            .output()
            .unwrap();

        let _ = fs::remove_dir_all(&child_root);
        assert_subprocess_success(&output, "zdotdir tmux assertions");
    }

    #[test]
    fn ensure_grove_tmux_session_propagates_current_ssh_auth_sock() {
        let _lock = env_lock();
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let original = env::var_os("SSH_AUTH_SOCK");
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let session_name = format!("grove-test-ssh-auth-{nonce}");
        let worktree_path = env::current_dir().unwrap();
        let worktree_path = worktree_path.to_string_lossy().into_owned();
        let pane_id = format!("pane-{nonce}");
        let expected_sock = format!("/tmp/grove-ssh-auth-{nonce}.sock");

        unsafe {
            env::set_var("SSH_AUTH_SOCK", &expected_sock);
        }

        let _session_guard = TmuxSessionGuard::new(session_name.clone());
        let _ = kill_tmux_session_if_exists(&session_name);

        let first =
            ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &worktree_path)
                .unwrap();
        assert_eq!(first, CreatePtySessionState::Created);
        assert_eq!(
            tmux_session_environment_value(&session_name, "SSH_AUTH_SOCK")
                .unwrap()
                .as_deref(),
            Some(expected_sock.as_str())
        );

        tmux_set_session_environment(&session_name, "SSH_AUTH_SOCK", "/tmp/stale-agent.sock")
            .unwrap();

        let second =
            ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &worktree_path)
                .unwrap();
        assert_eq!(second, CreatePtySessionState::Attached);
        assert_eq!(
            tmux_session_environment_value(&session_name, "SSH_AUTH_SOCK")
                .unwrap()
                .as_deref(),
            Some(expected_sock.as_str())
        );

        match original {
            Some(value) => unsafe {
                env::set_var("SSH_AUTH_SOCK", value);
            },
            None => unsafe {
                env::remove_var("SSH_AUTH_SOCK");
            },
        }
    }

    #[test]
    fn enforce_grove_tmux_options_restores_overridden_values_on_attach() {
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let session_name = format!("grove-test-enforce-{nonce}");
        let worktree_path = env::current_dir().unwrap();
        let worktree_path = worktree_path.to_string_lossy().into_owned();
        let pane_id = format!("pane-{nonce}");

        let _ = kill_tmux_session_if_exists(&session_name);

        // Create session — enforced options are set.
        ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &worktree_path).unwrap();

        // Simulate user or external process overriding every enforced option.
        tmux_set_option(&session_name, TMUX_STATUS_OPTION, "on").unwrap();
        tmux_set_option(&session_name, TMUX_MOUSE_OPTION, "off").unwrap();

        // Re-attach — ensure all enforced options are restored.
        let state =
            ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &worktree_path)
                .unwrap();
        assert_eq!(state, CreatePtySessionState::Attached);
        assert_eq!(
            tmux_session_option(&session_name, TMUX_STATUS_OPTION)
                .unwrap()
                .as_deref(),
            Some(TMUX_STATUS_OFF_VALUE),
            "status must be restored to off on attach"
        );
        assert_eq!(
            tmux_session_option(&session_name, TMUX_MOUSE_OPTION)
                .unwrap()
                .as_deref(),
            Some(TMUX_MOUSE_ON_VALUE),
            "mouse must be restored to on on attach"
        );

        kill_tmux_session_if_exists(&session_name).unwrap();
    }

    #[test]
    fn close_ptys_for_worktree_kills_orphaned_tmux_sessions() {
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let session_name = format!("grove-test-orphan-{nonce}");
        let worktree_path = env::temp_dir().join(format!("grove-worktree-{nonce}"));
        std::fs::create_dir_all(&worktree_path).unwrap();
        let worktree_path = worktree_path.to_string_lossy().into_owned();
        let pane_id = format!("pane-{nonce}");

        let _ = kill_tmux_session_if_exists(&session_name);
        ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &worktree_path).unwrap();
        assert!(tmux_session_exists(&session_name).unwrap());

        // This reproduces the restart case: the tmux session exists, but no live PTY
        // instance was registered in memory.
        close_ptys_for_worktree(&worktree_path).unwrap();

        assert!(!tmux_session_exists(&session_name).unwrap());

        let _ = std::fs::remove_dir_all(&worktree_path);
    }

    #[test]
    fn startup_cleanup_kills_stale_grove_tmux_sessions() {
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let session_name = format!("grove-test-startup-stale-{nonce}");
        let worktree_path = env::temp_dir().join(format!("grove-worktree-startup-stale-{nonce}"));
        std::fs::create_dir_all(&worktree_path).unwrap();
        let worktree_path = worktree_path.to_string_lossy().into_owned();
        let pane_id = format!("pane-{nonce}");

        let _ = kill_tmux_session_if_exists(&session_name);
        ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &worktree_path).unwrap();
        assert!(tmux_session_exists(&session_name).unwrap());

        cleanup_stale_tmux_sessions(vec![session_name.clone()], &HashSet::new()).unwrap();

        assert!(!tmux_session_exists(&session_name).unwrap());

        let _ = std::fs::remove_dir_all(&worktree_path);
    }

    #[test]
    fn startup_cleanup_preserves_live_registered_tmux_sessions() {
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let pty_id = format!("pty-{nonce}");
        let pane_id = format!("pane-{nonce}");
        let worktree_path = env::temp_dir().join(format!("grove-worktree-startup-live-{nonce}"));
        std::fs::create_dir_all(&worktree_path).unwrap();
        let worktree_path = worktree_path.to_string_lossy().into_owned();
        let session_name = grove_tmux_session_name(&worktree_path, &pane_id);

        let _ = kill_tmux_session_if_exists(&session_name);

        create(
            CreatePtyRequest {
                pty_id: pty_id.clone(),
                pane_id: pane_id.clone(),
                worktree_path: worktree_path.clone(),
                cwd: worktree_path.clone(),
                cols: 80,
                rows: 24,
                restore: None,
            },
            Arc::new(NoopSink),
        )
        .unwrap();
        assert!(tmux_session_exists(&session_name).unwrap());

        cleanup_stale_tmux_sessions(vec![session_name.clone()], &HashSet::new()).unwrap();

        assert!(tmux_session_exists(&session_name).unwrap());

        close(&pty_id).unwrap();
        let _ = std::fs::remove_dir_all(&worktree_path);
    }

    #[test]
    fn startup_cleanup_preserves_detached_sessions_present_in_saved_layouts() {
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let worktree_path =
            env::temp_dir().join(format!("grove-worktree-startup-restorable-{nonce}"));
        std::fs::create_dir_all(&worktree_path).unwrap();
        let worktree_path = worktree_path.to_string_lossy().into_owned();
        let pane_id = format!("pane-{nonce}");
        let session_name = grove_tmux_session_name(&worktree_path, &pane_id);

        let _ = kill_tmux_session_if_exists(&session_name);
        ensure_grove_tmux_session(&session_name, &worktree_path, &pane_id, &worktree_path).unwrap();
        assert!(tmux_session_exists(&session_name).unwrap());

        let layouts = serde_json::json!({
            worktree_path.clone(): {
                "id": pane_id,
                "type": "leaf"
            }
        });
        let preserved_sessions =
            restorable_grove_tmux_sessions_from_layouts(&layouts.to_string()).unwrap();

        cleanup_stale_tmux_sessions(vec![session_name.clone()], &preserved_sessions).unwrap();

        assert!(tmux_session_exists(&session_name).unwrap());

        kill_tmux_session_if_exists(&session_name).unwrap();
        let _ = std::fs::remove_dir_all(&worktree_path);
    }

    #[test]
    fn clear_scrollback_resets_runtime_buffer() {
        let tracked = Arc::new(Mutex::new(PtyRuntimeState::new(
            "/tmp/grove/worktree".into(),
            None,
            "grove-test".into(),
            None,
            None,
        )));

        {
            let mut state = tracked.lock().unwrap();
            state.append_scrollback(b"hello");
            state.scrollback_truncated = true;
        }

        {
            let mut state = tracked.lock().unwrap();
            state.scrollback.clear();
            state.scrollback_truncated = false;
        }

        let state = tracked.lock().unwrap();
        assert!(state.scrollback.is_empty());
        assert!(!state.scrollback_truncated);
    }

    #[test]
    fn close_reaps_running_child_after_signalling_termination() {
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let state = Arc::new(MockChildState::default());
        let session_name = format!("grove-test-close-running-{}", Uuid::new_v4().simple());
        let pty_id = register_mock_pty(
            MockChild {
                mode: MockChildMode::Running,
                state: Arc::clone(&state),
            },
            session_name,
        );

        close(&pty_id).unwrap();

        wait_for_atomic(&state.wait_calls, 1, "running child wait");
        assert_eq!(state.try_wait_calls.load(Ordering::SeqCst), 1);
        assert_eq!(state.kill_calls.load(Ordering::SeqCst), 1);
        assert_eq!(state.wait_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn close_reaps_already_exited_child_without_signalling_it_again() {
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let state = Arc::new(MockChildState::default());
        let session_name = format!("grove-test-close-exited-{}", Uuid::new_v4().simple());
        let pty_id = register_mock_pty(
            MockChild {
                mode: MockChildMode::Exited,
                state: Arc::clone(&state),
            },
            session_name,
        );

        close(&pty_id).unwrap();

        wait_for_atomic(&state.try_wait_calls, 1, "exited child try_wait");
        assert_eq!(state.try_wait_calls.load(Ordering::SeqCst), 1);
        assert_eq!(state.kill_calls.load(Ordering::SeqCst), 0);
        assert_eq!(state.wait_calls.load(Ordering::SeqCst), 0);
    }

    /// Run `f` with panic output suppressed so intentional test panics don't
    /// spam stderr; restores the previous hook once `f` (and any panic it drives
    /// to completion via join/catch_unwind) has returned.
    fn with_silenced_panics<F: FnOnce()>(f: F) {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        f();
        std::panic::set_hook(previous);
    }

    fn poison_mutex<T: Send + 'static>(lock: Arc<Mutex<T>>) {
        with_silenced_panics(|| {
            let _ = std::thread::spawn(move || {
                let _guard = lock.lock().unwrap();
                panic!("intentional poison for test");
            })
            .join();
        });
    }

    #[derive(Default)]
    struct CountingLogSink {
        errors: AtomicUsize,
    }

    impl crate::logger::LogEventSink for CountingLogSink {
        fn on_log(&self, level: &str, _tag: &str, _message: &str) {
            if level == "error" {
                self.errors.fetch_add(1, Ordering::SeqCst);
            }
        }
    }

    /// Read impl that reports a byte count larger than the caller's buffer,
    /// forcing the `&buf[..n]` slice in read_pty_output to panic WHILE the
    /// tracked lock is held — the same failure vector as a panic in
    /// append_scrollback.
    struct OverReadingReader;

    impl io::Read for OverReadingReader {
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            Ok(usize::MAX)
        }
    }

    struct BlockingSink {
        entered: Arc<(Mutex<bool>, Condvar)>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    impl PtyEventSink for BlockingSink {
        fn on_output(&self, _pty_id: &str, _data: &[u8]) {
            {
                let (lock, cvar) = &*self.entered;
                *lock.lock().unwrap() = true;
                cvar.notify_all();
            }
            let (lock, cvar) = &*self.release;
            let mut released = lock.lock().unwrap();
            while !*released {
                released = cvar.wait(released).unwrap();
            }
        }
    }

    #[test]
    fn poisoned_registry_lock_recovers_for_subsequent_ops() {
        let _env = env_lock();

        // Poison the global registry: a thread panics while holding its lock.
        with_silenced_panics(|| {
            let _ = std::thread::spawn(|| {
                let _guard = registry().lock().unwrap();
                panic!("intentional poison for test");
            })
            .join();
        });

        // Sanity: the registry really is poisoned now.
        assert!(registry().lock().is_err());

        // The recovery path used by every production op still yields a guard.
        {
            let guard = lock_recover(registry());
            assert!(!guard.contains_key("definitely-missing"));
        }

        // write/close/resize acquire the registry through lock_recover, so they
        // reach their own not-found logic instead of erroring on the poison.
        let missing = format!("pty-missing-{}", Uuid::new_v4().simple());
        assert_eq!(
            write(&missing, b"x"),
            Err(format!("PTY not found: {missing}"))
        );
        assert_eq!(close(&missing), Err(format!("PTY not found: {missing}")));
        assert_eq!(
            resize(&missing, 80, 24),
            Err(format!("PTY not found: {missing}"))
        );
        assert!(poll_bell_events().is_ok());

        // Restore a clean flag so unrelated tests' .lock().unwrap() don't panic.
        registry().clear_poison();
        assert!(registry().lock().is_ok());
    }

    #[test]
    fn poisoned_instance_locks_recover_for_write_and_snapshot() {
        let id = register_mock_pty_with_writer(
            MockChild {
                mode: MockChildMode::Running,
                state: Arc::new(MockChildState::default()),
            },
            format!("grove-test-poison-inst-{}", Uuid::new_v4().simple()),
            Box::new(io::sink()),
            new_mock_master(),
        );

        let (writer, tracked) = {
            let reg = registry().lock().unwrap();
            let instance = reg.get(&id).unwrap();
            (Arc::clone(&instance.writer), Arc::clone(&instance.tracked))
        };

        poison_mutex(Arc::clone(&writer));
        poison_mutex(Arc::clone(&tracked));
        assert!(writer.lock().is_err());
        assert!(tracked.lock().is_err());

        // write() recovers the poisoned per-instance writer lock and succeeds.
        assert!(write(&id, b"hello").is_ok());

        // A tracked-reading op recovers the poisoned tracked lock too.
        assert!(runtime_snapshot_for_pty(&id).unwrap().is_some());
        {
            let _guard = lock_recover(&tracked);
        }

        registry().lock().unwrap().remove(&id);
    }

    #[test]
    fn panic_in_read_path_is_contained_and_never_reaches_sink() {
        let log = Arc::new(CountingLogSink::default());
        crate::logger::set_log_sink(log.clone() as Arc<dyn crate::logger::LogEventSink>);

        let id = register_mock_pty_with_writer(
            MockChild {
                mode: MockChildMode::Running,
                state: Arc::new(MockChildState::default()),
            },
            format!("grove-test-read-panic-{}", Uuid::new_v4().simple()),
            Box::new(io::sink()),
            new_mock_master(),
        );
        let tracked = {
            let reg = registry().lock().unwrap();
            Arc::clone(&reg.get(&id).unwrap().tracked)
        };

        let sink = Arc::new(CollectingSink::default());
        let coalescer =
            OutputCoalescer::new(Arc::clone(&sink) as Arc<dyn PtyEventSink>, id.clone());
        let before = log.errors.load(Ordering::SeqCst);

        // The reader panics inside the tracked-locked block; the loop must
        // contain it, exit cleanly, and never push the panic bytes to the sink.
        with_silenced_panics(|| {
            read_pty_output(Box::new(OverReadingReader), coalescer, Arc::clone(&tracked));
        });

        // Give the flusher a moment; it should have nothing to emit.
        sleep(Duration::from_millis(20));
        assert!(
            sink.calls.lock().unwrap().is_empty(),
            "panic bytes must never reach on_output"
        );
        assert!(
            log.errors.load(Ordering::SeqCst) > before,
            "a diagnostic must be logged for the contained panic"
        );

        // The panic poisoned tracked; the same instance's locks still recover.
        {
            let reg = registry().lock().unwrap();
            let instance = reg.get(&id).unwrap();
            let _tracked_guard = lock_recover(&instance.tracked);
            let _writer_guard = lock_recover(&instance.writer);
        }
        assert!(write(&id, b"still works").is_ok());

        registry().lock().unwrap().remove(&id);
    }

    #[test]
    fn read_loop_marks_reader_exited_on_eof() {
        let id = register_mock_pty_with_writer(
            MockChild {
                mode: MockChildMode::Running,
                state: Arc::new(MockChildState::default()),
            },
            format!("grove-test-reader-eof-{}", Uuid::new_v4().simple()),
            Box::new(io::sink()),
            new_mock_master(),
        );
        let tracked = {
            let reg = registry().lock().unwrap();
            Arc::clone(&reg.get(&id).unwrap().tracked)
        };
        let sink = Arc::new(CollectingSink::default());
        let coalescer =
            OutputCoalescer::new(Arc::clone(&sink) as Arc<dyn PtyEventSink>, id.clone());

        assert!(!tracked.lock().unwrap().reader_exited);
        read_pty_output(Box::new(io::empty()), coalescer, Arc::clone(&tracked));
        assert!(tracked.lock().unwrap().reader_exited);

        registry().lock().unwrap().remove(&id);
    }

    #[test]
    fn registry_reap_plan_partitions_missing_and_dead_reader_sessions() {
        let live: HashSet<String> = ["grove-live".to_string()].into_iter().collect();
        let snapshot = vec![
            RegistryReapEntry {
                pty_id: "a".into(),
                session_name: "grove-live".into(),
                reader_exited: false,
            },
            RegistryReapEntry {
                pty_id: "b".into(),
                session_name: "grove-live".into(),
                reader_exited: true,
            },
            RegistryReapEntry {
                pty_id: "c".into(),
                session_name: "grove-gone".into(),
                reader_exited: true,
            },
        ];

        let plan = build_registry_reap_plan(&snapshot, &live);

        let candidate_ids: Vec<&str> = plan
            .reap_candidates
            .iter()
            .map(|candidate| candidate.pty_id.as_str())
            .collect();
        assert_eq!(candidate_ids, vec!["c"]);
        assert_eq!(plan.dead_reader_pty_ids, vec!["b".to_string()]);
    }

    #[test]
    fn terminal_gc_reaps_registry_entry_for_missing_tmux_session() {
        if Command::new("tmux").arg("-V").output().is_err() {
            return;
        }

        let session_name = format!("grove-test-reap-{}", Uuid::new_v4().simple());
        let id = register_mock_pty_with_writer(
            MockChild {
                mode: MockChildMode::Running,
                state: Arc::new(MockChildState::default()),
            },
            session_name.clone(),
            Box::new(io::sink()),
            new_mock_master(),
        );

        // Why: a concurrent test process churning the shared tmux server can
        // make the has-session probe transiently error, which the reap path
        // (correctly) treats as skip. Retry a few times before judging.
        let mut reaped = Vec::new();
        for _ in 0..3 {
            reaped = reap_dead_registry_entries(&[RegistryReapCandidate {
                pty_id: id.clone(),
                session_name: session_name.clone(),
            }]);
            if !reaped.is_empty() {
                break;
            }
            sleep(Duration::from_millis(100));
        }

        assert_eq!(reaped, vec![id.clone()]);
        assert!(!registry().lock().unwrap().contains_key(&id));
    }

    #[test]
    fn coalescer_pending_cap_keeps_newest_bytes_when_sink_stalls() {
        let entered = Arc::new((Mutex::new(false), Condvar::new()));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let sink = Arc::new(BlockingSink {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
        });
        let coalescer = OutputCoalescer::new(sink as Arc<dyn PtyEventSink>, "pty-cap".into());

        // Prime the flusher so it enters (and wedges inside) on_output.
        coalescer.push(b"x");
        {
            let (lock, cvar) = &*entered;
            let mut is_entered = lock.lock().unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while !*is_entered {
                let now = Instant::now();
                assert!(now < deadline, "flusher never entered on_output");
                let (guard, _) = cvar.wait_timeout(is_entered, deadline - now).unwrap();
                is_entered = guard;
            }
        }

        // Flusher is wedged and cannot drain; push far past the cap.
        let tail = b"NEWEST-TAIL-MARKER";
        coalescer.push(&vec![b'A'; MAX_PENDING_BYTES + 4096]);
        coalescer.push(tail);

        {
            let state = lock_recover(&coalescer.shared.state);
            assert!(
                state.pending.len() <= MAX_PENDING_BYTES,
                "pending exceeded cap: {}",
                state.pending.len()
            );
            assert!(
                state.pending.ends_with(tail),
                "keep-tail must preserve the newest bytes"
            );
            assert!(
                state.truncated,
                "overflow must set the internal truncated flag"
            );
        }

        // Release the flusher so its thread can exit when the coalescer drops.
        {
            let (lock, cvar) = &*release;
            *lock.lock().unwrap() = true;
            cvar.notify_all();
        }
    }
}
