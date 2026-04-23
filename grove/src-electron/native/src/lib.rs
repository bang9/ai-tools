use base64::Engine as _;
use napi::{
    bindgen_prelude::{Buffer, Error, Result},
    threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use serde::{de::DeserializeOwned, Serialize};
use std::{fmt::Display, sync::Arc};

#[napi(object)]
#[derive(Clone)]
pub struct PtyOutputPayload {
    pub id: String,
    pub data: String,
}

struct NapiEventSink {
    callback: ThreadsafeFunction<PtyOutputPayload>,
}

impl grove_core::PtyEventSink for NapiEventSink {
    fn on_output(&self, pty_id: &str, data: &[u8]) {
        let payload = PtyOutputPayload {
            id: pty_id.to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(data),
        };
        let _ = self
            .callback
            .call(Ok(payload), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

fn napi_error<E>(error: E) -> Error
where
    E: Display,
{
    Error::from_reason(error.to_string())
}

async fn blocking<T, F>(operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(napi_error)?
}

async fn blocking_core<T, F>(operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> std::result::Result<T, String> + Send + 'static,
{
    blocking(move || operation().map_err(napi_error)).await
}

async fn blocking_json<T, F>(operation: F) -> Result<String>
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> std::result::Result<T, String> + Send + 'static,
{
    let value = blocking_core(operation).await?;
    to_json(&value)
}

async fn blocking_optional_json<T, F>(operation: F) -> Result<Option<String>>
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> std::result::Result<Option<T>, String> + Send + 'static,
{
    let value = blocking_core(operation).await?;
    value.map(|inner| to_json(&inner)).transpose()
}

fn to_json<T>(value: &T) -> Result<String>
where
    T: Serialize,
{
    serde_json::to_string(value).map_err(napi_error)
}

fn from_json<T>(raw: &str, label: &str) -> Result<T>
where
    T: DeserializeOwned,
{
    serde_json::from_str(raw)
        .map_err(|error| Error::from_reason(format!("Failed to parse {label}: {error}")))
}

#[napi]
pub async fn get_terminal_theme() -> Result<String> {
    blocking_json(|| Ok(grove_core::terminal_theme::detect_terminal_theme())).await
}

#[napi]
pub async fn get_app_config() -> Result<String> {
    blocking_json(|| Ok(grove_core::config::get_app_config_impl())).await
}

#[napi]
pub async fn get_grove_preferences() -> Result<String> {
    blocking_json(|| Ok(grove_core::config::get_grove_preferences_impl())).await
}

#[napi]
pub async fn get_process_env_diagnostics() -> Result<String> {
    blocking_json(|| Ok(grove_core::process_env::process_env_diagnostics())).await
}

#[napi]
pub async fn save_app_config(config: String) -> Result<()> {
    let config = from_json::<grove_core::AppConfig>(&config, "AppConfig")?;
    blocking_core(move || grove_core::config::save_app_config(&config)).await
}

#[napi]
pub async fn save_grove_preferences(preferences: String) -> Result<()> {
    let preferences = from_json::<grove_core::GrovePreferences>(&preferences, "GrovePreferences")?;
    blocking_core(move || grove_core::config::save_grove_preferences(&preferences)).await
}

#[napi]
pub async fn open_in_ide(path: String, ide_menu_item: String) -> Result<()> {
    let ide_menu_item = from_json::<grove_core::IdeMenuItem>(&ide_menu_item, "IdeMenuItem")?;
    blocking_core(move || grove_core::ide::open_in_ide_menu_item(&path, &ide_menu_item)).await
}

#[napi]
pub async fn save_terminal_layouts(layouts: String) -> Result<()> {
    blocking_core(move || grove_core::config::save_terminal_layouts_impl(&layouts)).await
}

#[napi]
pub async fn load_terminal_layouts() -> Result<String> {
    blocking_core(grove_core::config::load_terminal_layouts_impl).await
}

#[napi]
pub async fn save_panel_layouts(layouts: String) -> Result<()> {
    blocking_core(move || grove_core::config::save_panel_layouts_impl(&layouts)).await
}

#[napi]
pub async fn load_panel_layouts() -> Result<String> {
    blocking_core(grove_core::config::load_panel_layouts_impl).await
}

#[napi]
pub async fn run_terminal_gc(dry_run: bool) -> Result<String> {
    blocking_json(move || grove_core::pty::run_terminal_gc(dry_run)).await
}

#[napi]
pub async fn list_projects() -> Result<String> {
    blocking_json(grove_core::git_project::list_projects_impl).await
}

#[napi]
pub async fn add_project(url: String) -> Result<String> {
    blocking_json(move || grove_core::git_project::add_project_impl(&url)).await
}

#[napi]
pub async fn create_project(name: String, path: String) -> Result<String> {
    blocking_json(move || grove_core::git_project::create_project_impl(&name, &path)).await
}

#[napi]
pub async fn remove_project(id: String) -> Result<()> {
    blocking_core(move || grove_core::git_project::remove_project_impl(&id)).await
}

#[napi]
pub async fn reorder_projects(project_ids: Vec<String>) -> Result<()> {
    blocking_core(move || grove_core::git_project::reorder_projects_impl(project_ids)).await
}

#[napi]
pub async fn rename_project(project_id: String, name: String) -> Result<()> {
    blocking_core(move || grove_core::git_project::rename_project_impl(&project_id, name)).await
}

#[napi]
pub async fn set_project_category(project_id: String, category_id: String) -> Result<()> {
    blocking_core(move || {
        grove_core::git_project::set_project_category_impl(&project_id, &category_id)
    })
    .await
}

#[napi]
pub async fn delete_project_category(category_id: String) -> Result<()> {
    blocking_core(move || grove_core::git_project::delete_project_category_impl(&category_id)).await
}

#[napi]
pub async fn set_project_collapsed(project_id: String, collapsed: bool) -> Result<()> {
    blocking_core(move || {
        grove_core::git_project::set_project_collapsed_impl(&project_id, collapsed)
    })
    .await
}

#[napi]
pub async fn is_source_dirty(project_id: String) -> Result<bool> {
    blocking_core(move || grove_core::git_project::is_source_dirty_impl(&project_id)).await
}

#[napi]
pub async fn refresh_project(project_id: String) -> Result<String> {
    blocking_json(move || grove_core::git_project::refresh_project_impl(&project_id)).await
}

#[napi]
pub async fn add_worktree(project_id: String, name: String, _branch: String) -> Result<String> {
    blocking_json(move || grove_core::git_project::add_worktree_impl(&project_id, &name)).await
}

#[napi]
pub async fn remove_worktree(project_id: String, name: String) -> Result<()> {
    blocking_core(move || grove_core::git_project::remove_worktree_impl(&project_id, &name)).await
}

#[napi]
pub async fn list_worktrees(project_id: String) -> Result<String> {
    blocking_json(move || grove_core::git_project::list_worktrees_impl(&project_id)).await
}

#[napi]
pub async fn get_worktree_pr_url(worktree_path: String) -> Result<Option<String>> {
    blocking_optional_json(move || {
        grove_core::git_project::get_worktree_pr_url_impl(&worktree_path)
    })
    .await
}

#[napi]
pub async fn create_worktree_pr(worktree_path: String) -> Result<()> {
    blocking_core(move || grove_core::git_project::create_worktree_pr_impl(&worktree_path)).await
}

#[napi]
pub async fn set_worktree_order(project_id: String, order: Vec<String>) -> Result<()> {
    blocking_core(move || grove_core::git_project::set_worktree_order_impl(&project_id, order))
        .await
}

#[napi]
pub async fn get_remote_branches(project_id: String) -> Result<String> {
    blocking_json(move || grove_core::git_project::get_remote_branches_impl(&project_id)).await
}

#[napi]
pub async fn set_base_branch(project_id: String, branch: Option<String>) -> Result<()> {
    blocking_core(move || grove_core::git_project::set_base_branch_impl(&project_id, branch)).await
}

#[napi]
pub async fn set_env_sync(project_id: String, config: String) -> Result<()> {
    let config = from_json::<grove_core::ProjectEnvSyncConfig>(&config, "ProjectEnvSyncConfig")?;
    blocking_core(move || grove_core::git_project::set_env_sync_impl(&project_id, config)).await
}

#[napi]
pub async fn get_env_sync(project_id: String) -> Result<Option<String>> {
    blocking_optional_json(move || grove_core::git_project::get_env_sync_impl(&project_id)).await
}

#[napi]
pub async fn list_gitignore_patterns(project_id: String) -> Result<String> {
    blocking_json(move || grove_core::git_project::list_gitignore_patterns_impl(&project_id)).await
}

#[napi]
pub async fn create_pty(
    pty_id: String,
    pane_id: String,
    worktree_path: String,
    cwd: String,
    cols: u16,
    rows: u16,
    restore: Option<String>,
    on_output: ThreadsafeFunction<PtyOutputPayload>,
) -> Result<String> {
    let restore = restore
        .as_deref()
        .map(|raw| from_json::<grove_core::CreatePtyRestore>(raw, "CreatePtyRestore"))
        .transpose()?;

    let request = grove_core::CreatePtyRequest {
        pty_id,
        pane_id,
        worktree_path,
        cwd,
        cols,
        rows,
        restore,
    };
    let sink: Arc<dyn grove_core::PtyEventSink> = Arc::new(NapiEventSink {
        callback: on_output,
    });

    blocking_json(move || grove_core::pty::create(request, sink)).await
}

#[napi]
pub async fn write_pty(id: String, data: Buffer) -> Result<()> {
    let data = data.to_vec();
    blocking_core(move || grove_core::pty::write(&id, &data)).await
}

#[napi]
pub async fn resize_pty(id: String, cols: u16, rows: u16) -> Result<()> {
    blocking_core(move || grove_core::pty::resize(&id, cols, rows)).await
}

#[napi]
pub async fn clear_pty_scrollback(pty_id: String) -> Result<()> {
    blocking_core(move || grove_core::pty::clear_scrollback(&pty_id)).await
}

#[napi]
pub async fn close_pty(pty_id: String) -> Result<()> {
    blocking_core(move || grove_core::pty::close(&pty_id)).await
}

#[napi]
pub async fn poll_pty_bells() -> Result<String> {
    blocking_json(grove_core::pty::poll_bell_events).await
}

#[napi]
pub async fn save_terminal_session_snapshot(snapshot: String) -> Result<String> {
    let snapshot = from_json::<grove_core::SaveTerminalSessionSnapshotRequest>(
        &snapshot,
        "SaveTerminalSessionSnapshotRequest",
    )?;
    blocking_json(move || grove_core::pty::save_terminal_session_snapshot(snapshot)).await
}

#[napi]
pub async fn load_terminal_session_snapshot(worktree_path: String) -> Result<Option<String>> {
    blocking_optional_json(move || grove_core::pty::load_terminal_session_snapshot(&worktree_path))
        .await
}

#[napi]
pub async fn get_status(worktree_path: String) -> Result<String> {
    blocking_json(move || grove_core::git_diff::get_status_impl(&worktree_path)).await
}

#[napi]
pub async fn get_commits(worktree_path: String, limit: u32) -> Result<String> {
    blocking_json(move || grove_core::git_diff::get_commits_impl(&worktree_path, limit)).await
}

#[napi]
pub async fn get_working_diff(worktree_path: String, path: String) -> Result<String> {
    blocking_json(move || grove_core::git_diff::get_working_diff_impl(&worktree_path, &path)).await
}

#[napi]
pub async fn get_commit_diff(worktree_path: String, hash: String) -> Result<String> {
    blocking_json(move || grove_core::git_diff::get_commit_diff_impl(&worktree_path, &hash)).await
}

#[napi]
pub async fn stage_file(worktree_path: String, path: String) -> Result<()> {
    blocking_core(move || grove_core::git_diff::stage_file_impl(&worktree_path, &path)).await
}

#[napi]
pub async fn stage_files(worktree_path: String, paths: Vec<String>) -> Result<()> {
    blocking_core(move || grove_core::git_diff::stage_files_impl(&worktree_path, &paths)).await
}

#[napi]
pub async fn unstage_file(worktree_path: String, path: String) -> Result<()> {
    blocking_core(move || grove_core::git_diff::unstage_file_impl(&worktree_path, &path)).await
}

#[napi]
pub async fn unstage_files(worktree_path: String, paths: Vec<String>) -> Result<()> {
    blocking_core(move || grove_core::git_diff::unstage_files_impl(&worktree_path, &paths)).await
}

#[napi]
pub async fn discard_file(worktree_path: String, path: String) -> Result<()> {
    blocking_core(move || grove_core::git_diff::discard_file_impl(&worktree_path, &path)).await
}

#[napi]
pub async fn discard_files(worktree_path: String, paths: Vec<String>) -> Result<()> {
    blocking_core(move || grove_core::git_diff::discard_files_impl(&worktree_path, &paths)).await
}

#[napi]
pub async fn remove_untracked_files(worktree_path: String, paths: Vec<String>) -> Result<()> {
    blocking_core(move || grove_core::git_diff::remove_untracked_files_impl(&worktree_path, &paths))
        .await
}

#[napi]
pub async fn stage_hunk(worktree_path: String, path: String, hunk_index: u32) -> Result<()> {
    blocking_core(move || grove_core::git_diff::stage_hunk_impl(&worktree_path, &path, hunk_index))
        .await
}

#[napi]
pub async fn unstage_hunk(worktree_path: String, path: String, hunk_index: u32) -> Result<()> {
    blocking_core(move || {
        grove_core::git_diff::unstage_hunk_impl(&worktree_path, &path, hunk_index)
    })
    .await
}

#[napi]
pub async fn discard_hunk(worktree_path: String, path: String, hunk_index: u32) -> Result<()> {
    blocking_core(move || {
        grove_core::git_diff::discard_hunk_impl(&worktree_path, &path, hunk_index)
    })
    .await
}

#[napi]
pub async fn stage_lines(
    worktree_path: String,
    path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
) -> Result<()> {
    blocking_core(move || {
        grove_core::git_diff::stage_lines_impl(&worktree_path, &path, hunk_index, &line_indices)
    })
    .await
}

#[napi]
pub async fn unstage_lines(
    worktree_path: String,
    path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
) -> Result<()> {
    blocking_core(move || {
        grove_core::git_diff::unstage_lines_impl(&worktree_path, &path, hunk_index, &line_indices)
    })
    .await
}

#[napi]
pub async fn discard_lines(
    worktree_path: String,
    path: String,
    hunk_index: u32,
    line_indices: Vec<u32>,
) -> Result<()> {
    blocking_core(move || {
        grove_core::git_diff::discard_lines_impl(&worktree_path, &path, hunk_index, &line_indices)
    })
    .await
}

#[napi]
pub async fn get_behind_count(worktree_path: String) -> Result<String> {
    blocking_json(move || grove_core::git_diff::get_behind_count_impl(&worktree_path)).await
}

#[napi]
pub async fn merge_default_branch(worktree_path: String) -> Result<()> {
    blocking_core(move || grove_core::git_diff::merge_default_branch_impl(&worktree_path)).await
}
