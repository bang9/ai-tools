use crate::terminal_theme::TerminalTheme;
use crate::worktree_lifecycle::WorktreeResource;
use crate::TerminalSessionSnapshotStore;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub id: String,
    pub name: String,
    pub url: String,
    pub org: String,
    pub repo: String,
    pub source_path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub worktree_order: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub stacked_parents: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub collapsed: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub focused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_sync: Option<ProjectEnvSyncConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProjectEnvSyncConfig {
    #[serde(default)]
    pub include_patterns: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalLinkOpenMode {
    #[default]
    External,
    Internal,
    ExternalWithLocalhostInternal,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectViewMode {
    #[default]
    Default,
    GroupByOrgs,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct IdeMenuItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_command: Option<String>,
}

pub const DEFAULT_PROJECT_CATEGORY_ID: &str = "default";

/// Default daemon scrollback ring cap (design D10/§8.X: grove-owned, configurable
/// history depth). 2 MiB approximates a generous tmux `history-limit` while
/// bounding a long-lived daemon's per-session memory. Config-file-only for now —
/// no settings UI (UI frozen). Overridden per session via `daemonScrollbackBytes`.
pub const DEFAULT_DAEMON_SCROLLBACK_BYTES: u64 = 2 * 1024 * 1024;

fn default_daemon_scrollback_bytes() -> u64 {
    DEFAULT_DAEMON_SCROLLBACK_BYTES
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCategory {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: ProjectCategoryIcon,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum ProjectCategoryIcon {
    Emoji(String),
    Lucide(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GrovePreferences {
    pub terminal_link_open_mode: TerminalLinkOpenMode,
    #[serde(default)]
    pub project_view_mode: ProjectViewMode,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub collapsed_project_orgs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub project_org_order: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub git_gui_menu_items: Vec<IdeMenuItem>,
    pub ide_menu_items: Vec<IdeMenuItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub project_categories: Vec<ProjectCategory>,
    /// Daemon scrollback ring cap in bytes (design D10/§8.X). Config-file-only;
    /// serde default keeps old configs (that predate the field) loading unchanged.
    #[serde(default = "default_daemon_scrollback_bytes")]
    pub daemon_scrollback_bytes: u64,
    #[serde(rename = "preferredIde", default, skip_serializing)]
    legacy_preferred_ide: Option<IdeMenuItem>,
}

impl PartialEq for GrovePreferences {
    fn eq(&self, other: &Self) -> bool {
        self.terminal_link_open_mode == other.terminal_link_open_mode
            && self.project_view_mode == other.project_view_mode
            && self.collapsed_project_orgs == other.collapsed_project_orgs
            && self.project_org_order == other.project_org_order
            && self.git_gui_menu_items == other.git_gui_menu_items
            && self.ide_menu_items == other.ide_menu_items
            && self.project_categories == other.project_categories
            && self.daemon_scrollback_bytes == other.daemon_scrollback_bytes
    }
}

impl Eq for GrovePreferences {}

impl GrovePreferences {
    pub fn normalized(mut self) -> Self {
        if self.ide_menu_items.is_empty() {
            if let Some(legacy_preferred_ide) = self.legacy_preferred_ide.take() {
                self.ide_menu_items.push(legacy_preferred_ide);
            }
        }

        self.project_org_order = self
            .project_org_order
            .into_iter()
            .filter(|org| !org.trim().is_empty())
            .collect();
        self.git_gui_menu_items = normalize_git_gui_menu_items(self.git_gui_menu_items);
        self.ide_menu_items = normalize_ide_menu_items(self.ide_menu_items);
        self.project_categories = normalize_project_categories(self.project_categories);
        self.legacy_preferred_ide = None;
        self
    }
}

impl Default for GrovePreferences {
    fn default() -> Self {
        Self {
            terminal_link_open_mode: TerminalLinkOpenMode::ExternalWithLocalhostInternal,
            project_view_mode: ProjectViewMode::Default,
            collapsed_project_orgs: Vec::new(),
            project_org_order: Vec::new(),
            git_gui_menu_items: vec![IdeMenuItem {
                id: "sourcetree".into(),
                display_name: None,
                open_command: None,
            }],
            ide_menu_items: vec![IdeMenuItem {
                id: "webstorm".into(),
                display_name: None,
                open_command: None,
            }],
            project_categories: Vec::new(),
            daemon_scrollback_bytes: DEFAULT_DAEMON_SCROLLBACK_BYTES,
            legacy_preferred_ide: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GroveConfig {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub projects: Vec<ProjectEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_theme: Option<TerminalTheme>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferences: Option<GrovePreferences>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_base_dir")]
    pub base_dir: String,
    #[serde(default)]
    pub terminal_theme: Option<TerminalTheme>,
    #[serde(default)]
    pub preferences: GrovePreferences,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            base_dir: default_base_dir(),
            terminal_theme: None,
            preferences: GrovePreferences::default(),
        }
    }
}

pub fn default_base_dir() -> String {
    dirs::home_dir()
        .map(|p| p.join(".grove"))
        .unwrap_or_else(|| PathBuf::from(".grove"))
        .to_string_lossy()
        .to_string()
}

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".grove")
        .join("config.json")
}

pub(crate) fn grove_data_path(filename: &str) -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("No home dir")?
        .join(".grove")
        .join(filename))
}

/// The daemon runtime directory (design §1.3): `~/.grove/daemon`, holding the
/// versioned socket/pid/token, the copied signed binary, the daemon log, and the
/// version-namespaced `terminal-history/` tree. This is grove's fixed app-data
/// dir joined with `daemon` — deliberately NOT the user-configurable worktrees
/// `baseDir`, so the daemon's IPC endpoint never lands on a network/removable
/// volume. Both shells pass this to `daemon::configure` at startup.
pub fn daemon_runtime_dir() -> Result<PathBuf, String> {
    grove_data_path("daemon")
}

pub(crate) fn load_json_file_or_default<T>(path: &Path) -> Result<T, String>
where
    T: DeserializeOwned + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }

    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse {}: {e}", path.display()))
}

pub(crate) fn save_json_file<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {e}"))?;
    }

    let content = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
    fs::write(path, content).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

pub fn load_config() -> GroveConfig {
    load_config_from_path(&config_path())
}

pub(crate) fn find_project_entry_by_id(project_id: &str) -> Result<ProjectEntry, String> {
    let config = load_config();
    config
        .projects
        .iter()
        .find(|project| project.id == project_id)
        .cloned()
        .ok_or_else(|| format!("Project not found: {project_id}"))
}

fn load_config_from_path(path: &Path) -> GroveConfig {
    if !path.exists() {
        return GroveConfig::default();
    }
    let content = fs::read_to_string(path).unwrap_or_default();
    serde_json::from_str(&content).unwrap_or_default()
}

pub fn save_config(config: &GroveConfig) -> Result<(), String> {
    save_config_to_path(&config_path(), config)
}

fn save_config_to_path(path: &Path, config: &GroveConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    fs::write(path, content).map_err(|e| format!("Failed to write config: {e}"))
}

pub fn load_app_config() -> AppConfig {
    let path = config_path();
    load_app_config_from_path(&path)
}

fn load_app_config_from_path(path: &Path) -> AppConfig {
    let config = load_config_from_path(path);
    AppConfig {
        base_dir: config
            .base_dir
            .filter(|base_dir| !base_dir.trim().is_empty())
            .unwrap_or_else(default_base_dir),
        terminal_theme: config.terminal_theme,
        preferences: config.preferences.unwrap_or_default().normalized(),
    }
}

pub fn save_app_config(config: &AppConfig) -> Result<(), String> {
    save_app_config_to_path(&config_path(), config)
}

fn save_app_config_to_path(path: &Path, app_config: &AppConfig) -> Result<(), String> {
    let mut config = load_config_from_path(path);
    config.base_dir = Some(app_config.base_dir.clone());
    config.terminal_theme = app_config.terminal_theme.clone();
    config.preferences = Some(app_config.preferences.clone().normalized());
    save_config_to_path(path, &config)
}

pub fn load_grove_preferences() -> GrovePreferences {
    load_app_config().preferences
}

pub fn save_grove_preferences(preferences: &GrovePreferences) -> Result<(), String> {
    save_grove_preferences_to_path(&config_path(), preferences)
}

fn save_grove_preferences_to_path(
    path: &Path,
    preferences: &GrovePreferences,
) -> Result<(), String> {
    let mut config = load_config_from_path(path);
    config.preferences = Some(preferences.clone().normalized());
    save_config_to_path(path, &config)
}

fn is_supported_ide_menu_item_id(id: &str) -> bool {
    matches!(
        id,
        "webstorm" | "vscode" | "xcode" | "android-studio" | "intellij" | "cursor" | "sublime"
    )
}

fn is_supported_git_gui_menu_item_id(id: &str) -> bool {
    matches!(id, "sourcetree" | "fork")
}

fn normalize_menu_items(
    items: Vec<IdeMenuItem>,
    is_supported_id: fn(&str) -> bool,
) -> Vec<IdeMenuItem> {
    let mut normalized = Vec::new();

    for item in items {
        let id = item.id.trim();
        if id.is_empty() || !is_supported_id(id) {
            continue;
        }

        if normalized
            .iter()
            .any(|existing: &IdeMenuItem| existing.id == id)
        {
            continue;
        }

        normalized.push(IdeMenuItem {
            id: id.to_string(),
            display_name: item.display_name,
            open_command: item.open_command,
        });
    }

    normalized
}

fn normalize_ide_menu_items(items: Vec<IdeMenuItem>) -> Vec<IdeMenuItem> {
    normalize_menu_items(items, is_supported_ide_menu_item_id)
}

fn normalize_git_gui_menu_items(items: Vec<IdeMenuItem>) -> Vec<IdeMenuItem> {
    normalize_menu_items(items, is_supported_git_gui_menu_item_id)
}

fn is_supported_project_category_icon_id(id: &str) -> bool {
    matches!(
        id,
        "sprout"
            | "folder"
            | "rocket"
            | "flame"
            | "bug"
            | "wrench"
            | "book"
            | "palette"
            | "database"
            | "bot"
            | "terminal"
            | "briefcase"
            | "star"
            | "package"
            | "code"
            | "gem"
    )
}

fn trim_and_limit_chars(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn normalize_project_category_icon(icon: ProjectCategoryIcon) -> Option<ProjectCategoryIcon> {
    match icon {
        ProjectCategoryIcon::Emoji(value) => {
            let value = trim_and_limit_chars(&value, 4);
            if value.is_empty() {
                None
            } else {
                Some(ProjectCategoryIcon::Emoji(value))
            }
        }
        ProjectCategoryIcon::Lucide(value) => {
            let value = value.trim();
            if value.is_empty() || !is_supported_project_category_icon_id(value) {
                None
            } else {
                Some(ProjectCategoryIcon::Lucide(value.to_string()))
            }
        }
    }
}

fn normalize_project_category_color(color: &str) -> Option<String> {
    let color = color.trim();
    let is_hex = color.len() == 7
        && color.starts_with('#')
        && color.chars().skip(1).all(|ch| ch.is_ascii_hexdigit());
    if is_hex {
        Some(color.to_ascii_lowercase())
    } else {
        None
    }
}

fn normalize_project_categories(categories: Vec<ProjectCategory>) -> Vec<ProjectCategory> {
    let mut normalized = Vec::new();

    for category in categories {
        let id = category.id.trim();
        if id.is_empty() || id == DEFAULT_PROJECT_CATEGORY_ID {
            continue;
        }

        if normalized
            .iter()
            .any(|existing: &ProjectCategory| existing.id == id)
        {
            continue;
        }

        let name = trim_and_limit_chars(&category.name, 10);
        if name.is_empty() {
            continue;
        }

        let Some(color) = normalize_project_category_color(&category.color) else {
            continue;
        };
        let Some(icon) = normalize_project_category_icon(category.icon) else {
            continue;
        };

        normalized.push(ProjectCategory {
            id: id.to_string(),
            name,
            color,
            icon,
        });
    }

    normalized
}

fn terminal_session_snapshots_path() -> Result<PathBuf, String> {
    grove_data_path("terminal-session-snapshots.json")
}

fn terminal_session_snapshot_store_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn parse_json_with_trailing_data_recovery<T>(content: &str) -> Result<Option<T>, serde_json::Error>
where
    T: DeserializeOwned,
{
    let mut stream = serde_json::Deserializer::from_str(content).into_iter::<T>();
    match stream.next() {
        Some(Ok(value)) => {
            let trailing = &content[stream.byte_offset()..];
            if trailing.trim().is_empty() {
                Ok(None)
            } else {
                Ok(Some(value))
            }
        }
        Some(Err(error)) => Err(error),
        None => Ok(None),
    }
}

pub fn load_terminal_session_snapshot_store() -> Result<TerminalSessionSnapshotStore, String> {
    let path = terminal_session_snapshots_path()?;
    let _guard = terminal_session_snapshot_store_lock()
        .lock()
        .map_err(|_| "Terminal session snapshot store lock poisoned".to_string())?;
    load_terminal_session_snapshot_store_from_path(&path)
}

fn load_terminal_session_snapshot_store_from_path(
    path: &Path,
) -> Result<TerminalSessionSnapshotStore, String> {
    if !path.exists() {
        return Ok(TerminalSessionSnapshotStore::default());
    }

    let content =
        fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    match serde_json::from_str(&content) {
        Ok(store) => Ok(store),
        Err(error) => {
            if let Some(store) = parse_json_with_trailing_data_recovery(&content)
                .map_err(|_| format!("Failed to parse {}: {error}", path.display()))?
            {
                save_terminal_session_snapshot_store_to_path(path, &store)?;
                Ok(store)
            } else {
                Err(format!("Failed to parse {}: {error}", path.display()))
            }
        }
    }
}

pub fn save_terminal_session_snapshot_store(
    store: &TerminalSessionSnapshotStore,
) -> Result<(), String> {
    let path = terminal_session_snapshots_path()?;
    let _guard = terminal_session_snapshot_store_lock()
        .lock()
        .map_err(|_| "Terminal session snapshot store lock poisoned".to_string())?;
    save_terminal_session_snapshot_store_to_path(&path, store)
}

pub fn update_terminal_session_snapshot_store<R>(
    update: impl FnOnce(&mut TerminalSessionSnapshotStore) -> Result<R, String>,
) -> Result<R, String> {
    let path = terminal_session_snapshots_path()?;
    update_terminal_session_snapshot_store_at_path(&path, update)
}

fn save_terminal_session_snapshot_store_to_path(
    path: &Path,
    store: &TerminalSessionSnapshotStore,
) -> Result<(), String> {
    save_json_file(path, store)
}

fn update_terminal_session_snapshot_store_at_path<R>(
    path: &Path,
    update: impl FnOnce(&mut TerminalSessionSnapshotStore) -> Result<R, String>,
) -> Result<R, String> {
    let _guard = terminal_session_snapshot_store_lock()
        .lock()
        .map_err(|_| "Terminal session snapshot store lock poisoned".to_string())?;
    let mut store = load_terminal_session_snapshot_store_from_path(path)?;
    let result = update(&mut store)?;
    save_terminal_session_snapshot_store_to_path(path, &store)?;
    Ok(result)
}

pub fn get_app_config_impl() -> AppConfig {
    let AppConfig {
        base_dir,
        terminal_theme,
        preferences,
    } = load_app_config();
    AppConfig {
        base_dir,
        terminal_theme: terminal_theme
            .or_else(|| Some(crate::terminal_theme::detect_terminal_theme().theme)),
        preferences,
    }
}

pub fn get_grove_preferences_impl() -> GrovePreferences {
    load_grove_preferences()
}

// ── Panel layout persistence ──

pub fn save_panel_layouts_impl(layouts: &str) -> Result<(), String> {
    let path = grove_data_path("panel-layouts.json")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&path, layouts).map_err(|e| e.to_string())
}

pub fn load_panel_layouts_impl() -> Result<String, String> {
    let path = grove_data_path("panel-layouts.json")?;
    if path.exists() {
        fs::read_to_string(&path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

// ── Persistent UI state (tab sessions, file browser expansion, …) ──

pub fn save_ui_state_impl(state: &str) -> Result<(), String> {
    let path = grove_data_path("ui-state.json")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&path, state).map_err(|e| e.to_string())
}

pub fn load_ui_state_impl() -> Result<String, String> {
    let path = grove_data_path("ui-state.json")?;
    if path.exists() {
        fs::read_to_string(&path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

// ── Terminal layout persistence ──

pub fn save_terminal_layouts_impl(layouts: &str) -> Result<(), String> {
    let path = grove_data_path("terminal-layouts.json")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&path, layouts).map_err(|e| e.to_string())
}

pub fn load_terminal_layouts_impl() -> Result<String, String> {
    let path = grove_data_path("terminal-layouts.json")?;
    if path.exists() {
        fs::read_to_string(&path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

// ── Worktree data cleanup ──

fn normalized_worktree_path(path: &str) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path))
}

fn matching_worktree_keys<'a>(
    keys: impl Iterator<Item = &'a str>,
    worktree_path: &str,
) -> Vec<String> {
    let normalized_target = normalized_worktree_path(worktree_path);
    keys.filter(|key| normalized_worktree_path(key) == normalized_target)
        .map(str::to_owned)
        .collect()
}

fn remove_worktree_entries_from_json_map(
    map: &mut serde_json::Map<String, serde_json::Value>,
    worktree_path: &str,
) -> bool {
    let keys_to_remove = matching_worktree_keys(map.keys().map(String::as_str), worktree_path);
    let mut removed = false;

    for key in keys_to_remove {
        removed |= map.remove(&key).is_some();
    }

    removed
}

fn remove_worktree_entries_from_snapshot_store(
    store: &mut TerminalSessionSnapshotStore,
    worktree_path: &str,
) -> bool {
    let keys_to_remove =
        matching_worktree_keys(store.worktrees.keys().map(String::as_str), worktree_path);
    let mut removed = false;

    for key in keys_to_remove {
        removed |= store.worktrees.remove(&key).is_some();
    }

    removed
}

pub fn remove_terminal_layouts_for_worktree(worktree_path: &str) -> Result<(), String> {
    let raw = load_terminal_layouts_impl()?;
    let mut map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse terminal-layouts.json: {e}"))?;
    if remove_worktree_entries_from_json_map(&mut map, worktree_path) {
        let updated = serde_json::to_string_pretty(&map)
            .map_err(|e| format!("Failed to serialize terminal-layouts.json: {e}"))?;
        save_terminal_layouts_impl(&updated)?;
    }
    Ok(())
}

pub fn remove_terminal_session_snapshot_for_worktree(worktree_path: &str) -> Result<(), String> {
    update_terminal_session_snapshot_store(|store| {
        remove_worktree_entries_from_snapshot_store(store, worktree_path);
        Ok(())
    })
}

pub fn remove_panel_layouts_for_worktree(worktree_path: &str) -> Result<(), String> {
    let raw = load_panel_layouts_impl()?;
    let mut map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse panel-layouts.json: {e}"))?;
    if remove_worktree_entries_from_json_map(&mut map, worktree_path) {
        let updated = serde_json::to_string_pretty(&map)
            .map_err(|e| format!("Failed to serialize panel-layouts.json: {e}"))?;
        save_panel_layouts_impl(&updated)?;
    }
    Ok(())
}

pub struct TerminalLayoutResource;

impl WorktreeResource for TerminalLayoutResource {
    fn name(&self) -> &str {
        "terminal layouts"
    }

    fn on_remove(&self, worktree_path: &str) -> Result<(), String> {
        remove_terminal_layouts_for_worktree(worktree_path)
    }
}

pub struct SessionSnapshotResource;

impl WorktreeResource for SessionSnapshotResource {
    fn name(&self) -> &str {
        "terminal session snapshots"
    }

    fn on_remove(&self, worktree_path: &str) -> Result<(), String> {
        remove_terminal_session_snapshot_for_worktree(worktree_path)
    }
}

pub struct PanelLayoutResource;

impl WorktreeResource for PanelLayoutResource {
    fn name(&self) -> &str {
        "panel layouts"
    }

    fn on_remove(&self, worktree_path: &str) -> Result<(), String> {
        remove_panel_layouts_for_worktree(worktree_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        TerminalPaneSnapshot, TerminalRestoreCwdSource, TerminalSessionSnapshot,
        TerminalSessionSnapshotStore,
    };
    use uuid::Uuid;

    fn temp_config_path() -> PathBuf {
        std::env::temp_dir()
            .join(format!("grove-config-tests-{}", Uuid::new_v4()))
            .join("config.json")
    }

    fn temp_snapshot_store_path() -> PathBuf {
        std::env::temp_dir()
            .join(format!("grove-snapshot-tests-{}", Uuid::new_v4()))
            .join("terminal-session-snapshots.json")
    }

    fn temp_worktree_root() -> PathBuf {
        std::env::temp_dir().join(format!("grove-worktree-tests-{}", Uuid::new_v4()))
    }

    fn write_fixture(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn sample_theme() -> TerminalTheme {
        TerminalTheme {
            background: "#000000".into(),
            foreground: "#ffffff".into(),
            cursor: "#cccccc".into(),
            black: "#111111".into(),
            red: "#222222".into(),
            green: "#333333".into(),
            yellow: "#444444".into(),
            blue: "#555555".into(),
            magenta: "#666666".into(),
            cyan: "#777777".into(),
            white: "#888888".into(),
            bright_black: "#999999".into(),
            bright_red: "#aaaaaa".into(),
            bright_green: "#bbbbbb".into(),
            bright_yellow: "#cccccc".into(),
            bright_blue: "#dddddd".into(),
            bright_magenta: "#eeeeee".into(),
            bright_cyan: "#fafafa".into(),
            bright_white: "#fefefe".into(),
            font_family: "Menlo".into(),
            font_size: 13.0,
        }
    }

    fn sample_preferences() -> GrovePreferences {
        GrovePreferences {
            terminal_link_open_mode: TerminalLinkOpenMode::Internal,
            project_view_mode: ProjectViewMode::GroupByOrgs,
            collapsed_project_orgs: vec!["sendbird".into()],
            project_org_order: vec!["bang9".into(), "sendbird".into()],
            git_gui_menu_items: vec![IdeMenuItem {
                id: "sourcetree".into(),
                display_name: Some("Sourcetree".into()),
                open_command: None,
            }],
            ide_menu_items: vec![IdeMenuItem {
                id: "cursor".into(),
                display_name: Some("Cursor".into()),
                open_command: None,
            }],
            project_categories: vec![ProjectCategory {
                id: "ops".into(),
                name: "Ops".into(),
                color: "#4f7cff".into(),
                icon: ProjectCategoryIcon::Lucide("wrench".into()),
            }],
            daemon_scrollback_bytes: DEFAULT_DAEMON_SCROLLBACK_BYTES,
            legacy_preferred_ide: None,
        }
    }

    fn sample_project() -> ProjectEntry {
        ProjectEntry {
            id: "project-1".into(),
            name: "grove".into(),
            url: "https://github.com/bang9/grove.git".into(),
            org: "bang9".into(),
            repo: "grove".into(),
            source_path: "/tmp/grove/source".into(),
            worktree_order: Vec::new(),
            stacked_parents: BTreeMap::new(),
            base_branch: None,
            collapsed: false,
            focused: false,
            category_id: Some("ops".into()),
            env_sync: None,
        }
    }

    fn sample_snapshot(worktree_path: &str) -> TerminalSessionSnapshot {
        let restore_cwd = Path::new(worktree_path).join("src");
        let restore_cwd = restore_cwd.to_string_lossy().to_string();

        TerminalSessionSnapshot {
            worktree_path: worktree_path.into(),
            panes: vec![TerminalPaneSnapshot {
                pane_id: "pane-1".into(),
                scrollback: "ls -la\n".into(),
                scrollback_truncated: false,
                launch_cwd: worktree_path.into(),
                last_known_cwd: Some(restore_cwd.clone()),
                restore_cwd,
                restore_cwd_source: TerminalRestoreCwdSource::LastKnownCwd,
            }],
        }
    }

    fn sample_snapshot_store() -> TerminalSessionSnapshotStore {
        let mut store = TerminalSessionSnapshotStore::default();
        store.worktrees.insert(
            "/tmp/grove/worktree".into(),
            sample_snapshot("/tmp/grove/worktree"),
        );
        store
    }

    fn existing_worktree_paths() -> (String, String, String, PathBuf) {
        let root = temp_worktree_root();
        let source_dir = root.join("project").join("source");
        let worktree_dir = root.join("project").join("worktrees").join("feature");
        let other_dir = root.join("project").join("worktrees").join("other");

        fs::create_dir_all(&source_dir).unwrap();
        fs::create_dir_all(&worktree_dir).unwrap();
        fs::create_dir_all(&other_dir).unwrap();

        let canonical_path = fs::canonicalize(&worktree_dir)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let cleanup_path = source_dir
            .join("..")
            .join("worktrees")
            .join("feature")
            .to_string_lossy()
            .to_string();
        let other_path = other_dir.to_string_lossy().to_string();

        (canonical_path, cleanup_path, other_path, root)
    }

    fn missing_worktree_path() -> (String, String, PathBuf) {
        let root = temp_worktree_root();
        let missing_path = root
            .join("project")
            .join("worktrees")
            .join("missing-feature")
            .to_string_lossy()
            .to_string();
        let other_path = root
            .join("project")
            .join("worktrees")
            .join("other-feature")
            .to_string_lossy()
            .to_string();

        (missing_path, other_path, root)
    }

    #[test]
    fn load_config_supports_legacy_projects_only_shape() {
        let path = temp_config_path();
        write_fixture(
            &path,
            r#"{
  "projects": [
    {
      "id": "project-1",
      "name": "grove",
      "url": "https://github.com/bang9/grove.git",
      "org": "bang9",
      "repo": "grove",
      "source_path": "/tmp/grove/source"
    }
  ]
}"#,
        );

        let config = load_config_from_path(&path);

        assert_eq!(config.projects.len(), 1);
        assert_eq!(config.projects[0].id, "project-1");
        assert_eq!(config.base_dir, None);
        assert!(config.terminal_theme.is_none());
        assert!(config.preferences.is_none());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn load_config_supports_legacy_app_only_shape() {
        let path = temp_config_path();
        write_fixture(
            &path,
            r##"{
  "baseDir": "/Users/test/.grove",
  "terminalTheme": {
    "background": "#000000",
    "foreground": "#ffffff",
    "cursor": "#cccccc",
    "black": "#111111",
    "red": "#222222",
    "green": "#333333",
    "yellow": "#444444",
    "blue": "#555555",
    "magenta": "#666666",
    "cyan": "#777777",
    "white": "#888888",
    "brightBlack": "#999999",
    "brightRed": "#aaaaaa",
    "brightGreen": "#bbbbbb",
    "brightYellow": "#cccccc",
    "brightBlue": "#dddddd",
    "brightMagenta": "#eeeeee",
    "brightCyan": "#fafafa",
    "brightWhite": "#fefefe",
    "fontFamily": "Menlo",
    "fontSize": 13.0
  }
}"##,
        );

        let config = load_config_from_path(&path);

        assert!(config.projects.is_empty());
        assert_eq!(config.base_dir.as_deref(), Some("/Users/test/.grove"));
        assert_eq!(
            config
                .terminal_theme
                .as_ref()
                .map(|theme| theme.font_family.as_str()),
            Some("Menlo")
        );
        assert!(config.preferences.is_none());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn load_app_config_preserves_saved_base_dir() {
        let path = temp_config_path();
        write_fixture(
            &path,
            &serde_json::to_string_pretty(&AppConfig {
                base_dir: "/Users/test/.grove".into(),
                terminal_theme: None,
                preferences: GrovePreferences::default(),
            })
            .unwrap(),
        );

        let app_config = load_app_config_from_path(&path);

        assert_eq!(app_config.base_dir, "/Users/test/.grove");
        assert_eq!(app_config.preferences, GrovePreferences::default());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn load_app_config_falls_back_to_default_base_dir() {
        let path = temp_config_path();
        write_fixture(&path, r#"{"projects":[]}"#);

        let app_config = load_app_config_from_path(&path);

        assert_eq!(app_config.base_dir, default_base_dir());
        assert_eq!(app_config.preferences, GrovePreferences::default());

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn load_app_config_filters_unsupported_ide_menu_items() {
        let path = temp_config_path();
        write_fixture(
            &path,
            r#"{
  "preferences": {
    "ideMenuItems": [
      { "id": "windsurf" },
      { "id": "cursor" },
      { "id": "zed" },
      { "id": "webstorm" }
    ]
  }
}"#,
        );

        let app_config = load_app_config_from_path(&path);

        assert_eq!(
            app_config
                .preferences
                .ide_menu_items
                .into_iter()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            vec!["cursor", "webstorm"]
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn load_app_config_filters_unsupported_git_gui_menu_items() {
        let path = temp_config_path();
        write_fixture(
            &path,
            r#"{
  "preferences": {
    "gitGuiMenuItems": [
      { "id": "tower" },
      { "id": "sourcetree" },
      { "id": "fork" },
      { "id": "zed" }
    ]
  }
}"#,
        );

        let app_config = load_app_config_from_path(&path);

        assert_eq!(
            app_config
                .preferences
                .git_gui_menu_items
                .into_iter()
                .map(|item| item.id)
                .collect::<Vec<_>>(),
            vec!["sourcetree", "fork"]
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn old_preferences_without_daemon_scrollback_bytes_default() {
        // An on-disk config that predates the daemonScrollbackBytes field must load
        // with the 2 MiB default instead of failing to parse.
        let path = temp_config_path();
        write_fixture(
            &path,
            r#"{
  "preferences": {
    "terminalLinkOpenMode": "internal"
  }
}"#,
        );

        let app_config = load_app_config_from_path(&path);

        assert_eq!(
            app_config.preferences.daemon_scrollback_bytes,
            DEFAULT_DAEMON_SCROLLBACK_BYTES
        );
        assert_eq!(app_config.preferences.daemon_scrollback_bytes, 2 * 1024 * 1024);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn daemon_scrollback_bytes_round_trips() {
        let path = temp_config_path();
        let mut prefs = sample_preferences();
        prefs.daemon_scrollback_bytes = 8 * 1024 * 1024;
        save_grove_preferences_to_path(&path, &prefs).unwrap();

        let loaded = load_app_config_from_path(&path).preferences;

        assert_eq!(loaded.daemon_scrollback_bytes, 8 * 1024 * 1024);
        assert_eq!(loaded, prefs);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn save_app_config_preserves_existing_projects() {
        let path = temp_config_path();
        write_fixture(
            &path,
            r#"{
  "projects": [
    {
      "id": "project-1",
      "name": "grove",
      "url": "https://github.com/bang9/grove.git",
      "org": "bang9",
      "repo": "grove",
      "source_path": "/tmp/grove/source"
    }
  ]
}"#,
        );

        save_app_config_to_path(
            &path,
            &AppConfig {
                base_dir: "/Users/test/.grove".into(),
                terminal_theme: Some(sample_theme()),
                preferences: sample_preferences(),
            },
        )
        .unwrap();

        let config = load_config_from_path(&path);

        assert_eq!(config.projects.len(), 1);
        assert_eq!(config.projects[0].id, "project-1");
        assert_eq!(config.base_dir.as_deref(), Some("/Users/test/.grove"));
        assert!(config.terminal_theme.is_some());
        assert_eq!(config.preferences, Some(sample_preferences()));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn save_config_preserves_existing_app_settings() {
        let path = temp_config_path();
        let theme = sample_theme();
        write_fixture(
            &path,
            &serde_json::to_string_pretty(&AppConfig {
                base_dir: "/Users/test/.grove".into(),
                terminal_theme: Some(theme.clone()),
                preferences: sample_preferences(),
            })
            .unwrap(),
        );

        let mut config = load_config_from_path(&path);
        config.projects.push(sample_project());
        save_config_to_path(&path, &config).unwrap();

        let saved = load_config_from_path(&path);

        assert_eq!(saved.projects.len(), 1);
        assert_eq!(saved.base_dir.as_deref(), Some("/Users/test/.grove"));
        assert_eq!(
            saved
                .terminal_theme
                .as_ref()
                .map(|saved_theme| saved_theme.background.as_str()),
            Some(theme.background.as_str())
        );
        assert_eq!(saved.preferences, Some(sample_preferences()));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn save_grove_preferences_preserves_existing_app_settings() {
        let path = temp_config_path();
        let theme = sample_theme();
        write_fixture(
            &path,
            &serde_json::to_string_pretty(&AppConfig {
                base_dir: "/Users/test/.grove".into(),
                terminal_theme: Some(theme.clone()),
                preferences: GrovePreferences::default(),
            })
            .unwrap(),
        );

        save_grove_preferences_to_path(&path, &sample_preferences()).unwrap();

        let saved = load_config_from_path(&path);

        assert_eq!(saved.base_dir.as_deref(), Some("/Users/test/.grove"));
        assert_eq!(
            saved
                .terminal_theme
                .as_ref()
                .map(|saved_theme| saved_theme.background.as_str()),
            Some(theme.background.as_str())
        );
        assert_eq!(saved.preferences, Some(sample_preferences()));

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn load_terminal_session_snapshot_store_defaults_when_missing() {
        let path = temp_snapshot_store_path();

        let store = load_terminal_session_snapshot_store_from_path(&path).unwrap();

        assert_eq!(store.version, 1);
        assert!(store.worktrees.is_empty());
    }

    #[test]
    fn save_terminal_session_snapshot_store_round_trips() {
        let path = temp_snapshot_store_path();
        let store = sample_snapshot_store();

        save_terminal_session_snapshot_store_to_path(&path, &store).unwrap();
        let loaded = load_terminal_session_snapshot_store_from_path(&path).unwrap();

        assert_eq!(loaded.version, 1);
        let snapshot = loaded.worktrees.get("/tmp/grove/worktree").unwrap();
        assert_eq!(snapshot.panes.len(), 1);
        assert_eq!(snapshot.panes[0].pane_id, "pane-1");
        assert_eq!(
            snapshot.panes[0].restore_cwd_source,
            TerminalRestoreCwdSource::LastKnownCwd
        );

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn load_terminal_session_snapshot_store_recovers_trailing_bytes() {
        let path = temp_snapshot_store_path();
        let store = sample_snapshot_store();
        let mut raw = serde_json::to_string_pretty(&store).unwrap();
        raw.push_str("garbage\x1b[31m");
        write_fixture(&path, &raw);

        let loaded = load_terminal_session_snapshot_store_from_path(&path).unwrap();
        let repaired = fs::read_to_string(&path).unwrap();

        assert_eq!(loaded.version, 1);
        assert_eq!(loaded.worktrees.len(), 1);
        serde_json::from_str::<TerminalSessionSnapshotStore>(&repaired).unwrap();

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn update_terminal_session_snapshot_store_serializes_concurrent_updates() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        let path = temp_snapshot_store_path();
        let barrier = Arc::new(Barrier::new(5));
        let mut handles = Vec::new();

        for index in 0..4 {
            let barrier = Arc::clone(&barrier);
            let path = path.clone();
            handles.push(thread::spawn(move || {
                let worktree_path = format!("/tmp/grove/worktree-{index}");
                barrier.wait();
                update_terminal_session_snapshot_store_at_path(&path, |store| {
                    store
                        .worktrees
                        .insert(worktree_path.clone(), sample_snapshot(&worktree_path));
                    Ok(())
                })
            }));
        }

        barrier.wait();

        for handle in handles {
            handle.join().unwrap().unwrap();
        }

        let loaded = load_terminal_session_snapshot_store_from_path(&path).unwrap();
        assert_eq!(loaded.worktrees.len(), 4);

        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn remove_worktree_entries_from_json_map_matches_exact_nonexistent_paths() {
        let (missing_path, other_path, root) = missing_worktree_path();
        let mut map = serde_json::Map::new();
        map.insert(
            missing_path.clone(),
            serde_json::json!({"layout": "target"}),
        );
        map.insert(other_path.clone(), serde_json::json!({"layout": "other"}));

        assert!(remove_worktree_entries_from_json_map(
            &mut map,
            &missing_path
        ));
        assert!(!map.contains_key(&missing_path));
        assert!(map.contains_key(&other_path));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn remove_worktree_entries_from_json_map_matches_canonicalized_paths() {
        let (stored_path, cleanup_path, other_path, root) = existing_worktree_paths();
        let mut map = serde_json::Map::new();
        map.insert(stored_path.clone(), serde_json::json!({"layout": "target"}));
        map.insert(
            cleanup_path.clone(),
            serde_json::json!({"layout": "duplicate"}),
        );
        map.insert(other_path.clone(), serde_json::json!({"layout": "other"}));

        assert!(remove_worktree_entries_from_json_map(
            &mut map,
            &cleanup_path
        ));
        assert!(!map.contains_key(&stored_path));
        assert!(!map.contains_key(&cleanup_path));
        assert!(map.contains_key(&other_path));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn remove_worktree_entries_from_snapshot_store_matches_exact_nonexistent_paths() {
        let (missing_path, other_path, root) = missing_worktree_path();
        let mut store = TerminalSessionSnapshotStore::default();
        store
            .worktrees
            .insert(missing_path.clone(), sample_snapshot(&missing_path));
        store
            .worktrees
            .insert(other_path.clone(), sample_snapshot(&other_path));

        assert!(remove_worktree_entries_from_snapshot_store(
            &mut store,
            &missing_path
        ));
        assert!(!store.worktrees.contains_key(&missing_path));
        assert!(store.worktrees.contains_key(&other_path));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn remove_worktree_entries_from_snapshot_store_matches_canonicalized_paths() {
        let (stored_path, cleanup_path, other_path, root) = existing_worktree_paths();
        let mut store = TerminalSessionSnapshotStore::default();
        store
            .worktrees
            .insert(stored_path.clone(), sample_snapshot(&stored_path));
        store
            .worktrees
            .insert(cleanup_path.clone(), sample_snapshot(&cleanup_path));
        store
            .worktrees
            .insert(other_path.clone(), sample_snapshot(&other_path));

        assert!(remove_worktree_entries_from_snapshot_store(
            &mut store,
            &cleanup_path
        ));
        assert!(!store.worktrees.contains_key(&stored_path));
        assert!(!store.worktrees.contains_key(&cleanup_path));
        assert!(store.worktrees.contains_key(&other_path));

        let _ = fs::remove_dir_all(root);
    }
}
