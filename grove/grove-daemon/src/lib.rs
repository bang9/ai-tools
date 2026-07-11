//! grove-daemon — the detached PTY daemon (design P2).
//!
//! The daemon owns every session's real `portable_pty` master + child and
//! constructs the SHARED grove-core libraries (`OutputCoalescer`, `PtyWriter`,
//! `append_scrollback_capped`) daemon-side — the tmux path in grove-core is
//! never touched. It speaks the P1 wire protocol: an NDJSON control channel for
//! RPC/notify (design P4) and a binary GCKL stream channel for ordered
//! `Data`/`Exit` frames (design P13).
//!
//! This library exposes the server + session types so integration tests can run
//! a full daemon in-process against a temp socket; `main.rs` is a thin wrapper.

pub mod checkpointer;
pub mod emulator;
pub mod history;
pub mod mode_state;
pub mod server;
pub mod session;

/// Recover a poisoned lock instead of propagating the panic. Why: a panic while
/// a thread held a short daemon lock (sessions map, session master/child, ring)
/// leaves the guarded data structurally valid; bricking every future op on the
/// poison flag is strictly worse than continuing (mirrors grove-core pty.rs).
pub(crate) fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
