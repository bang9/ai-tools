//! Daemon-mode terminal GC partition helpers (design §9, fix #3).
//!
//! These are the DAEMON-LIVENESS partition of `run_terminal_gc`, kept as PURE
//! functions so P9 can wire them into `pty.rs::run_terminal_gc` behind the
//! `terminalBackend == Daemon` branch WITHOUT touching the tmux-liveness partition
//! (which stays byte-for-byte unchanged, design invariant #12). Nothing here does
//! IO or talks to the daemon: P9 gathers the inputs (the session liveness snapshot
//! from `listSessions`, the connected-client gauge from `getDaemonInfo`, the
//! per-session history dirs from the history root, and the referenced-worktree set
//! from the terminal layouts) and feeds them in.
//!
//! The three helpers mirror design §9:
//!  - liveness snapshot ([`known_session_ids`] / [`live_session_ids`]) — the daemon
//!    "session exists" keep set;
//!  - the connected-app gate ([`HistoryGcInput::any_app_connected`]) — the daemon
//!    replacement for orca's attached-count skip;
//!  - the history-dir prune plan ([`plan_history_gc`]) — reap an orphaned unclean
//!    dir only when its session is dead AND its worktree is gone AND it is older
//!    than the young-dir guard.

use std::collections::HashSet;
use std::time::Duration;

use super::client::SessionInfo;

/// Young-dir guard (orca `GC_MIN_AGE_MS`, ~5 min): a per-session history dir younger
/// than this is NEVER reaped, so a dir mid-first-checkpoint (created but whose
/// session has not yet registered / whose adopting app has not yet reconnected) is
/// spared a GC-vs-create TOCTOU race (design §9).
pub const GC_MIN_AGE: Duration = Duration::from_secs(5 * 60);

/// All session ids the daemon currently KNOWS (design §9a): every id a
/// `listSessions` reply carries — alive OR dead-but-unreaped. A history dir whose
/// id is in this set is never GC'd: the daemon still owns the session, and a
/// dead-but-unreaped one self-reaps its OWN dir on the reader-exit clean-close path
/// (checkpointer `close_session`), so history GC must not race it.
pub fn known_session_ids(sessions: &[SessionInfo]) -> HashSet<String> {
    sessions.iter().map(|s| s.session_id.clone()).collect()
}

/// Only the ALIVE session ids from a `listSessions` reply (design §9a). Provided
/// alongside [`known_session_ids`] for callers that specifically want liveness
/// (e.g. a "how many terminals are running" gauge); history GC keys off the KNOWN
/// set so it never races a dead session's own self-reap.
pub fn live_session_ids(sessions: &[SessionInfo]) -> HashSet<String> {
    sessions
        .iter()
        .filter(|s| s.is_alive)
        .map(|s| s.session_id.clone())
        .collect()
}

/// One candidate per-session history dir (design §9c). P9 builds these by
/// enumerating the version-namespaced history root: `session_id` is the dir name
/// percent-decoded, `age` is now − the dir's creation/mtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryDirInfo {
    pub session_id: String,
    pub age: Duration,
}

impl HistoryDirInfo {
    pub fn new(session_id: impl Into<String>, age: Duration) -> Self {
        Self {
            session_id: session_id.into(),
            age,
        }
    }
}

/// Inputs to the daemon-mode history-dir GC (design §9c). Pure — no IO.
pub struct HistoryGcInput<'a> {
    /// Candidate per-session dirs found under the history root.
    pub dirs: &'a [HistoryDirInfo],
    /// Session ids the daemon still knows (KEEP — see [`known_session_ids`]).
    pub daemon_session_ids: &'a HashSet<String>,
    /// Session ids still referenced by an EXISTING worktree layout (KEEP). A
    /// session whose referencing worktree is gone is simply ABSENT from this set,
    /// which is what makes it an orphan.
    pub referenced_session_ids: &'a HashSet<String>,
    /// Any app currently connected to the daemon socket → skip ALL reaping (design
    /// §9, the daemon replacement for orca's attached-count skip): a connected app
    /// may reattach any session, so GC stands down entirely.
    pub any_app_connected: bool,
    /// Young-dir guard (typically [`GC_MIN_AGE`]).
    pub min_age: Duration,
}

/// Plan which history dirs to reap (design §9c). Reap a dir IFF:
///  1. no app is currently connected (else skip everything), AND
///  2. its session is DEAD — the daemon no longer knows the id, AND
///  3. its referencing worktree is GONE — the id is unreferenced, AND
///  4. it is older than the young-dir guard (TOCTOU protection).
///
/// Returns the session ids whose dirs P9 should remove. Pure — no IO, no daemon
/// call; deterministic and table-testable.
pub fn plan_history_gc(input: &HistoryGcInput) -> Vec<String> {
    // Connected-app gate: a connected app may reattach any session, so GC stands
    // down entirely (design §9 attached-count skip equivalent).
    if input.any_app_connected {
        return Vec::new();
    }
    input
        .dirs
        .iter()
        .filter(|dir| {
            !input.daemon_session_ids.contains(&dir.session_id)
                && !input.referenced_session_ids.contains(&dir.session_id)
                && dir.age >= input.min_age
        })
        .map(|dir| dir.session_id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: &str, alive: bool) -> SessionInfo {
        SessionInfo {
            session_id: id.to_string(),
            is_alive: alive,
            cols: 80,
            rows: 24,
        }
    }

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn liveness_snapshots_partition_known_vs_alive() {
        let sessions = vec![info("a", true), info("b", false), info("c", true)];
        // known = every id in the reply; live = only isAlive.
        assert_eq!(known_session_ids(&sessions), set(&["a", "b", "c"]));
        assert_eq!(live_session_ids(&sessions), set(&["a", "c"]));
    }

    #[test]
    fn dead_orphaned_old_dir_is_reaped() {
        // The canonical reap case: session dead (unknown to daemon), worktree gone
        // (unreferenced), older than the young-dir guard.
        let dirs = vec![HistoryDirInfo::new("dead", Duration::from_secs(10 * 60))];
        let plan = plan_history_gc(&HistoryGcInput {
            dirs: &dirs,
            daemon_session_ids: &set(&[]),
            referenced_session_ids: &set(&[]),
            any_app_connected: false,
            min_age: GC_MIN_AGE,
        });
        assert_eq!(plan, vec!["dead".to_string()]);
    }

    #[test]
    fn young_dir_is_kept() {
        // Same orphan shape but younger than the guard → spared (TOCTOU protection).
        let dirs = vec![HistoryDirInfo::new("fresh", Duration::from_secs(30))];
        let plan = plan_history_gc(&HistoryGcInput {
            dirs: &dirs,
            daemon_session_ids: &set(&[]),
            referenced_session_ids: &set(&[]),
            any_app_connected: false,
            min_age: GC_MIN_AGE,
        });
        assert!(plan.is_empty(), "a young orphan dir must be kept");
    }

    #[test]
    fn live_session_dir_is_kept() {
        // The daemon still knows the session (alive or dead-but-unreaped) → keep.
        let dirs = vec![HistoryDirInfo::new("known", Duration::from_secs(10 * 60))];
        let plan = plan_history_gc(&HistoryGcInput {
            dirs: &dirs,
            daemon_session_ids: &set(&["known"]),
            referenced_session_ids: &set(&[]),
            any_app_connected: false,
            min_age: GC_MIN_AGE,
        });
        assert!(plan.is_empty(), "a daemon-known session's dir must be kept");
    }

    #[test]
    fn unclean_but_referenced_dir_is_kept() {
        // Session dead + old, BUT a worktree layout still references it → keep (the
        // pane may be recreated / cold-restored).
        let dirs = vec![HistoryDirInfo::new("ref", Duration::from_secs(10 * 60))];
        let plan = plan_history_gc(&HistoryGcInput {
            dirs: &dirs,
            daemon_session_ids: &set(&[]),
            referenced_session_ids: &set(&["ref"]),
            any_app_connected: false,
            min_age: GC_MIN_AGE,
        });
        assert!(plan.is_empty(), "a referenced dir must be kept even if dead+old");
    }

    #[test]
    fn any_app_connected_skips_all_reaping() {
        // Even a dead+orphaned+old dir is spared while an app is connected (it may
        // reattach) — the connected-app gate stands GC down entirely (design §9).
        let dirs = vec![
            HistoryDirInfo::new("dead1", Duration::from_secs(10 * 60)),
            HistoryDirInfo::new("dead2", Duration::from_secs(20 * 60)),
        ];
        let plan = plan_history_gc(&HistoryGcInput {
            dirs: &dirs,
            daemon_session_ids: &set(&[]),
            referenced_session_ids: &set(&[]),
            any_app_connected: true,
            min_age: GC_MIN_AGE,
        });
        assert!(plan.is_empty(), "a connected app skips ALL reaping");
    }

    #[test]
    fn mixed_batch_reaps_only_the_orphans() {
        // A realistic mix: one live, one referenced, one young orphan, two reapable.
        let dirs = vec![
            HistoryDirInfo::new("live", Duration::from_secs(10 * 60)),
            HistoryDirInfo::new("referenced", Duration::from_secs(10 * 60)),
            HistoryDirInfo::new("young-orphan", Duration::from_secs(60)),
            HistoryDirInfo::new("orphan-1", Duration::from_secs(10 * 60)),
            HistoryDirInfo::new("orphan-2", Duration::from_secs(6 * 60)),
        ];
        let mut plan = plan_history_gc(&HistoryGcInput {
            dirs: &dirs,
            daemon_session_ids: &set(&["live"]),
            referenced_session_ids: &set(&["referenced"]),
            any_app_connected: false,
            min_age: GC_MIN_AGE,
        });
        plan.sort();
        assert_eq!(plan, vec!["orphan-1".to_string(), "orphan-2".to_string()]);
    }
}
