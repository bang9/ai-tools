pub mod browser_cookies;
pub mod config;
pub mod daemon;
pub mod file_browser;
pub mod git_diff;
pub mod git_project;
pub mod ide;
pub mod logger;
pub mod mission;
pub mod note;
pub mod process_env;
pub mod pty;
pub mod terminal_theme;
#[cfg(test)]
mod test_support;
pub mod tool_hooks;
pub mod url_open;
pub mod worktree_lifecycle;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

/// Compiled fallback for the user-facing app version. Why: grove-core is the crate
/// spawning PTYs, so its own package version is the sanest default to advertise as
/// TERM_PROGRAM_VERSION when no GUI host has injected the real app version yet
/// (e.g. Electron before main.ts wires set_app_version, or in unit tests).
const DEFAULT_APP_VERSION: &str = env!("CARGO_PKG_VERSION");

static APP_VERSION: OnceLock<String> = OnceLock::new();

/// Record the host application's user-facing version so spawned terminals can
/// advertise TERM_PROGRAM_VERSION. Idempotent and first-write-wins (OnceLock);
/// hosts call this once at startup, before any PTY create. Later calls are no-ops.
pub fn set_app_version(version: &str) {
    let _ = APP_VERSION.set(version.to_string());
}

/// The host-advertised app version, or the compiled fallback when no host has set
/// one. Used by the PTY env builders (TERM_PROGRAM_VERSION).
pub fn app_version() -> String {
    APP_VERSION
        .get()
        .cloned()
        .unwrap_or_else(|| DEFAULT_APP_VERSION.to_string())
}

pub use config::{
    AppConfig, GrovePreferences, IdeMenuItem, ProjectCategory, ProjectCategoryIcon,
    ProjectEnvSyncConfig, TerminalLinkOpenMode, DEFAULT_PROJECT_CATEGORY_ID,
};
pub use logger::LogEventSink;
pub use pty::PtyEventSink;
pub use terminal_theme::{DetectedThemeResult, TerminalTheme};
pub use url_open::UrlOpenSink;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub url: String,
    pub org: String,
    pub repo: String,
    pub source_path: String,
    pub worktrees: Vec<Worktree>,
    pub source_has_changes: bool,
    pub source_behind_remote: bool,
    pub base_branch: Option<String>,
    pub resolved_default_branch: String,
    pub collapsed: bool,
    pub focused: bool,
    pub category_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloningProject {
    pub id: String,
    pub url: String,
    pub org: String,
    pub repo: String,
}

pub enum StartCloneOutcome {
    Cloning(CloningProject),
    AlreadyExists(Project),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub name: String,
    pub path: String,
    pub branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack_parent_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorktreePullRequestStatus {
    Open,
    Merged,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePullRequest {
    pub url: String,
    pub status: WorktreePullRequestStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySession {
    pub id: String,
    pub worktree_path: String,
}

/// The pane size tmux has actually applied to a session's pane.
/// Why: lets the UI reconcile xterm's grid against the authoritative size the
/// shell/TUI truly sees, rather than trusting only the optimistic resize path.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppliedPtySize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PtyBellEvent {
    pub pty_id: String,
    pub bell: bool,
    /// AI tool status in "tool:status" format (e.g. "claude:running", "codex:running").
    pub ai_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPaneSnapshotInput {
    pub pane_id: String,
    #[serde(default)]
    pub pty_id: Option<String>,
    #[serde(default)]
    pub launch_cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePtyRestore {
    #[serde(default)]
    pub last_known_cwd: Option<String>,
    #[serde(default)]
    pub scrollback: Option<String>,
    #[serde(default)]
    pub scrollback_truncated: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePtyRequest {
    pub pty_id: String,
    pub pane_id: String,
    pub worktree_path: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub restore: Option<CreatePtyRestore>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CreatePtySessionState {
    Attached,
    Created,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CreatePtyInitialHydrationSource {
    TmuxCapture,
    /// A warm/cold reattach payload served by the PTY daemon (design S15/S16).
    /// The renderer replays it with the clear+reset+kitty+tail order that the
    /// tmux capture path never runs; the extra fields below are populated only
    /// for this variant.
    DaemonSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreatePtyInitialHydration {
    pub text: String,
    pub truncated: bool,
    pub source: CreatePtyInitialHydrationSource,
    // Daemon-snapshot reattach metadata (design S15). Optional + serde-default so
    // the tmux capture path and any already-persisted shape deserialize
    // unchanged; only DaemonSnapshot populates them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_cols: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_rows: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_escape_tail_ansi: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kitty_keyboard_flags: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_alternate_screen: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_cold_restore: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CreatePtyResult {
    pub session_state: CreatePtySessionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_hydration: Option<CreatePtyInitialHydration>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TerminalRestoreCwdSource {
    LaunchCwd,
    LastKnownCwd,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPaneSnapshot {
    pub pane_id: String,
    pub scrollback: String,
    pub scrollback_truncated: bool,
    pub launch_cwd: String,
    pub last_known_cwd: Option<String>,
    pub restore_cwd: String,
    pub restore_cwd_source: TerminalRestoreCwdSource,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSnapshot {
    pub worktree_path: String,
    #[serde(default)]
    pub panes: Vec<TerminalPaneSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTerminalSessionSnapshotRequest {
    pub worktree_path: String,
    #[serde(default)]
    pub panes: Vec<TerminalPaneSnapshotInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct TerminalGcReport {
    #[serde(default)]
    pub stale_worktree_paths: Vec<String>,
    #[serde(default)]
    pub stale_session_names: Vec<String>,
    #[serde(default)]
    pub pruned_worktree_paths: Vec<String>,
    #[serde(default)]
    pub killed_session_names: Vec<String>,
    #[serde(default)]
    pub skipped_attached_worktree_paths: Vec<String>,
    #[serde(default)]
    pub leftover_process_ids: Vec<u32>,
    /// Registry entries whose tmux session no longer exists (killed externally,
    /// server restart, pane exit); their fds/child handles are reaped.
    #[serde(default)]
    pub reaped_pty_ids: Vec<String>,
    /// Registry entries whose session is alive but whose reader thread has
    /// exited — detected and reported only; re-attach is a separate concern.
    #[serde(default)]
    pub dead_reader_pty_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSnapshotStore {
    #[serde(default = "default_terminal_session_snapshot_version")]
    pub version: u32,
    #[serde(default)]
    pub worktrees: HashMap<String, TerminalSessionSnapshot>,
}

fn default_terminal_session_snapshot_version() -> u32 {
    1
}

impl Default for TerminalSessionSnapshotStore {
    fn default() -> Self {
        Self {
            version: default_terminal_session_snapshot_version(),
            worktrees: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryFileEntry {
    pub path: String,
    pub name: String,
    #[serde(rename = "entryType")]
    pub entry_type: String,
    pub depth: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepDirectoryListing {
    pub entries: Vec<DirectoryFileEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileContent {
    /// "text" | "image" | "binary" | "tooLarge"
    pub kind: String,
    /// UTF-8 text for text files, base64 payload for images, empty otherwise.
    pub content: String,
    pub size: u64,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    #[serde(rename = "type")]
    pub line_type: String,
    pub content: String,
    pub old_line_number: Option<u32>,
    pub new_line_number: Option<u32>,
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub hunks: Vec<DiffHunk>,
    pub display_line_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehindInfo {
    pub behind: u32,
    pub default_branch: String,
}

#[cfg(test)]
mod create_pty_hydration_serde_tests {
    use super::*;

    // A pre-daemon (tmux) reply — no snapshot fields — must still deserialize:
    // the new fields default to None so already-in-flight/persisted shapes load.
    #[test]
    fn deserializes_old_tmux_shape_with_defaults() {
        let json = r#"{"text":"hello","truncated":false,"source":"tmuxCapture"}"#;
        let hydration: CreatePtyInitialHydration = serde_json::from_str(json).unwrap();
        assert_eq!(hydration.text, "hello");
        assert_eq!(hydration.source, CreatePtyInitialHydrationSource::TmuxCapture);
        assert_eq!(hydration.snapshot_cols, None);
        assert_eq!(hydration.snapshot_rows, None);
        assert_eq!(hydration.pending_escape_tail_ansi, None);
        assert_eq!(hydration.kitty_keyboard_flags, None);
        assert_eq!(hydration.is_alternate_screen, None);
        assert_eq!(hydration.is_cold_restore, None);
    }

    // The tmux reply must serialize byte-identically to before: every new field
    // is None and skip_serializing_if omits it, so no key is added.
    #[test]
    fn serializes_tmux_shape_without_new_keys() {
        let hydration = CreatePtyInitialHydration {
            text: "hi".into(),
            truncated: true,
            source: CreatePtyInitialHydrationSource::TmuxCapture,
            snapshot_cols: None,
            snapshot_rows: None,
            pending_escape_tail_ansi: None,
            kitty_keyboard_flags: None,
            is_alternate_screen: None,
            is_cold_restore: None,
        };
        let json = serde_json::to_string(&hydration).unwrap();
        assert_eq!(json, r#"{"text":"hi","truncated":true,"source":"tmuxCapture"}"#);
    }

    // The daemon snapshot reply round-trips with camelCase keys and the new
    // "daemonSnapshot" source discriminant.
    #[test]
    fn round_trips_daemon_snapshot_shape() {
        let json = r#"{"text":"buf","truncated":false,"source":"daemonSnapshot","snapshotCols":120,"snapshotRows":40,"pendingEscapeTailAnsi":"partial-tail","kittyKeyboardFlags":5,"isAlternateScreen":true,"isColdRestore":true}"#;
        let hydration: CreatePtyInitialHydration = serde_json::from_str(json).unwrap();
        assert_eq!(hydration.source, CreatePtyInitialHydrationSource::DaemonSnapshot);
        assert_eq!(hydration.snapshot_cols, Some(120));
        assert_eq!(hydration.snapshot_rows, Some(40));
        assert_eq!(hydration.pending_escape_tail_ansi.as_deref(), Some("partial-tail"));
        assert_eq!(hydration.kitty_keyboard_flags, Some(5));
        assert_eq!(hydration.is_alternate_screen, Some(true));
        assert_eq!(hydration.is_cold_restore, Some(true));
        let reserialized = serde_json::to_string(&hydration).unwrap();
        let reparsed: CreatePtyInitialHydration = serde_json::from_str(&reserialized).unwrap();
        assert_eq!(reparsed, hydration);
    }
}
