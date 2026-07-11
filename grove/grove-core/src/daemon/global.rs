//! Process-global daemon client slot (design P9 cutover seam).
//!
//! P9 installs the live [`ClientHandle`] here via [`set_global_client`] once the
//! daemon path replaces the tmux path; until then the slot is empty and
//! [`ack_cold_restore`] is a no-op. It exists ahead of the cutover so the shell
//! command + NAPI/Tauri `ack_cold_restore` wrappers have a stable grove-core entry
//! point to call before there is any client to forward to.

use std::sync::OnceLock;

use super::client::ClientHandle;

/// The one process-wide daemon client. `OnceLock` because the handle owns a
/// dedicated tokio runtime (not `Clone`) and is installed exactly once at startup.
static GLOBAL_CLIENT: OnceLock<ClientHandle> = OnceLock::new();

/// Install the process-global daemon client handle (design P9). Called once at
/// startup by the cutover; a second call is ignored — the first handle wins.
pub fn set_global_client(handle: ClientHandle) {
    let _ = GLOBAL_CLIENT.set(handle);
}

/// Acknowledge a cold restore through the global client (design P16): clears the
/// local sticky payload and tells the daemon to drop its retained one. No-ops when
/// no global client is installed yet (pre-P9), so callers wire in safely before
/// the cutover populates the slot. Best-effort — a transport error is swallowed.
pub fn ack_cold_restore(session_id: &str) {
    if let Some(handle) = GLOBAL_CLIENT.get() {
        let _ = handle.ack_cold_restore_blocking(session_id);
    }
}
