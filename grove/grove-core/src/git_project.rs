use crate::config::{self, ProjectEntry};
use crate::process_env::{interactive_shell_output, preferred_env_var, subprocess_env_pairs};
use crate::{
    CloningProject, Project, StartCloneOutcome, Worktree, WorktreePullRequest,
    WorktreePullRequestStatus,
};
use git2::{Oid, Repository};
use serde::Deserialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use uuid::Uuid;

const SOURCE_WORKTREE_NAME: &str = "source";
const SOURCE_REMOTE_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
const MAX_PROJECT_LOAD_WORKERS: usize = 4;

fn base_dir() -> PathBuf {
    PathBuf::from(config::load_app_config().base_dir)
}

pub(crate) fn git_command() -> Command {
    let mut command = Command::new("git");
    for (key, value) in subprocess_env_pairs() {
        command.env(key, value);
    }
    command
}

/// Parse a git URL into (host, org, repo).
/// Supports HTTPS (https://host/org/repo[.git]) and SSH (git@host:org/repo[.git]).
fn parse_git_url(url: &str) -> Result<(String, String, String), String> {
    // SSH: git@github.com:org/repo.git
    if let Some(rest) = url.strip_prefix("git@") {
        let parts: Vec<&str> = rest.splitn(2, ':').collect();
        if parts.len() != 2 {
            return Err(format!("Invalid SSH URL: {url}"));
        }
        let host = parts[0].to_string();
        let path = parts[1].trim_end_matches(".git");
        let segments: Vec<&str> = path.split('/').collect();
        if segments.len() < 2 {
            return Err(format!("Invalid URL path: {path}"));
        }
        return Ok((host, segments[0].to_string(), segments[1].to_string()));
    }

    // HTTPS: https://github.com/org/repo.git
    let url_str = url.trim_end_matches(".git");
    let without_protocol = url_str
        .strip_prefix("https://")
        .or_else(|| url_str.strip_prefix("http://"))
        .ok_or_else(|| format!("Unsupported URL format: {url}"))?;

    let segments: Vec<&str> = without_protocol.split('/').collect();
    if segments.len() < 3 {
        return Err(format!("Invalid URL — expected host/org/repo: {url}"));
    }

    Ok((
        segments[0].to_string(),
        segments[1].to_string(),
        segments[2].to_string(),
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PullRequestHeadRef {
    number: u64,
    oid: Oid,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GithubPullRequestSummary {
    url: String,
    state: String,
    head_ref_name: String,
    head_ref_oid: String,
    merged_at: Option<String>,
    updated_at: String,
}

fn is_github_host(host: &str) -> bool {
    let normalized = host.trim().to_ascii_lowercase();
    normalized == "github.com" || normalized.contains("github")
}

fn github_remote(url: &str) -> Option<(String, String, String)> {
    let (host, org, repo) = parse_git_url(url).ok()?;
    if !is_github_host(&host) {
        return None;
    }

    Some((host, org, repo))
}

fn parse_pull_request_head_ref(line: &str) -> Option<PullRequestHeadRef> {
    let mut parts = line.split_whitespace();
    let oid = Oid::from_str(parts.next()?).ok()?;
    let ref_name = parts.next()?;
    let number = ref_name
        .strip_prefix("refs/pull/")?
        .strip_suffix("/head")?
        .parse()
        .ok()?;

    Some(PullRequestHeadRef { number, oid })
}

fn parse_pull_request_head_refs(output: &str) -> Vec<PullRequestHeadRef> {
    output
        .lines()
        .filter_map(parse_pull_request_head_ref)
        .collect()
}

fn find_pull_request_number_for_head(refs: &[PullRequestHeadRef], head_oid: Oid) -> Option<u64> {
    refs.iter()
        .find(|pull_ref| pull_ref.oid == head_oid)
        .map(|pull_ref| pull_ref.number)
}

fn canonical_pull_request_url(host: &str, org: &str, repo: &str, number: u64) -> String {
    format!("https://{host}/{org}/{repo}/pull/{number}")
}

fn github_repo_selector(host: &str, org: &str, repo: &str) -> String {
    if host.eq_ignore_ascii_case("github.com") {
        format!("{org}/{repo}")
    } else {
        format!("{host}/{org}/{repo}")
    }
}

fn github_token_override_env(org: &str) -> Option<&'static str> {
    match org {
        "sendbird" => Some("GH_TOKEN_SENDBIRD"),
        "sendbird-playground" => Some("GH_TOKEN_SENDBIRD_PLAYGROUND"),
        "rich-automation" => Some("GH_TOKEN_RICH_AUTOMATION"),
        _ => None,
    }
}

fn gh_command(org: &str) -> Command {
    let mut command = Command::new("gh");
    for (key, value) in subprocess_env_pairs() {
        command.env(key, value);
    }

    if let Some(token_env_name) = github_token_override_env(org) {
        if let Some(token) = preferred_env_var(token_env_name) {
            command.env("GH_TOKEN", token);
        }
    }

    command
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn pull_request_status_from_github_summary(
    pull_request: &GithubPullRequestSummary,
) -> Option<WorktreePullRequestStatus> {
    if pull_request.state.eq_ignore_ascii_case("open") {
        Some(WorktreePullRequestStatus::Open)
    } else if pull_request.merged_at.is_some() {
        Some(WorktreePullRequestStatus::Merged)
    } else {
        None
    }
}

fn select_github_pull_request(
    pull_requests: &[GithubPullRequestSummary],
    branch_name: &str,
    head_oid: Oid,
) -> Option<WorktreePullRequest> {
    let head_oid = head_oid.to_string();

    pull_requests
        .iter()
        .filter(|pull_request| pull_request.head_ref_name == branch_name)
        .filter_map(|pull_request| {
            let status = pull_request_status_from_github_summary(pull_request)?;
            let priority = (
                matches!(status, WorktreePullRequestStatus::Open),
                pull_request.head_ref_oid.eq_ignore_ascii_case(&head_oid),
                pull_request.updated_at.as_str(),
            );
            Some((
                priority,
                WorktreePullRequest {
                    url: pull_request.url.clone(),
                    status,
                },
            ))
        })
        .max_by_key(|(priority, _)| *priority)
        .map(|(_, pull_request)| pull_request)
}

fn github_pull_request_via_cli(
    host: &str,
    org: &str,
    repo: &str,
    branch_name: &str,
    head_oid: Oid,
) -> Result<Option<WorktreePullRequest>, String> {
    let repo_selector = github_repo_selector(host, org, repo);
    let output = gh_command(org)
        .args([
            "pr",
            "list",
            "--repo",
            &repo_selector,
            "--state",
            "all",
            "--head",
            branch_name,
            "--json",
            "url,state,headRefName,headRefOid,mergedAt,updatedAt",
        ])
        .output()
        .map_err(|e| format!("Failed to run gh pr list: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "gh pr list failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let pull_requests: Vec<GithubPullRequestSummary> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse gh pr list output for {repo_selector}: {e}"))?;

    Ok(select_github_pull_request(
        &pull_requests,
        branch_name,
        head_oid,
    ))
}

fn github_pull_request_via_interactive_shell(
    host: &str,
    org: &str,
    repo: &str,
    branch_name: &str,
    head_oid: Oid,
) -> Result<Option<WorktreePullRequest>, String> {
    let repo_selector = github_repo_selector(host, org, repo);
    let gh_prefix = github_token_override_env(org)
        .map(|token_env| format!("GH_TOKEN=${token_env} "))
        .unwrap_or_default();
    let command = format!(
        "{gh_prefix}gh pr list -R {repo} --state all --head {branch} --json url,state,headRefName,headRefOid,mergedAt,updatedAt",
        repo = shell_quote(&repo_selector),
        branch = shell_quote(branch_name),
    );
    let output = interactive_shell_output(&command)?;
    let pull_requests: Vec<GithubPullRequestSummary> = serde_json::from_str(&output)
        .map_err(|e| format!("Failed to parse login-shell gh output for {repo_selector}: {e}"))?;

    Ok(select_github_pull_request(
        &pull_requests,
        branch_name,
        head_oid,
    ))
}

fn create_github_pull_request_via_cli(
    worktree: &Path,
    host: &str,
    org: &str,
    repo: &str,
    branch_name: &str,
) -> Result<(), String> {
    let repo_selector = github_repo_selector(host, org, repo);
    let output = gh_command(org)
        .current_dir(worktree)
        .args([
            "pr",
            "create",
            "--repo",
            &repo_selector,
            "--head",
            branch_name,
            "--web",
        ])
        .output()
        .map_err(|e| format!("Failed to run gh pr create: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "gh pr create failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn create_github_pull_request_via_interactive_shell(
    worktree: &Path,
    host: &str,
    org: &str,
    repo: &str,
    branch_name: &str,
) -> Result<(), String> {
    let repo_selector = github_repo_selector(host, org, repo);
    let gh_prefix = github_token_override_env(org)
        .map(|token_env| format!("GH_TOKEN=${token_env} "))
        .unwrap_or_default();
    let command = format!(
        "cd {worktree} && {gh_prefix}gh pr create -R {repo} --head {branch} --web",
        worktree = shell_quote(&worktree.to_string_lossy()),
        repo = shell_quote(&repo_selector),
        branch = shell_quote(branch_name),
    );
    interactive_shell_output(&command).map(|_| ())
}

fn git_ls_remote_pull_heads_via_interactive_shell(worktree: &Path) -> Result<String, String> {
    let command = format!(
        "git -C {worktree} ls-remote origin {pattern}",
        worktree = shell_quote(&worktree.to_string_lossy()),
        pattern = shell_quote("refs/pull/*/head"),
    );
    interactive_shell_output(&command)
}

fn project_dir(host: &str, org: &str, repo: &str) -> PathBuf {
    base_dir().join(host).join(org).join(repo)
}

fn find_project_entry(project_id: &str) -> Result<ProjectEntry, String> {
    let config = load_reconciled_config()?;
    config
        .projects
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))
}

fn normalize_source_path(path: &str) -> String {
    path.trim_end_matches('/').to_string()
}

fn normalize_project_url(url: &str) -> String {
    url.trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string()
}

fn same_project_entry(left: &ProjectEntry, right: &ProjectEntry) -> bool {
    left.id == right.id
        && left.name == right.name
        && left.url == right.url
        && left.org == right.org
        && left.repo == right.repo
        && left.source_path == right.source_path
}

fn same_project_entries(left: &[ProjectEntry], right: &[ProjectEntry]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right.iter())
            .all(|(left, right)| same_project_entry(left, right))
}

fn find_matching_project(
    entries: &[ProjectEntry],
    source_path: &str,
    url: Option<&str>,
) -> Option<ProjectEntry> {
    let source_key = normalize_source_path(source_path);
    let url_key = url.map(normalize_project_url);

    entries
        .iter()
        .find(|entry| {
            normalize_source_path(&entry.source_path) == source_key
                || url_key
                    .as_ref()
                    .map(|key| normalize_project_url(&entry.url) == *key)
                    .unwrap_or(false)
        })
        .cloned()
}

fn make_project_entry(
    name: String,
    url: String,
    org: String,
    repo: String,
    source_path: String,
) -> ProjectEntry {
    ProjectEntry {
        id: Uuid::new_v4().to_string(),
        name,
        url,
        org,
        repo,
        source_path,
        worktree_order: Vec::new(),
        stacked_parents: BTreeMap::new(),
        base_branch: None,
        collapsed: false,
        category_id: None,
        env_sync: None,
    }
}

fn project_entry_from_url(
    url: &str,
    source_dir: &Path,
    preferred_name: Option<&str>,
) -> Result<ProjectEntry, String> {
    let (_host, org, repo) = parse_git_url(url)?;
    Ok(make_project_entry(
        preferred_name.unwrap_or(&repo).to_string(),
        url.to_string(),
        org,
        repo,
        source_dir.to_string_lossy().to_string(),
    ))
}

fn remote_url_for_repo(source_dir: &Path) -> Result<String, String> {
    let repo = Repository::open(source_dir).map_err(|e| {
        format!(
            "Failed to open git repository at {}: {e}",
            source_dir.display()
        )
    })?;

    if let Ok(remote) = repo.find_remote("origin") {
        if let Some(url) = remote.url() {
            return Ok(url.to_string());
        }
    }

    let remotes = repo.remotes().map_err(|e| {
        format!(
            "Failed to inspect remotes for {}: {e}",
            source_dir.display()
        )
    })?;

    for remote_name in remotes.iter().flatten() {
        if let Ok(remote) = repo.find_remote(remote_name) {
            if let Some(url) = remote.url() {
                return Ok(url.to_string());
            }
        }
    }

    Err(format!(
        "No git remote URL found for {}",
        source_dir.display()
    ))
}

fn project_entry_from_source(source_dir: &Path) -> Result<ProjectEntry, String> {
    let remote_url = remote_url_for_repo(source_dir)?;
    project_entry_from_url(&remote_url, source_dir, None)
}

fn child_directories(path: &Path) -> Vec<PathBuf> {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(Result::ok))
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect()
}

fn scan_source_directories(base_dir: &Path) -> Vec<PathBuf> {
    let mut source_dirs = Vec::new();

    for host_dir in child_directories(base_dir) {
        for org_dir in child_directories(&host_dir) {
            for repo_dir in child_directories(&org_dir) {
                let source_dir = repo_dir.join("source");
                if source_dir.is_dir() {
                    source_dirs.push(source_dir);
                }
            }
        }
    }

    source_dirs.sort();
    source_dirs
}

fn reconcile_project_entries(entries: Vec<ProjectEntry>, base_dir: &Path) -> Vec<ProjectEntry> {
    let mut reconciled = Vec::new();
    let mut seen_paths = HashSet::new();
    let mut seen_urls = HashSet::new();

    for entry in entries {
        if !Path::new(&entry.source_path).is_dir() {
            continue;
        }

        let source_key = normalize_source_path(&entry.source_path);
        let url_key = normalize_project_url(&entry.url);
        if !seen_paths.insert(source_key) || !seen_urls.insert(url_key) {
            continue;
        }

        reconciled.push(entry);
    }

    for source_dir in scan_source_directories(base_dir) {
        let source_path = source_dir.to_string_lossy().to_string();
        let source_key = normalize_source_path(&source_path);
        if seen_paths.contains(&source_key) {
            continue;
        }

        let Ok(entry) = project_entry_from_source(&source_dir) else {
            continue;
        };

        let url_key = normalize_project_url(&entry.url);
        if seen_urls.contains(&url_key) {
            continue;
        }

        seen_paths.insert(source_key);
        seen_urls.insert(url_key);
        reconciled.push(entry);
    }

    reconciled
}

fn available_project_category_ids(config: &config::GroveConfig) -> HashSet<String> {
    config
        .preferences
        .clone()
        .unwrap_or_default()
        .normalized()
        .project_categories
        .into_iter()
        .map(|category| category.id)
        .collect()
}

fn normalize_project_category_id(
    category_id: Option<String>,
    available_ids: &HashSet<String>,
) -> Option<String> {
    let Some(category_id) = category_id else {
        return None;
    };

    let category_id = category_id.trim();
    if category_id.is_empty() || category_id == config::DEFAULT_PROJECT_CATEGORY_ID {
        return None;
    }

    if available_ids.contains(category_id) {
        Some(category_id.to_string())
    } else {
        None
    }
}

fn reconcile_project_categories(config: &mut config::GroveConfig) -> bool {
    let normalized_preferences = config.preferences.clone().unwrap_or_default().normalized();
    let available_ids = normalized_preferences
        .project_categories
        .iter()
        .map(|category| category.id.clone())
        .collect::<HashSet<_>>();
    let preferences_changed = config
        .preferences
        .as_ref()
        .map(|preferences| preferences != &normalized_preferences)
        .unwrap_or(false);
    if preferences_changed {
        config.preferences = Some(normalized_preferences);
    }

    let mut projects_changed = false;
    for entry in &mut config.projects {
        let normalized = normalize_project_category_id(entry.category_id.clone(), &available_ids);
        if entry.category_id != normalized {
            entry.category_id = normalized;
            projects_changed = true;
        }
    }

    preferences_changed || projects_changed
}

fn load_reconciled_config() -> Result<config::GroveConfig, String> {
    let mut config = config::load_config();
    let reconciled_projects = reconcile_project_entries(config.projects.clone(), &base_dir());
    let categories_changed = reconcile_project_categories(&mut config);

    if !same_project_entries(&config.projects, &reconciled_projects) || categories_changed {
        config.projects = reconciled_projects;
        config::save_config(&config)?;
    } else {
        config.projects = reconciled_projects;
    }

    Ok(config)
}

fn register_project_entry(entry: ProjectEntry) -> Result<ProjectEntry, String> {
    let mut config = load_reconciled_config()?;

    if let Some(existing) =
        find_matching_project(&config.projects, &entry.source_path, Some(&entry.url))
    {
        return Ok(existing);
    }

    config.projects.push(entry.clone());
    config::save_config(&config)?;
    Ok(entry)
}

fn recover_existing_project(
    source_dir: &Path,
    fallback_url: &str,
    fallback_name: Option<&str>,
) -> Result<Project, String> {
    let source_path = source_dir.to_string_lossy().to_string();
    let config = load_reconciled_config()?;

    if let Some(existing) =
        find_matching_project(&config.projects, &source_path, Some(fallback_url))
    {
        return Ok(project_from_entry(existing));
    }

    Repository::open(source_dir).map_err(|e| {
        format!(
            "Project already exists at {} but could not be recovered: {e}",
            source_dir.display()
        )
    })?;

    let entry = project_entry_from_source(source_dir)
        .or_else(|_| project_entry_from_url(fallback_url, source_dir, fallback_name))?;
    let entry = register_project_entry(entry)?;
    Ok(project_from_entry(entry))
}

fn project_from_entry(entry: ProjectEntry) -> Project {
    let worktrees = resolve_project_worktrees(&entry);

    let path = std::path::Path::new(&entry.source_path);
    let source_has_changes = path.exists() && has_local_source_changes(path);

    let resolved_default_branch =
        remote_default_branch(path).unwrap_or_else(|_| "main".to_string());
    let source_behind_remote =
        check_source_behind_remote(&entry.source_path, &resolved_default_branch);

    Project {
        id: entry.id,
        name: entry.name,
        url: entry.url,
        org: entry.org,
        repo: entry.repo,
        source_path: entry.source_path,
        worktrees,
        source_has_changes,
        source_behind_remote,
        base_branch: entry.base_branch,
        resolved_default_branch,
        collapsed: entry.collapsed,
        category_id: entry
            .category_id
            .unwrap_or_else(|| config::DEFAULT_PROJECT_CATEGORY_ID.to_string()),
    }
}

fn projects_from_entries(entries: Vec<ProjectEntry>) -> Vec<Project> {
    if entries.len() <= 1 {
        return entries.into_iter().map(project_from_entry).collect();
    }

    let len = entries.len();
    let worker_count = project_load_worker_count(len);
    let tasks = Mutex::new(entries.into_iter().enumerate());
    let results = Mutex::new(
        std::iter::repeat_with(|| None)
            .take(len)
            .collect::<Vec<Option<Project>>>(),
    );

    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            let tasks = &tasks;
            let results = &results;

            scope.spawn(move || loop {
                let next = tasks
                    .lock()
                    .expect("project task queue lock poisoned")
                    .next();
                let Some((idx, entry)) = next else {
                    break;
                };

                let project = project_from_entry(entry);
                results.lock().expect("project result lock poisoned")[idx] = Some(project);
            });
        }
    });

    results
        .into_inner()
        .expect("project result lock poisoned")
        .into_iter()
        .map(|project| project.expect("missing project load result"))
        .collect()
}

fn project_load_worker_count(project_count: usize) -> usize {
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(MAX_PROJECT_LOAD_WORKERS)
        .min(project_count)
        .max(1)
}

fn check_source_behind_remote(source_path: &str, default_branch: &str) -> bool {
    let path = std::path::Path::new(source_path);
    if !path.exists() {
        return false;
    }

    let _ = maybe_fetch_source_remote(path);
    source_head_differs_from_remote(path, default_branch)
}

fn has_local_source_changes(source: &Path) -> bool {
    let repo = match git2::Repository::open(source) {
        Ok(r) => r,
        Err(_) => return false,
    };
    let statuses = match repo.statuses(Some(
        git2::StatusOptions::new()
            .include_untracked(true)
            .recurse_untracked_dirs(true),
    )) {
        Ok(s) => s,
        Err(_) => return false,
    };
    !statuses.is_empty()
}

fn maybe_fetch_source_remote(source: &Path) -> Result<(), String> {
    if !source_remote_refresh_due(source) {
        return Ok(());
    }

    run_git(source, &["fetch", "origin", "--prune", "--quiet"])
}

fn source_remote_refresh_due(source: &Path) -> bool {
    let repo = match Repository::open(source) {
        Ok(repo) => repo,
        Err(_) => return false,
    };
    let fetch_head = repo.path().join("FETCH_HEAD");

    let last_fetch = fs::metadata(fetch_head)
        .and_then(|metadata| metadata.modified())
        .ok();

    match last_fetch {
        Some(last_fetch) => match SystemTime::now().duration_since(last_fetch) {
            Ok(elapsed) => elapsed >= SOURCE_REMOTE_REFRESH_INTERVAL,
            Err(_) => true,
        },
        None => true,
    }
}

fn source_head_differs_from_remote(source: &Path, default_branch: &str) -> bool {
    let repo = match Repository::open(source) {
        Ok(repo) => repo,
        Err(_) => return false,
    };

    let remote_ref = format!("refs/remotes/origin/{default_branch}");

    let head = match repo.head().and_then(|head| head.peel_to_commit()) {
        Ok(commit) => commit,
        Err(_) => return false,
    };
    let remote_head = match repo
        .find_reference(&remote_ref)
        .and_then(|reference| reference.peel_to_commit())
    {
        Ok(commit) => commit,
        Err(_) => return false,
    };

    head.id() != remote_head.id()
}

fn normalized_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn visible_worktrees(worktrees: Vec<Worktree>, source_path: &str) -> Vec<Worktree> {
    let source_path = normalized_path(Path::new(source_path));
    worktrees
        .into_iter()
        .filter(|worktree| normalized_path(Path::new(&worktree.path)) != source_path)
        .collect()
}

fn parse_worktree_list(output: &str, project_base: &Path) -> Vec<Worktree> {
    let mut worktrees = Vec::new();
    let mut current_path = String::new();
    let mut current_branch = String::new();
    let mut is_bare = false;
    let normalized_project_base = normalized_path(project_base);

    for line in output.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            // Flush previous entry
            if !current_path.is_empty()
                && !is_bare
                && normalized_path(Path::new(&current_path)).starts_with(&normalized_project_base)
            {
                worktrees.push(make_worktree(&current_path, &current_branch, project_base));
            }
            current_path = path.to_string();
            current_branch.clear();
            is_bare = false;
        } else if let Some(branch) = line.strip_prefix("branch ") {
            current_branch = branch
                .strip_prefix("refs/heads/")
                .unwrap_or(branch)
                .to_string();
        } else if line == "bare" {
            is_bare = true;
        }
    }

    // Flush last entry
    if !current_path.is_empty()
        && !is_bare
        && normalized_path(Path::new(&current_path)).starts_with(&normalized_project_base)
    {
        worktrees.push(make_worktree(&current_path, &current_branch, project_base));
    }

    worktrees
}

fn make_worktree(path_str: &str, branch: &str, project_base: &Path) -> Worktree {
    let path = Path::new(path_str);
    let normalized_project_base = normalized_path(project_base);
    let normalized_path_buf = normalized_path(path);
    let name = if normalized_path_buf == normalized_project_base.join(SOURCE_WORKTREE_NAME) {
        SOURCE_WORKTREE_NAME.to_string()
    } else {
        // Derive name from relative path under worktrees/ to preserve slashes
        // e.g. <project>/worktrees/feat/new-feature → feat/new-feature
        let worktrees_dir = normalized_project_base.join("worktrees");
        normalized_path_buf
            .strip_prefix(&worktrees_dir)
            .ok()
            .map(|rel| rel.to_string_lossy().to_string())
            .unwrap_or_else(|| {
                path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| path_str.to_string())
            })
    };

    let display_path = normalized_path_buf
        .strip_prefix(&normalized_project_base)
        .ok()
        .map(|rel| project_base.join(rel).to_string_lossy().to_string())
        .unwrap_or_else(|| path_str.to_string());

    Worktree {
        name,
        path: display_path,
        branch: branch.to_string(),
        stack_parent_name: None,
    }
}

fn sort_worktrees_by_creation_time(worktrees: &mut Vec<Worktree>) {
    worktrees.sort_by_key(|wt| {
        std::fs::metadata(&wt.path)
            .and_then(|m| m.created())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
    });
}

fn apply_worktree_order(worktrees: Vec<Worktree>, order: &[String]) -> Vec<Worktree> {
    if order.is_empty() {
        return worktrees;
    }
    let mut ordered = Vec::with_capacity(worktrees.len());
    let mut remaining: Vec<Worktree> = worktrees;
    for name in order {
        if let Some(pos) = remaining.iter().position(|wt| &wt.name == name) {
            ordered.push(remaining.remove(pos));
        }
    }
    ordered.extend(remaining);
    ordered
}

fn stack_parent_chain_has_cycle(start: &str, mapping: &BTreeMap<String, String>) -> bool {
    let mut seen = HashSet::new();
    let mut current = start;

    while let Some(parent) = mapping.get(current) {
        if !seen.insert(current.to_string()) {
            return true;
        }
        current = parent;
    }

    false
}

fn normalized_stacked_parents(
    stacked_parents: &BTreeMap<String, String>,
    worktrees: &[Worktree],
) -> BTreeMap<String, String> {
    if stacked_parents.is_empty() {
        return BTreeMap::new();
    }

    let worktree_names = worktrees
        .iter()
        .map(|worktree| worktree.name.as_str())
        .collect::<HashSet<_>>();

    let filtered = stacked_parents
        .iter()
        .filter(|(child, parent)| {
            child.as_str() != parent.as_str()
                && worktree_names.contains(child.as_str())
                && worktree_names.contains(parent.as_str())
        })
        .map(|(child, parent)| (child.clone(), parent.clone()))
        .collect::<BTreeMap<_, _>>();

    let invalid_children = filtered
        .keys()
        .filter(|child| stack_parent_chain_has_cycle(child, &filtered))
        .cloned()
        .collect::<HashSet<_>>();

    filtered
        .into_iter()
        .filter(|(child, _)| !invalid_children.contains(child))
        .collect()
}

fn apply_stacked_parent_metadata(
    mut worktrees: Vec<Worktree>,
    stacked_parents: &BTreeMap<String, String>,
) -> Vec<Worktree> {
    let normalized = normalized_stacked_parents(stacked_parents, &worktrees);
    for worktree in &mut worktrees {
        worktree.stack_parent_name = normalized.get(&worktree.name).cloned();
    }
    worktrees
}

fn resolve_project_worktrees(entry: &ProjectEntry) -> Vec<Worktree> {
    let worktrees = visible_worktrees(
        get_worktrees_for_project(&entry.source_path),
        &entry.source_path,
    );
    let worktrees = apply_worktree_order(worktrees, &entry.worktree_order);
    apply_stacked_parent_metadata(worktrees, &entry.stacked_parents)
}

fn get_worktrees_for_project(source_path: &str) -> Vec<Worktree> {
    let source = Path::new(source_path);
    let project_base = source.parent().unwrap_or(source);

    let output = match git_command()
        .args(["worktree", "list", "--porcelain"])
        .current_dir(source)
        .output()
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return vec![],
    };

    let mut worktrees = parse_worktree_list(&output, project_base);
    sort_worktrees_by_creation_time(&mut worktrees);
    worktrees
}

fn managed_source_dir(entry: &ProjectEntry) -> Result<PathBuf, String> {
    let (host, org, repo) = parse_git_url(&entry.url)?;
    let expected = project_dir(&host, &org, &repo).join(SOURCE_WORKTREE_NAME);
    let actual = PathBuf::from(&entry.source_path);

    if normalized_path(&actual) != normalized_path(&expected) {
        return Err(format!(
            "Refusing to operate on unmanaged source path: {}",
            entry.source_path
        ));
    }

    Ok(actual)
}

pub fn list_projects_impl() -> Result<Vec<Project>, String> {
    let config = load_reconciled_config()?;
    Ok(projects_from_entries(config.projects))
}

pub fn add_project_impl(url: &str) -> Result<Project, String> {
    let (host, org, repo) = parse_git_url(url)?;
    let proj_dir = project_dir(&host, &org, &repo);
    let source_dir = proj_dir.join("source");
    let source_path = source_dir.to_string_lossy().to_string();

    let config = load_reconciled_config()?;
    if let Some(existing) = find_matching_project(&config.projects, &source_path, Some(url)) {
        return Ok(project_from_entry(existing));
    }

    if source_dir.is_dir() {
        return recover_existing_project(&source_dir, url, None);
    }

    std::fs::create_dir_all(&proj_dir)
        .map_err(|e| format!("Failed to create project directory: {e}"))?;
    std::fs::create_dir_all(proj_dir.join("worktrees"))
        .map_err(|e| format!("Failed to create worktrees directory: {e}"))?;

    let output = git_command()
        .args(["clone", url, &source_dir.to_string_lossy()])
        .output()
        .map_err(|e| format!("Failed to run git clone: {e}"))?;

    if !output.status.success() {
        // Cleanup on failure
        let _ = std::fs::remove_dir_all(&proj_dir);
        return Err(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let entry = register_project_entry(project_entry_from_url(url, &source_dir, None)?)?;

    Ok(project_from_entry(entry))
}

/// Validates URL, checks for duplicates, creates directories.
/// Returns `Cloning` when a new clone should be started, or `AlreadyExists` if the project is already registered.
pub fn start_clone_impl(url: &str) -> Result<StartCloneOutcome, String> {
    let (host, org, repo) = parse_git_url(url)?;
    let proj_dir = project_dir(&host, &org, &repo);
    let source_dir = proj_dir.join("source");
    let source_path = source_dir.to_string_lossy().to_string();

    let config = load_reconciled_config()?;
    if let Some(existing) = find_matching_project(&config.projects, &source_path, Some(url)) {
        return Ok(StartCloneOutcome::AlreadyExists(project_from_entry(
            existing,
        )));
    }

    if source_dir.is_dir() {
        return Ok(StartCloneOutcome::AlreadyExists(recover_existing_project(
            &source_dir,
            url,
            None,
        )?));
    }

    std::fs::create_dir_all(&proj_dir)
        .map_err(|e| format!("Failed to create project directory: {e}"))?;
    std::fs::create_dir_all(proj_dir.join("worktrees"))
        .map_err(|e| format!("Failed to create worktrees directory: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();

    Ok(StartCloneOutcome::Cloning(CloningProject {
        id,
        url: url.to_string(),
        org,
        repo,
    }))
}

/// Runs git clone and registers the project in config.
/// Called on a background thread after start_clone_impl succeeds.
/// The returned Project has its own persisted ID (generated by register_project_entry).
/// The caller is responsible for correlating this result back to the CloningProject.id
/// that was returned by start_clone_impl.
pub fn run_clone_impl(url: &str) -> Result<Project, String> {
    let (host, org, repo) = parse_git_url(url)?;
    let proj_dir = project_dir(&host, &org, &repo);
    let source_dir = proj_dir.join("source");

    let output = git_command()
        .args(["clone", url, &source_dir.to_string_lossy()])
        .output()
        .map_err(|e| format!("Failed to run git clone: {e}"))?;

    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&proj_dir);
        return Err(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let entry = register_project_entry(project_entry_from_url(url, &source_dir, None)?)?;
    Ok(project_from_entry(entry))
}

pub fn create_project_impl(name: &str, remote_url: &str) -> Result<Project, String> {
    let (host, org, repo) = parse_git_url(remote_url)?;
    let proj_dir = project_dir(&host, &org, &repo);
    let source_dir = proj_dir.join("source");
    let source_path = source_dir.to_string_lossy().to_string();

    let config = load_reconciled_config()?;
    if let Some(existing) = find_matching_project(&config.projects, &source_path, Some(remote_url))
    {
        return Ok(project_from_entry(existing));
    }

    if source_dir.is_dir() {
        return recover_existing_project(&source_dir, remote_url, Some(name));
    }

    std::fs::create_dir_all(&source_dir)
        .map_err(|e| format!("Failed to create source directory: {e}"))?;
    std::fs::create_dir_all(proj_dir.join("worktrees"))
        .map_err(|e| format!("Failed to create worktrees directory: {e}"))?;

    // git init
    run_git(&source_dir, &["init"])?;
    // git remote add origin
    run_git(&source_dir, &["remote", "add", "origin", remote_url])?;
    // Create initial commit
    let readme = source_dir.join("README.md");
    std::fs::write(&readme, format!("# {name}\n"))
        .map_err(|e| format!("Failed to write README: {e}"))?;
    run_git(&source_dir, &["add", "README.md"])?;
    run_git(&source_dir, &["commit", "-m", "Initial commit"])?;
    // Ensure we're on main branch
    run_git(&source_dir, &["branch", "-M", "main"])?;
    // Push (may fail if remote doesn't exist yet — non-fatal)
    let _ = run_git(&source_dir, &["push", "-u", "origin", "main"]);

    let entry =
        register_project_entry(project_entry_from_url(remote_url, &source_dir, Some(name))?)?;

    Ok(project_from_entry(entry))
}

pub fn remove_project_impl(project_id: &str) -> Result<(), String> {
    let mut config = config::load_config();
    let idx = config
        .projects
        .iter()
        .position(|p| p.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;

    let entry = config.projects[idx].clone();
    let source = managed_source_dir(&entry)?;
    let project_dir = source
        .parent()
        .ok_or_else(|| format!("Invalid managed source path: {}", entry.source_path))?
        .to_path_buf();

    config.projects.remove(idx);
    config::save_config(&config)?;

    // Cleanup directory (source parent = project dir)
    let _ = std::fs::remove_dir_all(project_dir);

    Ok(())
}

pub fn reorder_projects_impl(project_ids: Vec<String>) -> Result<(), String> {
    let mut config = load_reconciled_config()?;
    let mut reordered = Vec::with_capacity(config.projects.len());
    for id in &project_ids {
        if let Some(entry) = config.projects.iter().find(|e| &e.id == id) {
            reordered.push(entry.clone());
        }
    }
    // Append any projects not in the provided list (safety net)
    for entry in &config.projects {
        if !project_ids.contains(&entry.id) {
            reordered.push(entry.clone());
        }
    }
    config.projects = reordered;
    config::save_config(&config)
}

pub fn list_gitignore_patterns_impl(project_id: &str) -> Result<Vec<String>, String> {
    let entry = find_project_entry(project_id)?;
    let source_dir = managed_source_dir(&entry)?;

    let mut patterns = std::collections::BTreeSet::new();

    // Read root .gitignore directly (may be untracked)
    let root_gitignore = source_dir.join(".gitignore");
    if let Ok(content) = std::fs::read_to_string(&root_gitignore) {
        collect_gitignore_patterns(&content, &mut patterns);
    }

    // Find nested .gitignore files from git index only (no filesystem walk)
    let gitignore_files =
        run_git_output(&source_dir, &["ls-files", "--cached", "--", "*/.gitignore"])?;
    for rel_path in gitignore_files
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
    {
        let abs_path = source_dir.join(rel_path);
        if let Ok(content) = std::fs::read_to_string(&abs_path) {
            collect_gitignore_patterns(&content, &mut patterns);
        }
    }

    // Also read .git/info/exclude
    let git_dir = run_git_output(&source_dir, &["rev-parse", "--git-dir"])?;
    let exclude_path = Path::new(git_dir.trim()).join("info/exclude");
    let exclude_path = if exclude_path.is_absolute() {
        exclude_path
    } else {
        source_dir.join(exclude_path)
    };
    if let Ok(content) = std::fs::read_to_string(&exclude_path) {
        collect_gitignore_patterns(&content, &mut patterns);
    }

    Ok(patterns.into_iter().collect())
}

fn collect_gitignore_patterns(content: &str, patterns: &mut std::collections::BTreeSet<String>) {
    for line in content.lines() {
        let line = line.trim();
        if !line.is_empty()
            && !line.starts_with('#')
            && !line.starts_with('!')
            && is_env_relevant_pattern(line)
        {
            patterns.insert(line.to_string());
        }
    }
}

/// Filter out build artifacts, dependencies, and OS junk that nobody
/// would ever want to sync into a worktree.
fn is_env_relevant_pattern(pattern: &str) -> bool {
    let p = pattern.trim_end_matches('/');
    // Filter directories that either (a) fetch packages dynamically or
    // (b) generate 100+ files that don't belong in git.
    const SKIP_DIRS: &[&str] = &[
        // Package managers (fetched dependencies)
        "node_modules",
        "Pods",
        "vendor",
        ".gradle",
        "venv",
        ".venv",
        // Build output (100+ generated files)
        "target",
        "build",
        ".build",
        "DerivedData",
        ".next",
        ".nuxt",
        "__pycache__",
    ];
    if SKIP_DIRS.iter().any(|s| p.eq_ignore_ascii_case(s)) {
        return false;
    }
    const SKIP_EXACT: &[&str] = &[];
    if SKIP_EXACT.contains(&pattern) {
        return false;
    }
    true
}

pub(crate) fn sync_env_files(
    source_dir: &Path,
    worktree_dir: &Path,
    include: &[String],
) -> Result<(), String> {
    if include.is_empty() {
        return Ok(());
    }

    let include_set: std::collections::HashSet<&str> = include.iter().map(String::as_str).collect();

    let files_output = run_git_output(
        source_dir,
        &["ls-files", "--others", "--ignored", "--exclude-standard"],
    )?;

    let files: Vec<&str> = files_output
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.contains(".."))
        .collect();

    if files.is_empty() {
        return Ok(());
    }

    // Use git check-ignore to resolve which pattern each file matches
    let input = files.join("\n");
    let output = std::process::Command::new("git")
        .args(["check-ignore", "--stdin", "-v"])
        .current_dir(source_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            if let Some(ref mut stdin) = child.stdin {
                stdin.write_all(input.as_bytes()).ok();
            }
            drop(child.stdin.take());
            child.wait_with_output()
        })
        .map_err(|e| format!("git check-ignore failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    for line in stdout.lines() {
        // Format: "<source>:<linenum>:<pattern>\t<pathname>"
        let Some((rule_part, rel_path)) = line.split_once('\t') else {
            continue;
        };
        let rel_path = rel_path.trim();
        if rel_path.is_empty() || rel_path.contains("..") {
            continue;
        }

        // Extract pattern: skip source path and line number
        let pattern = rule_part
            .find(':')
            .and_then(|i| {
                rule_part[i + 1..]
                    .find(':')
                    .map(|j| &rule_part[i + 1 + j + 1..])
            })
            .map(|p| p.trim())
            .unwrap_or("");

        if !include_set.contains(pattern) {
            continue;
        }

        let src = source_dir.join(rel_path);
        let dst = worktree_dir.join(rel_path);
        if !src.is_file() {
            continue;
        }
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("env sync: mkdir {}: {e}", parent.display()))?;
        }
        std::fs::copy(&src, &dst)
            .map_err(|e| format!("env sync: copy {} -> {}: {e}", src.display(), dst.display()))?;
    }

    Ok(())
}

pub fn add_worktree_impl(project_id: &str, name: &str) -> Result<Worktree, String> {
    validate_branch_name(name)?;

    let entry = find_project_entry(project_id)?;
    let source_dir = managed_source_dir(&entry)?;
    let source = source_dir.as_path();

    if !source.exists() {
        return Err(format!("Source directory not found: {}", entry.source_path));
    }

    // Fetch latest from origin
    let _ = run_git(source, &["fetch", "--prune", "origin"]);

    let default_branch = match &entry.base_branch {
        Some(branch) => {
            let remote_ref = format!("refs/remotes/origin/{branch}");
            if run_git(source, &["show-ref", "--verify", &remote_ref]).is_ok() {
                branch.clone()
            } else {
                eprintln!(
                    "Configured base branch '{}' not found on remote, falling back to auto-detect",
                    branch
                );
                remote_default_branch(source)?
            }
        }
        None => remote_default_branch(source)?,
    };

    let worktree_path = source
        .parent()
        .unwrap_or(source)
        .join("worktrees")
        .join(name);

    let worktree_path_str = worktree_path.to_string_lossy().to_string();
    let local_branches = local_branch_names(source)?;

    if let Some(conflicting_branch) = find_branch_prefix_conflict(&local_branches, name) {
        return Err(format_branch_prefix_conflict(name, conflicting_branch));
    }

    let local_exists = local_branches.iter().any(|branch| branch == name);

    if local_exists {
        // Branch already exists locally — just check it out in a new worktree
        run_worktree_add(source, &["worktree", "add", &worktree_path_str, name], name)?;
    } else {
        let remote_branch = format!("origin/{name}");
        let remote_exists =
            run_git_output(source, &["rev-parse", "--verify", &remote_branch]).is_ok();

        if remote_exists {
            // Track existing remote branch
            run_worktree_add(
                source,
                &[
                    "worktree",
                    "add",
                    &worktree_path_str,
                    "-b",
                    name,
                    &remote_branch,
                ],
                name,
            )?;
        } else {
            // Create new branch from default branch
            let base_ref = format!("origin/{default_branch}");
            run_worktree_add(
                source,
                &["worktree", "add", &worktree_path_str, "-b", name, &base_ref],
                name,
            )?;
        }
    }

    if let Some(ref env_sync) = entry.env_sync {
        if let Err(e) = sync_env_files(source, &worktree_path, &env_sync.include_patterns) {
            eprintln!("[grove] env sync warning: {e}");
        }
    }

    let mut config = config::load_config();
    let project_entry = config
        .projects
        .iter_mut()
        .find(|project| project.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    project_entry.stacked_parents.remove(name);
    config::save_config(&config)?;

    Ok(Worktree {
        name: name.to_string(),
        path: worktree_path_str,
        branch: name.to_string(),
        stack_parent_name: None,
    })
}

fn find_worktree_named<'a>(worktrees: &'a [Worktree], name: &str) -> Option<&'a Worktree> {
    worktrees.iter().find(|worktree| worktree.name == name)
}

fn direct_stacked_children(
    worktrees: &[Worktree],
    stacked_parents: &BTreeMap<String, String>,
    parent_name: &str,
) -> Vec<String> {
    let normalized = normalized_stacked_parents(stacked_parents, worktrees);

    worktrees
        .iter()
        .filter_map(|worktree| {
            (normalized.get(&worktree.name).map(String::as_str) == Some(parent_name))
                .then(|| worktree.name.clone())
        })
        .collect()
}

pub fn add_stacked_worktree_impl(
    project_id: &str,
    parent_name: &str,
    name: &str,
) -> Result<Worktree, String> {
    validate_branch_name(name)?;

    let entry = find_project_entry(project_id)?;
    let source_dir = managed_source_dir(&entry)?;
    let source = source_dir.as_path();

    if !source.exists() {
        return Err(format!("Source directory not found: {}", entry.source_path));
    }

    let _ = run_git(source, &["fetch", "--prune", "origin"]);

    let worktrees = resolve_project_worktrees(&entry);
    let parent_worktree = find_worktree_named(&worktrees, parent_name)
        .ok_or_else(|| format!("Parent worktree not found: {parent_name}"))?;
    let parent_worktree_path = PathBuf::from(&parent_worktree.path);
    if !parent_worktree_path.exists() {
        return Err(format!(
            "Parent worktree path not found: {}",
            parent_worktree.path
        ));
    }

    let worktree_path = source
        .parent()
        .unwrap_or(source)
        .join("worktrees")
        .join(name);
    let worktree_path_str = worktree_path.to_string_lossy().to_string();

    let local_branches = local_branch_names(source)?;
    if let Some(conflicting_branch) = find_branch_prefix_conflict(&local_branches, name) {
        return Err(format_branch_prefix_conflict(name, conflicting_branch));
    }
    if local_branches.iter().any(|branch| branch == name) {
        return Err(format!(
            "Cannot create stacked worktree '{name}' because branch '{name}' already exists locally. Use a new branch name for stacked worktrees."
        ));
    }

    let remote_branches = remote_branch_names(source)?;
    if remote_branches.iter().any(|branch| branch == name) {
        return Err(format!(
            "Cannot create stacked worktree '{name}' because branch '{name}' already exists on origin. Use a new branch name for stacked worktrees."
        ));
    }

    let parent_head = run_git_output(&parent_worktree_path, &["rev-parse", "HEAD"])?;
    run_worktree_add(
        source,
        &[
            "worktree",
            "add",
            &worktree_path_str,
            "-b",
            name,
            &parent_head,
        ],
        name,
    )?;

    if let Some(ref env_sync) = entry.env_sync {
        if let Err(error) = sync_env_files(
            &parent_worktree_path,
            &worktree_path,
            &env_sync.include_patterns,
        ) {
            eprintln!("[grove] env sync warning: {error}");
        }
    }

    let mut config = config::load_config();
    let project_entry = config
        .projects
        .iter_mut()
        .find(|project| project.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    project_entry
        .stacked_parents
        .insert(name.to_string(), parent_name.to_string());
    config::save_config(&config)?;

    Ok(Worktree {
        name: name.to_string(),
        path: worktree_path_str,
        branch: name.to_string(),
        stack_parent_name: Some(parent_name.to_string()),
    })
}

fn run_worktree_add(cwd: &Path, args: &[&str], branch_name: &str) -> Result<(), String> {
    run_git(cwd, args).map_err(|err| humanize_worktree_add_error(branch_name, &err))
}

pub fn remove_worktree_impl(project_id: &str, worktree_name: &str) -> Result<(), String> {
    let entry = find_project_entry(project_id)?;
    let source_dir = managed_source_dir(&entry)?;
    let source = source_dir.as_path();

    if !source.exists() {
        return Err(format!("Source directory not found: {}", entry.source_path));
    }

    let worktrees = resolve_project_worktrees(&entry);
    let child_names = direct_stacked_children(&worktrees, &entry.stacked_parents, worktree_name);
    if !child_names.is_empty() {
        return Err(format!(
            "Cannot remove worktree '{worktree_name}' because it has stacked children: {}. Remove child worktrees first.",
            child_names.join(", ")
        ));
    }

    let worktree_path = source
        .parent()
        .unwrap_or(source)
        .join("worktrees")
        .join(worktree_name);

    let worktree_path_str = worktree_path.to_string_lossy();

    crate::worktree_lifecycle::default_worktree_lifecycle().cleanup(&worktree_path_str);

    run_git(
        source,
        &["worktree", "remove", &worktree_path_str, "--force"],
    )?;

    if let Err(error) = run_git(source, &["branch", "-D", worktree_name]) {
        eprintln!(
            "Warning: removed worktree {worktree_name}, but failed to delete local branch: {error}"
        );
    }

    let mut config = config::load_config();
    let project_entry = config
        .projects
        .iter_mut()
        .find(|project| project.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    project_entry
        .worktree_order
        .retain(|name| name != worktree_name);
    project_entry.stacked_parents.remove(worktree_name);
    config::save_config(&config)?;

    Ok(())
}

pub fn list_worktrees_impl(project_id: &str) -> Result<Vec<Worktree>, String> {
    let entry = find_project_entry(project_id)?;
    Ok(resolve_project_worktrees(&entry))
}

pub fn get_worktree_pr_url_impl(
    worktree_path: &str,
) -> Result<Option<WorktreePullRequest>, String> {
    let worktree = Path::new(worktree_path);
    let repo = Repository::open(worktree).map_err(|e| {
        format!(
            "Failed to open git repository at {}: {e}",
            worktree.display()
        )
    })?;
    let head = repo
        .head()
        .map_err(|e| format!("Failed to read HEAD for {}: {e}", worktree.display()))?;
    let Some(branch_name) = head.shorthand().filter(|name| !name.is_empty()) else {
        return Ok(None);
    };
    if !head.is_branch() {
        return Ok(None);
    }
    let branch_name = branch_name.to_string();

    let head_oid = head
        .peel_to_commit()
        .map_err(|e| {
            format!(
                "Failed to resolve HEAD commit for {}: {e}",
                worktree.display()
            )
        })?
        .id();

    let remote_url = remote_url_for_repo(worktree)?;
    let Some((host, org, repo_name)) = github_remote(&remote_url) else {
        return Ok(None);
    };

    match github_pull_request_via_cli(&host, &org, &repo_name, &branch_name, head_oid).or_else(
        |_| {
            github_pull_request_via_interactive_shell(
                &host,
                &org,
                &repo_name,
                &branch_name,
                head_oid,
            )
        },
    ) {
        Ok(Some(pull_request)) => return Ok(Some(pull_request)),
        Ok(None) => return Ok(None),
        Err(error) => {
            eprintln!(
                "Warning: failed to determine pull request status via gh for {}: {error}",
                worktree.display()
            );
        }
    }

    let pull_refs_output =
        match run_git_output(worktree, &["ls-remote", "origin", "refs/pull/*/head"])
            .or_else(|_| git_ls_remote_pull_heads_via_interactive_shell(worktree))
        {
            Ok(output) => output,
            Err(error) => {
                eprintln!(
                    "Warning: failed to query pull refs for {}: {error}",
                    worktree.display()
                );
                return Ok(None);
            }
        };
    let pull_refs = parse_pull_request_head_refs(&pull_refs_output);
    let Some(number) = find_pull_request_number_for_head(&pull_refs, head_oid) else {
        return Ok(None);
    };

    Ok(Some(WorktreePullRequest {
        url: canonical_pull_request_url(&host, &org, &repo_name, number),
        status: WorktreePullRequestStatus::Unknown,
    }))
}

pub fn create_worktree_pr_impl(worktree_path: &str) -> Result<(), String> {
    let worktree = Path::new(worktree_path);
    let repo = Repository::open(worktree).map_err(|e| {
        format!(
            "Failed to open git repository for {}: {e}",
            worktree.display()
        )
    })?;
    let head = repo
        .head()
        .map_err(|e| format!("Failed to read HEAD for {}: {e}", worktree.display()))?;
    let Some(branch_name) = head.shorthand().filter(|name| !name.is_empty()) else {
        return Err(format!(
            "Cannot create a pull request for detached HEAD at {}",
            worktree.display()
        ));
    };
    if !head.is_branch() {
        return Err(format!(
            "Cannot create a pull request for detached HEAD at {}",
            worktree.display()
        ));
    }

    let remote_url = repo
        .find_remote("origin")
        .ok()
        .and_then(|remote| remote.url().map(str::to_owned))
        .or_else(|| remote_url_for_repo(worktree).ok())
        .ok_or_else(|| format!("No git remote URL found for {}", worktree.display()))?;
    let Some((host, org, repo_name)) = github_remote(&remote_url) else {
        return Err(format!(
            "Pull request creation is only supported for GitHub remotes: {}",
            remote_url
        ));
    };

    create_github_pull_request_via_cli(worktree, &host, &org, &repo_name, branch_name).or_else(
        |_| {
            create_github_pull_request_via_interactive_shell(
                worktree,
                &host,
                &org,
                &repo_name,
                branch_name,
            )
        },
    )
}

pub fn set_worktree_order_impl(project_id: &str, order: Vec<String>) -> Result<(), String> {
    let mut config = config::load_config();
    let entry = config
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    entry.worktree_order = order;
    config::save_config(&config)
}

pub fn get_remote_branches_impl(project_id: &str) -> Result<Vec<String>, String> {
    let entry = find_project_entry(project_id)?;
    let source_dir = managed_source_dir(&entry)?;
    let source = source_dir.as_path();

    if !source.exists() {
        return Err(format!("Source directory not found: {}", entry.source_path));
    }

    let _ = maybe_fetch_source_remote(source);

    let mut branches = remote_branch_names(source)?;
    branches.sort();
    Ok(branches)
}

pub fn set_project_collapsed_impl(project_id: &str, collapsed: bool) -> Result<(), String> {
    let mut config = config::load_config();
    let entry = config
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    entry.collapsed = collapsed;
    config::save_config(&config)
}

pub fn rename_project_impl(project_id: &str, name: String) -> Result<(), String> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err("Project name cannot be empty".to_string());
    }

    let mut config = config::load_config();
    let entry = config
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    entry.name = trimmed;
    config::save_config(&config)
}

pub fn set_project_category_impl(project_id: &str, category_id: &str) -> Result<(), String> {
    let mut config = load_reconciled_config()?;
    let available_ids = available_project_category_ids(&config);
    let normalized_category_id =
        normalize_project_category_id(Some(category_id.to_string()), &available_ids);

    if category_id.trim() != config::DEFAULT_PROJECT_CATEGORY_ID && normalized_category_id.is_none()
    {
        return Err(format!(
            "Project category not found: {}",
            category_id.trim()
        ));
    }

    let entry = config
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    entry.category_id = normalized_category_id;
    config::save_config(&config)
}

pub fn delete_project_category_impl(category_id: &str) -> Result<(), String> {
    let category_id = category_id.trim();
    if category_id.is_empty() || category_id == config::DEFAULT_PROJECT_CATEGORY_ID {
        return Err("Default project category cannot be deleted".to_string());
    }

    let mut config = load_reconciled_config()?;
    let mut preferences = config.preferences.clone().unwrap_or_default().normalized();
    let previous_len = preferences.project_categories.len();
    preferences
        .project_categories
        .retain(|category| category.id != category_id);

    if preferences.project_categories.len() == previous_len {
        return Err(format!("Project category not found: {category_id}"));
    }

    for entry in &mut config.projects {
        if entry.category_id.as_deref() == Some(category_id) {
            entry.category_id = None;
        }
    }

    config.preferences = Some(preferences);
    config::save_config(&config)
}

pub fn set_base_branch_impl(project_id: &str, branch: Option<String>) -> Result<(), String> {
    if let Some(ref branch_name) = branch {
        let entry = find_project_entry(project_id)?;
        let source_dir = managed_source_dir(&entry)?;
        let source = source_dir.as_path();

        if !source.exists() {
            return Err(format!("Source directory not found: {}", entry.source_path));
        }

        let remote_ref = format!("refs/remotes/origin/{branch_name}");
        run_git(source, &["show-ref", "--verify", &remote_ref])
            .map_err(|_| format!("Branch '{}' not found in remote", branch_name))?;
    }

    let mut config = config::load_config();
    let entry = config
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    entry.base_branch = branch;
    config::save_config(&config)
}

pub fn set_env_sync_impl(
    project_id: &str,
    env_sync: config::ProjectEnvSyncConfig,
) -> Result<(), String> {
    let mut grove_config = config::load_config();
    let entry = grove_config
        .projects
        .iter_mut()
        .find(|p| p.id == project_id)
        .ok_or_else(|| format!("Project not found: {project_id}"))?;
    entry.env_sync = if env_sync.include_patterns.is_empty() {
        None
    } else {
        Some(env_sync)
    };
    config::save_config(&grove_config)
}

pub fn get_env_sync_impl(project_id: &str) -> Result<Option<config::ProjectEnvSyncConfig>, String> {
    let entry = find_project_entry(project_id)?;
    Ok(entry.env_sync)
}

pub fn is_source_dirty_impl(project_id: &str) -> Result<bool, String> {
    let entry = find_project_entry(project_id)?;
    let source_dir = managed_source_dir(&entry)?;

    if !source_dir.exists() {
        return Ok(false);
    }

    Ok(has_local_source_changes(&source_dir))
}

pub fn refresh_project_impl(project_id: &str) -> Result<Project, String> {
    let entry = find_project_entry(project_id)?;
    let source_dir = managed_source_dir(&entry)?;
    let source = source_dir.as_path();

    if !source.exists() {
        return Err(format!("Source directory not found: {}", entry.source_path));
    }

    refresh_source_repo(source, entry.base_branch.as_deref())?;
    Ok(project_from_entry(entry))
}

fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Branch name cannot be empty".to_string());
    }
    if name.starts_with('/') || name.ends_with('/') || name.contains("//") {
        return Err(format!("Invalid branch name: {name}"));
    }
    if name.starts_with('-') || name.starts_with('.') {
        return Err(format!("Invalid branch name: {name}"));
    }
    if name.contains("..")
        || name.contains(" ")
        || name.contains("~")
        || name.contains("^")
        || name.contains(":")
        || name.contains("\\")
        || name.contains("*")
        || name.contains("?")
        || name.contains("[")
        || name.ends_with('.')
        || name.ends_with(".lock")
    {
        return Err(format!("Invalid branch name: {name}"));
    }
    Ok(())
}

pub(crate) fn run_git(cwd: &Path, args: &[&str]) -> Result<(), String> {
    run_git_output(cwd, args).map(|_| ())
}

pub(crate) fn run_git_output(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command()
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git {}: {e}", args.first().unwrap_or(&"")))?;

    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn remote_default_branch(source: &Path) -> Result<String, String> {
    if let Ok(branch) = resolve_origin_head(source) {
        return Ok(branch);
    }

    if let Ok(branches) = local_branch_names(source) {
        if branches.len() == 1 {
            return Ok(branches[0].clone());
        }
    }

    if let Ok(branches) = remote_branch_names(source) {
        if branches.len() == 1 {
            return Ok(branches[0].clone());
        }
    }

    for candidate in ["main", "master"] {
        let remote_ref = format!("refs/remotes/origin/{candidate}");
        let args = ["show-ref", "--verify", remote_ref.as_str()];
        if run_git(source, &args).is_ok() {
            return Ok(candidate.to_string());
        }
    }

    let branch = run_git_output(source, &["branch", "--show-current"])?;
    if !branch.is_empty() {
        return Ok(branch);
    }

    let _ = run_git(source, &["remote", "set-head", "origin", "-a"]);

    if let Ok(branch) = resolve_origin_head(source) {
        return Ok(branch);
    }

    Err(format!(
        "Failed to resolve origin default branch for {}",
        source.display()
    ))
}

fn local_branch_names(source: &Path) -> Result<Vec<String>, String> {
    let output = run_git_output(
        source,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect())
}

fn find_branch_prefix_conflict<'a>(branches: &'a [String], requested: &str) -> Option<&'a str> {
    branches
        .iter()
        .find(|branch| {
            branch.as_str() != requested
                && (requested.starts_with(&format!("{branch}/"))
                    || branch.starts_with(&format!("{requested}/")))
        })
        .map(|branch| branch.as_str())
}

fn format_branch_prefix_conflict(requested: &str, conflicting: &str) -> String {
    format!(
        "Cannot create branch '{requested}' because branch '{conflicting}' already exists. Git cannot keep both '{requested}' and '{conflicting}' because one name is a prefix of the other. Use a different branch name, or rename/delete the existing branch."
    )
}

fn humanize_worktree_add_error(branch_name: &str, err: &str) -> String {
    if let Some(conflicting_branch) = parse_branch_prefix_conflict_from_git_error(err) {
        return format_branch_prefix_conflict(branch_name, &conflicting_branch);
    }
    err.to_string()
}

fn parse_branch_prefix_conflict_from_git_error(err: &str) -> Option<String> {
    let needle = "cannot create 'refs/heads/";
    let start = err.find(needle)? + needle.len();
    let rest = &err[start..];
    let end = rest.find('\'')?;
    let requested = &rest[..end];

    let exists_marker = "'refs/heads/";
    let exists_start = err.find(exists_marker)? + exists_marker.len();
    let exists_rest = &err[exists_start..];
    let exists_end = exists_rest.find("' exists;")?;
    let existing = &exists_rest[..exists_end];

    if requested == existing {
        return None;
    }

    let requested_prefix = format!("{requested}/");
    let existing_prefix = format!("{existing}/");
    if requested.starts_with(&existing_prefix) || existing.starts_with(&requested_prefix) {
        return Some(existing.to_string());
    }

    None
}

fn remote_branch_names(source: &Path) -> Result<Vec<String>, String> {
    let output = run_git_output(
        source,
        &[
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/remotes/origin",
        ],
    )?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| line.strip_prefix("origin/"))
        .filter(|line| *line != "HEAD")
        .map(|line| line.to_string())
        .collect())
}

fn resolve_origin_head(source: &Path) -> Result<String, String> {
    let symbolic_ref = run_git_output(
        source,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )?;
    symbolic_ref
        .strip_prefix("origin/")
        .map(|branch| branch.to_string())
        .ok_or_else(|| format!("Unexpected origin HEAD ref: {symbolic_ref}"))
}

fn create_source_sync_stash(source: &Path) -> Result<Option<String>, String> {
    if !has_local_source_changes(source) {
        return Ok(None);
    }

    let stash_label = format!("grove-source-sync-{}", Uuid::new_v4());
    run_git(
        source,
        &[
            "stash",
            "push",
            "--include-untracked",
            "-m",
            stash_label.as_str(),
        ],
    )?;

    let stash_ref = run_git_output(source, &["rev-parse", "-q", "--verify", "refs/stash"])?;
    Ok(Some(stash_ref))
}

fn resolve_stash_selector(source: &Path, stash_ref: &str) -> Result<String, String> {
    let stash_list = run_git_output(source, &["stash", "list", "--format=%H %gd"])?;

    stash_list
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let selector = parts.next()?;
            (hash == stash_ref).then(|| selector.to_string())
        })
        .ok_or_else(|| format!("Temporary stash {stash_ref} is no longer present"))
}

fn restore_source_sync_stash(source: &Path, stash_ref: &str, context: &str) -> Result<(), String> {
    if let Err(e) = run_git(source, &["stash", "apply", stash_ref]) {
        return Err(format!(
            "{context}. Restoring local changes from temporary stash {stash_ref} failed: {e}. Your changes are still available in that stash entry. Recover them with `git stash apply {stash_ref}` or inspect them with `git stash show -p {stash_ref}`."
        ));
    }

    let stash_selector = resolve_stash_selector(source, stash_ref)?;
    if let Err(e) = run_git(source, &["stash", "drop", stash_selector.as_str()]) {
        return Err(format!(
            "{context}. Local changes were restored from temporary stash {stash_ref}, but dropping that stash failed: {e}. You can remove it manually with `git stash drop {stash_selector}`."
        ));
    }

    Ok(())
}

fn refresh_source_repo(source: &Path, base_branch: Option<&str>) -> Result<(), String> {
    let default_branch = match base_branch {
        Some(branch) => {
            let remote_ref = format!("refs/remotes/origin/{branch}");
            if run_git(source, &["show-ref", "--verify", &remote_ref]).is_ok() {
                branch.to_string()
            } else {
                eprintln!(
                    "Configured base branch '{}' not found on remote, falling back to auto-detect",
                    branch
                );
                remote_default_branch(source)?
            }
        }
        None => remote_default_branch(source)?,
    };
    let sync_stash_ref = create_source_sync_stash(source)?;

    let restore_after_error = |base: String| -> Result<(), String> {
        if let Some(stash_ref) = sync_stash_ref.as_deref() {
            if let Err(restore_err) = restore_source_sync_stash(source, stash_ref, &base) {
                return Err(format!("{base}\n{restore_err}"));
            }
        }

        Err(base)
    };

    if let Err(e) = run_git(source, &["checkout", &default_branch]) {
        return restore_after_error(format!(
            "Failed to switch source repo to default branch '{default_branch}' during sync: {e}"
        ));
    }

    if let Err(e) = run_git(source, &["fetch", "--prune", "origin"]) {
        return restore_after_error(format!("Failed to fetch origin during source sync: {e}"));
    }

    if let Err(e) = run_git(source, &["pull", "--rebase", "origin", &default_branch]) {
        let _ = run_git(source, &["rebase", "--abort"]);
        return restore_after_error(format!(
            "Rebase failed during source sync (local commits may conflict with upstream): {e}"
        ));
    }

    if let Some(stash_ref) = sync_stash_ref.as_deref() {
        restore_source_sync_stash(
            source,
            stash_ref,
            "Source sync completed, but reapplying local changes failed",
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::env_lock;
    use std::ffi::OsString;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn github_remote_accepts_github_urls_and_rejects_others() {
        assert_eq!(
            github_remote("https://github.com/bang9/grove.git"),
            Some((
                "github.com".to_string(),
                "bang9".to_string(),
                "grove".to_string(),
            ))
        );
        assert_eq!(
            github_remote("git@github.sendbird.com:product/grove.git"),
            Some((
                "github.sendbird.com".to_string(),
                "product".to_string(),
                "grove".to_string(),
            ))
        );
        assert_eq!(github_remote("https://gitlab.com/bang9/grove.git"), None);
    }

    #[test]
    fn parse_pull_request_head_refs_matches_head_oid() {
        let head_oid = Oid::from_str("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").unwrap();
        let refs = parse_pull_request_head_refs(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/pull/11/head\n\
             bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/pull/42/head\n\
             invalid\trefs/pull/not-a-number/head\n",
        );

        assert_eq!(
            refs,
            vec![
                PullRequestHeadRef {
                    number: 11,
                    oid: Oid::from_str("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap(),
                },
                PullRequestHeadRef {
                    number: 42,
                    oid: head_oid,
                },
            ]
        );
        assert_eq!(find_pull_request_number_for_head(&refs, head_oid), Some(42));
    }

    #[test]
    fn canonical_pull_request_url_uses_remote_identity() {
        assert_eq!(
            canonical_pull_request_url("github.com", "bang9", "grove", 42),
            "https://github.com/bang9/grove/pull/42"
        );
        assert_eq!(
            canonical_pull_request_url("github.sendbird.com", "product", "grove", 7),
            "https://github.sendbird.com/product/grove/pull/7"
        );
    }

    #[test]
    fn select_github_pull_request_prefers_open_and_merged_results() {
        let branch_name = "fix/rn-scroll-flicker";
        let head_oid = Oid::from_str("c45c4ac7074d75bcb5d391b1e4ff4c7870d2ae02").unwrap();
        let pull_requests = vec![
            GithubPullRequestSummary {
                url: "https://github.com/sendbird/ai-agent-js/pull/700".to_string(),
                state: "CLOSED".to_string(),
                head_ref_name: branch_name.to_string(),
                head_ref_oid: "deadbeef074d75bcb5d391b1e4ff4c7870d2ae02".to_string(),
                merged_at: None,
                updated_at: "2026-03-23T08:16:20Z".to_string(),
            },
            GithubPullRequestSummary {
                url: "https://github.com/sendbird/ai-agent-js/pull/805".to_string(),
                state: "CLOSED".to_string(),
                head_ref_name: branch_name.to_string(),
                head_ref_oid: "deadbeef074d75bcb5d391b1e4ff4c7870d2ae02".to_string(),
                merged_at: Some("2026-03-24T08:16:20Z".to_string()),
                updated_at: "2026-03-24T08:16:20Z".to_string(),
            },
            GithubPullRequestSummary {
                url: "https://github.com/sendbird/ai-agent-js/pull/806".to_string(),
                state: "OPEN".to_string(),
                head_ref_name: branch_name.to_string(),
                head_ref_oid: head_oid.to_string(),
                merged_at: None,
                updated_at: "2026-03-26T08:16:20Z".to_string(),
            },
        ];

        assert_eq!(
            select_github_pull_request(&pull_requests, branch_name, head_oid),
            Some(WorktreePullRequest {
                url: "https://github.com/sendbird/ai-agent-js/pull/806".to_string(),
                status: WorktreePullRequestStatus::Open,
            })
        );
    }

    #[test]
    fn select_github_pull_request_uses_latest_merged_when_no_open_pr_exists() {
        let branch_name = "release/2026-03-26";
        let head_oid = Oid::from_str("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        let pull_requests = vec![
            GithubPullRequestSummary {
                url: "https://github.com/bang9/grove/pull/40".to_string(),
                state: "CLOSED".to_string(),
                head_ref_name: branch_name.to_string(),
                head_ref_oid: "1111111111111111111111111111111111111111".to_string(),
                merged_at: Some("2026-03-20T00:00:00Z".to_string()),
                updated_at: "2026-03-20T00:00:00Z".to_string(),
            },
            GithubPullRequestSummary {
                url: "https://github.com/bang9/grove/pull/42".to_string(),
                state: "CLOSED".to_string(),
                head_ref_name: branch_name.to_string(),
                head_ref_oid: "2222222222222222222222222222222222222222".to_string(),
                merged_at: Some("2026-03-26T00:00:00Z".to_string()),
                updated_at: "2026-03-26T00:00:00Z".to_string(),
            },
        ];

        assert_eq!(
            select_github_pull_request(&pull_requests, branch_name, head_oid),
            Some(WorktreePullRequest {
                url: "https://github.com/bang9/grove/pull/42".to_string(),
                status: WorktreePullRequestStatus::Merged,
            })
        );
    }

    struct TestHome {
        root: PathBuf,
        original_home: Option<String>,
    }

    impl TestHome {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("grove-git-project-tests-{}", Uuid::new_v4()));
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

    fn save_test_config(base_dir: &Path, projects: Vec<ProjectEntry>) {
        config::save_config(&config::GroveConfig {
            projects,
            base_dir: Some(base_dir.to_string_lossy().to_string()),
            terminal_theme: None,
            preferences: None,
        })
        .unwrap();
    }

    fn project_entry(id: &str, url: &str, source_dir: &Path) -> ProjectEntry {
        let (_host, org, repo) = parse_git_url(url).unwrap();
        ProjectEntry {
            id: id.to_string(),
            name: repo.clone(),
            url: url.to_string(),
            org,
            repo,
            source_path: source_dir.to_string_lossy().to_string(),
            worktree_order: Vec::new(),
            stacked_parents: BTreeMap::new(),
            base_branch: None,
            collapsed: false,
            category_id: None,
            env_sync: None,
        }
    }

    fn run_git_ok(cwd: &Path, args: &[&str]) {
        let output = git_command().args(args).current_dir(cwd).output().unwrap();
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

    fn init_repo_with_remote(source_dir: &Path, remote_url: &str) {
        fs::create_dir_all(source_dir).unwrap();
        run_git_ok(source_dir, &["init"]);
        run_git_ok(source_dir, &["remote", "add", "origin", remote_url]);
        fs::write(
            Repository::open(source_dir)
                .unwrap()
                .path()
                .join("FETCH_HEAD"),
            "",
        )
        .unwrap();
    }

    fn create_bare_remote(root: &Path, name: &str, default_branch: &str) -> (PathBuf, PathBuf) {
        let remote_dir = root.join(format!("{name}.git"));
        let seed_dir = root.join(format!("{name}-seed"));
        fs::create_dir_all(root).unwrap();

        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        run_git_ok(
            root,
            &[
                "init",
                "--bare",
                "--initial-branch",
                default_branch,
                &remote_dir_str,
            ],
        );

        fs::create_dir_all(&seed_dir).unwrap();
        run_git_ok(&seed_dir, &["init", "--initial-branch", default_branch]);
        configure_git_identity(&seed_dir);

        (remote_dir, seed_dir)
    }

    fn commit_and_push(
        repo_dir: &Path,
        remote_dir: &Path,
        branch: &str,
        relative_path: &str,
        content: &str,
        message: &str,
    ) {
        let file_path = repo_dir.join(relative_path);
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&file_path, content).unwrap();
        run_git_ok(repo_dir, &["add", relative_path]);
        run_git_ok(repo_dir, &["commit", "-m", message]);

        let has_origin = run_git_output(repo_dir, &["remote", "get-url", "origin"]).is_ok();
        if !has_origin {
            let remote_dir_str = remote_dir.to_string_lossy().to_string();
            run_git_ok(repo_dir, &["remote", "add", "origin", &remote_dir_str]);
        }

        run_git_ok(repo_dir, &["push", "-u", "origin", branch]);
    }

    fn remove_fetch_head(source_dir: &Path) {
        let fetch_head = Repository::open(source_dir)
            .unwrap()
            .path()
            .join("FETCH_HEAD");
        let _ = fs::remove_file(fetch_head);
    }

    #[cfg(unix)]
    fn write_test_executable(path: &Path, content: &str) {
        fs::write(path, content).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    fn git_log_contains_in_order(log: &str, patterns: &[&str]) -> bool {
        let mut search_from = 0;
        for pattern in patterns {
            let Some(offset) = log[search_from..].find(pattern) else {
                return false;
            };
            search_from += offset + pattern.len();
        }
        true
    }

    #[test]
    fn visible_worktrees_hides_only_actual_source_path() {
        let source_path = "/tmp/grove/source";
        let source_worktree = Worktree {
            name: SOURCE_WORKTREE_NAME.to_string(),
            path: source_path.to_string(),
            branch: String::new(),
            stack_parent_name: None,
        };
        let user_worktree_named_source = Worktree {
            name: SOURCE_WORKTREE_NAME.to_string(),
            path: "/tmp/grove/worktrees/source".to_string(),
            branch: SOURCE_WORKTREE_NAME.to_string(),
            stack_parent_name: None,
        };

        let visible = visible_worktrees(
            vec![source_worktree, user_worktree_named_source.clone()],
            source_path,
        );

        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].name, user_worktree_named_source.name);
        assert_eq!(visible[0].path, user_worktree_named_source.path);
        assert_eq!(visible[0].branch, user_worktree_named_source.branch);
    }

    #[test]
    fn refresh_project_rejects_unmanaged_source_path() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let rogue_repo = home.root.join("rogue-repo");

        init_repo_with_remote(&rogue_repo, "https://github.com/bang9/grove.git");
        save_test_config(
            &base_dir,
            vec![project_entry(
                "project-1",
                "https://github.com/bang9/grove.git",
                &rogue_repo,
            )],
        );

        let error = refresh_project_impl("project-1").unwrap_err();
        assert!(error.contains("Refusing to operate on unmanaged source path"));
    }

    #[test]
    fn remote_default_branch_falls_back_to_single_local_branch_when_detached() {
        let _lock = env_lock();
        let home = TestHome::new();
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) = create_bare_remote(&remotes_dir, "grove-trunk", "trunk");
        let source_parent = home.root.join("clones");
        let source_dir = source_parent.join("source");

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove trunk\n",
            "Initial trunk commit",
        );

        fs::create_dir_all(&source_parent).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(&source_parent, &["clone", &remote_dir_str, &source_dir_str]);

        run_git_ok(&source_dir, &["remote", "set-head", "origin", "--delete"]);
        run_git_ok(&source_dir, &["checkout", "--detach", "origin/trunk"]);

        let missing_remote = home.root.join("missing-remote.git");
        let missing_remote_str = missing_remote.to_string_lossy().to_string();
        run_git_ok(
            &source_dir,
            &["remote", "set-url", "origin", &missing_remote_str],
        );

        assert_eq!(remote_default_branch(&source_dir).unwrap(), "trunk");
    }

    #[test]
    fn git_command_injects_current_ssh_auth_sock_into_spawned_process_env() {
        let _lock = env_lock();
        let original = std::env::var_os("SSH_AUTH_SOCK");
        unsafe {
            std::env::set_var("SSH_AUTH_SOCK", "/tmp/grove-git-command.sock");
        }

        let command = git_command();
        let ssh_auth_sock =
            command
                .get_envs()
                .find_map(|(key, value)| match (key.to_str(), value) {
                    (Some("SSH_AUTH_SOCK"), Some(value)) => Some(value.to_os_string()),
                    _ => None,
                });

        assert_eq!(
            ssh_auth_sock,
            Some(OsString::from("/tmp/grove-git-command.sock"))
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
    fn list_projects_reconciles_stale_entries_and_recovers_orphans() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let base_dir_str = base_dir.to_string_lossy().to_string();
        let orphan_source = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let orphan_source_str = orphan_source.to_string_lossy().to_string();
        let stale_source = base_dir
            .join("github.com")
            .join("bang9")
            .join("missing")
            .join("source");

        init_repo_with_remote(&orphan_source, "https://github.com/bang9/grove.git");
        save_test_config(
            &base_dir,
            vec![project_entry(
                "stale-project",
                "https://github.com/bang9/missing.git",
                &stale_source,
            )],
        );

        let projects = list_projects_impl().unwrap();

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].url, "https://github.com/bang9/grove.git");
        assert_eq!(projects[0].org, "bang9");
        assert_eq!(projects[0].repo, "grove");
        assert_eq!(projects[0].source_path, orphan_source_str);

        let saved = config::load_config();
        assert_eq!(saved.base_dir.as_deref(), Some(base_dir_str.as_str()));
        assert_eq!(saved.projects.len(), 1);
        assert_eq!(saved.projects[0].url, "https://github.com/bang9/grove.git");
        assert_eq!(
            saved.projects[0].source_path,
            orphan_source.to_string_lossy()
        );
    }

    #[test]
    fn list_projects_removes_config_only_entries_when_source_directory_is_missing() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let base_dir_str = base_dir.to_string_lossy().to_string();
        let stale_source = base_dir
            .join("github.com")
            .join("bang9")
            .join("missing")
            .join("source");

        save_test_config(
            &base_dir,
            vec![project_entry(
                "stale-project",
                "https://github.com/bang9/missing.git",
                &stale_source,
            )],
        );

        let projects = list_projects_impl().unwrap();

        assert!(projects.is_empty());

        let saved = config::load_config();
        assert_eq!(saved.base_dir.as_deref(), Some(base_dir_str.as_str()));
        assert!(saved.projects.is_empty());
    }

    #[test]
    fn list_projects_recovers_orphan_source_directory_into_config() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let base_dir_str = base_dir.to_string_lossy().to_string();
        let orphan_source = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let orphan_source_str = orphan_source.to_string_lossy().to_string();

        init_repo_with_remote(&orphan_source, "https://github.com/bang9/grove.git");
        save_test_config(&base_dir, vec![]);

        let projects = list_projects_impl().unwrap();

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].url, "https://github.com/bang9/grove.git");
        assert_eq!(projects[0].org, "bang9");
        assert_eq!(projects[0].repo, "grove");
        assert_eq!(projects[0].source_path, orphan_source_str);

        let saved = config::load_config();
        assert_eq!(saved.base_dir.as_deref(), Some(base_dir_str.as_str()));
        assert_eq!(saved.projects.len(), 1);
        assert_eq!(saved.projects[0].url, "https://github.com/bang9/grove.git");
        assert_eq!(
            saved.projects[0].source_path,
            orphan_source.to_string_lossy()
        );
    }

    #[test]
    fn list_projects_deduplicates_duplicate_config_entries() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");

        init_repo_with_remote(&source_dir, "https://github.com/bang9/grove.git");
        save_test_config(
            &base_dir,
            vec![
                project_entry(
                    "project-1",
                    "https://github.com/bang9/grove.git",
                    &source_dir,
                ),
                project_entry(
                    "project-2",
                    "https://github.com/bang9/grove.git",
                    &source_dir,
                ),
            ],
        );

        let projects = list_projects_impl().unwrap();

        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "project-1");

        let saved = config::load_config();
        assert_eq!(saved.projects.len(), 1);
        assert_eq!(saved.projects[0].id, "project-1");
    }

    #[test]
    fn list_projects_preserves_config_order_when_loaded_in_parallel() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let remotes_dir = home.root.join("remotes");

        let project_specs = [
            ("project-1", "alpha"),
            ("project-2", "beta"),
            ("project-3", "gamma"),
        ];
        let mut entries = Vec::new();

        for (id, repo) in project_specs {
            let source_dir = base_dir
                .join("github.com")
                .join("bang9")
                .join(repo)
                .join("source");
            let (remote_dir, seed_dir) = create_bare_remote(&remotes_dir, repo, "main");

            commit_and_push(
                &seed_dir,
                &remote_dir,
                "main",
                "README.md",
                &format!("# {repo}\n"),
                &format!("Initial {repo} commit"),
            );

            fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
            let remote_dir_str = remote_dir.to_string_lossy().to_string();
            let source_dir_str = source_dir.to_string_lossy().to_string();
            run_git_ok(
                source_dir.parent().unwrap(),
                &["clone", &remote_dir_str, &source_dir_str],
            );

            entries.push(project_entry(
                id,
                &format!("https://github.com/bang9/{repo}.git"),
                &source_dir,
            ));
        }

        save_test_config(
            &base_dir,
            vec![entries[1].clone(), entries[2].clone(), entries[0].clone()],
        );

        let project_ids = list_projects_impl()
            .unwrap()
            .into_iter()
            .map(|project| project.id)
            .collect::<Vec<_>>();

        assert_eq!(project_ids, vec!["project-2", "project-3", "project-1"]);
    }

    #[test]
    fn add_project_returns_existing_registered_project() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let existing = project_entry(
            "project-1",
            "https://github.com/bang9/grove.git",
            &source_dir,
        );

        init_repo_with_remote(&source_dir, "https://github.com/bang9/grove.git");
        save_test_config(&base_dir, vec![existing.clone()]);

        let project = add_project_impl("https://github.com/bang9/grove.git").unwrap();

        assert_eq!(project.id, existing.id);
        assert_eq!(project.url, existing.url);
        assert_eq!(project.source_path, existing.source_path);
        assert!(project.worktrees.is_empty());

        let saved = config::load_config();
        assert_eq!(saved.projects.len(), 1);
        assert_eq!(saved.projects[0].id, existing.id);
    }

    #[test]
    fn add_project_recovers_existing_source_directory_into_config() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let source_dir_str = source_dir.to_string_lossy().to_string();

        init_repo_with_remote(&source_dir, "https://github.com/bang9/grove.git");
        save_test_config(&base_dir, vec![]);

        let project = add_project_impl("https://github.com/bang9/grove.git").unwrap();

        assert_eq!(project.url, "https://github.com/bang9/grove.git");
        assert_eq!(project.source_path, source_dir_str);
        assert!(project.worktrees.is_empty());

        let saved = config::load_config();
        assert_eq!(saved.projects.len(), 1);
        assert_eq!(saved.projects[0].id, project.id);
        assert_eq!(saved.projects[0].source_path, project.source_path);
    }

    #[test]
    fn create_project_recovers_existing_source_directory_into_config() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let source_dir_str = source_dir.to_string_lossy().to_string();

        init_repo_with_remote(&source_dir, "https://github.com/bang9/grove.git");
        save_test_config(&base_dir, vec![]);

        let project =
            create_project_impl("Recovered Name", "https://github.com/bang9/grove.git").unwrap();

        assert_eq!(project.url, "https://github.com/bang9/grove.git");
        assert_eq!(project.repo, "grove");
        assert_eq!(project.source_path, source_dir_str);
        assert!(project.worktrees.is_empty());

        let saved = config::load_config();
        assert_eq!(saved.projects.len(), 1);
        assert_eq!(saved.projects[0].id, project.id);
        assert_eq!(saved.projects[0].source_path, project.source_path);
    }

    #[test]
    fn add_worktree_uses_remote_default_branch() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) = create_bare_remote(&remotes_dir, "grove", "trunk");

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove\n",
            "Initial commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_dir_str, &source_dir_str],
        );

        save_test_config(
            &base_dir,
            vec![project_entry(
                "project-1",
                "https://github.com/bang9/grove.git",
                &source_dir,
            )],
        );

        let worktree = add_worktree_impl("project-1", "feature-1").unwrap();
        let worktree_path = PathBuf::from(&worktree.path);

        assert_eq!(worktree.branch, "feature-1");
        assert!(worktree_path.is_dir());
        assert_eq!(
            run_git_output(&worktree_path, &["branch", "--show-current"]).unwrap(),
            "feature-1"
        );
        assert_eq!(
            run_git_output(&worktree_path, &["rev-parse", "HEAD"]).unwrap(),
            run_git_output(&source_dir, &["rev-parse", "origin/trunk"]).unwrap()
        );
        assert_eq!(list_worktrees_impl("project-1").unwrap().len(), 1);
    }

    #[test]
    fn add_worktree_reports_human_readable_branch_prefix_conflict() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) =
            create_bare_remote(&remotes_dir, "grove-prefix-conflict", "main");

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "main",
            "README.md",
            "# Grove\n",
            "Initial commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_dir_str, &source_dir_str],
        );
        run_git_ok(&source_dir, &["branch", "whip"]);

        save_test_config(
            &base_dir,
            vec![project_entry(
                "project-1",
                "https://github.com/bang9/grove.git",
                &source_dir,
            )],
        );

        let error = add_worktree_impl("project-1", "whip/scroll-bug-fix").unwrap_err();

        assert_eq!(
            error,
            "Cannot create branch 'whip/scroll-bug-fix' because branch 'whip' already exists. Git cannot keep both 'whip/scroll-bug-fix' and 'whip' because one name is a prefix of the other. Use a different branch name, or rename/delete the existing branch."
        );
    }

    #[test]
    fn add_stacked_worktree_uses_parent_head_and_parent_env_sync() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) =
            create_bare_remote(&remotes_dir, "grove-stacked-worktree", "main");

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "main",
            ".gitignore",
            ".env.local\n",
            "Ignore local env",
        );
        commit_and_push(
            &seed_dir,
            &remote_dir,
            "main",
            "README.md",
            "# Grove\n",
            "Initial commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_dir_str, &source_dir_str],
        );
        configure_git_identity(&source_dir);
        fs::write(source_dir.join(".env.local"), "SOURCE=1\n").unwrap();

        let mut entry = project_entry(
            "project-1",
            "https://github.com/bang9/grove.git",
            &source_dir,
        );
        entry.env_sync = Some(config::ProjectEnvSyncConfig {
            include_patterns: vec![".env.local".into()],
        });
        save_test_config(&base_dir, vec![entry]);

        let parent = add_worktree_impl("project-1", "feature-1").unwrap();
        let parent_path = PathBuf::from(&parent.path);
        assert_eq!(
            fs::read_to_string(parent_path.join(".env.local")).unwrap(),
            "SOURCE=1\n"
        );

        fs::write(parent_path.join(".env.local"), "PARENT=1\n").unwrap();
        fs::write(parent_path.join("README.md"), "# Parent branch\n").unwrap();
        run_git_ok(&parent_path, &["add", "README.md"]);
        run_git_ok(&parent_path, &["commit", "-m", "Parent branch commit"]);
        let parent_head = run_git_output(&parent_path, &["rev-parse", "HEAD"]).unwrap();

        let child = add_stacked_worktree_impl("project-1", "feature-1", "fix-token").unwrap();
        let child_path = PathBuf::from(&child.path);

        assert_eq!(child.stack_parent_name.as_deref(), Some("feature-1"));
        assert_eq!(
            run_git_output(&child_path, &["rev-parse", "HEAD"]).unwrap(),
            parent_head
        );
        assert_eq!(
            fs::read_to_string(child_path.join(".env.local")).unwrap(),
            "PARENT=1\n"
        );

        let listed = list_worktrees_impl("project-1").unwrap();
        assert_eq!(
            listed
                .iter()
                .find(|worktree| worktree.name == "fix-token")
                .and_then(|worktree| worktree.stack_parent_name.as_deref()),
            Some("feature-1")
        );
    }

    #[test]
    fn remove_worktree_deletes_local_branch_and_recreates_from_default_branch() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) =
            create_bare_remote(&remotes_dir, "grove-remove-worktree", "trunk");

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove\n",
            "Initial commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_dir_str, &source_dir_str],
        );
        configure_git_identity(&source_dir);

        save_test_config(
            &base_dir,
            vec![project_entry(
                "project-1",
                "https://github.com/bang9/grove.git",
                &source_dir,
            )],
        );

        let default_head = run_git_output(&source_dir, &["rev-parse", "origin/trunk"]).unwrap();

        let worktree = add_worktree_impl("project-1", "feature-1").unwrap();
        let worktree_path = PathBuf::from(&worktree.path);

        fs::write(worktree_path.join("README.md"), "# Feature branch\n").unwrap();
        run_git_ok(&worktree_path, &["add", "README.md"]);
        run_git_ok(&worktree_path, &["commit", "-m", "Feature branch commit"]);

        let stale_feature_head = run_git_output(&worktree_path, &["rev-parse", "HEAD"]).unwrap();
        assert_ne!(stale_feature_head, default_head);

        remove_worktree_impl("project-1", "feature-1").unwrap();

        assert!(!worktree_path.exists());
        assert!(list_worktrees_impl("project-1").unwrap().is_empty());
        assert!(run_git_output(
            &source_dir,
            &["rev-parse", "--verify", "refs/heads/feature-1"],
        )
        .is_err());

        let recreated = add_worktree_impl("project-1", "feature-1").unwrap();
        let recreated_path = PathBuf::from(&recreated.path);
        let recreated_head = run_git_output(&recreated_path, &["rev-parse", "HEAD"]).unwrap();

        assert_eq!(recreated_head, default_head);
        assert_ne!(recreated_head, stale_feature_head);
        assert_eq!(
            fs::read_to_string(recreated_path.join("README.md")).unwrap(),
            "# Grove\n"
        );
    }

    #[test]
    fn remove_worktree_ignores_missing_local_branch_after_removal() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) = create_bare_remote(
            &remotes_dir,
            "grove-remove-worktree-missing-branch",
            "trunk",
        );

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove\n",
            "Initial commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_dir_str, &source_dir_str],
        );

        save_test_config(
            &base_dir,
            vec![project_entry(
                "project-1",
                "https://github.com/bang9/grove.git",
                &source_dir,
            )],
        );

        let worktree = add_worktree_impl("project-1", "feature-1").unwrap();
        let worktree_path = PathBuf::from(&worktree.path);

        run_git_ok(&worktree_path, &["checkout", "--detach", "HEAD"]);
        run_git_ok(&source_dir, &["branch", "-D", "feature-1"]);
        assert!(run_git_output(
            &source_dir,
            &["rev-parse", "--verify", "refs/heads/feature-1"],
        )
        .is_err());

        remove_worktree_impl("project-1", "feature-1").unwrap();

        assert!(!worktree_path.exists());
        assert!(list_worktrees_impl("project-1").unwrap().is_empty());
    }

    #[test]
    fn remove_worktree_blocks_parents_with_stacked_children() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) =
            create_bare_remote(&remotes_dir, "grove-remove-stacked-parent", "main");

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "main",
            "README.md",
            "# Grove\n",
            "Initial commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_dir_str, &source_dir_str],
        );

        save_test_config(
            &base_dir,
            vec![project_entry(
                "project-1",
                "https://github.com/bang9/grove.git",
                &source_dir,
            )],
        );

        let parent = add_worktree_impl("project-1", "feature-1").unwrap();
        let child = add_stacked_worktree_impl("project-1", "feature-1", "fix-token").unwrap();
        let parent_path = PathBuf::from(&parent.path);

        let error = remove_worktree_impl("project-1", "feature-1").unwrap_err();
        assert_eq!(
            error,
            "Cannot remove worktree 'feature-1' because it has stacked children: fix-token. Remove child worktrees first."
        );
        assert!(parent_path.exists());

        remove_worktree_impl("project-1", "fix-token").unwrap();
        remove_worktree_impl("project-1", "feature-1").unwrap();

        assert!(!PathBuf::from(&child.path).exists());
        assert!(!parent_path.exists());
    }

    #[test]
    fn list_projects_marks_source_behind_remote_when_default_branch_advances() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) =
            create_bare_remote(&remotes_dir, "grove-remote-ahead", "trunk");

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove v1\n",
            "Initial commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_dir_str, &source_dir_str],
        );

        save_test_config(
            &base_dir,
            vec![project_entry(
                "project-1",
                "https://github.com/bang9/grove.git",
                &source_dir,
            )],
        );

        let initial_project = list_projects_impl().unwrap().pop().unwrap();
        assert!(!initial_project.source_has_changes);
        assert!(!initial_project.source_behind_remote);

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove v2\n",
            "Remote ahead",
        );
        remove_fetch_head(&source_dir);

        let project = list_projects_impl().unwrap().pop().unwrap();

        assert!(!project.source_has_changes);
        assert!(project.source_behind_remote);
        assert_ne!(
            run_git_output(&source_dir, &["rev-parse", "HEAD"]).unwrap(),
            run_git_output(&source_dir, &["rev-parse", "origin/trunk"]).unwrap()
        );
    }

    #[test]
    fn refresh_project_resets_source_to_remote_default_branch() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) = create_bare_remote(&remotes_dir, "grove-refresh", "trunk");

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove v1\n",
            "Initial commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_dir_str, &source_dir_str],
        );

        save_test_config(
            &base_dir,
            vec![project_entry(
                "project-1",
                "https://github.com/bang9/grove.git",
                &source_dir,
            )],
        );

        // Add a local dirty file that does NOT conflict with remote changes
        fs::write(source_dir.join("local.txt"), "local work").unwrap();

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove v2\n",
            "Refresh source",
        );

        let project = refresh_project_impl("project-1").unwrap();

        assert!(project.worktrees.is_empty());
        // source_has_changes is true because local.txt remains an untracked local change
        assert!(project.source_has_changes);
        // Remote change is pulled
        assert_eq!(
            fs::read_to_string(source_dir.join("README.md")).unwrap(),
            "# Grove v2\n"
        );
        // Local dirty file is preserved via stash
        assert_eq!(
            fs::read_to_string(source_dir.join("local.txt")).unwrap(),
            "local work"
        );
        assert_eq!(
            run_git_output(&source_dir, &["rev-parse", "HEAD"]).unwrap(),
            run_git_output(&source_dir, &["rev-parse", "origin/trunk"]).unwrap()
        );
        assert_eq!(
            run_git_output(&source_dir, &["branch", "--show-current"]).unwrap(),
            "trunk"
        );
    }

    #[test]
    fn refresh_project_uses_configured_base_branch_instead_of_remote_default() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) = create_bare_remote(&remotes_dir, "grove-base-branch", "trunk");

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove v1\n",
            "Initial commit",
        );

        // Create a "develop" branch on the remote
        run_git_ok(&seed_dir, &["checkout", "-b", "develop"]);
        commit_and_push(
            &seed_dir,
            &remote_dir,
            "develop",
            "dev.md",
            "# Dev\n",
            "Dev commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_dir_str, &source_dir_str],
        );

        // Save config with base_branch set to "develop"
        let mut entry = project_entry(
            "project-base",
            "https://github.com/bang9/grove.git",
            &source_dir,
        );
        entry.base_branch = Some("develop".to_string());
        save_test_config(&base_dir, vec![entry]);

        // Push a new commit to develop on the remote
        run_git_ok(&seed_dir, &["checkout", "develop"]);
        commit_and_push(
            &seed_dir,
            &remote_dir,
            "develop",
            "dev.md",
            "# Dev v2\n",
            "Update dev",
        );

        let project = refresh_project_impl("project-base").unwrap();

        // Should be on "develop", NOT "trunk"
        assert_eq!(
            run_git_output(&source_dir, &["branch", "--show-current"]).unwrap(),
            "develop"
        );
        // Remote changes on develop should be pulled
        assert_eq!(
            fs::read_to_string(source_dir.join("dev.md")).unwrap(),
            "# Dev v2\n"
        );
        // base_branch should be preserved in the returned project
        assert_eq!(project.base_branch, Some("develop".to_string()));
    }

    #[test]
    fn refresh_project_restores_tracked_dirty_changes_after_sync() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) =
            create_bare_remote(&remotes_dir, "grove-refresh-tracked", "trunk");

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove v1\n",
            "Initial commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_dir_str, &source_dir_str],
        );

        save_test_config(
            &base_dir,
            vec![project_entry(
                "project-1",
                "https://github.com/bang9/grove.git",
                &source_dir,
            )],
        );

        fs::write(source_dir.join("README.md"), "# Grove v1\nLocal note\n").unwrap();

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "SYNC.md",
            "remote update\n",
            "Refresh source",
        );

        let project = refresh_project_impl("project-1").unwrap();

        // Tracked file modification is preserved via stash/pop
        assert!(project.source_has_changes);
        assert_eq!(
            fs::read_to_string(source_dir.join("README.md")).unwrap(),
            "# Grove v1\nLocal note\n"
        );
        assert_eq!(
            fs::read_to_string(source_dir.join("SYNC.md")).unwrap(),
            "remote update\n"
        );
        assert_eq!(
            run_git_output(&source_dir, &["rev-parse", "HEAD"]).unwrap(),
            run_git_output(&source_dir, &["rev-parse", "origin/trunk"]).unwrap()
        );
    }

    #[test]
    fn refresh_project_keeps_recoverable_stash_when_reapply_conflicts() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) =
            create_bare_remote(&remotes_dir, "grove-refresh-conflict", "trunk");

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove v1\n",
            "Initial commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_dir_str, &source_dir_str],
        );

        save_test_config(
            &base_dir,
            vec![project_entry(
                "project-1",
                "https://github.com/bang9/grove.git",
                &source_dir,
            )],
        );

        fs::write(source_dir.join("README.md"), "# Grove local\n").unwrap();

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove remote\n",
            "Conflicting refresh source",
        );

        let error = refresh_project_impl("project-1").unwrap_err();
        let stash_list = run_git_output(&source_dir, &["stash", "list"]).unwrap();

        assert!(error.contains("temporary stash"));
        assert!(error.contains("git stash apply"));
        assert!(stash_list.contains("grove-source-sync-"));
        assert_eq!(
            run_git_output(&source_dir, &["rev-parse", "HEAD"]).unwrap(),
            run_git_output(&source_dir, &["rev-parse", "origin/trunk"]).unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn refresh_project_logs_git_and_ssh_env_at_spawn_time() {
        const CHILD_ENV: &str = "GROVE_REFRESH_GIT_SSH_LOG_CHILD";
        const BASE_DIR_ENV: &str = "GROVE_REFRESH_GIT_SSH_LOG_BASE_DIR";
        const LOG_DIR_ENV: &str = "GROVE_REFRESH_GIT_SSH_LOG_DIR";
        const BIN_DIR_ENV: &str = "GROVE_REFRESH_GIT_SSH_LOG_BIN_DIR";
        const REAL_GIT_ENV: &str = "GROVE_REFRESH_GIT_SSH_LOG_REAL_GIT";
        const SSH_AUTH_SOCK_ENV: &str = "GROVE_REFRESH_GIT_SSH_LOG_SOCKET";

        if std::env::var_os(CHILD_ENV).is_some() {
            let base_dir = PathBuf::from(std::env::var(BASE_DIR_ENV).unwrap());
            let fake_bin_dir = PathBuf::from(std::env::var(BIN_DIR_ENV).unwrap());
            let fake_ssh = fake_bin_dir.join("fake-ssh");
            let current_path = std::env::var("PATH").unwrap_or_default();
            unsafe {
                std::env::set_var("PATH", format!("{}:{current_path}", fake_bin_dir.display()));
                std::env::set_var("GIT_SSH_COMMAND", fake_ssh);
                std::env::set_var("SSH_AUTH_SOCK", std::env::var(SSH_AUTH_SOCK_ENV).unwrap());
            }

            let source_dir = base_dir
                .join("github.com")
                .join("bang9")
                .join("grove")
                .join("source");
            let before_head = run_git_output(&source_dir, &["rev-parse", "HEAD"]).unwrap();
            let project = refresh_project_impl("project-1").unwrap();
            let after_head = run_git_output(&source_dir, &["rev-parse", "HEAD"]).unwrap();

            assert!(project.worktrees.is_empty());
            assert_ne!(before_head, after_head);
            return;
        }

        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let remotes_dir = home.root.join("remotes");
        let (remote_dir, seed_dir) =
            create_bare_remote(&remotes_dir, "grove-refresh-ssh-logging", "trunk");

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove v1\n",
            "Initial commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_dir_str = remote_dir.to_string_lossy().to_string();
        let source_dir_str = source_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_dir_str, &source_dir_str],
        );

        let ssh_remote_url = format!("git@fakehost:{}", remote_dir.display());
        run_git_ok(
            &source_dir,
            &["remote", "set-url", "origin", &ssh_remote_url],
        );

        save_test_config(
            &base_dir,
            vec![project_entry(
                "project-1",
                "https://github.com/bang9/grove.git",
                &source_dir,
            )],
        );

        commit_and_push(
            &seed_dir,
            &remote_dir,
            "trunk",
            "README.md",
            "# Grove v2\n",
            "Refresh source",
        );

        let log_dir = home.root.join("refresh-logs");
        let fake_bin_dir = home.root.join("fake-bin");
        fs::create_dir_all(&log_dir).unwrap();
        fs::create_dir_all(&fake_bin_dir).unwrap();

        let real_git = std::process::Command::new("sh")
            .args(["-lc", "command -v git"])
            .output()
            .unwrap();
        assert!(real_git.status.success());
        let real_git = String::from_utf8_lossy(&real_git.stdout).trim().to_string();
        assert!(!real_git.is_empty());

        let fake_git = fake_bin_dir.join("git");
        write_test_executable(
            &fake_git,
            r#"#!/bin/sh
set -eu
{
  printf 'cwd=%s\n' "$PWD"
  printf 'argv='
  printf '%s\x1f' "$@"
  printf '\n'
  printf 'ssh_auth_sock=%s\n' "${SSH_AUTH_SOCK-}"
  printf 'git_ssh_command=%s\n' "${GIT_SSH_COMMAND-}"
  printf -- '---\n'
} >> "${GROVE_REFRESH_GIT_SSH_LOG_DIR}/git.log"
exec "${GROVE_REFRESH_GIT_SSH_LOG_REAL_GIT}" "$@"
"#,
        );

        let fake_ssh = fake_bin_dir.join("fake-ssh");
        write_test_executable(
            &fake_ssh,
            r#"#!/bin/sh
set -eu
{
  printf 'cwd=%s\n' "$PWD"
  printf 'argv='
  printf '%s\x1f' "$@"
  printf '\n'
  printf 'ssh_auth_sock=%s\n' "${SSH_AUTH_SOCK-}"
  printf -- '---\n'
} >> "${GROVE_REFRESH_GIT_SSH_LOG_DIR}/ssh.log"
host="$1"
shift
remote_cmd="$*"
exec /bin/sh -c "$remote_cmd"
"#,
        );

        let expected_socket = "/tmp/grove-refresh-test.sock";
        let child_output = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("git_project::tests::refresh_project_logs_git_and_ssh_env_at_spawn_time")
            .arg("--nocapture")
            .env(CHILD_ENV, "1")
            .env(BASE_DIR_ENV, &base_dir)
            .env(LOG_DIR_ENV, &log_dir)
            .env(BIN_DIR_ENV, &fake_bin_dir)
            .env(REAL_GIT_ENV, &real_git)
            .env(SSH_AUTH_SOCK_ENV, expected_socket)
            .output()
            .unwrap();

        assert!(
            child_output.status.success(),
            "child process failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&child_output.stdout),
            String::from_utf8_lossy(&child_output.stderr)
        );

        let git_log = fs::read_to_string(log_dir.join("git.log")).unwrap();
        let ssh_log = fs::read_to_string(log_dir.join("ssh.log")).unwrap();

        assert!(
            git_log_contains_in_order(
                &git_log,
                &[
                    "argv=symbolic-ref\x1f--short\x1frefs/remotes/origin/HEAD\x1f",
                    "argv=checkout\x1ftrunk\x1f",
                    "argv=fetch\x1f--prune\x1forigin\x1f",
                    "argv=pull\x1f--rebase\x1forigin\x1ftrunk\x1f",
                    "argv=worktree\x1flist\x1f--porcelain\x1f",
                ],
            ),
            "unexpected git invocation order:\n{git_log}"
        );
        assert!(git_log.contains("ssh_auth_sock=/tmp/grove-refresh-test.sock"));
        assert!(git_log.contains(&format!("git_ssh_command={}", fake_ssh.display())));

        assert!(ssh_log.contains("argv=git@fakehost\x1fgit-upload-pack"));
        assert!(ssh_log.contains("ssh_auth_sock=/tmp/grove-refresh-test.sock"));
    }

    // === Base branch tests ===

    #[test]
    fn set_base_branch_happy_path() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let remotes_dir = home.root.join("remotes");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let (remote_dir, seed_dir) = create_bare_remote(&remotes_dir, "grove", "main");
        commit_and_push(
            &seed_dir,
            &remote_dir,
            "main",
            "README.md",
            "# Hello\n",
            "init",
        );
        run_git_ok(&seed_dir, &["checkout", "-b", "develop"]);
        commit_and_push(
            &seed_dir,
            &remote_dir,
            "develop",
            "dev.md",
            "dev\n",
            "dev commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_url = remote_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_url, "source"],
        );

        let entry = project_entry("p1", "https://github.com/bang9/grove.git", &source_dir);
        save_test_config(&base_dir, vec![entry]);

        set_base_branch_impl("p1", Some("develop".to_string())).unwrap();

        let config = config::load_config();
        assert_eq!(config.projects[0].base_branch, Some("develop".to_string()));
    }

    #[test]
    fn set_base_branch_rejects_nonexistent_branch() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let remotes_dir = home.root.join("remotes");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let (remote_dir, seed_dir) = create_bare_remote(&remotes_dir, "grove", "main");
        commit_and_push(
            &seed_dir,
            &remote_dir,
            "main",
            "README.md",
            "# Hello\n",
            "init",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_url = remote_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_url, "source"],
        );

        let entry = project_entry("p1", "https://github.com/bang9/grove.git", &source_dir);
        save_test_config(&base_dir, vec![entry]);

        let result = set_base_branch_impl("p1", Some("nonexistent".to_string()));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found in remote"));
    }

    #[test]
    fn set_base_branch_none_resets_to_auto_detect() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let remotes_dir = home.root.join("remotes");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let (remote_dir, seed_dir) = create_bare_remote(&remotes_dir, "grove", "main");
        commit_and_push(
            &seed_dir,
            &remote_dir,
            "main",
            "README.md",
            "# Hello\n",
            "init",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_url = remote_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_url, "source"],
        );

        let mut entry = project_entry("p1", "https://github.com/bang9/grove.git", &source_dir);
        entry.base_branch = Some("main".to_string());
        save_test_config(&base_dir, vec![entry]);

        set_base_branch_impl("p1", None).unwrap();

        let config = config::load_config();
        assert_eq!(config.projects[0].base_branch, None);
    }

    #[test]
    fn add_worktree_uses_configured_base_branch() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let remotes_dir = home.root.join("remotes");
        let source_dir = base_dir
            .join("github.com")
            .join("bang9")
            .join("grove")
            .join("source");
        let (remote_dir, seed_dir) = create_bare_remote(&remotes_dir, "grove", "main");
        commit_and_push(
            &seed_dir,
            &remote_dir,
            "main",
            "README.md",
            "# Hello\n",
            "init",
        );
        run_git_ok(&seed_dir, &["checkout", "-b", "develop"]);
        commit_and_push(
            &seed_dir,
            &remote_dir,
            "develop",
            "dev.md",
            "dev\n",
            "dev commit",
        );

        fs::create_dir_all(source_dir.parent().unwrap()).unwrap();
        let remote_url = remote_dir.to_string_lossy().to_string();
        run_git_ok(
            source_dir.parent().unwrap(),
            &["clone", &remote_url, "source"],
        );

        let mut entry = project_entry("p1", "https://github.com/bang9/grove.git", &source_dir);
        entry.base_branch = Some("develop".to_string());
        save_test_config(&base_dir, vec![entry]);

        let worktree = add_worktree_impl("p1", "my-feature").unwrap();
        assert_eq!(worktree.name, "my-feature");

        // Verify the new branch was created from develop, not main
        let log = run_git_output(
            std::path::Path::new(&worktree.path),
            &["log", "--oneline", "-1"],
        )
        .unwrap();
        assert!(log.contains("dev commit"));
    }

    #[test]
    fn config_round_trip_preserves_base_branch() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");

        let mut entry = project_entry(
            "p1",
            "https://github.com/bang9/grove.git",
            &base_dir.join("source"),
        );
        entry.base_branch = Some("develop".to_string());
        save_test_config(&base_dir, vec![entry]);

        let loaded = config::load_config();
        assert_eq!(loaded.projects[0].base_branch, Some("develop".to_string()));

        // None round-trip
        let mut entry2 = project_entry(
            "p2",
            "https://github.com/bang9/other.git",
            &base_dir.join("source2"),
        );
        entry2.base_branch = None;
        save_test_config(&base_dir, vec![loaded.projects[0].clone(), entry2]);

        let loaded2 = config::load_config();
        assert_eq!(loaded2.projects[0].base_branch, Some("develop".to_string()));
        assert_eq!(loaded2.projects[1].base_branch, None);
    }

    #[test]
    fn set_and_delete_project_category_round_trip() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir.join("source");
        fs::create_dir_all(&source_dir).unwrap();

        let mut preferences = config::GrovePreferences::default();
        preferences.project_categories = vec![config::ProjectCategory {
            id: "ops".into(),
            name: "Ops".into(),
            color: "#4f7cff".into(),
            icon: config::ProjectCategoryIcon::Lucide("wrench".into()),
        }];

        config::save_config(&config::GroveConfig {
            projects: vec![project_entry(
                "p1",
                "https://github.com/bang9/grove.git",
                &source_dir,
            )],
            base_dir: Some(base_dir.to_string_lossy().to_string()),
            terminal_theme: None,
            preferences: Some(preferences),
        })
        .unwrap();

        set_project_category_impl("p1", "ops").unwrap();
        let assigned = config::load_config();
        assert_eq!(assigned.projects[0].category_id.as_deref(), Some("ops"));

        delete_project_category_impl("ops").unwrap();
        let deleted = config::load_config();
        assert_eq!(deleted.projects[0].category_id, None);
        assert_eq!(
            deleted
                .preferences
                .unwrap()
                .normalized()
                .project_categories
                .len(),
            0
        );
    }

    #[test]
    fn set_project_category_rejects_unknown_category() {
        let _lock = env_lock();
        let home = TestHome::new();
        let base_dir = home.root.join("grove-data");
        let source_dir = base_dir.join("source");
        fs::create_dir_all(&source_dir).unwrap();
        save_test_config(
            &base_dir,
            vec![project_entry(
                "p1",
                "https://github.com/bang9/grove.git",
                &source_dir,
            )],
        );

        let error = set_project_category_impl("p1", "missing").unwrap_err();
        assert!(error.contains("Project category not found"));
    }
}
