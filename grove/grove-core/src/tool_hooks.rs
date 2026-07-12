use std::path::Path;
use std::sync::OnceLock;

/// The env var carrying a pane's AI-status file path into its shell (design G9).
/// `pty::create` exports it (`<daemon base dir>/ai-status/<session id>`); the hook
/// scripts below write `tool:status` into it ATOMICALLY (tmp + `mv`), and
/// `pty::poll_bell_events` consumes the file each tick and forwards the value to the
/// daemon (`setAiStatus`). This file IS the hook channel — the daemon-native
/// replacement for `tmux set-option @grove_ai_status`, which the shell could reach
/// only because tmux happened to be the PTY backend.
///
/// An EMPTY file means "clear the status" (the old `set-option -u` unset).
pub const GROVE_AI_STATUS_FILE_ENV: &str = "GROVE_AI_STATUS_FILE";

/// Tools that lack a hook system and need PTY idle timeout detection.
/// Tools with hooks (e.g. Claude Code via `--settings`) report status directly.
const HOOKLESS_TOOLS: &[&str] = &["codex"];

/// Returns true if the tool name belongs to a hookless tool.
pub fn is_hookless_tool(tool: &str) -> bool {
    HOOKLESS_TOOLS.contains(&tool)
}

/// Returns true if the given AI status belongs to a tool without hooks.
pub fn needs_idle_detection(ai_status: Option<&str>) -> bool {
    ai_status.is_some_and(|s| s.split(':').next().is_some_and(is_hookless_tool))
}

/// Returns true if the status suffix is `:running`.
pub fn is_running(ai_status: Option<&str>) -> bool {
    ai_status.is_some_and(|s| s.ends_with(":running"))
}

/// Returns true if the status suffix is `:idle`.
pub fn is_idle(ai_status: Option<&str>) -> bool {
    ai_status.is_some_and(|s| s.ends_with(":idle"))
}

/// Converts a status to its `:running` variant (e.g. "codex:idle" → "codex:running").
pub fn to_running(ai_status: &str) -> String {
    let tool = ai_status.split(':').next().unwrap_or(ai_status);
    format!("{tool}:running")
}

/// Converts a status to its `:idle` variant (e.g. "codex:running" → "codex:idle").
pub fn to_idle(ai_status: &str) -> String {
    let tool = ai_status.split(':').next().unwrap_or(ai_status);
    format!("{tool}:idle")
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

    let grove_hook = bin_dir.join("grove-hook");
    write_executable(&grove_hook, &grove_hook_script())?;

    let grove_app = std::env::current_exe()
        .map_err(|error| format!("failed to resolve current executable: {error}"))?;
    let claude_wrapper = bin_dir.join("claude");
    write_executable(
        &claude_wrapper,
        &claude_wrapper_script(&grove_hook, &grove_app),
    )?;

    let codex_wrapper = bin_dir.join("codex");
    write_executable(&codex_wrapper, &codex_wrapper_script())?;

    let open_wrapper = bin_dir.join("open");
    write_executable(&open_wrapper, open_wrapper_script())?;

    install_zdotdir(&home)?;

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

/// The shared shell function every hook path uses to publish status: write the
/// value to a temp file next to the target, then `mv` it into place. The rename is
/// atomic, so grove's poller never reads a half-written status, and an EMPTY payload
/// is the explicit "clear" signal (the old `tmux set-option -u`). The temp name is
/// pid-suffixed so two concurrent tools in the same pane can't clobber each other's
/// tmp file mid-write.
const GROVE_AI_WRITE_FN: &str = r#"grove_ai_write() { _t="$GROVE_AI_STATUS_FILE.$$.tmp"; printf '%s' "$1" > "$_t" 2>/dev/null && mv -f "$_t" "$GROVE_AI_STATUS_FILE" 2>/dev/null; rm -f "$_t" 2>/dev/null; }"#;

fn grove_hook_script() -> String {
    format!(
        r#"#!/usr/bin/env bash
# Grove hook dispatcher. Usage: grove-hook <tool> <event>
# Publishes "tool:status" into the pane's GROVE_AI_STATUS_FILE (atomic write+mv).
TOOL="$1"; EVENT="$2"
[ -z "$GROVE_AI_STATUS_FILE" ] && exit 0
{GROVE_AI_WRITE_FN}
grove_ai() {{ grove_ai_write "$1"; }}
grove_ai_clear() {{ grove_ai_write ""; }}
case "$TOOL" in
  claude)
    case "$EVENT" in
      SessionStart)          grove_ai "claude:idle" ;;
      UserPromptSubmit)      grove_ai "claude:running" ;;
      Stop)                  grove_ai "claude:idle" ;;
      StopFailure|Notification) grove_ai "claude:attention" ;;
      SessionEnd|cleanup)    grove_ai_clear ;;
    esac ;;
esac
"#
    )
}

/// Common shell helper: find real binary by scanning PATH, skipping our own bin dir.
fn find_real_binary_fn(tool: &str) -> String {
    format!(
        r#"find_real_{tool}() {{
  local self_dir; self_dir="$(cd "$(dirname "$0")" && pwd)"
  local IFS=:; for d in $PATH; do
    [[ "$d" == "$self_dir" ]] && continue
    [[ -x "$d/{tool}" ]] && printf '%s' "$d/{tool}" && return 0
  done; return 1
}}"#
    )
}

/// Common lifecycle: publish `{tool}:idle` into the pane's status file on start and
/// clear it on exit (design G9). Same semantics the tmux `@grove_ai_status`
/// set/unset pair had, over the file channel.
fn grove_lifecycle_trap(tool: &str) -> String {
    format!(
        r#"{GROVE_AI_WRITE_FN}
grove_ai_cleanup() {{ grove_ai_write ""; }}
trap grove_ai_cleanup EXIT INT TERM HUP
grove_ai_write "{tool}:idle""#
    )
}

fn claude_wrapper_script(grove_hook_path: &Path, _grove_app_path: &Path) -> String {
    let grove_hook_path = grove_hook_path.to_string_lossy();
    let find_fn = find_real_binary_fn("claude");
    let lifecycle = grove_lifecycle_trap("claude");
    format!(
        r#"#!/usr/bin/env bash
# Grove-managed Claude Code wrapper — lifecycle tracking + hooks for fine-grained status.
{find_fn}
REAL_CLAUDE="$(find_real_claude)" || {{ echo "claude: not found" >&2; exit 127; }}
[ -z "$GROVE_AI_STATUS_FILE" ] && exec "$REAL_CLAUDE" "$@"
{lifecycle}
GROVE_HOOK="{grove_hook_path}"
HOOKS_JSON='{{"hooks":{{"SessionStart":[{{"matcher":"","hooks":[{{"type":"command","command":"'"'"'{grove_hook_path}'"'"' claude SessionStart","timeout":5}}]}}],"Stop":[{{"matcher":"","hooks":[{{"type":"command","command":"'"'"'{grove_hook_path}'"'"' claude Stop","timeout":5}}]}}],"StopFailure":[{{"matcher":"","hooks":[{{"type":"command","command":"'"'"'{grove_hook_path}'"'"' claude StopFailure","timeout":5}}]}}],"Notification":[{{"matcher":"","hooks":[{{"type":"command","command":"'"'"'{grove_hook_path}'"'"' claude Notification","timeout":5}}]}}],"UserPromptSubmit":[{{"matcher":"","hooks":[{{"type":"command","command":"'"'"'{grove_hook_path}'"'"' claude UserPromptSubmit","timeout":5}}]}}],"SessionEnd":[{{"matcher":"","hooks":[{{"type":"command","command":"'"'"'{grove_hook_path}'"'"' claude SessionEnd","timeout":1}}]}}]}}}}'
"$REAL_CLAUDE" --settings "$HOOKS_JSON" "$@"
"#
    )
}

fn codex_wrapper_script() -> String {
    let find_fn = find_real_binary_fn("codex");
    let lifecycle = grove_lifecycle_trap("codex");
    format!(
        r#"#!/usr/bin/env bash
# Grove-managed Codex wrapper — lifecycle tracking.
{find_fn}
REAL_CODEX="$(find_real_codex)" || {{ echo "codex: not found" >&2; exit 127; }}
[ -z "$GROVE_AI_STATUS_FILE" ] && exec "$REAL_CODEX" "$@"
{lifecycle}
"$REAL_CODEX" "$@"
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
        claude_wrapper_script, codex_wrapper_script, ensure_installed, grove_hook_script,
        grove_zdotdir, GROVE_AI_STATUS_FILE_ENV,
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

    #[test]
    fn needs_idle_detection_only_for_hookless_tools() {
        use super::needs_idle_detection;

        // Codex — hookless, needs idle detection
        assert!(needs_idle_detection(Some("codex:idle")));
        assert!(needs_idle_detection(Some("codex:running")));
        assert!(needs_idle_detection(Some("codex:attention")));

        // Claude — has hooks, does NOT need idle detection
        assert!(!needs_idle_detection(Some("claude:idle")));
        assert!(!needs_idle_detection(Some("claude:running")));

        // None
        assert!(!needs_idle_detection(None));
    }

    #[test]
    fn status_predicates_and_conversions() {
        use super::{is_idle, is_running, to_idle, to_running};

        assert!(is_running(Some("codex:running")));
        assert!(!is_running(Some("codex:idle")));
        assert!(!is_running(None));

        assert!(is_idle(Some("codex:idle")));
        assert!(!is_idle(Some("codex:running")));
        assert!(!is_idle(None));

        assert_eq!(to_running("codex:idle"), "codex:running");
        assert_eq!(to_running("codex:attention"), "codex:running");
        assert_eq!(to_idle("codex:running"), "codex:idle");
        assert_eq!(to_idle("newtool:running"), "newtool:idle");
    }

    #[test]
    fn grove_hook_script_writes_ai_status_file_atomically() {
        let script = grove_hook_script();

        // The hook channel is the per-session status FILE, never tmux (design G9).
        assert!(script.contains(GROVE_AI_STATUS_FILE_ENV));
        assert!(!script.contains("tmux"));
        assert!(!script.contains("GROVE_TMUX_SESSION"));
        // Atomic publish: write a tmp file, then rename it into place.
        assert!(script.contains(r#"printf '%s' "$1" > "$_t""#));
        assert!(script.contains(r#"mv -f "$_t" "$GROVE_AI_STATUS_FILE""#));
        // An empty payload is the explicit clear (the old `set-option -u`).
        assert!(script.contains(r#"grove_ai_clear() { grove_ai_write ""; }"#));
        assert!(script.contains("claude:idle"));
        assert!(script.contains("claude:running"));
        assert!(script.contains("claude:attention"));
        assert!(script.contains("StopFailure|Notification"));
        assert!(script.contains("SessionEnd|cleanup"));
    }

    /// The hook script must be a runnable bash program that publishes exactly the
    /// status the event maps to — asserted by RUNNING it against a scratch file.
    #[test]
    fn grove_hook_script_publishes_status_into_the_file() {
        let dir = unique_test_dir("grove-hook-status-file");
        fs::create_dir_all(&dir).unwrap();
        let script_path = dir.join("grove-hook");
        fs::write(&script_path, grove_hook_script()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let status_file = dir.join("grove-abc-pane1");

        let run = |event: &str| {
            let output = std::process::Command::new(&script_path)
                .args(["claude", event])
                .env(GROVE_AI_STATUS_FILE_ENV, &status_file)
                .output()
                .unwrap();
            assert_subprocess_success(&output, &format!("grove-hook claude {event}"));
            fs::read_to_string(&status_file).unwrap()
        };

        assert_eq!(run("UserPromptSubmit"), "claude:running");
        assert_eq!(run("Stop"), "claude:idle");
        assert_eq!(run("Notification"), "claude:attention");
        // SessionEnd clears: an EMPTY file, not a deleted one (the poller reads an
        // empty payload as "clear the status").
        assert_eq!(run("SessionEnd"), "");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_wrapper_script_uses_lifecycle_trap_and_hooks() {
        let hook_path = Path::new("/tmp/grove-hook");
        let grove_app = Path::new("/Applications/grove.app/Contents/MacOS/grove");
        let script = claude_wrapper_script(hook_path, grove_app);

        assert!(script.contains("GROVE_HOOK=\"/tmp/grove-hook\""));
        assert!(script.contains("grove_ai_cleanup"));
        assert!(script.contains("trap grove_ai_cleanup EXIT INT TERM HUP"));
        assert!(!script.contains("tmux"));
        assert!(script.contains(r#"[ -z "$GROVE_AI_STATUS_FILE" ] && exec "$REAL_CLAUDE""#));
        assert!(script.contains("claude:idle"));
        assert!(script.contains("claude UserPromptSubmit"));
        assert!(script.contains("claude Notification"));
        assert!(script.contains("--settings \"$HOOKS_JSON\""));
        // Should NOT use exec — run as child process
        assert!(!script.contains("exec \"$REAL_CLAUDE\" --settings"));
    }

    #[test]
    fn codex_wrapper_script_uses_lifecycle_trap() {
        let script = codex_wrapper_script();

        assert!(script.contains("find_real_codex"));
        assert!(script.contains("grove_ai_cleanup"));
        assert!(script.contains("trap grove_ai_cleanup EXIT INT TERM HUP"));
        assert!(!script.contains("tmux"));
        assert!(script.contains(r#"[ -z "$GROVE_AI_STATUS_FILE" ] && exec "$REAL_CODEX""#));
        assert!(script.contains("codex:idle"));
        // Should NOT use exec when in Grove session
        assert!(!script.contains("exec \"$REAL_CODEX\" \"$@\"\n\"#"));
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
