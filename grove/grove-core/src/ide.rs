use crate::IdeMenuItem;
use std::process::{Command, Stdio};
use std::thread;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IdeLaunchPlatform {
    MacOs,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MacOsLaunchTarget {
    AppName(&'static str),
    BundleId(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MenuItemDefinition {
    id: &'static str,
    macos_targets: &'static [MacOsLaunchTarget],
    non_macos_commands: &'static [&'static str],
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchCommand {
    program: String,
    args: Vec<String>,
    display: String,
    wait_for_exit: bool,
}

const XCODE_MACOS_TARGETS: &[MacOsLaunchTarget] = &[
    MacOsLaunchTarget::AppName("Xcode"),
    MacOsLaunchTarget::BundleId("com.apple.dt.Xcode"),
];
const ANDROID_STUDIO_MACOS_TARGETS: &[MacOsLaunchTarget] = &[
    MacOsLaunchTarget::AppName("Android Studio"),
    MacOsLaunchTarget::BundleId("com.google.android.studio"),
    MacOsLaunchTarget::BundleId("com.google.android.studio-EAP"),
    MacOsLaunchTarget::AppName("Android Studio Preview"),
];
const CURSOR_MACOS_TARGETS: &[MacOsLaunchTarget] = &[MacOsLaunchTarget::AppName("Cursor")];
const VSCODE_MACOS_TARGETS: &[MacOsLaunchTarget] =
    &[MacOsLaunchTarget::AppName("Visual Studio Code")];
const SUBLIME_MACOS_TARGETS: &[MacOsLaunchTarget] = &[MacOsLaunchTarget::AppName("Sublime Text")];
const SOURCETREE_MACOS_TARGETS: &[MacOsLaunchTarget] = &[
    MacOsLaunchTarget::AppName("Sourcetree"),
    MacOsLaunchTarget::BundleId("com.torusknot.SourceTreeNotMAS"),
];
const FORK_MACOS_TARGETS: &[MacOsLaunchTarget] = &[
    MacOsLaunchTarget::AppName("Fork"),
    MacOsLaunchTarget::BundleId("com.DanPristupov.Fork"),
];
const WEBSTORM_MACOS_TARGETS: &[MacOsLaunchTarget] = &[
    MacOsLaunchTarget::AppName("WebStorm"),
    MacOsLaunchTarget::BundleId("com.jetbrains.WebStorm"),
];
const INTELLIJ_MACOS_TARGETS: &[MacOsLaunchTarget] = &[
    MacOsLaunchTarget::BundleId("com.jetbrains.intellij"),
    MacOsLaunchTarget::BundleId("com.jetbrains.intellij.ce"),
    MacOsLaunchTarget::AppName("IntelliJ IDEA"),
    MacOsLaunchTarget::AppName("IntelliJ IDEA CE"),
];

const MENU_ITEM_DEFINITIONS: &[MenuItemDefinition] = &[
    MenuItemDefinition {
        id: "webstorm",
        macos_targets: WEBSTORM_MACOS_TARGETS,
        non_macos_commands: &["webstorm"],
    },
    MenuItemDefinition {
        id: "vscode",
        macos_targets: VSCODE_MACOS_TARGETS,
        non_macos_commands: &["code"],
    },
    MenuItemDefinition {
        id: "xcode",
        macos_targets: XCODE_MACOS_TARGETS,
        non_macos_commands: &[],
    },
    MenuItemDefinition {
        id: "android-studio",
        macos_targets: ANDROID_STUDIO_MACOS_TARGETS,
        non_macos_commands: &["studio"],
    },
    MenuItemDefinition {
        id: "intellij",
        macos_targets: INTELLIJ_MACOS_TARGETS,
        non_macos_commands: &["idea", "intellij-idea-ultimate", "intellij-idea-community"],
    },
    MenuItemDefinition {
        id: "cursor",
        macos_targets: CURSOR_MACOS_TARGETS,
        non_macos_commands: &["cursor"],
    },
    MenuItemDefinition {
        id: "sublime",
        macos_targets: SUBLIME_MACOS_TARGETS,
        non_macos_commands: &["subl"],
    },
    MenuItemDefinition {
        id: "sourcetree",
        macos_targets: SOURCETREE_MACOS_TARGETS,
        non_macos_commands: &[],
    },
    MenuItemDefinition {
        id: "fork",
        macos_targets: FORK_MACOS_TARGETS,
        non_macos_commands: &[],
    },
];

pub fn open_in_ide_menu_item(path: &str, ide_menu_item: &IdeMenuItem) -> Result<(), String> {
    let commands = resolve_launch_commands(ide_menu_item, current_platform(), path)?;
    let mut last_error = None;

    for command in commands {
        match spawn_launch_command(&command) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error.unwrap_or_else(|| format!("Failed to launch menu item '{}'", ide_menu_item.id)))
}

fn menu_item_definition(id: &str) -> Option<MenuItemDefinition> {
    MENU_ITEM_DEFINITIONS
        .iter()
        .copied()
        .find(|definition| definition.id == id)
}

fn current_platform() -> IdeLaunchPlatform {
    if cfg!(target_os = "macos") {
        IdeLaunchPlatform::MacOs
    } else {
        IdeLaunchPlatform::Other
    }
}

fn spawn_launch_command(command: &LaunchCommand) -> Result<(), String> {
    if command.wait_for_exit {
        let output = Command::new(&command.program)
            .args(&command.args)
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("Failed to launch IDE with `{}`: {error}", command.display))?;

        if output.status.success() {
            return Ok(());
        }

        let status = output
            .status
            .code()
            .map(|code| format!("exit code {code}"))
            .unwrap_or_else(|| "terminated by signal".to_string());
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return if stderr.is_empty() {
            Err(format!(
                "Failed to launch IDE with `{}`: {status}",
                command.display
            ))
        } else {
            Err(format!(
                "Failed to launch IDE with `{}`: {stderr} ({status})",
                command.display
            ))
        };
    }

    let mut child = Command::new(&command.program)
        .args(&command.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Failed to launch IDE with `{}`: {error}", command.display))?;

    thread::spawn(move || {
        let _ = child.wait();
    });

    Ok(())
}

fn resolve_launch_commands(
    ide_menu_item: &IdeMenuItem,
    platform: IdeLaunchPlatform,
    path: &str,
) -> Result<Vec<LaunchCommand>, String> {
    if let Some(open_command) = ide_menu_item
        .open_command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(vec![parse_open_command(open_command, path)?]);
    }

    match platform {
        IdeLaunchPlatform::MacOs => resolve_macos_launch_commands(ide_menu_item, path),
        IdeLaunchPlatform::Other => resolve_non_macos_launch_commands(ide_menu_item, path),
    }
}

fn resolve_macos_launch_commands(
    ide_menu_item: &IdeMenuItem,
    path: &str,
) -> Result<Vec<LaunchCommand>, String> {
    let definition = menu_item_definition(&ide_menu_item.id)
        .ok_or_else(|| format!("Unsupported menu item '{}'", ide_menu_item.id))?;

    Ok(definition
        .macos_targets
        .iter()
        .map(|target| match target {
            MacOsLaunchTarget::AppName(app_name) => open_app_command(app_name, path),
            MacOsLaunchTarget::BundleId(bundle_id) => open_bundle_command(bundle_id, path),
        })
        .collect())
}

fn resolve_non_macos_launch_commands(
    ide_menu_item: &IdeMenuItem,
    path: &str,
) -> Result<Vec<LaunchCommand>, String> {
    let definition = menu_item_definition(&ide_menu_item.id)
        .ok_or_else(|| format!("Unsupported menu item '{}'", ide_menu_item.id))?;

    if definition.non_macos_commands.is_empty() {
        return Err(format!(
            "Menu item '{}' is only supported on macOS",
            ide_menu_item.id
        ));
    }

    Ok(definition
        .non_macos_commands
        .iter()
        .map(|program| cli_command(program, path))
        .collect())
}

fn open_app_command(app_name: &str, path: &str) -> LaunchCommand {
    LaunchCommand {
        program: "open".into(),
        args: vec!["-a".into(), app_name.into(), path.into()],
        display: format!(r#"open -a "{}""#, app_name),
        wait_for_exit: true,
    }
}

fn open_bundle_command(bundle_id: &str, path: &str) -> LaunchCommand {
    LaunchCommand {
        program: "open".into(),
        args: vec!["-b".into(), bundle_id.into(), path.into()],
        display: format!("open -b {bundle_id}"),
        wait_for_exit: true,
    }
}

fn cli_command(program: &str, path: &str) -> LaunchCommand {
    LaunchCommand {
        program: program.into(),
        args: vec![path.into()],
        display: program.into(),
        wait_for_exit: false,
    }
}

fn parse_open_command(open_command: &str, path: &str) -> Result<LaunchCommand, String> {
    let parts = shlex::split(open_command)
        .ok_or_else(|| format!("Invalid menu item openCommand: {open_command}"))?;
    let (program, args) = parts
        .split_first()
        .ok_or_else(|| "Menu item openCommand cannot be empty".to_string())?;
    let mut full_args = args.to_vec();
    full_args.push(path.to_string());
    Ok(LaunchCommand {
        program: program.clone(),
        args: full_args,
        display: open_command.to_string(),
        wait_for_exit: program == "open",
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_open_command, resolve_launch_commands, IdeLaunchPlatform, LaunchCommand};
    use crate::IdeMenuItem;

    fn ide_menu_item(id: &str) -> IdeMenuItem {
        IdeMenuItem {
            id: id.into(),
            display_name: None,
            open_command: None,
        }
    }

    #[test]
    fn resolve_launch_commands_uses_override_when_present() {
        let item = IdeMenuItem {
            id: "cursor".into(),
            display_name: Some("Cursor".into()),
            open_command: Some("custom-ide --reuse-window".into()),
        };

        assert_eq!(
            resolve_launch_commands(&item, IdeLaunchPlatform::MacOs, "/tmp/project").unwrap(),
            vec![LaunchCommand {
                program: "custom-ide".into(),
                args: vec!["--reuse-window".into(), "/tmp/project".into()],
                display: "custom-ide --reuse-window".into(),
                wait_for_exit: false,
            }]
        );
    }

    #[test]
    fn resolve_launch_commands_supports_xcode_on_macos() {
        assert_eq!(
            resolve_launch_commands(
                &ide_menu_item("xcode"),
                IdeLaunchPlatform::MacOs,
                "/tmp/project"
            )
            .unwrap(),
            vec![
                LaunchCommand {
                    program: "open".into(),
                    args: vec!["-a".into(), "Xcode".into(), "/tmp/project".into()],
                    display: r#"open -a "Xcode""#.into(),
                    wait_for_exit: true,
                },
                LaunchCommand {
                    program: "open".into(),
                    args: vec![
                        "-b".into(),
                        "com.apple.dt.Xcode".into(),
                        "/tmp/project".into()
                    ],
                    display: "open -b com.apple.dt.Xcode".into(),
                    wait_for_exit: true,
                },
            ]
        );
    }

    #[test]
    fn resolve_launch_commands_supports_android_studio_on_macos() {
        assert_eq!(
            resolve_launch_commands(
                &ide_menu_item("android-studio"),
                IdeLaunchPlatform::MacOs,
                "/tmp/project"
            )
            .unwrap(),
            vec![
                LaunchCommand {
                    program: "open".into(),
                    args: vec!["-a".into(), "Android Studio".into(), "/tmp/project".into()],
                    display: r#"open -a "Android Studio""#.into(),
                    wait_for_exit: true,
                },
                LaunchCommand {
                    program: "open".into(),
                    args: vec![
                        "-b".into(),
                        "com.google.android.studio".into(),
                        "/tmp/project".into()
                    ],
                    display: "open -b com.google.android.studio".into(),
                    wait_for_exit: true,
                },
                LaunchCommand {
                    program: "open".into(),
                    args: vec![
                        "-b".into(),
                        "com.google.android.studio-EAP".into(),
                        "/tmp/project".into()
                    ],
                    display: "open -b com.google.android.studio-EAP".into(),
                    wait_for_exit: true,
                },
                LaunchCommand {
                    program: "open".into(),
                    args: vec![
                        "-a".into(),
                        "Android Studio Preview".into(),
                        "/tmp/project".into()
                    ],
                    display: r#"open -a "Android Studio Preview""#.into(),
                    wait_for_exit: true,
                },
            ]
        );
    }

    #[test]
    fn resolve_launch_commands_uses_bundle_candidates_for_intellij_on_macos() {
        assert_eq!(
            resolve_launch_commands(
                &ide_menu_item("intellij"),
                IdeLaunchPlatform::MacOs,
                "/tmp/project"
            )
            .unwrap(),
            vec![
                LaunchCommand {
                    program: "open".into(),
                    args: vec![
                        "-b".into(),
                        "com.jetbrains.intellij".into(),
                        "/tmp/project".into()
                    ],
                    display: "open -b com.jetbrains.intellij".into(),
                    wait_for_exit: true,
                },
                LaunchCommand {
                    program: "open".into(),
                    args: vec![
                        "-b".into(),
                        "com.jetbrains.intellij.ce".into(),
                        "/tmp/project".into()
                    ],
                    display: "open -b com.jetbrains.intellij.ce".into(),
                    wait_for_exit: true,
                },
                LaunchCommand {
                    program: "open".into(),
                    args: vec!["-a".into(), "IntelliJ IDEA".into(), "/tmp/project".into()],
                    display: r#"open -a "IntelliJ IDEA""#.into(),
                    wait_for_exit: true,
                },
                LaunchCommand {
                    program: "open".into(),
                    args: vec![
                        "-a".into(),
                        "IntelliJ IDEA CE".into(),
                        "/tmp/project".into()
                    ],
                    display: r#"open -a "IntelliJ IDEA CE""#.into(),
                    wait_for_exit: true,
                },
            ]
        );
    }

    #[test]
    fn resolve_launch_commands_supports_sourcetree_on_macos() {
        assert_eq!(
            resolve_launch_commands(
                &ide_menu_item("sourcetree"),
                IdeLaunchPlatform::MacOs,
                "/tmp/project"
            )
            .unwrap(),
            vec![
                LaunchCommand {
                    program: "open".into(),
                    args: vec!["-a".into(), "Sourcetree".into(), "/tmp/project".into()],
                    display: r#"open -a "Sourcetree""#.into(),
                    wait_for_exit: true,
                },
                LaunchCommand {
                    program: "open".into(),
                    args: vec![
                        "-b".into(),
                        "com.torusknot.SourceTreeNotMAS".into(),
                        "/tmp/project".into()
                    ],
                    display: "open -b com.torusknot.SourceTreeNotMAS".into(),
                    wait_for_exit: true,
                },
            ]
        );
    }

    #[test]
    fn resolve_launch_commands_supports_fork_on_macos() {
        assert_eq!(
            resolve_launch_commands(
                &ide_menu_item("fork"),
                IdeLaunchPlatform::MacOs,
                "/tmp/project"
            )
            .unwrap(),
            vec![
                LaunchCommand {
                    program: "open".into(),
                    args: vec!["-a".into(), "Fork".into(), "/tmp/project".into()],
                    display: r#"open -a "Fork""#.into(),
                    wait_for_exit: true,
                },
                LaunchCommand {
                    program: "open".into(),
                    args: vec![
                        "-b".into(),
                        "com.DanPristupov.Fork".into(),
                        "/tmp/project".into()
                    ],
                    display: "open -b com.DanPristupov.Fork".into(),
                    wait_for_exit: true,
                },
            ]
        );
    }

    #[test]
    fn resolve_launch_commands_uses_cli_candidates_off_macos() {
        assert_eq!(
            resolve_launch_commands(
                &ide_menu_item("intellij"),
                IdeLaunchPlatform::Other,
                "/tmp/project"
            )
            .unwrap(),
            vec![
                LaunchCommand {
                    program: "idea".into(),
                    args: vec!["/tmp/project".into()],
                    display: "idea".into(),
                    wait_for_exit: false,
                },
                LaunchCommand {
                    program: "intellij-idea-ultimate".into(),
                    args: vec!["/tmp/project".into()],
                    display: "intellij-idea-ultimate".into(),
                    wait_for_exit: false,
                },
                LaunchCommand {
                    program: "intellij-idea-community".into(),
                    args: vec!["/tmp/project".into()],
                    display: "intellij-idea-community".into(),
                    wait_for_exit: false,
                },
            ]
        );
    }

    #[test]
    fn parse_open_command_waits_for_open_exit_status() {
        assert_eq!(
            parse_open_command(r#"open -a "Cursor""#, "/tmp/project").unwrap(),
            LaunchCommand {
                program: "open".into(),
                args: vec!["-a".into(), "Cursor".into(), "/tmp/project".into()],
                display: r#"open -a "Cursor""#.into(),
                wait_for_exit: true,
            }
        );
    }

    #[test]
    fn parse_open_command_supports_quoted_arguments() {
        assert_eq!(
            parse_open_command(
                r#"open -a "Visual Studio Code" --new-window"#,
                "/tmp/project"
            )
            .unwrap(),
            LaunchCommand {
                program: "open".into(),
                args: vec![
                    "-a".into(),
                    "Visual Studio Code".into(),
                    "--new-window".into(),
                    "/tmp/project".into(),
                ],
                display: r#"open -a "Visual Studio Code" --new-window"#.into(),
                wait_for_exit: true,
            }
        );
    }
}
