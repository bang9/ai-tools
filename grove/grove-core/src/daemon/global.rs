//! Process-global daemon runtime + client slot (design P9 cutover seam, item 1).
//!
//! This is the single lazily-initialized entry point the rewired `pty.rs` pub fns
//! use to reach the daemon. Two-phase, matching design item 1:
//!
//! 1. [`configure`] is called ONCE at app startup by each shell (Tauri `lib.rs` /
//!    the Electron NAPI addon) with the concrete `base_dir`, the bundled daemon
//!    binary path, and the app version. It only stores config — no IO.
//! 2. The first terminal op calls [`get_or_init_client`], which lazily runs the
//!    [`supervisor::ensure_running`] connect-or-spawn adoption gate (coalesced by a
//!    [`tokio::sync::OnceCell`]) then connects a [`ClientHandle`] and caches it. Every
//!    later caller reuses the same handle.
//!
//! If [`configure`] was never called, [`get_or_init_client`] returns a descriptive
//! error and NEVER panics, so a shell that forgets to wire startup fails loudly at
//! the first `create` instead of aborting the process.
//!
//! ## Why the client is reached async, not through the blocking bridge
//!
//! [`ClientHandle`]'s `*_blocking` wrappers deliberately REFUSE to run inside an
//! ambient tokio runtime (design R12 / `BridgeError::AmbientRuntime`). Both shells
//! reach `pty.rs` from inside `tokio::task::spawn_blocking`, where the runtime
//! context IS entered (`Handle::try_current()` is `Ok`), so the blocking wrappers
//! would refuse. The RPC-shaped pub fns are therefore `async` (design G1) and reach
//! the daemon through [`ClientHandle::client`] — the async [`DaemonClient`] methods,
//! awaited on the caller's runtime. The blocking bridge stays reserved for the
//! genuinely sync paths (e.g. [`ack_cold_restore`], called off any runtime).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tokio::sync::OnceCell;

use super::client::{ClientHandle, DaemonClientOptions};
use super::supervisor::{ensure_running, EnsureRunningConfig};

/// One-time daemon runtime configuration, supplied by the host at startup via
/// [`configure`]. `bin_source_path` is the daemon binary shipped inside the app
/// bundle (the supervisor copies + signature-verifies it before spawn, design
/// L1-sig); `GROVE_DAEMON_BIN` overrides it for dev/test.
#[derive(Debug, Clone)]
pub struct DaemonRuntimeConfig {
    pub base_dir: PathBuf,
    pub bin_source_path: PathBuf,
    pub app_version: String,
}

/// Env var overriding the bundled daemon binary path (dev/test, design item 1).
pub const DAEMON_BIN_ENV: &str = "GROVE_DAEMON_BIN";

/// Is [`DAEMON_BIN_ENV`] honored? Only in debug/test builds. In a RELEASE app the
/// daemon binary comes from the signed bundle and nowhere else: an env var that
/// redirects the detached, PTY-owning daemon to an arbitrary executable is a
/// privilege-escalation seam, and the signature gate in `supervisor::prepare_binary`
/// is only meaningful if the path it verifies cannot be swapped from the environment.
const DAEMON_BIN_ENV_ALLOWED: bool = cfg!(debug_assertions);

static CONFIG: OnceLock<DaemonRuntimeConfig> = OnceLock::new();

/// The one process-wide daemon client. Async-lazy so the first terminal op runs the
/// adoption gate + connect exactly once, coalescing concurrent first callers.
static CLIENT: OnceCell<ClientHandle> = OnceCell::const_new();

/// Store the daemon runtime config (design item 1). Called once at app startup; a
/// second call is ignored (first wins). Pure — no IO, no spawn.
pub fn configure(config: DaemonRuntimeConfig) {
    let _ = CONFIG.set(config);
}

/// Whether [`configure`] has run yet (diagnostics / startup guards).
pub fn is_configured() -> bool {
    CONFIG.get().is_some()
}

/// The configured daemon runtime dir (`~/.grove/daemon` by default), if [`configure`]
/// has run. Callers that need a daemon-owned path (e.g. the per-session AI-status file
/// `pty.rs` exports into each child) read it from here so an app that passed a custom
/// base dir stays self-consistent.
pub fn runtime_base_dir() -> Option<PathBuf> {
    CONFIG.get().map(|config| config.base_dir.clone())
}

/// Best-effort default path to the bundled daemon binary: a `grove-daemon`
/// sibling of the running host executable (the sidecar convention for both
/// shells). The `GROVE_DAEMON_BIN` override (honored in [`get_or_init_client`])
/// supersedes this for dev/test, so a not-yet-final production bundle layout only
/// matters once the daemon actually ships bundled.
pub fn default_bin_source_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("grove-daemon")))
        .unwrap_or_else(|| PathBuf::from("grove-daemon"))
}

/// One-line startup configure for the hosts (design item 1). Derives the daemon
/// runtime dir (`~/.grove/daemon`) and the bundled binary path, then stores the
/// config. `base_dir_override` lets a shell pass an explicit dir (e.g. Electron
/// forwarding `app.getPath('userData')`); `None` uses grove's fixed app-data
/// convention. Pure — no IO, no spawn (the first terminal op runs the gate).
pub fn configure_default(
    app_version: impl Into<String>,
    base_dir_override: Option<PathBuf>,
) -> Result<(), String> {
    let base_dir = match base_dir_override {
        Some(dir) => dir,
        None => crate::config::daemon_runtime_dir()?,
    };
    configure(DaemonRuntimeConfig {
        base_dir,
        bin_source_path: default_bin_source_path(),
        app_version: app_version.into(),
    });
    Ok(())
}

/// Force a final checkpoint of every live session (design L12 / P6 sleep tier),
/// awaited on the CALLER's runtime. For host suspend hooks that run ON a tokio
/// runtime (e.g. a Tauri async command). No-op — and error-swallowing — when no
/// global client is installed yet (no terminals ⇒ nothing to checkpoint).
pub async fn checkpoint_all_sessions() {
    if let Some(handle) = CLIENT.get() {
        let _ = handle.client().checkpoint_all().await;
    }
}

/// Sync variant of [`checkpoint_all_sessions`] for suspend hooks that run OFF any
/// tokio runtime (e.g. Electron's `powerMonitor 'suspend'` on the Node main
/// thread). Uses the blocking bridge — do NOT call from inside a runtime, where
/// the bridge refuses (design R12). No-op when no global client is installed.
pub fn checkpoint_all_sessions_blocking() {
    if let Some(handle) = CLIENT.get() {
        let _ = handle.checkpoint_all_blocking();
    }
}

/// Resolve the daemon binary source path: in debug/test builds the `GROVE_DAEMON_BIN`
/// override wins, else (and ALWAYS in release — see [`DAEMON_BIN_ENV_ALLOWED`]) the
/// configured bundled path. Split from the env read so it is pure-testable.
fn resolve_bin_source(
    configured: &Path,
    env_override: Option<OsString>,
    allow_override: bool,
) -> PathBuf {
    match env_override {
        Some(over) if allow_override && !over.is_empty() => PathBuf::from(over),
        _ => configured.to_path_buf(),
    }
}

/// Lazily ensure the process-global daemon client (design item 1). The first caller
/// runs [`supervisor::ensure_running`] (connect-or-spawn adoption gate) then connects
/// a [`ClientHandle`]; concurrent first callers coalesce on the [`OnceCell`] and reuse
/// the winner's handle. Returns a descriptive error (never panics) when [`configure`]
/// was not called or the daemon can't be reached.
///
/// Async because it awaits the daemon RPCs on the CALLER's runtime (see the module
/// docs on why the blocking bridge is unusable from `spawn_blocking`).
pub async fn get_or_init_client() -> Result<&'static ClientHandle, String> {
    CLIENT
        .get_or_try_init(|| async {
            let config = CONFIG.get().ok_or_else(|| {
                "grove daemon is not configured: call grove_core::daemon::configure() at app \
                 startup before creating terminals"
                    .to_string()
            })?;

            let bin_source_path = resolve_bin_source(
                &config.bin_source_path,
                std::env::var_os(DAEMON_BIN_ENV),
                DAEMON_BIN_ENV_ALLOWED,
            );

            let ensured = ensure_running(&EnsureRunningConfig {
                base_dir: config.base_dir.clone(),
                bin_source_path,
                app_version: config.app_version.clone(),
            })
            .await
            .map_err(|e| format!("failed to ensure the grove daemon is running: {e}"))?;

            let opts = DaemonClientOptions::new(ensured.socket_path, ensured.token_path);
            let handle = ClientHandle::new(opts)
                .map_err(|e| format!("failed to build the grove daemon client: {e}"))?;

            // Connect eagerly on the caller's runtime so the first terminal op fails
            // fast with a clear error instead of surfacing a lazy reconnect later.
            handle
                .client()
                .ensure_connected()
                .await
                .map_err(|e| format!("failed to connect to the grove daemon: {e}"))?;

            Ok(handle)
        })
        .await
}

/// The cached client handle if one has been initialized (never triggers init).
/// Used by the sync [`ack_cold_restore`] path, which must not await.
pub fn global_client() -> Option<&'static ClientHandle> {
    CLIENT.get()
}

/// Install a pre-built client handle directly (design P9). Retained for the
/// cutover/test seam; the first handle wins (a later [`get_or_init_client`] reuses
/// it). Best-effort — a second install is ignored.
pub fn set_global_client(handle: ClientHandle) {
    let _ = CLIENT.set(handle);
}

/// Acknowledge a cold restore through the global client (design P16): clears the
/// local sticky payload and tells the daemon to drop its retained one. No-ops when
/// no global client is installed yet, so callers wire in safely before the cutover
/// populates the slot. Best-effort — a transport error is swallowed. Sync: safe to
/// call from any thread, including off a runtime (uses the blocking bridge).
pub fn ack_cold_restore(session_id: &str) {
    if let Some(handle) = CLIENT.get() {
        let _ = handle.ack_cold_restore_blocking(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bin_source_prefers_env_override_in_debug_builds() {
        let configured = Path::new("/Applications/Grove.app/daemon/grove-daemon");
        let resolved = resolve_bin_source(
            configured,
            Some(OsString::from("/tmp/target/debug/grove-daemon")),
            true,
        );
        assert_eq!(resolved, PathBuf::from("/tmp/target/debug/grove-daemon"));
    }

    /// `GROVE_DAEMON_BIN` is a dev/test knob. A RELEASE build must ignore it: the
    /// daemon is detached, owns every PTY, and outlives the app, so an env var that
    /// redirects it to an arbitrary executable would also route around the supervisor's
    /// signature gate. The test harness keeps working because tests are debug builds.
    #[test]
    fn bin_source_ignores_env_override_in_release_builds() {
        let configured = Path::new("/Applications/Grove.app/daemon/grove-daemon");
        assert_eq!(
            resolve_bin_source(configured, Some(OsString::from("/tmp/evil-daemon")), false),
            configured.to_path_buf()
        );
        // …and the constant the production call site passes tracks the build profile.
        assert_eq!(DAEMON_BIN_ENV_ALLOWED, cfg!(debug_assertions));
    }

    #[test]
    fn bin_source_falls_back_to_configured_when_no_override() {
        let configured = Path::new("/Applications/Grove.app/daemon/grove-daemon");
        assert_eq!(
            resolve_bin_source(configured, None, true),
            configured.to_path_buf()
        );
    }

    #[test]
    fn bin_source_ignores_empty_override() {
        let configured = Path::new("/bundle/grove-daemon");
        assert_eq!(
            resolve_bin_source(configured, Some(OsString::new()), true),
            configured.to_path_buf()
        );
    }
}
