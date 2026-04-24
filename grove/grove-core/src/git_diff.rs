use crate::process_env::enriched_path;
use crate::{BehindInfo, CommitInfo, DiffHunk, DiffLine, FileDiff, FileStatus};
use git2::{DiffOptions, Repository, Sort, StatusOptions};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Component, Path};
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

const FILE_CONTENT_CACHE_LIMIT: usize = 256;

// === QUERY OPERATIONS ===

pub fn get_status_impl(worktree_path: &str) -> Result<Vec<FileStatus>, String> {
    let repo = Repository::open(worktree_path).map_err(|e| e.to_string())?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true);

    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let mut result = Vec::new();

    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let st = entry.status();

        // Staged changes (HEAD -> index)
        if st.intersects(
            git2::Status::INDEX_NEW
                | git2::Status::INDEX_MODIFIED
                | git2::Status::INDEX_DELETED
                | git2::Status::INDEX_RENAMED,
        ) {
            let status_str = if st.contains(git2::Status::INDEX_NEW) {
                "added"
            } else if st.contains(git2::Status::INDEX_DELETED) {
                "deleted"
            } else if st.contains(git2::Status::INDEX_RENAMED) {
                "renamed"
            } else {
                "modified"
            };
            result.push(FileStatus {
                path: path.clone(),
                status: status_str.to_string(),
                staged: true,
            });
        }

        // Unstaged changes (index -> workdir)
        if st.intersects(
            git2::Status::WT_NEW
                | git2::Status::WT_MODIFIED
                | git2::Status::WT_DELETED
                | git2::Status::WT_RENAMED,
        ) {
            let status_str = if st.contains(git2::Status::WT_NEW) {
                "untracked"
            } else if st.contains(git2::Status::WT_DELETED) {
                "deleted"
            } else if st.contains(git2::Status::WT_RENAMED) {
                "renamed"
            } else {
                "modified"
            };
            result.push(FileStatus {
                path: path.clone(),
                status: status_str.to_string(),
                staged: false,
            });
        }
    }

    Ok(result)
}

pub fn get_commits_impl(worktree_path: &str, limit: u32) -> Result<Vec<CommitInfo>, String> {
    let repo = Repository::open(worktree_path).map_err(|e| e.to_string())?;

    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(vec![]), // Empty repo, no commits
    };

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk
        .push(head.target().ok_or("HEAD has no target")?)
        .map_err(|e| e.to_string())?;
    revwalk.set_sorting(Sort::TIME).map_err(|e| e.to_string())?;

    let mut commits = Vec::new();
    for (i, oid) in revwalk.enumerate() {
        if i >= limit as usize {
            break;
        }
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;

        let hash = oid.to_string();
        let short_hash = hash[..7.min(hash.len())].to_string();
        let message = commit.message().unwrap_or("").trim_end().to_string();
        let author = commit.author().name().unwrap_or("Unknown").to_string();
        let date = commit.time().seconds().to_string();

        commits.push(CommitInfo {
            hash,
            short_hash,
            message,
            author,
            date,
        });
    }

    Ok(commits)
}

pub fn get_working_diff_impl(worktree_path: &str, path: &str) -> Result<FileDiff, String> {
    // Support "staged:" prefix to request staged diff
    let (actual_path, want_staged) = if let Some(p) = path.strip_prefix("staged:") {
        (p, true)
    } else {
        (path, false)
    };

    let repo = Repository::open(worktree_path).map_err(|e| e.to_string())?;

    let diff = if want_staged {
        let head_tree = repo.head().and_then(|h| h.peel_to_tree()).ok();
        let mut opts = DiffOptions::new();
        opts.pathspec(actual_path);
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(|e| e.to_string())?
    } else {
        let mut opts = DiffOptions::new();
        opts.pathspec(actual_path);
        opts.include_untracked(true);
        opts.show_untracked_content(true);
        opts.recurse_untracked_dirs(true);
        let d = repo
            .diff_index_to_workdir(None, Some(&mut opts))
            .map_err(|e| e.to_string())?;

        // pathspec doesn't match untracked files (not in index).
        // Only attempt the expensive unfiltered fallback when the file is actually untracked.
        if d.deltas().count() == 0 && is_untracked(&repo, actual_path) {
            let mut opts2 = DiffOptions::new();
            opts2.include_untracked(true);
            opts2.show_untracked_content(true);
            opts2.recurse_untracked_dirs(true);
            let full = repo
                .diff_index_to_workdir(None, Some(&mut opts2))
                .map_err(|e| e.to_string())?;

            let file_diffs = parse_diff(&full)?;
            if let Some(mut fd) = file_diffs.into_iter().find(|f| f.path == actual_path) {
                if should_track_display_line_count(&fd.status) {
                    let source = get_working_display_source(&repo, worktree_path, &fd.path, want_staged)?;
                    fd.display_line_count = count_lines_for_source(&repo, &source)?;
                }
                return Ok(fd);
            }
            d
        } else {
            d
        }
    };

    let mut file_diffs = parse_diff(&diff)?;
    for file_diff in &mut file_diffs {
        if should_track_display_line_count(&file_diff.status) {
            let source = get_working_display_source(&repo, worktree_path, &file_diff.path, want_staged)?;
            file_diff.display_line_count = count_lines_for_source(&repo, &source)?;
        }
    }

    Ok(file_diffs.into_iter().next().unwrap_or(FileDiff {
        path: actual_path.to_string(),
        old_path: None,
        status: "modified".to_string(),
        hunks: vec![],
        display_line_count: 0,
    }))
}

pub fn get_commit_diff_impl(
    worktree_path: &str,
    commit_hash: &str,
) -> Result<Vec<FileDiff>, String> {
    let repo = Repository::open(worktree_path).map_err(|e| e.to_string())?;
    let oid = git2::Oid::from_str(commit_hash).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;

    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
        .map_err(|e| e.to_string())?;

    let mut file_diffs = parse_diff(&diff)?;
    for file_diff in &mut file_diffs {
        if should_track_display_line_count(&file_diff.status) {
            let source = get_commit_display_source(&repo, &tree, parent_tree.as_ref(), file_diff)?;
            file_diff.display_line_count = count_lines_for_source(&repo, &source)?;
        }
    }

    Ok(file_diffs)
}

pub fn get_working_diff_context_impl(
    worktree_path: &str,
    path: &str,
    start_line: u32,
    line_count: u32,
) -> Result<Vec<String>, String> {
    let (actual_path, want_staged) = if let Some(p) = path.strip_prefix("staged:") {
        (p, true)
    } else {
        (path, false)
    };

    validate_repo_relative_path(actual_path)?;
    let repo = Repository::open(worktree_path).map_err(|e| e.to_string())?;
    ensure_working_diff_path_allowed(worktree_path, actual_path, want_staged)?;
    let source = get_working_display_source(&repo, worktree_path, actual_path, want_staged)?;
    slice_lines_for_source(&repo, &source, start_line, line_count)
}

pub fn get_commit_diff_context_impl(
    worktree_path: &str,
    commit_hash: &str,
    path: &str,
    old_path: Option<&str>,
    start_line: u32,
    line_count: u32,
) -> Result<Vec<String>, String> {
    validate_repo_relative_path(path)?;
    if let Some(previous_path) = old_path {
        validate_repo_relative_path(previous_path)?;
    }

    let repo = Repository::open(worktree_path).map_err(|e| e.to_string())?;
    let oid = git2::Oid::from_str(commit_hash).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());

    ensure_commit_diff_path_allowed(&repo, &tree, parent_tree.as_ref(), path, old_path)?;
    let source = get_commit_display_source_from_paths(&repo, &tree, parent_tree.as_ref(), path, old_path)?;
    slice_lines_for_source(&repo, &source, start_line, line_count)
}

// === FILE-LEVEL OPERATIONS ===

pub fn stage_file_impl(worktree_path: &str, file_path: &str) -> Result<(), String> {
    stage_files_impl(worktree_path, &[file_path.to_string()])
}

pub fn unstage_file_impl(worktree_path: &str, file_path: &str) -> Result<(), String> {
    unstage_files_impl(worktree_path, &[file_path.to_string()])
}

pub fn discard_file_impl(worktree_path: &str, file_path: &str) -> Result<(), String> {
    let result = run_git(worktree_path, &["checkout", "--", file_path]);
    if result.is_err() {
        // Might be untracked — delete file
        let full_path = Path::new(worktree_path).join(file_path);
        if full_path.exists() {
            remove_path(&full_path)?;
            return Ok(());
        }
    }
    result
}

pub fn discard_files_impl(worktree_path: &str, file_paths: &[String]) -> Result<(), String> {
    for path in file_paths {
        discard_file_impl(worktree_path, path)?;
    }
    Ok(())
}

pub fn remove_untracked_files_impl(
    worktree_path: &str,
    file_paths: &[String],
) -> Result<(), String> {
    let repo = Repository::open(worktree_path).map_err(|e| e.to_string())?;
    for path in file_paths {
        if !is_untracked(&repo, path) {
            return Err(format!("'{}' is not an untracked file", path));
        }
        let full_path = Path::new(worktree_path).join(path);
        if full_path.exists() {
            remove_path(&full_path)?;
        }
    }
    Ok(())
}

pub fn stage_files_impl(worktree_path: &str, file_paths: &[String]) -> Result<(), String> {
    run_git_with_paths(worktree_path, &["add"], file_paths)
}

pub fn unstage_files_impl(worktree_path: &str, file_paths: &[String]) -> Result<(), String> {
    let result = run_git_with_paths(worktree_path, &["reset", "HEAD"], file_paths);
    if result.is_err() {
        // No HEAD (initial commit) — remove from index
        return run_git_with_paths(worktree_path, &["rm", "--cached"], file_paths);
    }
    result
}

// === HUNK-LEVEL OPERATIONS ===

pub fn stage_hunk_impl(
    worktree_path: &str,
    file_path: &str,
    hunk_index: u32,
) -> Result<(), String> {
    let diff = get_unstaged_diff(worktree_path, file_path)?;
    let hunk = get_hunk(&diff, hunk_index)?;
    let patch = build_hunk_patch(file_path, diff.old_path.as_deref(), hunk);
    apply_patch(worktree_path, &patch, &["--cached"])
}

pub fn unstage_hunk_impl(
    worktree_path: &str,
    file_path: &str,
    hunk_index: u32,
) -> Result<(), String> {
    let diff = get_staged_diff(worktree_path, file_path)?;
    let hunk = get_hunk(&diff, hunk_index)?;
    let patch = build_hunk_patch(file_path, diff.old_path.as_deref(), hunk);
    apply_patch(worktree_path, &patch, &["--cached", "--reverse"])
}

pub fn discard_hunk_impl(
    worktree_path: &str,
    file_path: &str,
    hunk_index: u32,
) -> Result<(), String> {
    let diff = get_unstaged_diff(worktree_path, file_path)?;
    let hunk = get_hunk(&diff, hunk_index)?;
    let patch = build_hunk_patch(file_path, diff.old_path.as_deref(), hunk);
    apply_patch(worktree_path, &patch, &["--reverse"])
}

// === LINE-LEVEL OPERATIONS ===

pub fn stage_lines_impl(
    worktree_path: &str,
    file_path: &str,
    hunk_index: u32,
    line_indices: &[u32],
) -> Result<(), String> {
    let diff = get_unstaged_diff(worktree_path, file_path)?;
    let hunk = get_hunk(&diff, hunk_index)?;
    let selected: HashSet<u32> = line_indices.iter().copied().collect();
    let patch = build_selective_patch(file_path, diff.old_path.as_deref(), hunk, &selected)?;
    apply_patch(worktree_path, &patch, &["--cached"])
}

pub fn unstage_lines_impl(
    worktree_path: &str,
    file_path: &str,
    hunk_index: u32,
    line_indices: &[u32],
) -> Result<(), String> {
    let diff = get_staged_diff(worktree_path, file_path)?;
    let hunk = get_hunk(&diff, hunk_index)?;
    let selected: HashSet<u32> = line_indices.iter().copied().collect();
    let patch = build_selective_patch(file_path, diff.old_path.as_deref(), hunk, &selected)?;
    apply_patch(worktree_path, &patch, &["--cached", "--reverse"])
}

pub fn discard_lines_impl(
    worktree_path: &str,
    file_path: &str,
    hunk_index: u32,
    line_indices: &[u32],
) -> Result<(), String> {
    let diff = get_unstaged_diff(worktree_path, file_path)?;
    let hunk = get_hunk(&diff, hunk_index)?;
    let selected: HashSet<u32> = line_indices.iter().copied().collect();
    let patch = build_selective_patch(file_path, diff.old_path.as_deref(), hunk, &selected)?;
    apply_patch(worktree_path, &patch, &["--reverse"])
}

// === INTERNAL HELPERS ===

fn is_untracked(repo: &Repository, path: &str) -> bool {
    match repo.status_file(Path::new(path)) {
        Ok(status) => status.contains(git2::Status::WT_NEW),
        Err(_) => {
            let normalized = path.trim_end_matches('/');
            let prefix = format!("{normalized}/");
            let mut opts = StatusOptions::new();
            opts.include_untracked(true).recurse_untracked_dirs(true);

            repo.statuses(Some(&mut opts))
                .map(|statuses| {
                    let mut found = false;

                    for entry in statuses.iter() {
                        let Some(entry_path) = entry.path() else {
                            continue;
                        };

                        if entry_path == normalized || entry_path.starts_with(&prefix) {
                            found = true;
                            if !entry.status().contains(git2::Status::WT_NEW) {
                                return false;
                            }
                        }
                    }

                    found
                })
                .unwrap_or(false)
        }
    }
}

fn get_unstaged_diff(worktree_path: &str, file_path: &str) -> Result<FileDiff, String> {
    let repo = Repository::open(worktree_path).map_err(|e| e.to_string())?;
    let mut opts = DiffOptions::new();
    opts.pathspec(file_path);
    opts.include_untracked(true);
    opts.show_untracked_content(true);
    opts.recurse_untracked_dirs(true);
    let diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| e.to_string())?;
    let file_diffs = parse_diff(&diff)?;
    file_diffs
        .into_iter()
        .next()
        .ok_or_else(|| format!("No unstaged diff for {}", file_path))
}

fn get_staged_diff(worktree_path: &str, file_path: &str) -> Result<FileDiff, String> {
    let repo = Repository::open(worktree_path).map_err(|e| e.to_string())?;
    let head_tree = repo.head().and_then(|h| h.peel_to_tree()).ok();
    let mut opts = DiffOptions::new();
    opts.pathspec(file_path);
    let diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
        .map_err(|e| e.to_string())?;
    let file_diffs = parse_diff(&diff)?;
    file_diffs
        .into_iter()
        .next()
        .ok_or_else(|| format!("No staged diff for {}", file_path))
}

fn get_hunk(diff: &FileDiff, hunk_index: u32) -> Result<&DiffHunk, String> {
    diff.hunks.get(hunk_index as usize).ok_or_else(|| {
        format!(
            "Hunk index {} out of range (file has {} hunks)",
            hunk_index,
            diff.hunks.len()
        )
    })
}

fn parse_diff(diff: &git2::Diff) -> Result<Vec<FileDiff>, String> {
    let mut file_diffs: Vec<FileDiff> = Vec::new();
    // Global line index counter — unique across all hunks within a file
    let mut global_line_idx: u32 = 0;

    diff.print(git2::DiffFormat::Patch, |delta, hunk, line| {
        let path = delta
            .new_file()
            .path()
            .unwrap_or(Path::new(""))
            .to_string_lossy()
            .to_string();

        // New file entry if path changed
        let needs_new = file_diffs.last().map(|f| f.path != path).unwrap_or(true);
        if needs_new {
            global_line_idx = 0; // Reset per file
            let old_path = delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().to_string());
            let status = match delta.status() {
                git2::Delta::Added | git2::Delta::Untracked => "added",
                git2::Delta::Deleted => "deleted",
                git2::Delta::Renamed => "renamed",
                git2::Delta::Modified => "modified",
                _ => "modified",
            };
            file_diffs.push(FileDiff {
                path: path.clone(),
                old_path,
                status: status.to_string(),
                hunks: vec![],
                display_line_count: 0,
            });
        }

        let file_diff = match file_diffs.last_mut() {
            Some(fd) => fd,
            None => return true,
        };

        match line.origin() {
            'H' => {
                if let Some(h) = hunk {
                    let header = std::str::from_utf8(h.header())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    file_diff.hunks.push(DiffHunk {
                        header,
                        lines: vec![],
                        old_start: h.old_start(),
                        old_count: h.old_lines(),
                        new_start: h.new_start(),
                        new_count: h.new_lines(),
                    });
                }
            }
            '+' | '-' | ' ' => {
                // Ensure a hunk exists for these content lines
                if let Some(h) = hunk {
                    let need_hunk = file_diff.hunks.is_empty() || {
                        let last = file_diff.hunks.last().unwrap();
                        last.old_start != h.old_start() || last.new_start != h.new_start()
                    };
                    if need_hunk {
                        let header = std::str::from_utf8(h.header())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        file_diff.hunks.push(DiffHunk {
                            header,
                            lines: vec![],
                            old_start: h.old_start(),
                            old_count: h.old_lines(),
                            new_start: h.new_start(),
                            new_count: h.new_lines(),
                        });
                    }
                }

                if let Some(current_hunk) = file_diff.hunks.last_mut() {
                    let line_type = match line.origin() {
                        '+' => "add",
                        '-' => "remove",
                        _ => "context",
                    };
                    let content = String::from_utf8_lossy(line.content()).to_string();
                    let index = global_line_idx;
                    global_line_idx += 1;

                    current_hunk.lines.push(DiffLine {
                        line_type: line_type.to_string(),
                        content,
                        old_line_number: line.old_lineno(),
                        new_line_number: line.new_lineno(),
                        index,
                    });
                }
            }
            _ => {}
        }

        true
    })
    .map_err(|e| e.to_string())?;

    Ok(file_diffs)
}

fn build_hunk_patch(file_path: &str, old_path: Option<&str>, hunk: &DiffHunk) -> String {
    let old = old_path.unwrap_or(file_path);
    let mut patch = String::new();
    patch.push_str(&format!("--- a/{}\n", old));
    patch.push_str(&format!("+++ b/{}\n", file_path));
    patch.push_str(&hunk.header);
    if !hunk.header.ends_with('\n') {
        patch.push('\n');
    }

    for line in &hunk.lines {
        let prefix = match line.line_type.as_str() {
            "add" => '+',
            "remove" => '-',
            _ => ' ',
        };
        patch.push(prefix);
        patch.push_str(&line.content);
        if !line.content.ends_with('\n') {
            patch.push('\n');
        }
    }

    patch
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum FileContentSource {
    Missing,
    Blob {
        oid: git2::Oid,
    },
    Workdir {
        full_path: String,
        modified_unix_nanos: u128,
        len: u64,
    },
}

#[derive(Clone)]
struct CachedFileContent {
    line_count: u32,
    lines: Option<Vec<String>>,
}

static FILE_CONTENT_CACHE: LazyLock<Mutex<HashMap<FileContentSource, CachedFileContent>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn should_track_display_line_count(status: &str) -> bool {
    !matches!(status, "added" | "deleted")
}

fn validate_repo_relative_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("Path is required".to_string());
    }

    let mut has_normal_component = false;
    for component in Path::new(path).components() {
        match component {
            Component::Normal(_) => has_normal_component = true,
            Component::CurDir => {}
            _ => return Err(format!("Invalid repo-relative path: {path}")),
        }
    }

    if !has_normal_component {
        return Err(format!("Invalid repo-relative path: {path}"));
    }

    Ok(())
}

fn ensure_working_diff_path_allowed(
    worktree_path: &str,
    path: &str,
    want_staged: bool,
) -> Result<(), String> {
    let diff = if want_staged {
        get_staged_diff(worktree_path, path)?
    } else {
        get_unstaged_diff(worktree_path, path)?
    };

    if diff.path == path {
        return Ok(());
    }

    Err(format!("Path is not part of the requested diff: {path}"))
}

fn ensure_commit_diff_path_allowed(
    repo: &Repository,
    tree: &git2::Tree,
    parent_tree: Option<&git2::Tree>,
    path: &str,
    old_path: Option<&str>,
) -> Result<(), String> {
    let mut opts = DiffOptions::new();
    opts.pathspec(path);
    if let Some(previous_path) = old_path.filter(|previous_path| *previous_path != path) {
        opts.pathspec(previous_path);
    }

    let diff = repo
        .diff_tree_to_tree(parent_tree, Some(tree), Some(&mut opts))
        .map_err(|e| e.to_string())?;
    let file_diffs = parse_diff(&diff)?;
    let allowed = file_diffs.into_iter().any(|file_diff| {
        file_diff.path == path && old_path.map_or(true, |previous_path| file_diff.old_path.as_deref() == Some(previous_path))
    });

    if allowed {
        return Ok(());
    }

    Err(format!("Path is not part of commit diff: {path}"))
}

fn get_working_display_source(
    repo: &Repository,
    worktree_path: &str,
    path: &str,
    want_staged: bool,
) -> Result<FileContentSource, String> {
    if want_staged {
        let index = read_index_source(repo, path)?;
        if !matches!(index, FileContentSource::Missing) {
            return Ok(index);
        }

        let head_tree = repo.head().and_then(|head| head.peel_to_tree()).ok();
        return read_tree_source(repo, head_tree.as_ref(), path);
    }

    let workdir = read_workdir_source(worktree_path, path)?;
    if !matches!(workdir, FileContentSource::Missing) {
        return Ok(workdir);
    }

    let index = read_index_source(repo, path)?;
    if !matches!(index, FileContentSource::Missing) {
        return Ok(index);
    }

    Ok(FileContentSource::Missing)
}

fn get_commit_display_source(
    repo: &Repository,
    tree: &git2::Tree,
    parent_tree: Option<&git2::Tree>,
    file_diff: &FileDiff,
) -> Result<FileContentSource, String> {
    get_commit_display_source_from_paths(
        repo,
        tree,
        parent_tree,
        &file_diff.path,
        file_diff.old_path.as_deref(),
    )
}

fn get_commit_display_source_from_paths(
    repo: &Repository,
    tree: &git2::Tree,
    parent_tree: Option<&git2::Tree>,
    path: &str,
    old_path: Option<&str>,
) -> Result<FileContentSource, String> {
    let new_source = read_tree_source(repo, Some(tree), path)?;
    if !matches!(new_source, FileContentSource::Missing) {
        return Ok(new_source);
    }

    let previous_path = old_path.unwrap_or(path);
    read_tree_source(repo, parent_tree, previous_path)
}

fn read_tree_source(
    repo: &Repository,
    tree: Option<&git2::Tree>,
    path: &str,
) -> Result<FileContentSource, String> {
    let Some(tree) = tree else {
        return Ok(FileContentSource::Missing);
    };

    let Ok(entry) = tree.get_path(Path::new(path)) else {
        return Ok(FileContentSource::Missing);
    };

    repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
    Ok(FileContentSource::Blob { oid: entry.id() })
}

fn read_index_source(repo: &Repository, path: &str) -> Result<FileContentSource, String> {
    let index = repo.index().map_err(|e| e.to_string())?;
    let Some(entry) = index.get_path(Path::new(path), 0) else {
        return Ok(FileContentSource::Missing);
    };

    repo.find_blob(entry.id).map_err(|e| e.to_string())?;
    Ok(FileContentSource::Blob { oid: entry.id })
}

fn read_workdir_source(worktree_path: &str, path: &str) -> Result<FileContentSource, String> {
    let full_path = Path::new(worktree_path).join(path);
    if !full_path.exists() {
        return Ok(FileContentSource::Missing);
    }

    let metadata = std::fs::metadata(&full_path).map_err(|e| e.to_string())?;
    let modified_unix_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);

    Ok(FileContentSource::Workdir {
        full_path: full_path.to_string_lossy().to_string(),
        modified_unix_nanos,
        len: metadata.len(),
    })
}

fn count_lines_for_source(repo: &Repository, source: &FileContentSource) -> Result<u32, String> {
    if let Some(cached) = get_cached_file_content(source) {
        return Ok(cached.line_count);
    }

    let bytes = read_source_bytes(repo, source)?;
    let line_count = count_lines(&bytes);
    cache_file_content(
        source.clone(),
        CachedFileContent {
            line_count,
            lines: None,
        },
    );
    Ok(line_count)
}

fn slice_lines_for_source(
    repo: &Repository,
    source: &FileContentSource,
    start_line: u32,
    line_count: u32,
) -> Result<Vec<String>, String> {
    if let Some(cached) = get_cached_file_content(source) {
        if let Some(lines) = cached.lines {
            return Ok(slice_lines(&lines, start_line, line_count));
        }
    }

    let bytes = read_source_bytes(repo, source)?;
    let lines = decode_lines(&bytes);
    let result = slice_lines(&lines, start_line, line_count);
    cache_file_content(
        source.clone(),
        CachedFileContent {
            line_count: lines.len() as u32,
            lines: Some(lines),
        },
    );
    Ok(result)
}

fn get_cached_file_content(source: &FileContentSource) -> Option<CachedFileContent> {
    FILE_CONTENT_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(source)
        .cloned()
}

fn cache_file_content(source: FileContentSource, entry: CachedFileContent) {
    let mut cache = FILE_CONTENT_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if cache.len() >= FILE_CONTENT_CACHE_LIMIT && !cache.contains_key(&source) {
        cache.clear();
    }
    cache.insert(source, entry);
}

fn read_source_bytes(repo: &Repository, source: &FileContentSource) -> Result<Vec<u8>, String> {
    match source {
        FileContentSource::Missing => Ok(vec![]),
        FileContentSource::Blob { oid } => {
            let blob = repo.find_blob(*oid).map_err(|e| e.to_string())?;
            Ok(blob.content().to_vec())
        }
        FileContentSource::Workdir { full_path, .. } => {
            std::fs::read(Path::new(full_path)).map_err(|e| e.to_string())
        }
    }
}

fn count_lines(bytes: &[u8]) -> u32 {
    if bytes.is_empty() {
        return 0;
    }

    let newline_count = bytes.iter().filter(|byte| **byte == b'\n').count() as u32;
    if bytes.last() == Some(&b'\n') {
        newline_count
    } else {
        newline_count + 1
    }
}

fn decode_lines(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(|line| line.to_string())
        .collect()
}

fn slice_lines(lines: &[String], start_line: u32, line_count: u32) -> Vec<String> {
    if start_line == 0 || line_count == 0 {
        return vec![];
    }

    let start_index = (start_line - 1) as usize;
    if start_index >= lines.len() {
        return vec![];
    }

    let end_index = start_index.saturating_add(line_count as usize).min(lines.len());
    lines[start_index..end_index].to_vec()
}

fn build_selective_patch(
    file_path: &str,
    old_path: Option<&str>,
    hunk: &DiffHunk,
    selected_indices: &HashSet<u32>,
) -> Result<String, String> {
    let old = old_path.unwrap_or(file_path);
    let mut patch_lines: Vec<String> = Vec::new();
    let mut old_count: u32 = 0;
    let mut new_count: u32 = 0;
    let mut has_changes = false;

    for line in &hunk.lines {
        let is_selected = selected_indices.contains(&line.index);

        match line.line_type.as_str() {
            "add" => {
                if is_selected {
                    patch_lines.push(format_patch_line('+', &line.content));
                    new_count += 1;
                    has_changes = true;
                }
                // Unselected adds: skip entirely
            }
            "remove" => {
                if is_selected {
                    patch_lines.push(format_patch_line('-', &line.content));
                    old_count += 1;
                    has_changes = true;
                } else {
                    // Convert to context (line stays unchanged)
                    patch_lines.push(format_patch_line(' ', &line.content));
                    old_count += 1;
                    new_count += 1;
                }
            }
            _ => {
                // Context
                patch_lines.push(format_patch_line(' ', &line.content));
                old_count += 1;
                new_count += 1;
            }
        }
    }

    if !has_changes {
        return Err("No changes selected".to_string());
    }

    let mut patch = String::new();
    patch.push_str(&format!("--- a/{}\n", old));
    patch.push_str(&format!("+++ b/{}\n", file_path));
    patch.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        hunk.old_start, old_count, hunk.new_start, new_count
    ));
    for line in &patch_lines {
        patch.push_str(line);
    }

    Ok(patch)
}

fn format_patch_line(prefix: char, content: &str) -> String {
    let mut line = format!("{}{}", prefix, content);
    if !line.ends_with('\n') {
        line.push('\n');
    }
    line
}

fn run_git(worktree_path: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(worktree_path)
        .env("PATH", enriched_path())
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git {} failed: {}", args.join(" "), stderr));
    }

    Ok(())
}

fn run_git_with_paths(
    worktree_path: &str,
    prefix_args: &[&str],
    file_paths: &[String],
) -> Result<(), String> {
    if file_paths.is_empty() {
        return Ok(());
    }

    let mut args = Vec::with_capacity(prefix_args.len() + file_paths.len() + 1);
    args.extend_from_slice(prefix_args);
    args.push("--");
    args.extend(file_paths.iter().map(String::as_str));

    run_git(worktree_path, &args)
}

fn remove_path(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_dir() {
        std::fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }
}

fn apply_patch(worktree_path: &str, patch: &str, extra_args: &[&str]) -> Result<(), String> {
    let mut cmd = Command::new("git");
    cmd.arg("apply");
    for arg in extra_args {
        cmd.arg(arg);
    }
    cmd.current_dir(worktree_path);
    cmd.env("PATH", enriched_path());
    cmd.stdin(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn git apply: {}", e))?;

    if let Some(ref mut stdin) = child.stdin {
        stdin
            .write_all(patch.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git apply failed: {}", stderr));
    }

    Ok(())
}

// === BEHIND COUNT / MERGE ===

fn run_git_output_with_ssh(worktree_path: &str, args: &[&str]) -> Result<String, String> {
    let output = crate::git_project::git_command()
        .args(args)
        .current_dir(worktree_path)
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

fn run_git_with_ssh(worktree_path: &str, args: &[&str]) -> Result<(), String> {
    run_git_output_with_ssh(worktree_path, args).map(|_| ())
}

pub fn get_behind_count_impl(worktree_path: &str) -> Result<BehindInfo, String> {
    let wt_path = Path::new(worktree_path);
    let default_branch = crate::git_project::remote_default_branch(wt_path)?;
    let remote_ref = format!("origin/{default_branch}");

    let count_str = run_git_output_with_ssh(
        worktree_path,
        &["rev-list", "--count", &format!("HEAD..{remote_ref}")],
    )?;

    let behind: u32 = count_str
        .parse()
        .map_err(|e| format!("Failed to parse behind count: {e}"))?;

    Ok(BehindInfo {
        behind,
        default_branch,
    })
}

pub fn merge_default_branch_impl(worktree_path: &str) -> Result<(), String> {
    let wt_path = Path::new(worktree_path);
    let default_branch = crate::git_project::remote_default_branch(wt_path)?;
    let remote_ref = format!("origin/{default_branch}");

    // Fetch latest
    run_git_with_ssh(worktree_path, &["fetch", "origin"])?;

    // Attempt merge
    let merge_result = run_git_with_ssh(worktree_path, &["merge", &remote_ref, "--no-edit"]);

    if let Err(err) = merge_result {
        // Abort on conflict
        let _ = run_git_with_ssh(worktree_path, &["merge", "--abort"]);
        return Err(format!("Merge conflict — resolve in terminal. {err}"));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::env_lock;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use uuid::Uuid;

    fn temp_repo(prefix: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("grove-git-diff-{prefix}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .env("PATH", enriched_path())
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn head_hash(repo: &Path) -> String {
        let output = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repo)
            .env("PATH", enriched_path())
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "git rev-parse HEAD failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn stage_files_batches_multiple_paths() {
        let _lock = env_lock();
        let repo = temp_repo("stage-files");

        git(&repo, &["init"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        fs::write(repo.join("b.txt"), "b\n").unwrap();

        stage_files_impl(
            repo.to_str().unwrap(),
            &["a.txt".to_string(), "b.txt".to_string()],
        )
        .unwrap();

        let mut staged = get_status_impl(repo.to_str().unwrap())
            .unwrap()
            .into_iter()
            .filter(|status| status.staged)
            .collect::<Vec<_>>();
        staged.sort_by(|left, right| left.path.cmp(&right.path));

        assert_eq!(staged.len(), 2);
        assert_eq!(staged[0].path, "a.txt");
        assert_eq!(staged[0].status, "added");
        assert_eq!(staged[1].path, "b.txt");
        assert_eq!(staged[1].status, "added");

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn unstage_files_falls_back_to_rm_cached_without_head() {
        let _lock = env_lock();
        let repo = temp_repo("unstage-files");

        git(&repo, &["init"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        fs::write(repo.join("b.txt"), "b\n").unwrap();

        stage_files_impl(
            repo.to_str().unwrap(),
            &["a.txt".to_string(), "b.txt".to_string()],
        )
        .unwrap();
        unstage_files_impl(
            repo.to_str().unwrap(),
            &["a.txt".to_string(), "b.txt".to_string()],
        )
        .unwrap();

        let mut unstaged = get_status_impl(repo.to_str().unwrap()).unwrap();
        unstaged.sort_by(|left, right| left.path.cmp(&right.path));

        assert_eq!(unstaged.len(), 2);
        assert_eq!(unstaged[0].path, "a.txt");
        assert_eq!(unstaged[0].status, "untracked");
        assert!(!unstaged[0].staged);
        assert_eq!(unstaged[1].path, "b.txt");
        assert_eq!(unstaged[1].status, "untracked");
        assert!(!unstaged[1].staged);

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn discard_file_removes_untracked_directories() {
        let _lock = env_lock();
        let repo = temp_repo("discard-dir");

        git(&repo, &["init"]);
        fs::create_dir_all(repo.join("scratch")).unwrap();
        fs::write(repo.join("scratch/note.txt"), "temp\n").unwrap();

        discard_file_impl(repo.to_str().unwrap(), "scratch").unwrap();

        assert!(!repo.join("scratch").exists());

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn discard_files_batches_multiple_paths() {
        let _lock = env_lock();
        let repo = temp_repo("discard-files");

        git(&repo, &["init"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        fs::write(repo.join("b.txt"), "b\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "init"]);

        fs::write(repo.join("a.txt"), "updated a\n").unwrap();
        fs::write(repo.join("b.txt"), "updated b\n").unwrap();

        discard_files_impl(
            repo.to_str().unwrap(),
            &["a.txt".to_string(), "b.txt".to_string()],
        )
        .unwrap();

        let statuses = get_status_impl(repo.to_str().unwrap()).unwrap();
        assert!(statuses.is_empty());
        assert_eq!(fs::read_to_string(repo.join("a.txt")).unwrap(), "a\n");
        assert_eq!(fs::read_to_string(repo.join("b.txt")).unwrap(), "b\n");

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn remove_untracked_files_removes_multiple_paths() {
        let _lock = env_lock();
        let repo = temp_repo("remove-untracked-files");

        git(&repo, &["init"]);
        fs::write(repo.join("a.txt"), "a\n").unwrap();
        fs::create_dir_all(repo.join("scratch")).unwrap();
        fs::write(repo.join("scratch/note.txt"), "temp\n").unwrap();

        remove_untracked_files_impl(
            repo.to_str().unwrap(),
            &["a.txt".to_string(), "scratch".to_string()],
        )
        .unwrap();

        assert!(!repo.join("a.txt").exists());
        assert!(!repo.join("scratch").exists());

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn working_diff_context_rejects_path_traversal() {
        let _lock = env_lock();
        let repo = temp_repo("working-context-traversal");

        git(&repo, &["init"]);

        let error =
            get_working_diff_context_impl(repo.to_str().unwrap(), "../../etc/passwd", 1, 10)
                .unwrap_err();
        assert!(error.contains("Invalid repo-relative path"));

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn working_diff_context_reads_staged_file_content() {
        let _lock = env_lock();
        let repo = temp_repo("working-context-staged");

        git(&repo, &["init"]);
        fs::write(repo.join("note.txt"), "one\ntwo\nthree\nfour\n").unwrap();
        git(&repo, &["add", "note.txt"]);
        git(&repo, &["commit", "-m", "init"]);

        fs::write(repo.join("note.txt"), "one\ntwo changed\nthree\nfour\nfive\n").unwrap();
        git(&repo, &["add", "note.txt"]);

        let diff = get_working_diff_impl(repo.to_str().unwrap(), "staged:note.txt").unwrap();
        assert_eq!(diff.display_line_count, 5);

        let lines =
            get_working_diff_context_impl(repo.to_str().unwrap(), "staged:note.txt", 2, 2)
                .unwrap();
        assert_eq!(lines, vec!["two changed".to_string(), "three".to_string()]);

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn commit_diff_context_rejects_paths_outside_the_commit_diff() {
        let _lock = env_lock();
        let repo = temp_repo("commit-context-path-guard");

        git(&repo, &["init"]);
        fs::write(repo.join("tracked.txt"), "base\n").unwrap();
        fs::write(repo.join("other.txt"), "untouched\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "init"]);

        fs::write(repo.join("tracked.txt"), "base\nnext\n").unwrap();
        git(&repo, &["add", "tracked.txt"]);
        git(&repo, &["commit", "-m", "update tracked"]);
        let commit_hash = head_hash(&repo);

        let error = get_commit_diff_context_impl(
            repo.to_str().unwrap(),
            &commit_hash,
            "other.txt",
            Some("other.txt"),
            1,
            10,
        )
        .unwrap_err();
        assert!(error.contains("Path is not part of commit diff"));

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn commit_diff_context_reads_commit_file_lines() {
        let _lock = env_lock();
        let repo = temp_repo("commit-context-lines");

        git(&repo, &["init"]);
        fs::write(repo.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
        git(&repo, &["add", "tracked.txt"]);
        git(&repo, &["commit", "-m", "init"]);

        fs::write(repo.join("tracked.txt"), "one\ntwo changed\nthree\nfour\n").unwrap();
        git(&repo, &["add", "tracked.txt"]);
        git(&repo, &["commit", "-m", "update tracked"]);
        let commit_hash = head_hash(&repo);

        let diff = get_commit_diff_impl(repo.to_str().unwrap(), &commit_hash).unwrap();
        assert_eq!(diff[0].display_line_count, 4);

        let lines = get_commit_diff_context_impl(
            repo.to_str().unwrap(),
            &commit_hash,
            "tracked.txt",
            Some("tracked.txt"),
            2,
            2,
        )
        .unwrap();
        assert_eq!(lines, vec!["two changed".to_string(), "three".to_string()]);

        let _ = fs::remove_dir_all(repo);
    }
}
