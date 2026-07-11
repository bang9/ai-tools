use crate::tool_hooks;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::io::Read as _;
#[cfg(unix)]
use std::os::unix::fs::FileTypeExt as _;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

fn normalize_env_value(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

#[cfg(target_os = "macos")]
fn launchctl_getenv(key: &str) -> Option<String> {
    let output = Command::new("launchctl")
        .args(["getenv", key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    normalize_env_value(Some(String::from_utf8_lossy(&output.stdout).to_string()))
}

#[cfg(not(target_os = "macos"))]
fn launchctl_getenv(_key: &str) -> Option<String> {
    None
}

fn parse_env_var_from_ps_output(output: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    output
        .split_whitespace()
        .find_map(|segment| segment.strip_prefix(&prefix).map(str::to_string))
        .and_then(|value| normalize_env_value(Some(value)))
}

fn process_parent_id(pid: u32) -> Option<u32> {
    let output = Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u32>()
        .ok()
}

fn process_env_var(pid: u32, key: &str) -> Option<String> {
    let output = Command::new("ps")
        .args(["eww", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    parse_env_var_from_ps_output(&String::from_utf8_lossy(&output.stdout), key)
}

fn ancestor_process_env_var(key: &str) -> Option<String> {
    let mut pid = std::process::id();
    for _ in 0..8 {
        let parent = process_parent_id(pid)?;
        if parent <= 1 {
            return None;
        }

        if let Some(value) = process_env_var(parent, key) {
            return Some(value);
        }

        pid = parent;
    }

    None
}

#[cfg(target_os = "macos")]
fn cached_launchctl_ssh_auth_sock() -> Option<String> {
    static SSH_AUTH_SOCK: OnceLock<Option<String>> = OnceLock::new();
    SSH_AUTH_SOCK
        .get_or_init(|| launchctl_getenv("SSH_AUTH_SOCK"))
        .clone()
}

#[cfg(not(target_os = "macos"))]
fn cached_launchctl_ssh_auth_sock() -> Option<String> {
    None
}

const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(2);
const LOGIN_SHELL_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const LOGIN_SHELL_RETRY_ATTEMPTS: usize = 4;
const LOGIN_SHELL_RETRY_DELAY: Duration = Duration::from_millis(1500);
const PATH_MARKER: &str = "__GROVE_PATH__";
const ENV_MARKER: &str = "__GROVE_ENV__";
const SHELL_ENV_KEYS: &[&str] = &[
    "PATH",
    "SSH_AUTH_SOCK",
    "GH_TOKEN_SENDBIRD",
    "GH_TOKEN_SENDBIRD_PLAYGROUND",
    "GH_TOKEN_RICH_AUTOMATION",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EnvValueSource {
    Process,
    Launchctl,
    AncestorProcess,
    InteractiveShell,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubprocessEnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathDiagnostics {
    pub process_env: Option<String>,
    pub interactive_shell_env: Option<String>,
    pub login_shell_env: Option<String>,
    pub preferred_env_source: Option<EnvValueSource>,
    pub preferred_env_value: Option<String>,
    pub merged_base_value: String,
    pub final_value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshAuthSockDiagnostics {
    pub process_env: Option<String>,
    pub launchctl_env: Option<String>,
    pub ancestor_process_env: Option<String>,
    pub interactive_shell_env: Option<String>,
    pub selected_source: Option<EnvValueSource>,
    pub selected_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEnvDiagnostics {
    pub shell: Option<String>,
    pub zdotdir: Option<String>,
    pub grove_zdotdir: Option<String>,
    pub path: PathDiagnostics,
    pub ssh_auth_sock: SshAuthSockDiagnostics,
    pub subprocess_env: Vec<SubprocessEnvVar>,
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn grove_real_zdotdir() -> String {
    let real_zdotdir = env::var("ZDOTDIR").unwrap_or_default();
    let grove_zsh = tool_hooks::grove_zdotdir();

    if !real_zdotdir.is_empty() && grove_zsh.as_deref() != Some(real_zdotdir.as_str()) {
        return real_zdotdir;
    }

    dirs::home_dir()
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn shell_command(shell: &str, interactive: bool, command: &str) -> Command {
    let mut child = Command::new(shell);
    if interactive {
        child.args(["-i", "-c", command]);
        if let Some(zdotdir) = tool_hooks::grove_zdotdir() {
            child.env("GROVE_REAL_ZDOTDIR", grove_real_zdotdir());
            child.env("ZDOTDIR", zdotdir);
        }
    } else {
        child.args(["-l", "-c", command]);
    }
    child
}

fn shell_output(command: &str, interactive: bool) -> Result<String, String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    if !is_posix_like_shell(&shell) {
        return Err(format!("Unsupported shell: {shell}"));
    }

    let mut child = shell_command(&shell, interactive, command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch shell: {e}"))?;

    let start = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|e| format!("Failed to poll shell: {e}"))?
        {
            Some(status) => {
                let output = child
                    .wait_with_output()
                    .map_err(|e| format!("Failed to read shell output: {e}"))?;
                if !status.success() {
                    return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
                }
                return Ok(String::from_utf8_lossy(&output.stdout).to_string());
            }
            None if start.elapsed() >= LOGIN_SHELL_COMMAND_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                let shell_mode = if interactive { "interactive" } else { "login" };
                return Err(format!(
                    "{shell_mode} shell command timed out after {}s",
                    LOGIN_SHELL_COMMAND_TIMEOUT.as_secs()
                ));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn shell_env_snapshot_command() -> String {
    let keys = SHELL_ENV_KEYS
        .iter()
        .map(|key| shell_quote(key))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "printf '%s\\n' {marker}; \
for key in {keys}; do \
  value=\"$(/usr/bin/printenv \"$key\" 2>/dev/null || true)\"; \
  printf '%s=%s\\n' \"$key\" \"$value\"; \
done; \
printf '%s\\n' {marker}",
        marker = shell_quote(ENV_MARKER),
    )
}

fn merge_path_candidates(primary: Option<String>, secondary: Option<String>) -> Option<String> {
    let mut merged = Vec::new();
    for candidate in [primary, secondary].into_iter().flatten() {
        for entry in candidate.split(':') {
            let trimmed = entry.trim();
            if trimmed.is_empty() || merged.iter().any(|existing| existing == trimmed) {
                continue;
            }
            merged.push(trimmed.to_string());
        }
    }

    if merged.is_empty() {
        None
    } else {
        Some(merged.join(":"))
    }
}

pub fn enriched_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| path_diagnostics(&SystemEnvSourceLookup).final_value.clone())
        .as_str()
}

#[cfg(unix)]
fn resolve_login_shell_path() -> Option<String> {
    resolve_with_retry(
        LOGIN_SHELL_RETRY_ATTEMPTS,
        LOGIN_SHELL_RETRY_DELAY,
        resolve_login_shell_path_once,
    )
}

#[cfg(unix)]
fn resolve_login_shell_path_once() -> Option<String> {
    let shell = env::var("SHELL").ok()?;
    if !is_posix_like_shell(&shell) {
        return None;
    }

    let mut child = Command::new(&shell)
        .args([
            "-l",
            "-c",
            &format!(
                "printf '\\n{m}\\n%s\\n{m}' \"$(/usr/bin/printenv PATH)\"",
                m = PATH_MARKER
            ),
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;

    let start = Instant::now();
    loop {
        match child.try_wait().ok()? {
            Some(_) => break,
            None if start.elapsed() >= LOGIN_SHELL_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }

    let mut stdout = String::new();
    child.stdout.take()?.read_to_string(&mut stdout).ok()?;
    parse_path_marker(&stdout)
}

#[cfg(not(unix))]
fn resolve_login_shell_path() -> Option<String> {
    None
}

fn resolve_with_retry<T, F>(attempts: usize, delay: Duration, mut resolver: F) -> Option<T>
where
    F: FnMut() -> Option<T>,
{
    if attempts == 0 {
        return None;
    }

    for attempt_idx in 0..attempts {
        if let Some(value) = resolver() {
            return Some(value);
        }

        if attempt_idx + 1 < attempts {
            std::thread::sleep(delay);
        }
    }

    None
}

fn is_posix_like_shell(shell: &str) -> bool {
    let basename = std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    matches!(basename, "bash" | "zsh" | "sh" | "dash" | "ksh")
}

fn parse_path_marker(output: &str) -> Option<String> {
    let start_tag = format!("{PATH_MARKER}\n");
    let end_tag = format!("\n{PATH_MARKER}");

    let start = output.find(&start_tag)? + start_tag.len();
    let end = output.rfind(&end_tag)?;
    if start >= end {
        return None;
    }

    let path = output[start..end].trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

fn parse_env_marker_output(output: &str) -> HashMap<String, String> {
    let start_tag = format!("{ENV_MARKER}\n");
    let end_tag = format!("\n{ENV_MARKER}");

    let Some(start) = output.find(&start_tag).map(|idx| idx + start_tag.len()) else {
        return HashMap::new();
    };
    let Some(end) = output.rfind(&end_tag) else {
        return HashMap::new();
    };
    if start >= end {
        return HashMap::new();
    }

    output[start..end]
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            normalize_env_value(Some(value.to_string())).map(|value| (key.to_string(), value))
        })
        .collect()
}

#[cfg(unix)]
fn resolve_interactive_shell_env_once() -> Option<HashMap<String, String>> {
    let output = shell_output(&shell_env_snapshot_command(), true).ok()?;
    Some(parse_env_marker_output(&output))
}

#[cfg(unix)]
fn interactive_shell_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        resolve_with_retry(
            LOGIN_SHELL_RETRY_ATTEMPTS,
            LOGIN_SHELL_RETRY_DELAY,
            resolve_interactive_shell_env_once,
        )
        .unwrap_or_default()
    })
}

#[cfg(not(unix))]
fn interactive_shell_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(HashMap::new)
}

trait EnvSourceLookup {
    fn process_env_var(&self, key: &str) -> Option<String>;
    fn launchctl_env_var(&self, key: &str) -> Option<String>;
    fn ancestor_process_env_var(&self, key: &str) -> Option<String>;
    fn interactive_shell_env_var(&self, key: &str) -> Option<String>;
    fn login_shell_path(&self) -> Option<String>;
    /// Standard binary directories to fold into PATH unconditionally, so tool
    /// resolution never depends on a successful shell snapshot. Returns `None`
    /// off macOS (and in hermetic tests).
    fn well_known_path_dirs(&self) -> Option<String> {
        None
    }
}

struct SystemEnvSourceLookup;

impl EnvSourceLookup for SystemEnvSourceLookup {
    fn process_env_var(&self, key: &str) -> Option<String> {
        env::var(key).ok()
    }

    fn launchctl_env_var(&self, key: &str) -> Option<String> {
        if key == "SSH_AUTH_SOCK" {
            cached_launchctl_ssh_auth_sock()
        } else {
            launchctl_getenv(key)
        }
    }

    fn ancestor_process_env_var(&self, key: &str) -> Option<String> {
        ancestor_process_env_var(key)
    }

    fn interactive_shell_env_var(&self, key: &str) -> Option<String> {
        interactive_shell_env().get(key).cloned()
    }

    fn login_shell_path(&self) -> Option<String> {
        resolve_login_shell_path()
    }

    fn well_known_path_dirs(&self) -> Option<String> {
        well_known_path_suffix()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct EnvSourceSnapshot {
    process_env: Option<String>,
    launchctl_env: Option<String>,
    ancestor_process_env: Option<String>,
    interactive_shell_env: Option<String>,
    login_shell_env: Option<String>,
    well_known_dirs: Option<String>,
}

fn collect_env_snapshot(
    lookup: &impl EnvSourceLookup,
    key: &str,
    include_launchctl: bool,
    include_ancestor: bool,
    include_interactive_shell: bool,
    include_login_shell: bool,
) -> EnvSourceSnapshot {
    EnvSourceSnapshot {
        process_env: normalize_env_value(lookup.process_env_var(key)),
        launchctl_env: include_launchctl
            .then(|| lookup.launchctl_env_var(key))
            .flatten(),
        ancestor_process_env: include_ancestor
            .then(|| lookup.ancestor_process_env_var(key))
            .flatten(),
        interactive_shell_env: include_interactive_shell
            .then(|| lookup.interactive_shell_env_var(key))
            .flatten(),
        login_shell_env: include_login_shell
            .then(|| lookup.login_shell_path())
            .flatten(),
        well_known_dirs: lookup.well_known_path_dirs(),
    }
}

fn preferred_env_var_selection(snapshot: &EnvSourceSnapshot) -> Option<(EnvValueSource, String)> {
    if let Some(value) = snapshot.process_env.clone() {
        return Some((EnvValueSource::Process, value));
    }
    snapshot
        .interactive_shell_env
        .clone()
        .map(|value| (EnvValueSource::InteractiveShell, value))
}

pub fn preferred_env_var(key: &str) -> Option<String> {
    preferred_env_var_selection(&collect_env_snapshot(
        &SystemEnvSourceLookup,
        key,
        false,
        false,
        true,
        false,
    ))
    .map(|(_, value)| value)
}

fn validated_shell_ssh_auth_sock(value: Option<String>) -> Option<String> {
    let value = normalize_env_value(value)?;
    let metadata = std::fs::metadata(&value).ok()?;
    #[cfg(unix)]
    {
        if metadata.file_type().is_socket() {
            return Some(value);
        }
    }

    #[cfg(not(unix))]
    {
        if metadata.is_file() {
            return Some(value);
        }
    }

    None
}

fn preferred_ssh_auth_sock_selection(
    snapshot: &EnvSourceSnapshot,
) -> Option<(EnvValueSource, String)> {
    if let Some(value) = snapshot.process_env.clone() {
        return Some((EnvValueSource::Process, value));
    }
    if let Some(value) = snapshot.launchctl_env.clone() {
        return Some((EnvValueSource::Launchctl, value));
    }
    if let Some(value) = validated_shell_ssh_auth_sock(snapshot.ancestor_process_env.clone()) {
        return Some((EnvValueSource::AncestorProcess, value));
    }
    validated_shell_ssh_auth_sock(snapshot.interactive_shell_env.clone())
        .map(|value| (EnvValueSource::InteractiveShell, value))
}

#[cfg(test)]
fn preferred_ssh_auth_sock_from(
    env_value: Option<String>,
    launchctl_value: Option<String>,
    ancestor_value: Option<String>,
    shell_value: Option<String>,
) -> Option<String> {
    preferred_ssh_auth_sock_selection(&EnvSourceSnapshot {
        process_env: normalize_env_value(env_value),
        launchctl_env: normalize_env_value(launchctl_value),
        ancestor_process_env: normalize_env_value(ancestor_value),
        interactive_shell_env: normalize_env_value(shell_value),
        login_shell_env: None,
        well_known_dirs: None,
    })
    .map(|(_, value)| value)
}

fn build_enriched_path(base: String) -> String {
    match dirs::home_dir().and_then(|h| h.join(".grove/bin").to_str().map(String::from)) {
        Some(grove_bin) => format!("{grove_bin}:{base}"),
        None => base,
    }
}

/// Standard binary directories that GUI launches frequently omit from PATH.
/// Folded into the merged PATH unconditionally (when present on disk) so that
/// resolving tools like tmux/claude/codex/gh never depends on a successful
/// login- or interactive-shell snapshot.
#[cfg(target_os = "macos")]
const WELL_KNOWN_BIN_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
];

#[cfg(target_os = "macos")]
fn well_known_path_suffix() -> Option<String> {
    let dirs: Vec<&str> = WELL_KNOWN_BIN_DIRS
        .iter()
        .copied()
        .filter(|dir| std::path::Path::new(dir).is_dir())
        .collect();
    (!dirs.is_empty()).then(|| dirs.join(":"))
}

/// Linux counterpart of the macOS well-known dirs. Why: a Linux GUI launch (e.g.
/// AppImage/desktop entry) inherits a minimal PATH, so fold in the standard
/// user/system bin dirs — mirroring the macOS suffix — so tmux/claude/gh resolve
/// even when every shell snapshot fails. ~/.local/bin needs home expansion, so the
/// list is built at runtime rather than a static &[&str].
#[cfg(all(unix, not(target_os = "macos")))]
fn well_known_path_suffix() -> Option<String> {
    let mut dirs: Vec<String> = vec!["/usr/local/bin".to_string()];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin").to_string_lossy().into_owned());
    }
    dirs.push("/snap/bin".to_string());

    let dirs: Vec<String> = dirs
        .into_iter()
        .filter(|dir| std::path::Path::new(dir).is_dir())
        .collect();
    (!dirs.is_empty()).then(|| dirs.join(":"))
}

#[cfg(not(unix))]
fn well_known_path_suffix() -> Option<String> {
    None
}

fn merged_path_value(snapshot: &EnvSourceSnapshot) -> Option<String> {
    let merged = merge_path_candidates(
        snapshot.process_env.clone(),
        snapshot.interactive_shell_env.clone(),
    );
    let merged = merge_path_candidates(merged, snapshot.login_shell_env.clone());
    // Appended last (lowest precedence) so a successfully resolved shell PATH
    // still wins; deduped by merge_path_candidates. Guarantees Homebrew/standard
    // dirs are present even when every shell snapshot fails.
    merge_path_candidates(merged, snapshot.well_known_dirs.clone())
}

fn path_diagnostics(lookup: &impl EnvSourceLookup) -> PathDiagnostics {
    let snapshot = collect_env_snapshot(lookup, "PATH", false, false, true, true);
    let preferred = preferred_env_var_selection(&snapshot);
    let merged_base_value =
        merged_path_value(&snapshot).unwrap_or_else(|| env::var("PATH").unwrap_or_default());
    let final_value = build_enriched_path(merged_base_value.clone());

    PathDiagnostics {
        process_env: snapshot.process_env,
        interactive_shell_env: snapshot.interactive_shell_env,
        login_shell_env: snapshot.login_shell_env,
        preferred_env_source: preferred.as_ref().map(|(source, _)| *source),
        preferred_env_value: preferred.map(|(_, value)| value),
        merged_base_value,
        final_value,
    }
}

fn ssh_auth_sock_diagnostics(lookup: &impl EnvSourceLookup) -> SshAuthSockDiagnostics {
    let snapshot = collect_env_snapshot(lookup, "SSH_AUTH_SOCK", true, true, true, false);
    let selected = preferred_ssh_auth_sock_selection(&snapshot);

    SshAuthSockDiagnostics {
        process_env: snapshot.process_env,
        launchctl_env: snapshot.launchctl_env,
        ancestor_process_env: snapshot.ancestor_process_env,
        interactive_shell_env: snapshot.interactive_shell_env,
        selected_source: selected.as_ref().map(|(source, _)| *source),
        selected_value: selected.map(|(_, value)| value),
    }
}

pub fn preferred_ssh_auth_sock() -> Option<String> {
    // `19a8ad9` started sourcing SSH_AUTH_SOCK from interactive shell env
    // rendering. That lets shell-specific or stale agent sockets override the
    // launchd session socket that refresh/sync previously relied on.
    // Keep SSH on the pre-refactor trust path and use shell-derived values
    // only as a last resort.
    preferred_ssh_auth_sock_selection(&collect_env_snapshot(
        &SystemEnvSourceLookup,
        "SSH_AUTH_SOCK",
        true,
        true,
        true,
        false,
    ))
    .map(|(_, value)| value)
}

pub fn subprocess_env_pairs() -> Vec<(String, String)> {
    // Keep subprocess env assembly on the fast path. Full diagnostics may invoke
    // slower source resolution (notably login-shell PATH rendering) and should
    // stay opt-in via `process_env_diagnostics()`.
    let mut pairs = vec![("PATH".to_string(), enriched_path().to_string())];
    if let Some(ssh_auth_sock) = preferred_ssh_auth_sock() {
        pairs.push(("SSH_AUTH_SOCK".to_string(), ssh_auth_sock));
    }
    pairs
}

pub fn process_env_diagnostics() -> ProcessEnvDiagnostics {
    let lookup = SystemEnvSourceLookup;
    let path = path_diagnostics(&lookup);
    let ssh_auth_sock = ssh_auth_sock_diagnostics(&lookup);
    let subprocess_env = std::iter::once(SubprocessEnvVar {
        key: "PATH".to_string(),
        value: path.final_value.clone(),
    })
    .chain(
        ssh_auth_sock
            .selected_value
            .clone()
            .map(|value| SubprocessEnvVar {
                key: "SSH_AUTH_SOCK".to_string(),
                value,
            }),
    )
    .collect();

    ProcessEnvDiagnostics {
        shell: normalize_env_value(env::var("SHELL").ok()),
        zdotdir: normalize_env_value(env::var("ZDOTDIR").ok()),
        grove_zdotdir: tool_hooks::grove_zdotdir(),
        path,
        ssh_auth_sock,
        subprocess_env,
    }
}

pub fn interactive_shell_output(command: &str) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        shell_output(command, true)
    }

    #[cfg(not(target_os = "macos"))]
    {
        shell_output(command, false)
    }
}

pub fn login_shell_output(command: &str) -> Result<String, String> {
    shell_output(command, false)
}

#[cfg(test)]
mod tests {
    use super::{
        enriched_path, is_posix_like_shell, merge_path_candidates, merged_path_value,
        normalize_env_value, parse_env_marker_output, parse_env_var_from_ps_output,
        parse_path_marker, path_diagnostics, preferred_env_var, preferred_ssh_auth_sock,
        preferred_ssh_auth_sock_from, resolve_with_retry, ssh_auth_sock_diagnostics,
        EnvSourceLookup, EnvSourceSnapshot, EnvValueSource,
    };
    #[cfg(target_os = "macos")]
    use super::well_known_path_suffix;
    use crate::test_support::env_lock;
    use std::collections::HashMap;
    #[cfg(unix)]
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;
    use std::time::Duration;
    use uuid::Uuid;

    #[derive(Default)]
    struct FakeLookup {
        process_env: HashMap<String, String>,
        launchctl_env: HashMap<String, String>,
        ancestor_process_env: HashMap<String, String>,
        interactive_shell_env: HashMap<String, String>,
        login_shell_path: Option<String>,
    }

    impl EnvSourceLookup for FakeLookup {
        fn process_env_var(&self, key: &str) -> Option<String> {
            self.process_env.get(key).cloned()
        }

        fn launchctl_env_var(&self, key: &str) -> Option<String> {
            self.launchctl_env.get(key).cloned()
        }

        fn ancestor_process_env_var(&self, key: &str) -> Option<String> {
            self.ancestor_process_env.get(key).cloned()
        }

        fn interactive_shell_env_var(&self, key: &str) -> Option<String> {
            self.interactive_shell_env.get(key).cloned()
        }

        fn login_shell_path(&self) -> Option<String> {
            self.login_shell_path.clone()
        }
    }

    #[test]
    fn preferred_ssh_auth_sock_prefers_process_env() {
        let _lock = env_lock();
        let original = std::env::var("SSH_AUTH_SOCK").ok();
        unsafe {
            std::env::set_var("SSH_AUTH_SOCK", "/tmp/grove-test.sock");
        }

        assert_eq!(
            preferred_ssh_auth_sock().as_deref(),
            Some("/tmp/grove-test.sock")
        );

        match original {
            Some(value) => unsafe {
                std::env::set_var("SSH_AUTH_SOCK", value);
            },
            None => unsafe {
                std::env::remove_var("SSH_AUTH_SOCK");
            },
        }
    }

    #[test]
    fn preferred_ssh_auth_sock_uses_launchctl_fallback_when_env_missing() {
        let resolved =
            preferred_ssh_auth_sock_from(None, Some("/tmp/launchctl.sock".to_string()), None, None);

        assert_eq!(resolved, Some("/tmp/launchctl.sock".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn preferred_ssh_auth_sock_uses_valid_shell_socket_when_other_sources_missing() {
        let socket_path = PathBuf::from(format!("/tmp/gssh-{}.sock", Uuid::new_v4().simple()));
        let listener = UnixListener::bind(&socket_path).unwrap();

        let resolved = preferred_ssh_auth_sock_from(
            None,
            None,
            None,
            Some(socket_path.to_string_lossy().into_owned()),
        );

        assert_eq!(resolved.as_deref(), socket_path.to_str());

        drop(listener);
        let _ = std::fs::remove_file(socket_path);
    }

    #[test]
    fn preferred_ssh_auth_sock_rejects_invalid_shell_socket_path() {
        let missing_path = PathBuf::from("/tmp/grove-missing-shell-ssh-auth.sock");
        let resolved = preferred_ssh_auth_sock_from(
            None,
            None,
            None,
            Some(missing_path.to_string_lossy().into_owned()),
        );

        assert_eq!(resolved, None);
    }

    #[cfg(unix)]
    #[test]
    fn preferred_ssh_auth_sock_prefers_launchctl_over_shell_rendering() {
        let launchctl_path =
            PathBuf::from(format!("/tmp/glaunchctl-{}.sock", Uuid::new_v4().simple()));
        let shell_path = PathBuf::from(format!("/tmp/gshell-{}.sock", Uuid::new_v4().simple()));
        let launchctl_listener = UnixListener::bind(&launchctl_path).unwrap();
        let shell_listener = UnixListener::bind(&shell_path).unwrap();

        let resolved = preferred_ssh_auth_sock_from(
            None,
            Some(launchctl_path.to_string_lossy().into_owned()),
            None,
            Some(shell_path.to_string_lossy().into_owned()),
        );

        assert_eq!(resolved.as_deref(), launchctl_path.to_str());

        drop(launchctl_listener);
        drop(shell_listener);
        let _ = std::fs::remove_file(launchctl_path);
        let _ = std::fs::remove_file(shell_path);
    }

    #[cfg(unix)]
    #[test]
    fn preferred_ssh_auth_sock_uses_ancestor_when_process_and_launchctl_are_missing() {
        let ancestor_path =
            PathBuf::from(format!("/tmp/gancestor-{}.sock", Uuid::new_v4().simple()));
        let shell_path = PathBuf::from(format!("/tmp/gshell-{}.sock", Uuid::new_v4().simple()));
        let ancestor_listener = UnixListener::bind(&ancestor_path).unwrap();
        let shell_listener = UnixListener::bind(&shell_path).unwrap();

        let resolved = preferred_ssh_auth_sock_from(
            None,
            None,
            Some(ancestor_path.to_string_lossy().into_owned()),
            Some(shell_path.to_string_lossy().into_owned()),
        );

        assert_eq!(resolved.as_deref(), ancestor_path.to_str());

        drop(ancestor_listener);
        drop(shell_listener);
        let _ = std::fs::remove_file(ancestor_path);
        let _ = std::fs::remove_file(shell_path);
    }

    #[test]
    fn parse_env_var_from_ps_output_extracts_requested_value() {
        let output = "PID TTY STAT TIME COMMAND HOME=/Users/airenkang SSH_AUTH_SOCK=/tmp/agent.sock PATH=/usr/bin";
        assert_eq!(
            parse_env_var_from_ps_output(output, "SSH_AUTH_SOCK").as_deref(),
            Some("/tmp/agent.sock")
        );
        assert_eq!(
            parse_env_var_from_ps_output(output, "HOME").as_deref(),
            Some("/Users/airenkang")
        );
    }

    #[test]
    fn preferred_env_var_prefers_process_env() {
        let _lock = env_lock();
        let original = std::env::var("GH_TOKEN_SENDBIRD").ok();
        unsafe {
            std::env::set_var("GH_TOKEN_SENDBIRD", "test-token");
        }

        assert_eq!(
            preferred_env_var("GH_TOKEN_SENDBIRD").as_deref(),
            Some("test-token")
        );

        match original {
            Some(value) => unsafe {
                std::env::set_var("GH_TOKEN_SENDBIRD", value);
            },
            None => unsafe {
                std::env::remove_var("GH_TOKEN_SENDBIRD");
            },
        }
    }

    #[test]
    fn path_diagnostics_reports_preferred_and_final_path() {
        let mut lookup = FakeLookup::default();
        lookup
            .process_env
            .insert("PATH".to_string(), "/usr/local/bin:/usr/bin".to_string());
        lookup.interactive_shell_env.insert(
            "PATH".to_string(),
            "/opt/homebrew/bin:/usr/local/bin".to_string(),
        );
        lookup.login_shell_path = Some("/usr/bin:/bin".to_string());

        let diagnostics = path_diagnostics(&lookup);

        assert_eq!(
            diagnostics.preferred_env_source,
            Some(EnvValueSource::Process)
        );
        assert_eq!(
            diagnostics.preferred_env_value.as_deref(),
            Some("/usr/local/bin:/usr/bin")
        );
        assert_eq!(
            diagnostics.merged_base_value,
            "/usr/local/bin:/usr/bin:/opt/homebrew/bin:/bin".to_string()
        );
        assert!(diagnostics
            .final_value
            .contains("/usr/local/bin:/usr/bin:/opt/homebrew/bin:/bin"));
    }

    #[test]
    fn path_diagnostics_includes_interactive_shell_when_process_path_is_sparse() {
        let mut lookup = FakeLookup::default();
        lookup.process_env.insert(
            "PATH".to_string(),
            "/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
        );
        lookup.interactive_shell_env.insert(
            "PATH".to_string(),
            "/Users/airenkang/.local/bin:/opt/homebrew/bin:/usr/bin".to_string(),
        );
        lookup.login_shell_path =
            Some("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin".to_string());

        let diagnostics = path_diagnostics(&lookup);

        assert_eq!(
            diagnostics.merged_base_value,
            "/usr/bin:/bin:/usr/sbin:/sbin:/Users/airenkang/.local/bin:/opt/homebrew/bin:/usr/local/bin".to_string()
        );
        assert!(diagnostics
            .final_value
            .contains("/Users/airenkang/.local/bin"));
    }

    #[cfg(unix)]
    #[test]
    fn ssh_auth_sock_diagnostics_reports_selected_source() {
        let socket_path = PathBuf::from(format!("/tmp/gdiag-{}.sock", Uuid::new_v4().simple()));
        let listener = UnixListener::bind(&socket_path).unwrap();
        let mut lookup = FakeLookup::default();
        lookup.launchctl_env.insert(
            "SSH_AUTH_SOCK".to_string(),
            socket_path.to_string_lossy().into_owned(),
        );

        let diagnostics = ssh_auth_sock_diagnostics(&lookup);

        assert_eq!(diagnostics.selected_source, Some(EnvValueSource::Launchctl));
        assert_eq!(diagnostics.selected_value.as_deref(), socket_path.to_str());

        drop(listener);
        let _ = std::fs::remove_file(socket_path);
    }

    #[test]
    fn normalize_env_value_ignores_blank_values() {
        assert_eq!(
            normalize_env_value(Some("  /private/tmp/agent.sock \n".to_string())),
            Some("/private/tmp/agent.sock".to_string())
        );
        assert_eq!(normalize_env_value(Some("   ".to_string())), None);
    }

    #[test]
    fn parse_path_marker_extracts_path_between_markers() {
        let output = "Welcome!\n\n__GROVE_PATH__\n/usr/bin:/opt/homebrew/bin\n__GROVE_PATH__";
        assert_eq!(
            parse_path_marker(output),
            Some("/usr/bin:/opt/homebrew/bin".to_string())
        );
    }

    #[test]
    fn parse_path_marker_returns_none_on_missing_markers() {
        assert_eq!(parse_path_marker("no markers here"), None);
        assert_eq!(parse_path_marker(""), None);
    }

    #[test]
    fn parse_path_marker_returns_none_on_empty_path() {
        let output = "__GROVE_PATH__\n\n__GROVE_PATH__";
        assert_eq!(parse_path_marker(output), None);
    }

    #[test]
    fn parse_env_marker_output_extracts_non_empty_values() {
        let output =
            "noise\n__GROVE_ENV__\nPATH=/usr/bin:/bin\nSSH_AUTH_SOCK=\nGH_TOKEN_SENDBIRD=abc123\n__GROVE_ENV__\nnoise";
        let expected = HashMap::from([
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("GH_TOKEN_SENDBIRD".to_string(), "abc123".to_string()),
        ]);

        assert_eq!(parse_env_marker_output(output), expected);
    }

    #[test]
    fn merge_path_candidates_preserves_order_and_deduplicates() {
        assert_eq!(
            merge_path_candidates(
                Some("/a:/b:/bin".to_string()),
                Some("/bin:/c:/a".to_string())
            ),
            Some("/a:/b:/bin:/c".to_string())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn well_known_path_suffix_lists_only_existing_dirs() {
        if let Some(suffix) = well_known_path_suffix() {
            for dir in suffix.split(':') {
                assert!(
                    std::path::Path::new(dir).is_dir(),
                    "{dir} should exist on disk"
                );
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn merged_path_includes_well_known_dirs_when_shell_sources_missing() {
        let snapshot = EnvSourceSnapshot {
            process_env: Some("/usr/bin:/bin".to_string()),
            interactive_shell_env: None,
            login_shell_env: None,
            well_known_dirs: well_known_path_suffix(),
            ..Default::default()
        };
        let merged = merged_path_value(&snapshot).expect("merged path is present");
        // Process PATH keeps highest precedence.
        assert!(merged.starts_with("/usr/bin:/bin"));
        // Every existing well-known dir is folded in even with no shell sources.
        if let Some(suffix) = well_known_path_suffix() {
            for dir in suffix.split(':') {
                assert!(
                    merged.split(':').any(|entry| entry == dir),
                    "{dir} missing from {merged}"
                );
            }
        }
    }

    #[test]
    fn is_posix_like_shell_recognizes_common_shells() {
        assert!(is_posix_like_shell("/bin/zsh"));
        assert!(is_posix_like_shell("/bin/bash"));
        assert!(is_posix_like_shell("/usr/bin/dash"));
        assert!(!is_posix_like_shell("/usr/bin/fish"));
        assert!(!is_posix_like_shell("/usr/bin/nu"));
    }

    #[test]
    fn enriched_path_returns_non_empty() {
        assert!(!enriched_path().is_empty());
    }

    #[test]
    fn resolve_with_retry_retries_until_success() {
        let mut attempts = 0;
        let resolved = resolve_with_retry(4, Duration::ZERO, || {
            attempts += 1;
            if attempts == 4 {
                Some("resolved".to_string())
            } else {
                None
            }
        });

        assert_eq!(resolved.as_deref(), Some("resolved"));
        assert_eq!(attempts, 4);
    }

    #[test]
    fn resolve_with_retry_stops_after_attempt_limit() {
        let mut attempts = 0;
        let resolved = resolve_with_retry::<String, _>(4, Duration::ZERO, || {
            attempts += 1;
            None
        });

        assert_eq!(resolved, None);
        assert_eq!(attempts, 4);
    }
}
