//! Grove's CLI shims (`~/.grove/bin`) and the agents' OWN hook wiring
//! (agent-status design §6, Step 6).
//!
//! ## What this module installs, and why each piece exists
//!
//! | File | Purpose |
//! |---|---|
//! | `~/.grove/bin/grove-agent` | the launcher + hook relay binary (a copy of the one shipped in the app bundle). Its path is **byte-stable forever** — codex's hook TRUST hash covers the hook COMMAND STRING, so a path that moved (or gained a version) would re-show codex's "Hooks need review" modal on every upgrade. |
//! | `~/.grove/bin/claude`, `~/.grove/bin/codex` | one-line shims: `exec grove-agent launch <tool> -- "$@"`. They **exec** — a fork-and-wait wrapper deadlocks the pane on Ctrl-Z. |
//! | `~/.grove/plugins/grove-status/` | Claude's hooks, shipped as a PLUGIN. `--plugin-dir` is repeatable+accumulating, so grove's hooks live in a layer the user's own `--settings` structurally cannot reach (see [`install_claude_plugin`]). |
//! | `~/.grove/bin/open` | the link-interception wrapper. **Untouched by the status rewrite.** |
//! | `~/.grove/zsh/` | the ZDOTDIR overlay. **Untouched.** It re-prepends `~/.grove/bin` to PATH *after* all user config has had its say, and it is what delivers the `open` wrapper. A previous rewrite dropped it and silently broke link interception. |
//!
//! ## What is GONE (agent-status design §4)
//!
//! The status FILE (`GROVE_AI_STATUS_FILE`), the `grove_ai_write` shell function, the
//! `trap … EXIT INT TERM HUP` lifecycle (a `SIGKILL` cannot be trapped — the status
//! wedged at `claude:running` forever, across app restart AND reboot), the
//! `grove-hook` dispatcher, and `HOOKLESS_TOOLS` (factually wrong: codex 0.144.1 ships
//! hooks, `PermissionRequest` included). Status now has exactly ONE writer — the
//! daemon, fed by the agents' own structured hook events over the agent socket — and
//! liveness has exactly ONE source: the kernel, at read time.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The hook events grove subscribes to. **ONE list, both agents**: codex's hook event
/// names are CamelCase and byte-identical to Claude Code's, in the config keys AND in
/// `hook_event_name` on the wire (measured live against codex 0.144.1 and claude
/// 2.1.207). `grove-daemon`'s `map_event` therefore needs no per-tool discriminant.
///
/// The ORDER is load-bearing for codex: its hook-trust key is
/// `<source>:<event>:<group_idx>:<handler_idx>`, and each event here becomes exactly
/// one group with one handler (`0:0`). Reordering would not change the keys, but
/// changing the COMMAND string would — see the module docs.
pub const HOOK_EVENTS: [&str; 6] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
];

/// Per-hook wall-clock cap, in seconds. Both agents run hooks SYNCHRONOUSLY and in
/// band — codex's default is **600s**, so a wedged hook would hang the agent for ten
/// minutes. `grove-agent event` caps itself far below this (its own watchdog), but the
/// belt-and-braces timeout is free.
pub const HOOK_TIMEOUT_SECS: u32 = 5;

/// The Claude plugin that carries grove's hooks. A plugin — not `--settings` — because
/// `--settings` is **last-wins on the WHOLE OBJECT**: an earlier `--settings`
/// contributes nothing at all, so grove's hooks silently vanished the moment a user
/// passed their own (and the naive fix, putting grove's last, destroys the USER's
/// hooks instead — both orderings are lossy). `--plugin-dir` is a different option kind:
/// repeatable and accumulating.
pub const STATUS_PLUGIN_NAME: &str = "grove-status";

/// Env var overriding the `grove-agent` binary grove copies into `~/.grove/bin`
/// (dev/test only — see [`AGENT_BIN_ENV_ALLOWED`]).
pub const AGENT_BIN_ENV: &str = "GROVE_AGENT_BIN";

/// Honored only in debug/test builds. In a RELEASE app the launcher comes from the
/// signed bundle and nowhere else: an env var that plants an arbitrary executable at a
/// stable path on the user's PATH is a persistence primitive, not a knob.
const AGENT_BIN_ENV_ALLOWED: bool = cfg!(debug_assertions);

/// `~/.grove/bin` — the shim directory. `pty::daemon_child_env` puts it FIRST on the
/// pane's PATH (shell-agnostic: bash/fish/nu users get the shims too, which the
/// ZDOTDIR-only approach never gave them).
pub fn grove_bin_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".grove").join("bin"))
}

/// `~/.grove/bin/grove-agent` — the STABLE path baked into every hook command. Never
/// versioned, never `current_exe()`: see the module docs on codex's trust hash.
pub fn grove_agent_bin() -> Option<PathBuf> {
    Some(grove_bin_dir()?.join("grove-agent"))
}

/// `~/.grove/plugins/grove-status` — Claude's hook plugin.
pub fn claude_plugin_dir() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".grove")
            .join("plugins")
            .join(STATUS_PLUGIN_NAME),
    )
}

/// Whether the Claude hook plugin is materialized. `grove-agent launch` passes
/// `--plugin-dir` ONLY when this is true: an unknown flag is a HARD ERROR in claude, so
/// a `--plugin-dir` handed to a claude too old to have it would break the agent
/// outright. Its presence IS the cached capability probe (see [`install_claude_plugin`]).
pub fn claude_plugin_is_installed() -> bool {
    claude_plugin_dir()
        .map(|dir| dir.join(".claude-plugin").join("plugin.json").is_file())
        .unwrap_or(false)
}

/// The hook command every event fires: `'<grove-agent>' event`. Single-quoted so a home
/// directory with spaces still works, with the POSIX `'\''` escape for the (pathological)
/// quote-in-path case.
pub fn hook_command(agent_bin: &Path) -> String {
    let quoted = agent_bin.to_string_lossy().replace('\'', r"'\''");
    format!("'{quoted}' event")
}

/// Claude's hook groups, keyed by event: `{"<Event>": [{matcher, hooks: [command]}]}`.
/// Shared by the plugin file and by the `--settings` MERGE fallback, so the two can
/// never disagree about what grove asks Claude to run.
pub fn claude_hook_groups(agent_bin: &Path) -> serde_json::Value {
    let command = hook_command(agent_bin);
    let mut groups = serde_json::Map::new();
    for event in HOOK_EVENTS {
        groups.insert(
            event.to_string(),
            serde_json::json!([{
                "matcher": "",
                "hooks": [{
                    "type": "command",
                    "command": command,
                    "timeout": HOOK_TIMEOUT_SECS,
                }],
            }]),
        );
    }
    serde_json::Value::Object(groups)
}

/// Codex's hooks, as CLI config overrides: `-c hooks.<Event>=<inline TOML>`.
///
/// Verified against codex 0.144.1 (a bad shape is a hard `Error loading config.toml`,
/// so this parses AND loads; the events fire with CamelCase `hook_event_name` on the
/// wire). Deliberately NOT used: `hooks=<path>` (`hooks` is a struct, not a path — it
/// cannot carry a file), a `CODEX_HOME` overlay (a second overlay to own), `async = true`
/// (silently DISABLES the hook), and `--dangerously-bypass-hook-trust` (a flag whose
/// name is the argument against it).
///
/// One group, one handler per event ⇒ codex's trust keys stay `…:0:0` forever.
pub fn codex_hook_config_args(agent_bin: &Path) -> Vec<String> {
    let command = hook_command(agent_bin).replace('\\', r"\\").replace('"', r#"\""#);
    HOOK_EVENTS
        .iter()
        .flat_map(|event| {
            [
                "-c".to_string(),
                format!(
                    r#"hooks.{event}=[{{hooks=[{{type="command",command="{command}",timeout={HOOK_TIMEOUT_SECS}}}]}}]"#
                ),
            ]
        })
        .collect()
}

pub fn ensure_installed() {
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        if let Err(error) = install() {
            eprintln!("Warning: failed to install Grove CLI wrappers: {error}");
        }
    });
}

fn install() -> Result<(), String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };

    let bin_dir = home.join(".grove").join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|error| format!("failed to create {}: {error}", bin_dir.display()))?;

    install_grove_agent(&bin_dir)?;

    let claude_wrapper = bin_dir.join("claude");
    write_executable(&claude_wrapper, &agent_wrapper_script("claude"))?;

    let codex_wrapper = bin_dir.join("codex");
    write_executable(&codex_wrapper, &agent_wrapper_script("codex"))?;

    let open_wrapper = bin_dir.join("open");
    write_executable(&open_wrapper, open_wrapper_script())?;

    // The status-file era's hook dispatcher. It writes into a channel nothing reads
    // any more; leaving it on PATH is dead weight that a user's own config might still
    // call. Best-effort — a stale file that will not delete is harmless.
    let _ = std::fs::remove_file(bin_dir.join("grove-hook"));

    install_zdotdir(&home)?;

    // Claude's plugin needs a CAPABILITY PROBE (`claude --help` — does this build have
    // `--plugin-dir`?), which costs a node startup. Off the critical path: `install()`
    // runs from `pty::create`, and a terminal must not wait ~500ms on it. Until the
    // probe lands, `grove-agent launch` uses the `--settings` MERGE path — correct, just
    // one launch later to the plugin.
    std::thread::spawn(move || {
        if let Err(error) = install_claude_plugin(&home, claude_supports_plugin_dir()) {
            crate::logger::emit_log(
                "warn",
                "tool_hooks",
                &format!("failed to install the Claude status plugin: {error}"),
            );
        }
    });

    Ok(())
}

/// Copy the bundled `grove-agent` to `~/.grove/bin/grove-agent`.
///
/// Written via a temp file + `rename`, NEVER truncated in place: the destination may be
/// the very binary a live agent's hooks are executing, and overwriting a running image
/// is `ETXTBSY` (at best) or a torn read (at worst). A rename swaps the inode; the
/// running process keeps the old one.
///
/// A MISSING source is not an error: in a dev tree (or an unpackaged run) there is no
/// bundled launcher, and the shims fall back to exec'ing the real agent directly — the
/// user gets their agent, just no badge.
fn install_grove_agent(bin_dir: &Path) -> Result<(), String> {
    let Some(source) = grove_agent_source() else {
        return Ok(());
    };
    if !source.is_file() {
        return Ok(());
    }
    let dest = bin_dir.join("grove-agent");
    if agent_copy_is_current(&source, &dest) {
        return Ok(());
    }

    let tmp = bin_dir.join(format!("grove-agent.{}.tmp", std::process::id()));
    std::fs::copy(&source, &tmp)
        .map_err(|error| format!("failed to stage {}: {error}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("failed to chmod {}: {error}", tmp.display()))?;
    }
    std::fs::rename(&tmp, &dest).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        format!("failed to install {}: {error}", dest.display())
    })
}

/// The `grove-agent` shipped alongside the host binary (the sidecar convention both
/// shells already use for `grove-daemon`), or the `GROVE_AGENT_BIN` override in
/// debug/test builds.
fn grove_agent_source() -> Option<PathBuf> {
    if AGENT_BIN_ENV_ALLOWED {
        if let Some(over) = std::env::var_os(AGENT_BIN_ENV).filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(over));
        }
    }
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("grove-agent"))
}

/// Is the installed copy already this build's? Same size and not older than the source.
/// `fs::copy` stamps the destination with the copy time, so a NEWER bundled launcher
/// (a fresh app version) always wins.
fn agent_copy_is_current(source: &Path, dest: &Path) -> bool {
    let (Ok(src), Ok(dst)) = (source.metadata(), dest.metadata()) else {
        return false;
    };
    if src.len() != dst.len() {
        return false;
    }
    match (src.modified(), dst.modified()) {
        (Ok(src_time), Ok(dst_time)) => src_time <= dst_time,
        _ => false,
    }
}

/// Does the installed `claude` support `--plugin-dir`? Probed ONCE (per app process),
/// off the critical path, because an unknown flag is a hard error in claude — passing
/// `--plugin-dir` to a build without it would BREAK the agent, and "nothing may block
/// or break the agent" is the whole contract.
///
/// Resolves claude WITHOUT `~/.grove/bin` on PATH so the probe cannot recurse into
/// grove's own shim.
fn claude_supports_plugin_dir() -> bool {
    let Some(real) = find_real_binary_outside_grove("claude") else {
        return false;
    };
    let Ok(output) = std::process::Command::new(&real)
        .arg("--help")
        .env("PATH", crate::process_env::enriched_path())
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout).contains("--plugin-dir")
}

/// The first `tool` on the enriched PATH that is not one of grove's own shims.
///
/// The directory check alone is NOT enough, and the failure is nasty: a shim found through
/// any other PATH entry would exec `grove-agent launch claude -- --help`, which would
/// resolve `claude`… The marker sniff is the same guard `grove-agent`'s resolver uses (a
/// shim carries `GROVE_AGENT_WRAPPER` in its source), and it holds no matter what `HOME`
/// or `PATH` happen to say.
fn find_real_binary_outside_grove(tool: &str) -> Option<PathBuf> {
    let grove_bin = grove_bin_dir();
    std::env::split_paths(crate::process_env::enriched_path())
        .filter(|dir| Some(dir) != grove_bin.as_ref())
        .map(|dir| dir.join(tool))
        .find(|candidate| is_executable_file(candidate) && !is_grove_shim(candidate))
}

/// Does this file carry grove's shim marker? Reads at most the first 4 KiB — the real
/// agent is a multi-megabyte binary and must not be slurped.
fn is_grove_shim(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 4096];
    let Ok(read) = file.read(&mut head) else {
        return false;
    };
    String::from_utf8_lossy(&head[..read]).contains("GROVE_AGENT_WRAPPER")
}

fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Materialize (or remove) Claude's hook plugin under `~/.grove/plugins/grove-status`.
///
/// `supported == false` REMOVES it, so the presence of the manifest is a truthful,
/// self-healing cache of the capability probe: a claude downgraded below `--plugin-dir`
/// falls back to the `--settings` merge on the next app start instead of being handed a
/// flag that would break it.
///
/// Layout (auto-discovered by claude, verified):
/// ```text
/// grove-status/.claude-plugin/plugin.json   {"name":"grove-status","version":"1.0.0"}
/// grove-status/hooks/hooks.json             {"hooks":{ "<Event>": [ … ] }}
/// ```
pub(crate) fn install_claude_plugin(home: &Path, supported: bool) -> Result<(), String> {
    let plugin_dir = home
        .join(".grove")
        .join("plugins")
        .join(STATUS_PLUGIN_NAME);
    if !supported {
        if plugin_dir.exists() {
            std::fs::remove_dir_all(&plugin_dir)
                .map_err(|e| format!("failed to remove {}: {e}", plugin_dir.display()))?;
        }
        return Ok(());
    }

    let agent_bin = home.join(".grove").join("bin").join("grove-agent");
    let manifest_dir = plugin_dir.join(".claude-plugin");
    let hooks_dir = plugin_dir.join("hooks");
    std::fs::create_dir_all(&manifest_dir)
        .map_err(|e| format!("failed to create {}: {e}", manifest_dir.display()))?;
    std::fs::create_dir_all(&hooks_dir)
        .map_err(|e| format!("failed to create {}: {e}", hooks_dir.display()))?;

    // hooks.json FIRST, manifest LAST: `claude_plugin_is_installed` keys off the
    // manifest, so a launch racing this install can never see a plugin whose hooks file
    // is missing or half-written.
    std::fs::write(
        hooks_dir.join("hooks.json"),
        serde_json::json!({ "hooks": claude_hook_groups(&agent_bin) }).to_string(),
    )
    .map_err(|e| format!("failed to write the plugin hooks: {e}"))?;
    std::fs::write(
        manifest_dir.join("plugin.json"),
        r#"{"name":"grove-status","version":"1.0.0","description":"Grove agent status hooks"}"#,
    )
    .map_err(|e| format!("failed to write the plugin manifest: {e}"))?;

    Ok(())
}

/// Creates `~/.grove/zsh/` with wrapper rc files that source the user's
/// real dotfiles and then prepend `~/.grove/bin` to PATH.  This ensures
/// the Grove claude wrapper is found first regardless of what the user's
/// `.zshrc` does to PATH.
pub(crate) fn install_zdotdir(home: &std::path::Path) -> Result<(), String> {
    let zsh_dir = home.join(".grove").join("zsh");
    std::fs::create_dir_all(&zsh_dir)
        .map_err(|e| format!("failed to create {}: {e}", zsh_dir.display()))?;

    let grove_bin = home.join(".grove").join("bin");
    let grove_bin_str = grove_bin.to_string_lossy();

    // .zshenv — runs for ALL zsh invocations (login, non-login, scripts)
    std::fs::write(
        zsh_dir.join(".zshenv"),
        r#"# Grove-managed — sources real .zshenv then ensures Grove PATH.
source "${GROVE_REAL_ZDOTDIR:-$HOME}/.zshenv" 2>/dev/null; true
"#,
    )
    .map_err(|e| format!("failed to write .zshenv: {e}"))?;

    // .zprofile — login shells only (lets path_helper run via /etc/zprofile, then sources user's)
    std::fs::write(
        zsh_dir.join(".zprofile"),
        r#"# Grove-managed — sources real .zprofile.
source "${GROVE_REAL_ZDOTDIR:-$HOME}/.zprofile" 2>/dev/null; true
"#,
    )
    .map_err(|e| format!("failed to write .zprofile: {e}"))?;

    // .zshrc — interactive shells; prepends ~/.grove/bin AFTER all user config, then
    // installs the prompt-time TUI-state reset (see grove_reset_tui_state below).
    std::fs::write(
        zsh_dir.join(".zshrc"),
        format!(
            r#"# Grove-managed — sources real .zshrc then ensures Grove PATH.
source "${{GROVE_REAL_ZDOTDIR:-$HOME}}/.zshrc" 2>/dev/null; true
export PATH="{grove_bin_str}:$PATH"

# Grove-managed — clear terminal state a TUI leaked when it died without restoring it.
# Grove's PTY is a raw terminal now (tmux used to absorb mouse events for us), so an
# agent killed while mouse reporting was armed would turn every later click at the shell
# prompt into escape-sequence garbage on the command line. Reset at each prompt: mouse
# reporting (1000/1002/1003 + the 1006/1015/1016 encodings), focus reporting (1004),
# cursor visibility, and cursor shape. Deliberately NOT reset: bracketed paste (zsh owns
# it) and the alternate screen (a live TUI's subshell must not be yanked out of it).
grove_reset_tui_state() {{
  printf '\e[?1000l\e[?1002l\e[?1003l\e[?1006l\e[?1015l\e[?1016l\e[?1004l\e[?25h\e[0 q'
}}
autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd grove_reset_tui_state
"#
        ),
    )
    .map_err(|e| format!("failed to write .zshrc: {e}"))?;

    // .zlogin — login shells, after .zshrc
    std::fs::write(
        zsh_dir.join(".zlogin"),
        r#"# Grove-managed — sources real .zlogin.
source "${GROVE_REAL_ZDOTDIR:-$HOME}/.zlogin" 2>/dev/null; true
"#,
    )
    .map_err(|e| format!("failed to write .zlogin: {e}"))?;

    Ok(())
}

/// Returns the Grove-managed ZDOTDIR path when it has been installed.
pub fn grove_zdotdir() -> Option<String> {
    let home = dirs::home_dir()?;
    let zsh_dir = home.join(".grove").join("zsh");
    if zsh_dir.is_dir() {
        Some(zsh_dir.to_string_lossy().into_owned())
    } else {
        None
    }
}

fn write_executable(path: &Path, content: &str) -> Result<(), String> {
    std::fs::write(path, content)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("failed to chmod {}: {error}", path.display()))?;
    }
    Ok(())
}

/// The shim for one agent. Three properties, each load-bearing:
///
/// 1. **It `exec`s.** It never becomes a parent, never `waitpid`s, never proxies
///    signals. A fork-and-wait wrapper WEDGES the pane on Ctrl-Z (proven: a TUI that
///    self-suspends with the textbook `raise(SIGTSTP)` idiom stops alone, the wrapper
///    stays foreground blocked in `waitpid`, and the shell never regains the terminal).
///    With `exec`, the suspended process IS the job — the failure mode is structurally
///    impossible.
/// 2. **It degrades.** If `grove-agent` is missing (a dev tree, a half-finished
///    install), it execs the REAL agent directly. The user always gets their agent; the
///    only thing they lose is the badge.
/// 3. **It is marked.** `GROVE_AGENT_WRAPPER` in the source is what `grove-agent`'s
///    resolver content-sniffs for, so a wrapper reachable through an unexpected PATH
///    entry can never be mistaken for the real binary and exec'd in a loop.
fn agent_wrapper_script(tool: &str) -> String {
    format!(
        r#"#!/usr/bin/env bash
# GROVE_AGENT_WRAPPER — Grove-managed {tool} shim (agent-status design §6).
# execs grove-agent, which claims the pane, installs {tool}'s own hooks, and execs the
# real {tool}. No fork, no wait, no trap: a fork-and-wait wrapper deadlocks the pane on
# Ctrl-Z, and a trap cannot survive SIGKILL.
GROVE_AGENT="${{GROVE_BIN_DIR:-$HOME/.grove/bin}}/grove-agent"
if [ -x "$GROVE_AGENT" ]; then
  exec "$GROVE_AGENT" launch {tool} -- "$@"
fi

# grove-agent is not installed — run the real {tool} anyway (no badge, never a broken
# agent). Scan PATH, skipping this wrapper's own directory.
find_real_{tool}() {{
  local self_dir; self_dir="$(cd "$(dirname "$0")" && pwd)"
  local IFS=:; for d in $PATH; do
    [[ "$d" == "$self_dir" ]] && continue
    [[ -x "$d/{tool}" ]] && printf '%s' "$d/{tool}" && return 0
  done; return 1
}}
REAL="$(find_real_{tool})" || {{ echo "{tool}: not found" >&2; exit 127; }}
exec "$REAL" "$@"
"#
    )
}

fn open_wrapper_script() -> &'static str {
    r#"#!/usr/bin/env bash
# Grove-managed open wrapper — routes HTTP(S) URLs through Grove.
GROVE_SOCK="$HOME/.grove/open-url.sock"
for arg in "$@"; do
  case "$arg" in
    http://*|https://*)
      if [ -S "$GROVE_SOCK" ]; then
        printf '%s' "$arg" | /usr/bin/nc -U "$GROVE_SOCK" -w 1 2>/dev/null
        exit 0
      fi
      exec /usr/bin/open "$@"
      ;;
  esac
done
exec /usr/bin/open "$@"
"#
}

#[cfg(test)]
mod tests {
    use super::{
        agent_wrapper_script, claude_hook_groups, codex_hook_config_args, ensure_installed,
        grove_zdotdir, hook_command, install_claude_plugin, HOOK_EVENTS, HOOK_TIMEOUT_SECS,
    };
    use std::env;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Output;
    use uuid::Uuid;

    const ENSURE_INSTALLED_CHILD_ENV: &str = "GROVE_TOOL_HOOKS_CHILD";

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

    /// Codex hashes the hook COMMAND STRING to decide whether it is still trusted, so a
    /// command that drifts (a version in the path, a new flag, a reordered arg) re-shows
    /// codex's "Hooks need review" modal on every grove upgrade. Pin the exact string.
    #[test]
    fn the_hook_command_is_byte_stable() {
        assert_eq!(
            hook_command(Path::new("/Users/u/.grove/bin/grove-agent")),
            "'/Users/u/.grove/bin/grove-agent' event"
        );
        // A home with a space still yields ONE argv word for the shell.
        assert_eq!(
            hook_command(Path::new("/Users/a b/.grove/bin/grove-agent")),
            "'/Users/a b/.grove/bin/grove-agent' event"
        );
    }

    #[test]
    fn claude_hook_groups_cover_every_event_grove_maps() {
        let groups = claude_hook_groups(Path::new("/g/grove-agent"));
        let object = groups.as_object().expect("an object keyed by event");
        assert_eq!(object.len(), HOOK_EVENTS.len());
        // PermissionRequest is the event the entire design hinges on: it fires at the
        // exact instant the agent blocks on a human.
        assert!(object.contains_key("PermissionRequest"));
        for event in HOOK_EVENTS {
            let handler = &groups[event][0]["hooks"][0];
            assert_eq!(handler["type"], "command");
            assert_eq!(handler["command"], "'/g/grove-agent' event");
            assert_eq!(handler["timeout"], HOOK_TIMEOUT_SECS);
        }
        // No PII, no transcript path, no cwd — the hook binary decides what crosses the
        // wire, and it sends only the event name and the tool name.
        assert!(!groups.to_string().contains("transcript"));
    }

    /// The codex wiring, verified live against codex 0.144.1: a bad shape is a hard
    /// `Error loading config.toml`, and this one loads and FIRES. One group + one handler
    /// per event keeps codex's trust keys at `…:0:0` forever.
    #[test]
    fn codex_hook_args_are_inline_toml_with_a_five_second_timeout() {
        let args = codex_hook_config_args(Path::new("/g/grove-agent"));
        assert_eq!(args.len(), HOOK_EVENTS.len() * 2);
        for (i, event) in HOOK_EVENTS.iter().enumerate() {
            assert_eq!(args[i * 2], "-c");
            assert_eq!(
                args[i * 2 + 1],
                format!(
                    r#"hooks.{event}=[{{hooks=[{{type="command",command="'/g/grove-agent' event",timeout=5}}]}}]"#
                )
            );
        }
        // `hooks=<path>` is impossible (hooks is a struct, not a path) and `async = true`
        // silently DISABLES the hook — neither may ever appear here.
        assert!(!args.iter().any(|a| a.contains("async")));
        assert!(!args.iter().any(|a| a.starts_with("hooks=")));
        // Never bypass codex's hook-trust review: a flag whose name is the argument
        // against it.
        assert!(!args.iter().any(|a| a.contains("dangerously")));
    }

    #[test]
    fn the_shims_exec_grove_agent_and_still_run_the_agent_without_it() {
        for tool in ["claude", "codex"] {
            let script = agent_wrapper_script(tool);
            assert!(script.contains(&format!(r#"exec "$GROVE_AGENT" launch {tool} -- "$@""#)));
            // The resolver's content sniff keys off this marker: without it, a wrapper
            // found through an unexpected PATH entry would exec ITSELF, forever.
            assert!(script.contains("GROVE_AGENT_WRAPPER"));
            // Degrade, never break: no grove-agent ⇒ exec the real agent, no badge.
            assert!(script.contains(&format!(r#"REAL="$(find_real_{tool})""#)));
            assert!(script.contains(r#"exec "$REAL" "$@""#));
            // The status file, the write function and the lifecycle trap are GONE. A
            // trap cannot survive SIGKILL — that is why the badge used to wedge at
            // `claude:running` forever, across app restart AND reboot.
            assert!(!script.contains("GROVE_AI_STATUS_FILE"));
            assert!(!script.contains("grove_ai_write"));
            assert!(
                !script.lines().any(|line| line.trim_start().starts_with("trap ")),
                "no lifecycle trap may come back: it cannot survive SIGKILL"
            );
            assert!(!script.contains("tmux"));
            // It EXECS. A fork-and-wait wrapper deadlocks the pane on Ctrl-Z.
            assert!(!script.contains("\"$REAL\" \"$@\"\n\"#"));
        }
    }

    /// The plugin manifest is written LAST, so a `grove-agent launch` racing the
    /// installer never sees a plugin whose hooks file is missing. And an unsupported
    /// claude REMOVES the plugin — `claude_plugin_is_installed()` is the capability
    /// cache, and it must be able to go false again (a downgraded claude must not be
    /// handed a `--plugin-dir` it would hard-error on).
    #[test]
    fn the_claude_plugin_materializes_only_when_plugin_dir_is_supported() {
        let home = unique_test_dir("grove-plugin-home");
        fs::create_dir_all(&home).unwrap();
        let plugin = home.join(".grove").join("plugins").join("grove-status");

        install_claude_plugin(&home, true).unwrap();
        let manifest = plugin.join(".claude-plugin").join("plugin.json");
        let hooks = plugin.join("hooks").join("hooks.json");
        assert!(manifest.is_file() && hooks.is_file());
        let hooks_json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&hooks).unwrap()).unwrap();
        let command = hooks_json["hooks"]["PermissionRequest"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(
            command.ends_with("/.grove/bin/grove-agent' event"),
            "the hook must call the STABLE ~/.grove/bin path, never a versioned one: {command}"
        );

        install_claude_plugin(&home, false).unwrap();
        assert!(!plugin.exists(), "an unsupported claude removes the plugin");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn ensure_installed_creates_zdotdir_wrappers_and_grove_zdotdir() {
        if env::var_os(ENSURE_INSTALLED_CHILD_ENV).is_some() {
            ensure_installed();

            let home = dirs::home_dir().unwrap();
            let zsh_dir = home.join(".grove").join("zsh");
            let grove_bin = home.join(".grove").join("bin");

            assert_eq!(
                grove_zdotdir(),
                Some(zsh_dir.to_string_lossy().into_owned())
            );
            for file_name in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
                assert!(zsh_dir.join(file_name).is_file(), "missing {file_name}");
            }
            // The `open` link-interception wrapper rides the same PATH the shims do. A
            // previous rewrite dropped its delivery and broke link interception silently.
            let open_wrapper = grove_bin.join("open");
            assert!(open_wrapper.is_file(), "the open wrapper must ship");
            assert!(fs::read_to_string(&open_wrapper)
                .unwrap()
                .contains("open-url.sock"));
            for shim in ["claude", "codex"] {
                assert!(grove_bin.join(shim).is_file(), "missing the {shim} shim");
            }

            let zshrc = fs::read_to_string(zsh_dir.join(".zshrc")).unwrap();
            assert!(zshrc.contains("source \"${GROVE_REAL_ZDOTDIR:-$HOME}/.zshrc\""));
            assert!(zshrc.contains(&format!("export PATH=\"{}:$PATH\"", grove_bin.display())));

            // The PTY is a raw terminal now (tmux used to absorb mouse events), so an
            // agent killed with mouse reporting armed would turn every later click at
            // the prompt into escape-sequence garbage on the command line. The prompt
            // hook is the only thing that clears it — assert each disarm ships.
            assert!(zshrc.contains("add-zsh-hook precmd grove_reset_tui_state"));
            for disarm in [
                "\\e[?1000l", "\\e[?1002l", "\\e[?1003l", // mouse reporting
                "\\e[?1006l", "\\e[?1015l", "\\e[?1016l", // mouse encodings
                "\\e[?1004l", // focus reporting
                "\\e[?25h",   // cursor visibility
            ] {
                assert!(zshrc.contains(disarm), "prompt reset missing {disarm}");
            }
            // zsh owns bracketed paste, and yanking a live TUI's subshell out of the
            // alternate screen would corrupt it — neither may be reset here.
            assert!(!zshrc.contains("2004l"), "must not disable bracketed paste");
            assert!(!zshrc.contains("1049l"), "must not leave the alternate screen");
            return;
        }

        let child_home = unique_test_dir("grove-tool-hooks-home");
        fs::create_dir_all(&child_home).unwrap();

        let output = std::process::Command::new(env::current_exe().unwrap())
            .arg("--exact")
            .arg("tool_hooks::tests::ensure_installed_creates_zdotdir_wrappers_and_grove_zdotdir")
            .arg("--nocapture")
            .env(ENSURE_INSTALLED_CHILD_ENV, "1")
            .env("HOME", &child_home)
            .env_remove("ZDOTDIR")
            .output()
            .unwrap();

        let _ = fs::remove_dir_all(&child_home);
        assert_subprocess_success(&output, "tool_hooks ensure_installed assertions");
    }
}
