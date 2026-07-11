mod browser;
mod browser_cookie_inject;
mod dev_permissions;
mod eventbus;
use grove_core::{
    AppConfig, AppliedPtySize, BehindInfo, CloningProject, CommitInfo, CreatePtyRequest,
    CreatePtyRestore,
    CreatePtyResult, DeepDirectoryListing, DetectedThemeResult, DirectoryFileEntry, FileDiff,
    FileStatus, WorkspaceFileContent,
    GrovePreferences, IdeMenuItem, Project, PtyBellEvent, SaveTerminalSessionSnapshotRequest,
    TerminalGcReport, TerminalSessionSnapshot, Worktree, WorktreePullRequest,
};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

// === Async helper ===

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

// === CONFIG/THEME COMMANDS (W1) ===

#[tauri::command]
async fn get_terminal_theme() -> Result<DetectedThemeResult, String> {
    blocking(|| Ok(grove_core::terminal_theme::detect_terminal_theme())).await
}

#[tauri::command]
async fn get_app_config() -> Result<AppConfig, String> {
    blocking(|| Ok(grove_core::config::get_app_config_impl())).await
}

#[tauri::command]
async fn get_grove_preferences() -> Result<GrovePreferences, String> {
    blocking(|| Ok(grove_core::config::get_grove_preferences_impl())).await
}

#[tauri::command]
async fn get_process_env_diagnostics(
) -> Result<grove_core::process_env::ProcessEnvDiagnostics, String> {
    blocking(|| Ok(grove_core::process_env::process_env_diagnostics())).await
}

#[tauri::command]
async fn save_app_config(config: AppConfig) -> Result<(), String> {
    blocking(move || grove_core::config::save_app_config(&config)).await
}

#[tauri::command]
async fn save_grove_preferences(preferences: GrovePreferences) -> Result<(), String> {
    blocking(move || grove_core::config::save_grove_preferences(&preferences)).await
}

#[tauri::command]
async fn save_terminal_layouts(layouts: String) -> Result<(), String> {
    blocking(move || grove_core::config::save_terminal_layouts_impl(&layouts)).await
}

#[tauri::command]
async fn load_terminal_layouts() -> Result<String, String> {
    blocking(grove_core::config::load_terminal_layouts_impl).await
}

#[tauri::command]
async fn save_panel_layouts(layouts: String) -> Result<(), String> {
    blocking(move || grove_core::config::save_panel_layouts_impl(&layouts)).await
}

#[tauri::command]
async fn load_panel_layouts() -> Result<String, String> {
    blocking(grove_core::config::load_panel_layouts_impl).await
}

#[tauri::command]
async fn save_ui_state(state: String) -> Result<(), String> {
    blocking(move || grove_core::config::save_ui_state_impl(&state)).await
}

#[tauri::command]
async fn load_ui_state() -> Result<String, String> {
    blocking(grove_core::config::load_ui_state_impl).await
}

// === GIT PROJECT COMMANDS (W2) ===

#[tauri::command]
async fn list_projects() -> Result<Vec<Project>, String> {
    blocking(grove_core::git_project::list_projects_impl).await
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum StartCloneResult {
    Cloning(CloningProject),
    AlreadyExists(grove_core::Project),
}

#[tauri::command]
async fn start_clone(
    app_handle: tauri::AppHandle,
    url: String,
) -> Result<StartCloneResult, String> {
    let clone_url = url.clone();
    let outcome = blocking(move || grove_core::git_project::start_clone_impl(&clone_url)).await?;

    match outcome {
        grove_core::StartCloneOutcome::AlreadyExists(project) => {
            Ok(StartCloneResult::AlreadyExists(project))
        }
        grove_core::StartCloneOutcome::Cloning(cloning) => {
            let id = cloning.id.clone();
            let bg_url = url.clone();
            let handle = app_handle.clone();

            tokio::task::spawn_blocking(move || {
                match grove_core::git_project::run_clone_impl(&bg_url) {
                    Ok(project) => {
                        let payload = eventbus::CloneCompletedPayload { id, project };
                        let _ = handle.emit("grove:clone-completed", payload);
                    }
                    Err(error) => {
                        let payload = eventbus::CloneFailedPayload { id, error };
                        let _ = handle.emit("grove:clone-failed", payload);
                    }
                }
            });

            Ok(StartCloneResult::Cloning(cloning))
        }
    }
}

#[tauri::command]
async fn create_project(name: String, path: String) -> Result<Project, String> {
    blocking(move || grove_core::git_project::create_project_impl(&name, &path)).await
}

#[tauri::command]
async fn remove_project(id: String) -> Result<(), String> {
    blocking(move || grove_core::git_project::remove_project_impl(&id)).await
}

#[tauri::command]
async fn reorder_projects(project_ids: Vec<String>) -> Result<(), String> {
    blocking(move || grove_core::git_project::reorder_projects_impl(project_ids)).await
}

#[tauri::command]
async fn rename_project(project_id: String, name: String) -> Result<(), String> {
    blocking(move || grove_core::git_project::rename_project_impl(&project_id, name)).await
}

#[tauri::command]
async fn set_project_category(project_id: String, category_id: String) -> Result<(), String> {
    blocking(move || grove_core::git_project::set_project_category_impl(&project_id, &category_id))
        .await
}

#[tauri::command]
async fn delete_project_category(category_id: String) -> Result<(), String> {
    blocking(move || grove_core::git_project::delete_project_category_impl(&category_id)).await
}

#[tauri::command]
async fn set_project_collapsed(project_id: String, collapsed: bool) -> Result<(), String> {
    blocking(move || grove_core::git_project::set_project_collapsed_impl(&project_id, collapsed))
        .await
}

#[tauri::command]
async fn set_project_focus(project_id: String, focused: bool) -> Result<(), String> {
    blocking(move || grove_core::git_project::set_project_focus_impl(&project_id, focused)).await
}

#[tauri::command]
async fn is_source_dirty(project_id: String) -> Result<bool, String> {
    blocking(move || grove_core::git_project::is_source_dirty_impl(&project_id)).await
}

#[tauri::command]
async fn refresh_project(project_id: String) -> Result<Project, String> {
    blocking(move || grove_core::git_project::refresh_project_impl(&project_id)).await
}

#[tauri::command]
async fn add_worktree(
    project_id: String,
    name: String,
    _branch: String,
) -> Result<Worktree, String> {
    blocking(move || grove_core::git_project::add_worktree_impl(&project_id, &name)).await
}

#[tauri::command]
async fn add_stacked_worktree(
    project_id: String,
    parent_name: String,
    name: String,
) -> Result<Worktree, String> {
    blocking(move || {
        grove_core::git_project::add_stacked_worktree_impl(&project_id, &parent_name, &name)
    })
    .await
}

#[tauri::command]
async fn remove_worktree(project_id: String, name: String) -> Result<(), String> {
    blocking(move || grove_core::git_project::remove_worktree_impl(&project_id, &name)).await
}

#[tauri::command]
async fn list_worktrees(project_id: String) -> Result<Vec<Worktree>, String> {
    blocking(move || grove_core::git_project::list_worktrees_impl(&project_id)).await
}

#[tauri::command]
async fn get_worktree_pr_url(worktree_path: String) -> Result<Option<WorktreePullRequest>, String> {
    blocking(move || grove_core::git_project::get_worktree_pr_url_impl(&worktree_path)).await
}

#[tauri::command]
async fn create_worktree_pr(worktree_path: String) -> Result<(), String> {
    blocking(move || grove_core::git_project::create_worktree_pr_impl(&worktree_path)).await
}

#[tauri::command]
async fn set_worktree_order(project_id: String, order: Vec<String>) -> Result<(), String> {
    blocking(move || grove_core::git_project::set_worktree_order_impl(&project_id, order)).await
}

#[tauri::command]
async fn get_remote_branches(project_id: String) -> Result<Vec<String>, String> {
    blocking(move || grove_core::git_project::get_remote_branches_impl(&project_id)).await
}

#[tauri::command]
async fn set_base_branch(project_id: String, branch: Option<String>) -> Result<(), String> {
    blocking(move || grove_core::git_project::set_base_branch_impl(&project_id, branch)).await
}

#[tauri::command]
async fn set_env_sync(
    project_id: String,
    config: grove_core::config::ProjectEnvSyncConfig,
) -> Result<(), String> {
    blocking(move || grove_core::git_project::set_env_sync_impl(&project_id, config)).await
}

#[tauri::command]
async fn get_env_sync(
    project_id: String,
) -> Result<Option<grove_core::config::ProjectEnvSyncConfig>, String> {
    blocking(move || grove_core::git_project::get_env_sync_impl(&project_id)).await
}

#[tauri::command]
async fn list_gitignore_patterns(project_id: String) -> Result<Vec<String>, String> {
    blocking(move || grove_core::git_project::list_gitignore_patterns_impl(&project_id)).await
}

// === MISSION COMMANDS (W5) ===

#[tauri::command]
async fn list_missions() -> Result<Vec<grove_core::mission::Mission>, String> {
    blocking(|| Ok(grove_core::mission::load_missions().missions)).await
}

#[tauri::command]
async fn create_mission(
    name: String,
    branch_name: Option<String>,
) -> Result<grove_core::mission::Mission, String> {
    blocking(move || grove_core::mission::create_mission(&name, branch_name)).await
}

#[tauri::command]
async fn delete_mission(id: String) -> Result<(), String> {
    blocking(move || grove_core::mission::delete_mission(&id)).await
}

#[tauri::command]
async fn set_mission_collapsed(mission_id: String, collapsed: bool) -> Result<(), String> {
    blocking(move || grove_core::mission::set_mission_collapsed(&mission_id, collapsed)).await
}

#[tauri::command]
async fn add_project_to_mission(
    mission_id: String,
    project_id: String,
) -> Result<grove_core::mission::MissionProject, String> {
    blocking(move || grove_core::mission::add_project_to_mission(&mission_id, &project_id)).await
}

#[tauri::command]
async fn remove_project_from_mission(mission_id: String, project_id: String) -> Result<(), String> {
    blocking(move || grove_core::mission::remove_project_from_mission(&mission_id, &project_id))
        .await
}

// === NOTE COMMANDS ===

#[tauri::command]
async fn list_notes() -> Result<std::collections::HashMap<String, String>, String> {
    blocking(|| Ok(grove_core::note::load_notes()?.notes)).await
}

#[tauri::command]
async fn save_note(key: String, content: String) -> Result<(), String> {
    blocking(move || grove_core::note::save_note(&key, &content)).await
}

#[tauri::command]
async fn delete_note(key: String) -> Result<(), String> {
    blocking(move || grove_core::note::delete_note(&key)).await
}

#[tauri::command]
async fn open_external(url: String) -> Result<(), String> {
    blocking(move || {
        webbrowser::open(&url)
            .map(|_| ())
            .map_err(|e| format!("Failed to open URL: {e}"))
    })
    .await
}

#[tauri::command]
async fn reveal_in_finder(path: String) -> Result<(), String> {
    blocking(move || {
        std::process::Command::new("open")
            .arg(&path)
            .status()
            .map(|_| ())
            .map_err(|e| format!("Failed to reveal path: {e}"))
    })
    .await
}

#[tauri::command]
async fn open_in_ide(path: String, ide_menu_item: IdeMenuItem) -> Result<(), String> {
    blocking(move || grove_core::ide::open_in_ide_menu_item(&path, &ide_menu_item)).await
}

#[tauri::command]
async fn open_dev_console(window: tauri::WebviewWindow) -> Result<(), String> {
    window.open_devtools();
    Ok(())
}

#[tauri::command]
async fn reload_app_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.reload().map_err(|e| e.to_string())
}

// === PTY COMMANDS (W3) ===

#[tauri::command]
async fn create_pty(
    on_output: tauri::ipc::Channel,
    pty_id: String,
    pane_id: String,
    worktree_path: String,
    cwd: String,
    cols: u16,
    rows: u16,
    restore: Option<CreatePtyRestore>,
) -> Result<CreatePtyResult, String> {
    let request = CreatePtyRequest {
        pty_id,
        pane_id,
        worktree_path,
        cwd,
        cols,
        rows,
        restore,
    };
    let sink = eventbus::pty_sink(on_output);

    blocking(move || grove_core::pty::create(request, sink)).await
}

// Input arrives as a raw octet-stream body (a nested Uint8Array degrades to a
// JSON number array under Tauri's serializer), so the bytes are the whole
// payload and the ptyId rides the `pty-id` header. Returning a `Result` is
// required for an async command that borrows a reference arg (`Request`).
#[tauri::command]
async fn write_pty(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let id = request
        .headers()
        .get("pty-id")
        .and_then(|value| value.to_str().ok())
        .ok_or("write_pty: missing pty-id header")?
        .to_string();
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("write_pty: expected a raw byte body".to_string());
        }
    };

    blocking(move || grove_core::pty::write(&id, &data)).await
}

#[tauri::command]
async fn resize_pty(id: String, cols: u16, rows: u16) -> Result<(), String> {
    blocking(move || grove_core::pty::resize(&id, cols, rows)).await
}

#[tauri::command]
async fn applied_pty_size(id: String) -> Result<Option<AppliedPtySize>, String> {
    blocking(move || grove_core::pty::applied_pty_size(&id)).await
}

#[tauri::command]
async fn clear_pty_scrollback(pty_id: String) -> Result<(), String> {
    blocking(move || grove_core::pty::clear_scrollback(&pty_id)).await
}

#[tauri::command]
async fn close_pty(pty_id: String) -> Result<(), String> {
    blocking(move || grove_core::pty::close(&pty_id)).await
}

#[tauri::command]
async fn poll_pty_bells() -> Result<Vec<PtyBellEvent>, String> {
    blocking(grove_core::pty::poll_bell_events).await
}

#[tauri::command]
async fn save_terminal_session_snapshot(
    snapshot: SaveTerminalSessionSnapshotRequest,
) -> Result<TerminalSessionSnapshot, String> {
    blocking(move || grove_core::pty::save_terminal_session_snapshot(snapshot)).await
}

#[tauri::command]
async fn load_terminal_session_snapshot(
    worktree_path: String,
) -> Result<Option<TerminalSessionSnapshot>, String> {
    blocking(move || grove_core::pty::load_terminal_session_snapshot(&worktree_path)).await
}

#[tauri::command]
async fn run_terminal_gc(dry_run: bool) -> Result<TerminalGcReport, String> {
    blocking(move || grove_core::pty::run_terminal_gc(dry_run)).await
}

// === GIT DIFF COMMANDS (W4) ===

#[tauri::command]
async fn get_status(worktree_path: String) -> Result<Vec<FileStatus>, String> {
    blocking(move || grove_core::git_diff::get_status_impl(&worktree_path)).await
}

#[tauri::command]
async fn list_directory_files(
    root_path: String,
    parent_path: Option<String>,
) -> Result<Vec<DirectoryFileEntry>, String> {
    blocking(move || {
        grove_core::file_browser::list_directory_files_impl(&root_path, parent_path.as_deref())
    })
    .await
}

#[tauri::command]
async fn list_directory_files_deep(root_path: String) -> Result<DeepDirectoryListing, String> {
    blocking(move || grove_core::file_browser::list_directory_files_deep_impl(&root_path)).await
}

#[tauri::command]
async fn read_workspace_file(
    root_path: String,
    file_path: String,
) -> Result<WorkspaceFileContent, String> {
    blocking(move || grove_core::file_browser::read_workspace_file_impl(&root_path, &file_path))
        .await
}

#[tauri::command]
async fn get_commits(worktree_path: String, limit: u32) -> Result<Vec<CommitInfo>, String> {
    blocking(move || grove_core::git_diff::get_commits_impl(&worktree_path, limit)).await
}

#[tauri::command]
async fn get_working_diff(worktree_path: String, path: String) -> Result<FileDiff, String> {
    blocking(move || grove_core::git_diff::get_working_diff_impl(&worktree_path, &path)).await
}

#[tauri::command]
async fn get_commit_diff(worktree_path: String, hash: String) -> Result<Vec<FileDiff>, String> {
    blocking(move || grove_core::git_diff::get_commit_diff_impl(&worktree_path, &hash)).await
}

#[tauri::command]
async fn get_working_diff_context(
    worktree_path: String,
    path: String,
    start_line: u32,
    line_count: u32,
) -> Result<Vec<String>, String> {
    blocking(move || {
        grove_core::git_diff::get_working_diff_context_impl(
            &worktree_path,
            &path,
            start_line,
            line_count,
        )
    })
    .await
}

#[tauri::command]
async fn get_commit_diff_context(
    worktree_path: String,
    hash: String,
    path: String,
    old_path: Option<String>,
    start_line: u32,
    line_count: u32,
) -> Result<Vec<String>, String> {
    blocking(move || {
        grove_core::git_diff::get_commit_diff_context_impl(
            &worktree_path,
            &hash,
            &path,
            old_path.as_deref(),
            start_line,
            line_count,
        )
    })
    .await
}

#[tauri::command]
async fn stage_file(worktree_path: String, path: String) -> Result<(), String> {
    blocking(move || grove_core::git_diff::stage_file_impl(&worktree_path, &path)).await
}

#[tauri::command]
async fn stage_files(worktree_path: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || grove_core::git_diff::stage_files_impl(&worktree_path, &paths)).await
}

#[tauri::command]
async fn unstage_file(worktree_path: String, path: String) -> Result<(), String> {
    blocking(move || grove_core::git_diff::unstage_file_impl(&worktree_path, &path)).await
}

#[tauri::command]
async fn unstage_files(worktree_path: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || grove_core::git_diff::unstage_files_impl(&worktree_path, &paths)).await
}

#[tauri::command]
async fn discard_file(worktree_path: String, path: String) -> Result<(), String> {
    blocking(move || grove_core::git_diff::discard_file_impl(&worktree_path, &path)).await
}

#[tauri::command]
async fn discard_files(worktree_path: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || grove_core::git_diff::discard_files_impl(&worktree_path, &paths)).await
}

#[tauri::command]
async fn remove_untracked_files(worktree_path: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || grove_core::git_diff::remove_untracked_files_impl(&worktree_path, &paths))
        .await
}

#[tauri::command]
async fn stage_hunk(worktree_path: String, path: String, hunk_index: u32) -> Result<(), String> {
    blocking(move || grove_core::git_diff::stage_hunk_impl(&worktree_path, &path, hunk_index)).await
}

#[tauri::command]
async fn unstage_hunk(worktree_path: String, path: String, hunk_index: u32) -> Result<(), String> {
    blocking(move || grove_core::git_diff::unstage_hunk_impl(&worktree_path, &path, hunk_index))
        .await
}

#[tauri::command]
async fn discard_hunk(worktree_path: String, path: String, hunk_index: u32) -> Result<(), String> {
    blocking(move || grove_core::git_diff::discard_hunk_impl(&worktree_path, &path, hunk_index))
        .await
}

#[tauri::command]
async fn stage_lines(
    worktree_path: String,
    path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
) -> Result<(), String> {
    blocking(move || {
        grove_core::git_diff::stage_lines_impl(&worktree_path, &path, hunk_index, &line_indices)
    })
    .await
}

#[tauri::command]
async fn unstage_lines(
    worktree_path: String,
    path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
) -> Result<(), String> {
    blocking(move || {
        grove_core::git_diff::unstage_lines_impl(&worktree_path, &path, hunk_index, &line_indices)
    })
    .await
}

#[tauri::command]
async fn discard_lines(
    worktree_path: String,
    path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
) -> Result<(), String> {
    blocking(move || {
        grove_core::git_diff::discard_lines_impl(&worktree_path, &path, hunk_index, &line_indices)
    })
    .await
}

// === GIT MERGE COMMANDS ===

#[tauri::command]
async fn get_behind_count(worktree_path: String) -> Result<BehindInfo, String> {
    blocking(move || grove_core::git_diff::get_behind_count_impl(&worktree_path)).await
}

#[tauri::command]
async fn merge_default_branch(worktree_path: String) -> Result<(), String> {
    blocking(move || grove_core::git_diff::merge_default_branch_impl(&worktree_path)).await
}

// === APP SETUP ===

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            // Config/Theme (W1)
            get_terminal_theme,
            get_app_config,
            get_grove_preferences,
            get_process_env_diagnostics,
            save_app_config,
            save_grove_preferences,
            save_terminal_layouts,
            load_terminal_layouts,
            save_panel_layouts,
            load_panel_layouts,
            save_ui_state,
            load_ui_state,
            // Git Project (W2)
            list_projects,
            start_clone,
            create_project,
            remove_project,
            reorder_projects,
            rename_project,
            set_project_category,
            delete_project_category,
            set_project_collapsed,
            set_project_focus,
            is_source_dirty,
            refresh_project,
            add_worktree,
            add_stacked_worktree,
            remove_worktree,
            list_worktrees,
            get_worktree_pr_url,
            create_worktree_pr,
            set_worktree_order,
            get_remote_branches,
            set_base_branch,
            set_env_sync,
            get_env_sync,
            list_gitignore_patterns,
            // Mission (W5)
            list_missions,
            create_mission,
            delete_mission,
            set_mission_collapsed,
            add_project_to_mission,
            remove_project_from_mission,
            // Note
            list_notes,
            save_note,
            delete_note,
            open_external,
            reveal_in_finder,
            open_in_ide,
            open_dev_console,
            reload_app_window,
            // PTY (W3)
            create_pty,
            write_pty,
            resize_pty,
            applied_pty_size,
            clear_pty_scrollback,
            close_pty,
            poll_pty_bells,
            save_terminal_session_snapshot,
            load_terminal_session_snapshot,
            run_terminal_gc,
            // Git Diff (W4)
            get_status,
            list_directory_files,
            list_directory_files_deep,
            read_workspace_file,
            get_commits,
            get_working_diff,
            get_commit_diff,
            get_working_diff_context,
            get_commit_diff_context,
            stage_file,
            stage_files,
            unstage_file,
            unstage_files,
            discard_file,
            discard_files,
            remove_untracked_files,
            stage_hunk,
            unstage_hunk,
            discard_hunk,
            stage_lines,
            unstage_lines,
            discard_lines,
            // Git Merge
            get_behind_count,
            merge_default_branch,
            // Browser (native webview tabs)
            browser::browser_create,
            browser::browser_navigate,
            browser::browser_go_back,
            browser::browser_go_forward,
            browser::browser_reload,
            browser::browser_set_grab_mode,
            browser::browser_find,
            browser::browser_stop_find,
            browser::browser_set_bounds,
            browser::browser_set_visible,
            browser::browser_close,
            browser::browser_close_all,
            browser::browser_open_devtools,
            browser::detect_installed_browsers,
            browser::browser_import_cookies,
            // Dev Permissions
            dev_permissions::dev_permissions_status,
            dev_permissions::dev_permissions_request,
        ])
        .manage(browser::BrowserState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Why: advertise the real app version as TERM_PROGRAM_VERSION in spawned
            // terminals. Set before any PTY create so panes never fall back.
            grove_core::set_app_version(&app.package_info().version.to_string());
            grove_core::pty::install_panic_hook();
            grove_core::tool_hooks::ensure_installed();
            if let Err(error) = grove_core::pty::cleanup_stale_tmux_sessions_on_startup() {
                eprintln!(
                    "Warning: failed to clean up stale Grove tmux sessions on startup: {error}"
                );
            }
            eventbus::init(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                grove_core::url_open::cleanup();
            }
        });
}
