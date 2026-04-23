use crate::config::{grove_data_path, load_json_file_or_default, save_json_file};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionProject {
    pub project_id: String,
    pub branch: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mission {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub projects: Vec<MissionProject>,
    /// Absolute path to ~/.grove/missions/{id}. Populated at load time, not persisted.
    #[serde(default, skip_deserializing)]
    pub mission_dir: String,
    #[serde(default)]
    pub collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MissionStore {
    #[serde(default)]
    pub missions: Vec<Mission>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMission {
    id: String,
    name: String,
    #[serde(default)]
    projects: Vec<MissionProject>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    collapsed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedMissionStore {
    #[serde(default)]
    missions: Vec<PersistedMission>,
}

fn missions_path() -> Result<PathBuf, String> {
    grove_data_path("missions.json")
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<(), String> {
    crate::git_project::run_git(cwd, args)
}

fn run_git_output(cwd: &Path, args: &[&str]) -> Result<String, String> {
    crate::git_project::run_git_output(cwd, args)
}

pub(crate) fn missions_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or("No home dir")?
        .join(".grove")
        .join("missions"))
}

pub fn load_missions() -> MissionStore {
    let path = missions_path().unwrap_or_default();
    let dir = missions_dir().unwrap_or_default();
    let config = crate::config::load_config();
    let project_ids: HashSet<String> = config
        .projects
        .into_iter()
        .map(|project| project.id)
        .collect();
    load_missions_with_paths(&path, &dir, &project_ids)
}

fn load_missions_with_paths(
    path: &Path,
    dir: &Path,
    project_ids: &HashSet<String>,
) -> MissionStore {
    let mut store = load_missions_from_path(path);
    let changed = reconcile_missions(&mut store, dir, project_ids);

    if changed {
        let _ = save_missions_to_path(path, &store);
    }

    for mission in &mut store.missions {
        mission.mission_dir = dir.join(&mission.id).to_string_lossy().to_string();
    }

    store
}

fn reconcile_missions(store: &mut MissionStore, dir: &Path, project_ids: &HashSet<String>) -> bool {
    let mut changed = false;

    for mission in &mut store.missions {
        let before = mission.projects.len();
        mission
            .projects
            .retain(|project| project_ids.contains(project.project_id.as_str()));
        if mission.projects.len() != before {
            changed = true;
        }
    }

    if dir.exists() {
        if let Ok(entries) = fs::read_dir(&dir) {
            let known_ids: HashSet<&str> = store
                .missions
                .iter()
                .map(|mission| mission.id.as_str())
                .collect();
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !known_ids.contains(name.as_str()) {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
    }

    changed
}

pub(crate) fn load_missions_from_path(path: &Path) -> MissionStore {
    if !path.exists() {
        return MissionStore::default();
    }
    let persisted: PersistedMissionStore = load_json_file_or_default(path).unwrap_or_default();
    MissionStore {
        missions: persisted
            .missions
            .into_iter()
            .map(|mission| Mission {
                id: mission.id,
                name: mission.name,
                projects: mission.projects,
                mission_dir: String::new(),
                collapsed: mission.collapsed,
            })
            .collect(),
    }
}

pub fn save_missions(store: &MissionStore) -> Result<(), String> {
    save_missions_to_path(&missions_path()?, store)
}

pub(crate) fn save_missions_to_path(path: &Path, store: &MissionStore) -> Result<(), String> {
    let persisted = PersistedMissionStore {
        missions: store
            .missions
            .iter()
            .map(|mission| PersistedMission {
                id: mission.id.clone(),
                name: mission.name.clone(),
                projects: mission.projects.clone(),
                collapsed: mission.collapsed,
            })
            .collect(),
    };
    save_json_file(path, &persisted)
}

fn generate_mission_id() -> String {
    let mut rng = rand::rng();
    format!("{:08x}", rng.random::<u32>())
}

pub fn create_mission(name: &str) -> Result<Mission, String> {
    let path = missions_path()?;
    let dir = missions_dir()?;
    create_mission_with_paths(&path, &dir, name)
}

fn resolve_source_path_for_project(project_id: &str) -> Result<PathBuf, String> {
    let entry = crate::config::find_project_entry_by_id(project_id)?;
    Ok(PathBuf::from(&entry.source_path))
}

fn remove_mission_worktree(source_path: &Path, worktree_path: &str, branch: &str) {
    if source_path.exists() {
        let _ = run_git(
            source_path,
            &["worktree", "remove", worktree_path, "--force"],
        );
        let _ = run_git(source_path, &["branch", "-D", branch]);
    }

    let worktree_dir = Path::new(worktree_path);
    if worktree_dir.exists() {
        let _ = fs::remove_dir_all(worktree_dir);
    }
}

fn create_mission_with_paths(
    store_path: &Path,
    missions_dir: &Path,
    name: &str,
) -> Result<Mission, String> {
    let mut store = load_missions_from_path(store_path);

    let id = loop {
        let candidate = generate_mission_id();
        let already_exists = store.missions.iter().any(|mission| mission.id == candidate)
            || missions_dir.join(&candidate).exists();

        if !already_exists {
            break candidate;
        }
    };

    let mission_dir = missions_dir.join(&id);
    fs::create_dir_all(&mission_dir)
        .map_err(|e| format!("Failed to create mission directory: {e}"))?;

    let mission = Mission {
        id,
        name: name.to_string(),
        projects: vec![],
        mission_dir: mission_dir.to_string_lossy().to_string(),
        collapsed: false,
    };

    store.missions.push(mission.clone());
    save_missions_to_path(store_path, &store)?;
    Ok(mission)
}

pub fn add_project_to_mission(
    mission_id: &str,
    project_id: &str,
) -> Result<MissionProject, String> {
    let store_path = missions_path()?;
    let dir = missions_dir()?;
    let entry = crate::config::find_project_entry_by_id(project_id)?;

    let project = add_project_to_mission_with_paths(
        &store_path,
        &dir,
        mission_id,
        project_id,
        &entry.source_path,
        &entry.repo,
    )?;

    // Sync gitignored env files from source if configured
    if let Some(ref env_sync) = entry.env_sync {
        let source = Path::new(&entry.source_path);
        let worktree = Path::new(&project.path);
        if let Err(e) =
            crate::git_project::sync_env_files(source, worktree, &env_sync.include_patterns)
        {
            eprintln!("[grove] env sync warning (mission): {e}");
        }
    }

    Ok(project)
}

fn add_project_to_mission_with_paths(
    store_path: &Path,
    missions_dir: &Path,
    mission_id: &str,
    project_id: &str,
    source_path: &str,
    repo_name: &str,
) -> Result<MissionProject, String> {
    let mut store = load_missions_from_path(store_path);
    let mission = store
        .missions
        .iter_mut()
        .find(|mission| mission.id == mission_id)
        .ok_or_else(|| format!("Mission not found: {mission_id}"))?;

    if mission
        .projects
        .iter()
        .any(|project| project.project_id == project_id)
    {
        return Err("Project already in mission".into());
    }

    let branch_name = format!("mission/{mission_id}");
    let worktree_path = missions_dir.join(mission_id).join(repo_name);
    let worktree_path_str = worktree_path.to_string_lossy().to_string();
    let source = Path::new(source_path);

    if !source.exists() {
        return Err(format!("Source directory not found: {source_path}"));
    }

    if let Some(parent) = worktree_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create mission worktree parent: {error}"))?;
    }

    let branch_exists = run_git_output(source, &["rev-parse", "--verify", &branch_name]).is_ok();
    if branch_exists {
        run_git(
            source,
            &["worktree", "add", &worktree_path_str, &branch_name],
        )?;
    } else {
        run_git(
            source,
            &["worktree", "add", "-b", &branch_name, &worktree_path_str],
        )?;
    }

    let project = MissionProject {
        project_id: project_id.to_string(),
        branch: branch_name,
        path: worktree_path_str,
    };
    mission.projects.push(project.clone());
    save_missions_to_path(store_path, &store)?;
    Ok(project)
}

pub fn remove_project_from_mission(mission_id: &str, project_id: &str) -> Result<(), String> {
    let store_path = missions_path()?;
    let dir = missions_dir()?;
    remove_project_from_mission_with_paths(&store_path, &dir, mission_id, project_id)
}

fn remove_project_from_mission_with_paths(
    store_path: &Path,
    _missions_dir: &Path,
    mission_id: &str,
    project_id: &str,
) -> Result<(), String> {
    let mut store = load_missions_from_path(store_path);
    let mission = store
        .missions
        .iter_mut()
        .find(|mission| mission.id == mission_id)
        .ok_or_else(|| format!("Mission not found: {mission_id}"))?;
    let project = mission
        .projects
        .iter()
        .find(|project| project.project_id == project_id)
        .ok_or_else(|| format!("Project not in mission: {project_id}"))?
        .clone();

    crate::worktree_lifecycle::default_worktree_lifecycle().cleanup(&project.path);
    if let Ok(source_path) = resolve_source_path_for_project(project_id) {
        remove_mission_worktree(&source_path, &project.path, &project.branch);
    } else {
        let worktree_dir = Path::new(&project.path);
        if worktree_dir.exists() {
            let _ = fs::remove_dir_all(worktree_dir);
        }
    }

    mission
        .projects
        .retain(|project| project.project_id != project_id);
    save_missions_to_path(store_path, &store)
}

pub fn set_mission_collapsed(id: &str, collapsed: bool) -> Result<(), String> {
    let path = missions_path()?;
    let mut store = load_missions_from_path(&path);
    let mission = store
        .missions
        .iter_mut()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("Mission not found: {id}"))?;
    mission.collapsed = collapsed;
    save_missions_to_path(&path, &store)
}

pub fn delete_mission(id: &str) -> Result<(), String> {
    let path = missions_path()?;
    let dir = missions_dir()?;
    delete_mission_with_paths(&path, &dir, id)
}

fn delete_mission_with_paths(
    store_path: &Path,
    missions_dir: &Path,
    id: &str,
) -> Result<(), String> {
    delete_mission_with_lifecycle(
        store_path,
        missions_dir,
        id,
        crate::worktree_lifecycle::default_worktree_lifecycle(),
    )
}

fn delete_mission_with_lifecycle(
    store_path: &Path,
    missions_dir: &Path,
    id: &str,
    lifecycle: &crate::worktree_lifecycle::WorktreeLifecycle,
) -> Result<(), String> {
    let mission = load_missions_from_path(store_path)
        .missions
        .iter()
        .find(|mission| mission.id == id)
        .cloned()
        .ok_or_else(|| format!("Mission not found: {id}"))?;

    for project_id in mission
        .projects
        .iter()
        .map(|project| project.project_id.clone())
    {
        remove_project_from_mission_with_paths(store_path, missions_dir, id, &project_id)?;
    }

    let mission_dir = missions_dir.join(id);
    let mission_dir_str = mission_dir.to_string_lossy().to_string();
    lifecycle.cleanup(&mission_dir_str);
    if mission_dir.exists() {
        fs::remove_dir_all(&mission_dir)
            .map_err(|e| format!("Failed to remove mission directory: {e}"))?;
    }

    let mut store = load_missions_from_path(store_path);
    store.missions.retain(|mission| mission.id != id);
    save_missions_to_path(store_path, &store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{GroveConfig, ProjectEntry};
    use crate::test_support::env_lock;
    use crate::worktree_lifecycle::{WorktreeLifecycle, WorktreeResource};
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;

    fn temp_missions_path() -> PathBuf {
        std::env::temp_dir()
            .join(format!("grove-mission-tests-{}", Uuid::new_v4()))
            .join("missions.json")
    }

    struct TestHome {
        root: PathBuf,
        original_home: Option<String>,
    }

    impl TestHome {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("grove-mission-home-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();

            let original_home = std::env::var("HOME").ok();
            unsafe {
                std::env::set_var("HOME", &root);
            }

            Self {
                root,
                original_home,
            }
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            match &self.original_home {
                Some(original_home) => unsafe {
                    std::env::set_var("HOME", original_home);
                },
                None => unsafe {
                    std::env::remove_var("HOME");
                },
            }

            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn run_git_ok(cwd: &Path, args: &[&str]) {
        let output = crate::git_project::git_command()
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn configure_git_identity(repo_dir: &Path) {
        run_git_ok(repo_dir, &["config", "user.name", "Grove Test"]);
        run_git_ok(repo_dir, &["config", "user.email", "grove@example.com"]);
    }

    fn temp_git_repo() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("grove-mission-git-{}", Uuid::new_v4()));
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        run_git_ok(&source, &["init"]);
        configure_git_identity(&source);
        run_git_ok(&source, &["checkout", "-b", "main"]);
        fs::write(source.join("README.md"), "# test").unwrap();
        run_git_ok(&source, &["add", "."]);
        run_git_ok(&source, &["commit", "-m", "init"]);
        (root, source)
    }

    fn sample_project_entry(project_id: &str, source_dir: &Path, repo_name: &str) -> ProjectEntry {
        ProjectEntry {
            id: project_id.to_string(),
            name: repo_name.to_string(),
            url: format!("https://github.com/bang9/{repo_name}.git"),
            org: "bang9".into(),
            repo: repo_name.to_string(),
            source_path: source_dir.to_string_lossy().to_string(),
            worktree_order: Vec::new(),
            stacked_parents: std::collections::BTreeMap::new(),
            base_branch: None,
            collapsed: false,
            category_id: None,
            env_sync: None,
        }
    }

    fn save_test_config(projects: Vec<ProjectEntry>) {
        crate::config::save_config(&GroveConfig {
            projects,
            base_dir: None,
            terminal_theme: None,
            preferences: None,
        })
        .unwrap();
    }

    struct TrackingResource {
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl WorktreeResource for TrackingResource {
        fn name(&self) -> &str {
            "tracking"
        }

        fn on_remove(&self, worktree_path: &str) -> Result<(), String> {
            self.calls.lock().unwrap().push(worktree_path.to_string());
            Ok(())
        }
    }

    #[test]
    fn load_missions_returns_empty_when_file_missing() {
        let path = temp_missions_path();
        let store = load_missions_from_path(&path);
        assert!(store.missions.is_empty());
    }

    #[test]
    fn save_and_load_missions_round_trips() {
        let path = temp_missions_path();
        let store = MissionStore {
            missions: vec![Mission {
                id: "abcd1234".into(),
                name: "Test Mission".into(),
                projects: vec![MissionProject {
                    project_id: "proj-uuid-1".into(),
                    branch: "mission/abcd1234".into(),
                    path: "/tmp/missions/abcd1234/my-repo".into(),
                }],
                mission_dir: String::new(),
                collapsed: false,
            }],
        };

        save_missions_to_path(&path, &store).unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"projectId\""));
        assert!(!raw.contains("missionDir"));

        let loaded = load_missions_from_path(&path);
        assert_eq!(loaded.missions.len(), 1);
        assert_eq!(loaded.missions[0].id, "abcd1234");
        assert_eq!(loaded.missions[0].name, "Test Mission");
        assert_eq!(loaded.missions[0].projects.len(), 1);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn create_mission_generates_id_and_creates_directory() {
        let path = temp_missions_path();
        let missions_dir = path.parent().unwrap().join("missions");

        let mission =
            create_mission_with_paths(&path, &missions_dir, "SDK v5 마이그레이션").unwrap();

        assert_eq!(mission.name, "SDK v5 마이그레이션");
        assert_eq!(mission.id.len(), 8);
        assert!(mission.id.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert!(mission.projects.is_empty());
        assert!(missions_dir.join(&mission.id).exists());

        let store = load_missions_from_path(&path);
        assert_eq!(store.missions.len(), 1);
        assert_eq!(store.missions[0].id, mission.id);

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn delete_mission_removes_directory_and_entry() {
        let path = temp_missions_path();
        let missions_dir = path.parent().unwrap().join("missions");

        let mission = create_mission_with_paths(&path, &missions_dir, "To Delete").unwrap();
        assert!(missions_dir.join(&mission.id).exists());

        delete_mission_with_paths(&path, &missions_dir, &mission.id).unwrap();

        assert!(!missions_dir.join(&mission.id).exists());

        let store = load_missions_from_path(&path);
        assert!(store.missions.is_empty());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn delete_mission_cleans_up_mission_root_resources() {
        let path = temp_missions_path();
        let missions_dir = path.parent().unwrap().join("missions");
        let mission = create_mission_with_paths(&path, &missions_dir, "To Delete").unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut lifecycle = WorktreeLifecycle::default();
        lifecycle.register(Box::new(TrackingResource {
            calls: Arc::clone(&calls),
        }));

        delete_mission_with_lifecycle(&path, &missions_dir, &mission.id, &lifecycle).unwrap();

        assert_eq!(
            *calls.lock().unwrap(),
            vec![missions_dir.join(&mission.id).to_string_lossy().to_string()]
        );

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn load_missions_reconciles_orphaned_projects_and_stale_directories() {
        let path = temp_missions_path();
        let missions_dir = path.parent().unwrap().join("missions");
        let mission_id = "abcd1234";
        let stale_dir_name = "deadbeef";
        let mission_dir = missions_dir.join(mission_id);
        let stale_dir = missions_dir.join(stale_dir_name);
        fs::create_dir_all(&mission_dir).unwrap();
        fs::create_dir_all(&stale_dir).unwrap();

        save_missions_to_path(
            &path,
            &MissionStore {
                missions: vec![Mission {
                    id: mission_id.into(),
                    name: "Mission".into(),
                    projects: vec![
                        MissionProject {
                            project_id: "project-1".into(),
                            branch: format!("mission/{mission_id}"),
                            path: mission_dir.join("grove").to_string_lossy().to_string(),
                        },
                        MissionProject {
                            project_id: "project-2".into(),
                            branch: format!("mission/{mission_id}"),
                            path: mission_dir.join("other").to_string_lossy().to_string(),
                        },
                    ],
                    mission_dir: String::new(),
                    collapsed: false,
                }],
            },
        )
        .unwrap();

        let store = load_missions_with_paths(
            &path,
            &missions_dir,
            &HashSet::from([String::from("project-1")]),
        );
        let mission = store
            .missions
            .iter()
            .find(|mission| mission.id == mission_id)
            .unwrap();

        assert_eq!(mission.projects.len(), 1);
        assert_eq!(mission.projects[0].project_id, "project-1");
        assert_eq!(
            mission.mission_dir,
            mission_dir.to_string_lossy().to_string()
        );
        assert!(!stale_dir.exists());

        let saved_store = load_missions_from_path(&path);
        let saved_mission = saved_store
            .missions
            .iter()
            .find(|mission| mission.id == mission_id)
            .unwrap();
        assert_eq!(saved_mission.projects.len(), 1);
        assert_eq!(saved_mission.projects[0].project_id, "project-1");

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn add_project_creates_worktree_at_mission_path() {
        let _lock = env_lock();
        let home = TestHome::new();
        let (repo_root, source_dir) = temp_git_repo();
        let project_id = "project-1";
        let repo_name = "grove";
        save_test_config(vec![sample_project_entry(
            project_id,
            &source_dir,
            repo_name,
        )]);

        let mission = create_mission("Mission").unwrap();
        let project = add_project_to_mission(&mission.id, project_id).unwrap();
        let expected_path = home
            .root
            .join(".grove")
            .join("missions")
            .join(&mission.id)
            .join(repo_name);

        assert_eq!(PathBuf::from(&project.path), expected_path);
        assert_eq!(project.branch, format!("mission/{}", mission.id));
        assert!(expected_path.exists());
        assert_eq!(
            run_git_output(&expected_path, &["branch", "--show-current"]).unwrap(),
            project.branch
        );

        let store = load_missions();
        let saved_mission = store
            .missions
            .iter()
            .find(|saved_mission| saved_mission.id == mission.id)
            .unwrap();
        assert_eq!(saved_mission.projects.len(), 1);
        assert_eq!(saved_mission.projects[0].project_id, project.project_id);
        assert_eq!(saved_mission.projects[0].branch, project.branch);
        assert_eq!(saved_mission.projects[0].path, project.path);

        delete_mission(&mission.id).unwrap();
        let _ = fs::remove_dir_all(repo_root);
    }

    #[test]
    fn add_project_reuses_existing_branch() {
        let _lock = env_lock();
        let _home = TestHome::new();
        let (repo_root, source_dir) = temp_git_repo();
        let project_id = "project-1";
        let repo_name = "grove";
        save_test_config(vec![sample_project_entry(
            project_id,
            &source_dir,
            repo_name,
        )]);

        let mission = create_mission("Mission").unwrap();
        let branch_name = format!("mission/{}", mission.id);
        run_git_ok(&source_dir, &["branch", &branch_name]);

        let project = add_project_to_mission(&mission.id, project_id).unwrap();

        assert_eq!(project.branch, branch_name);
        assert_eq!(
            run_git_output(Path::new(&project.path), &["branch", "--show-current"]).unwrap(),
            project.branch
        );

        delete_mission(&mission.id).unwrap();
        let _ = fs::remove_dir_all(repo_root);
    }

    #[test]
    fn remove_project_removes_worktree_and_branch() {
        let _lock = env_lock();
        let _home = TestHome::new();
        let (repo_root, source_dir) = temp_git_repo();
        let project_id = "project-1";
        save_test_config(vec![sample_project_entry(project_id, &source_dir, "grove")]);

        let mission = create_mission("Mission").unwrap();
        let project = add_project_to_mission(&mission.id, project_id).unwrap();

        assert!(Path::new(&project.path).exists());
        assert!(run_git_output(&source_dir, &["rev-parse", "--verify", &project.branch]).is_ok());

        remove_project_from_mission(&mission.id, project_id).unwrap();

        assert!(!Path::new(&project.path).exists());
        assert!(run_git_output(&source_dir, &["rev-parse", "--verify", &project.branch]).is_err());

        let store = load_missions();
        let saved_mission = store
            .missions
            .iter()
            .find(|saved_mission| saved_mission.id == mission.id)
            .unwrap();
        assert!(saved_mission.projects.is_empty());

        delete_mission(&mission.id).unwrap();
        let _ = fs::remove_dir_all(repo_root);
    }

    #[test]
    fn delete_mission_removes_project_worktree_and_branch() {
        let _lock = env_lock();
        let home = TestHome::new();
        let (repo_root, source_dir) = temp_git_repo();
        let project_id = "project-1";
        let repo_name = "grove";
        save_test_config(vec![sample_project_entry(
            project_id,
            &source_dir,
            repo_name,
        )]);

        let mission = create_mission("Mission").unwrap();
        let project = add_project_to_mission(&mission.id, project_id).unwrap();
        let mission_path = home.root.join(".grove").join("missions").join(&mission.id);

        delete_mission(&mission.id).unwrap();

        assert!(!mission_path.exists());
        assert!(!Path::new(&project.path).exists());
        assert!(run_git_output(&source_dir, &["rev-parse", "--verify", &project.branch]).is_err());
        assert!(load_missions().missions.is_empty());

        let _ = fs::remove_dir_all(repo_root);
    }
}
