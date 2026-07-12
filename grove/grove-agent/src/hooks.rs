//! Planning the real agent's argv: grove's hook config + the user's own arguments.
//!
//! ## Claude: a PLUGIN, not `--settings`
//!
//! `--settings` is **last-wins on the WHOLE SETTINGS OBJECT** — an earlier `--settings`
//! contributes *nothing at all* (measured: grove's hooks vanished even when the user's
//! file had no `hooks` key whatsoever). grove's shipping argv put grove's `--settings`
//! FIRST, so any user who passed their own silently lost every grove hook and every
//! badge. And the naive fix — putting grove's last — destroys the USER's hooks instead.
//! Both orderings are lossy.
//!
//! `--plugin-dir` is a different option kind: **repeatable and accumulating**. Plugins
//! carry hooks. So grove's hooks live in a layer the user's `--settings` structurally
//! cannot reach — verified end-to-end, including `PermissionRequest` firing from a plugin
//! hook under a real permission block with a user `--settings` present.
//!
//! The fallback ([`plan_claude_settings`]) exists for a claude too old to have
//! `--plugin-dir` (an unknown flag is a HARD ERROR — it would break the agent, so
//! `tool_hooks` probes for it once and the plugin's existence is the cached answer).
//! There, grove MERGES: the user's object is the base, grove's hook groups are APPENDED
//! per event. Multiple groups under one event all fire, so nobody's hooks are lost.
//!
//! ## Codex: `-c hooks.<Event>=<inline TOML>`
//!
//! See `grove_core::tool_hooks::codex_hook_config_args`.

use std::path::Path;

use grove_core::tool_hooks;
use serde_json::{Map, Value};

/// The full argv tail for the real agent: grove's hook config, then the user's args
/// (with the `--settings` surgery applied when it is needed).
pub fn plan_argv(
    tool: &str,
    user_args: &[String],
    agent_bin: &Path,
    claude_plugin: Option<&Path>,
) -> Vec<String> {
    match tool {
        "claude" => match claude_plugin {
            Some(dir) => {
                let mut argv = vec![
                    "--plugin-dir".to_string(),
                    dir.to_string_lossy().into_owned(),
                ];
                argv.extend_from_slice(user_args);
                argv
            }
            None => plan_claude_settings(user_args, &tool_hooks::claude_hook_groups(agent_bin)),
        },
        "codex" => {
            let mut argv = tool_hooks::codex_hook_config_args(agent_bin);
            argv.extend_from_slice(user_args);
            argv
        }
        // An agent grove does not hook: pass the user's args through untouched. It gets
        // no hooks and therefore (rung C) no badge — but it RUNS. Never break the agent.
        _ => user_args.to_vec(),
    }
}

/// The `--settings` fallback. Rules, each forced by a measurement:
///
/// * The LAST `--settings` is the only one claude honors, and it replaces the whole
///   object — so we never ADD a second one. We rewrite the user's.
/// * A user value may be a PATH or a JSON STRING. Both are accepted by claude; the
///   merged result goes back as a JSON string, so nothing is written to disk and nothing
///   leaks.
/// * A user value we cannot read or parse is passed through UNTOUCHED: claude then prints
///   its own native error (`Settings file not found`) instead of grove silently swallowing
///   the user's intent. No badge, working agent.
pub fn plan_claude_settings(user_args: &[String], groups: &Value) -> Vec<String> {
    let grove_only = || {
        let mut argv = vec![
            "--settings".to_string(),
            Value::Object(hooks_object(groups)).to_string(),
        ];
        argv.extend_from_slice(user_args);
        argv
    };

    let Some(slot) = last_settings_slot(user_args) else {
        return grove_only();
    };

    let raw = match slot {
        Slot::Space(i) => user_args[i + 1].clone(),
        Slot::Eq(i) => user_args[i]["--settings=".len()..].to_string(),
    };
    let Some(base) = load_settings(&raw) else {
        return user_args.to_vec(); // unreadable / not an object — let claude speak
    };

    let merged = merge_hook_groups(base, groups).to_string();
    let mut argv = user_args.to_vec();
    match slot {
        Slot::Space(i) => argv[i + 1] = merged,
        Slot::Eq(i) => argv[i] = format!("--settings={merged}"),
    }
    argv
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    /// `--settings <value>` — the index of the FLAG.
    Space(usize),
    /// `--settings=<value>` — the index of the arg.
    Eq(usize),
}

fn last_settings_slot(args: &[String]) -> Option<Slot> {
    let mut found = None;
    for (i, arg) in args.iter().enumerate() {
        if arg == "--settings" && i + 1 < args.len() {
            found = Some(Slot::Space(i));
        } else if arg.starts_with("--settings=") {
            found = Some(Slot::Eq(i));
        }
    }
    found
}

/// A `--settings` value is either a JSON object or a path to one.
fn load_settings(raw: &str) -> Option<Value> {
    let text = if raw.trim_start().starts_with('{') {
        raw.to_string()
    } else {
        std::fs::read_to_string(raw).ok()?
    };
    let value: Value = serde_json::from_str(&text).ok()?;
    value.is_object().then_some(value)
}

fn hooks_object(groups: &Value) -> Map<String, Value> {
    let mut object = Map::new();
    object.insert("hooks".to_string(), groups.clone());
    object
}

/// APPEND grove's group to each event the user may already hook. Multiple groups under
/// one event ALL fire, so this adds grove's hooks without taking anybody's away.
fn merge_hook_groups(base: Value, groups: &Value) -> Value {
    let Value::Object(mut base) = base else {
        return base;
    };
    let mut hooks = match base.remove("hooks") {
        Some(Value::Object(existing)) => existing,
        _ => Map::new(),
    };
    if let Some(groups) = groups.as_object() {
        for (event, grove_groups) in groups {
            let mut merged = match hooks.remove(event) {
                Some(Value::Array(user_groups)) => user_groups,
                _ => Vec::new(),
            };
            if let Some(grove_groups) = grove_groups.as_array() {
                merged.extend(grove_groups.iter().cloned());
            }
            hooks.insert(event.clone(), Value::Array(merged));
        }
    }
    base.insert("hooks".to_string(), Value::Object(hooks));
    Value::Object(base)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn groups() -> Value {
        tool_hooks::claude_hook_groups(Path::new("/g/grove-agent"))
    }

    fn settings_value(argv: &[String]) -> Value {
        let i = argv.iter().position(|a| a == "--settings").expect("--settings");
        serde_json::from_str(&argv[i + 1]).expect("a JSON settings object")
    }

    #[test]
    fn the_plugin_route_touches_nothing_the_user_passed() {
        let user: Vec<String> = ["--settings", "./mine.json", "-p", "hi"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let argv = plan_argv(
            "claude",
            &user,
            Path::new("/g/grove-agent"),
            Some(Path::new("/h/.grove/plugins/grove-status")),
        );
        assert_eq!(argv[0], "--plugin-dir");
        assert_eq!(argv[1], "/h/.grove/plugins/grove-status");
        // The user's own --settings survives BYTE-FOR-BYTE — a plugin lives in a layer it
        // cannot reach, so there is nothing to merge and nothing to lose.
        assert_eq!(&argv[2..], &user[..]);
    }

    #[test]
    fn without_a_plugin_grove_adds_its_own_settings() {
        let user = vec!["-p".to_string(), "hi".to_string()];
        let argv = plan_claude_settings(&user, &groups());
        assert_eq!(argv[0], "--settings");
        let settings = settings_value(&argv);
        assert_eq!(
            settings["hooks"]["PermissionRequest"][0]["hooks"][0]["command"],
            "'/g/grove-agent' event"
        );
        assert_eq!(&argv[2..], &user[..], "the user's args keep their order");
    }

    /// THE regression this whole route exists for. `--settings` is last-wins on the whole
    /// object, so grove's own `--settings` (the shipping argv put it FIRST) was silently
    /// DISCARDED the moment a user passed theirs — hooks gone, badge dead, no error. And
    /// the naive fix (grove's last) would have destroyed the USER's hooks instead.
    #[test]
    fn a_user_settings_file_is_merged_never_clobbered_and_never_clobbers_us() {
        let dir = std::env::temp_dir().join(format!("grove-hooks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("user.json");
        std::fs::write(
            &path,
            r#"{"env":{"MY":"1"},"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"mine.sh"}]}]}}"#,
        )
        .unwrap();

        let user = vec![
            "--settings".to_string(),
            path.to_string_lossy().into_owned(),
            "-p".to_string(),
            "hi".to_string(),
        ];
        let argv = plan_claude_settings(&user, &groups());

        // Exactly ONE --settings: a second would discard the first, whichever we chose.
        assert_eq!(argv.iter().filter(|a| *a == "--settings").count(), 1);
        let merged = settings_value(&argv);
        // The user's non-hook keys survive…
        assert_eq!(merged["env"]["MY"], "1");
        // …their own SessionStart hook still fires (both groups under one event fire)…
        let session_start = merged["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(session_start.len(), 2);
        assert_eq!(session_start[0]["hooks"][0]["command"], "mine.sh");
        assert_eq!(session_start[1]["hooks"][0]["command"], "'/g/grove-agent' event");
        // …and grove's other events are all present.
        assert_eq!(
            merged["hooks"]["PermissionRequest"][0]["hooks"][0]["command"],
            "'/g/grove-agent' event"
        );
        assert_eq!(argv[argv.len() - 2..], ["-p".to_string(), "hi".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_user_settings_json_string_and_the_eq_form_are_both_rewritten_in_place() {
        // `--settings '<json>'` (the string form)…
        let user = vec![
            "--settings".to_string(),
            r#"{"model":"opus"}"#.to_string(),
        ];
        let merged = settings_value(&plan_claude_settings(&user, &groups()));
        assert_eq!(merged["model"], "opus");
        assert!(merged["hooks"]["Stop"].is_array());

        // …and `--settings=<value>` (the `=` form), which claude also honors and which a
        // naive scanner misses entirely.
        let user = vec![format!("--settings={}", r#"{"model":"opus"}"#)];
        let argv = plan_claude_settings(&user, &groups());
        assert_eq!(argv.len(), 1, "rewritten IN PLACE, not appended");
        let merged: Value =
            serde_json::from_str(argv[0].strip_prefix("--settings=").unwrap()).unwrap();
        assert_eq!(merged["model"], "opus");
        assert!(merged["hooks"]["PermissionRequest"].is_array());
    }

    #[test]
    fn the_last_user_settings_is_the_one_claude_honors_and_the_one_we_rewrite() {
        let user = vec![
            "--settings".to_string(),
            r#"{"model":"first"}"#.to_string(),
            "--settings".to_string(),
            r#"{"model":"last"}"#.to_string(),
        ];
        let argv = plan_claude_settings(&user, &groups());
        // The FIRST one is claude's own casualty (it discards it wholesale) — grove must
        // not "fix" it, and must put its hooks in the one that actually wins.
        assert_eq!(argv[1], r#"{"model":"first"}"#);
        let winner: Value = serde_json::from_str(&argv[3]).unwrap();
        assert_eq!(winner["model"], "last");
        assert!(winner["hooks"]["Stop"].is_array());
    }

    #[test]
    fn an_unreadable_user_settings_is_passed_through_so_claude_can_complain() {
        let user = vec![
            "--settings".to_string(),
            "/nope/does-not-exist.json".to_string(),
        ];
        assert_eq!(
            plan_claude_settings(&user, &groups()),
            user,
            "pass through: claude prints its own error. Grove must not swallow it, and \
             must not add a second --settings that would discard the user's."
        );
    }

    #[test]
    fn codex_gets_its_hook_config_before_the_user_args() {
        let user = vec!["--yolo".to_string()];
        let argv = plan_argv("codex", &user, Path::new("/g/grove-agent"), None);
        assert_eq!(argv[0], "-c");
        assert!(argv[1].starts_with("hooks.SessionStart="));
        assert_eq!(argv.last().unwrap(), "--yolo");
        assert_eq!(argv.iter().filter(|a| *a == "-c").count(), 6);
    }

    #[test]
    fn an_unknown_tool_is_run_exactly_as_the_user_typed_it() {
        let user = vec!["--flag".to_string()];
        assert_eq!(
            plan_argv("aider", &user, &PathBuf::from("/g/grove-agent"), None),
            user
        );
    }
}
