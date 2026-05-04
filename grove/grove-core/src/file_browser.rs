use crate::process_env::enriched_path;
use crate::DirectoryFileEntry;
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path};
use std::process::Command;

fn normalize_parent_path(parent_path: Option<&str>) -> Result<String, String> {
    let raw = parent_path.unwrap_or("").trim_matches('/');
    if raw.is_empty() {
        return Ok(String::new());
    }

    let mut parts = Vec::new();
    for component in Path::new(raw).components() {
        match component {
            Component::Normal(part) => parts.push(part.to_string_lossy().to_string()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Parent path must be relative".to_string());
            }
        }
    }
    Ok(parts.join("/"))
}

fn entry_depth(path: &str) -> usize {
    path.split('/')
        .filter(|part| !part.is_empty())
        .count()
        .saturating_sub(1)
}

fn is_git_worktree(root: &Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(root)
        .env("PATH", enriched_path())
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn sort_entries(entries: &mut [DirectoryFileEntry]) {
    entries.sort_by(|left, right| {
        let left_dir = left.entry_type == "directory";
        let right_dir = right.entry_type == "directory";
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.path.cmp(&right.path))
    });
}

fn list_git_children(root: &Path, parent_path: &str) -> Result<Vec<DirectoryFileEntry>, String> {
    let mut command = Command::new("git");
    command
        .args(["ls-files", "-co", "--exclude-standard", "--"])
        .current_dir(root)
        .env("PATH", enriched_path());
    if parent_path.is_empty() {
        command.arg(".");
    } else {
        command.arg(parent_path);
    }

    let output = command
        .output()
        .map_err(|e| format!("Failed to list file browser entries: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to list file browser entries: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let mut entries: HashMap<String, DirectoryFileEntry> = HashMap::new();
    let prefix = if parent_path.is_empty() {
        String::new()
    } else {
        format!("{parent_path}/")
    };

    for raw_path in String::from_utf8_lossy(&output.stdout).lines() {
        let path = raw_path.trim_end_matches('\r').to_string();
        if path.is_empty() {
            continue;
        }

        let remainder = if prefix.is_empty() {
            path.as_str()
        } else if let Some(rest) = path.strip_prefix(&prefix) {
            rest
        } else {
            continue;
        };
        let Some(name) = remainder.split('/').find(|part| !part.is_empty()) else {
            continue;
        };
        let child_path = if parent_path.is_empty() {
            name.to_string()
        } else {
            format!("{parent_path}/{name}")
        };
        let entry_type = if remainder.contains('/') {
            "directory"
        } else {
            "file"
        };
        entries
            .entry(child_path.clone())
            .and_modify(|entry| {
                if entry_type == "directory" {
                    entry.entry_type = "directory".to_string();
                }
            })
            .or_insert_with(|| DirectoryFileEntry {
                path: child_path.clone(),
                name: name.to_string(),
                entry_type: entry_type.to_string(),
                depth: entry_depth(&child_path),
            });
    }

    let mut result = entries.into_values().collect::<Vec<_>>();
    sort_entries(&mut result);
    Ok(result)
}

fn list_fs_children(root: &Path, parent_path: &str) -> Result<Vec<DirectoryFileEntry>, String> {
    let directory = if parent_path.is_empty() {
        root.to_path_buf()
    } else {
        root.join(parent_path)
    };
    if !directory.is_dir() {
        return Err("File browser path does not exist".to_string());
    }

    let mut result = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|e| format!("Failed to read directory: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.is_empty() {
            continue;
        }

        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read file type: {e}"))?;
        let path = if parent_path.is_empty() {
            name.clone()
        } else {
            format!("{parent_path}/{name}")
        };
        result.push(DirectoryFileEntry {
            path,
            name,
            entry_type: if file_type.is_dir() {
                "directory"
            } else {
                "file"
            }
            .to_string(),
            depth: entry_depth(parent_path) + if parent_path.is_empty() { 0 } else { 1 },
        });
    }
    sort_entries(&mut result);
    Ok(result)
}

pub fn list_directory_files_impl(
    root_path: &str,
    parent_path: Option<&str>,
) -> Result<Vec<DirectoryFileEntry>, String> {
    let root = Path::new(root_path);
    if !root.is_dir() {
        return Err("File browser root does not exist".to_string());
    }

    let parent_path = normalize_parent_path(parent_path)?;
    if is_git_worktree(root) {
        list_git_children(root, &parent_path)
    } else {
        list_fs_children(root, &parent_path)
    }
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
        let root =
            std::env::temp_dir().join(format!("grove-file-browser-{prefix}-{}", Uuid::new_v4()));
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

    #[test]
    fn list_directory_files_lists_immediate_git_children() {
        let _lock = env_lock();
        let repo = temp_repo("directory-files");

        git(&repo, &["init"]);
        fs::create_dir_all(repo.join("src")).unwrap();
        fs::create_dir_all(repo.join("docs")).unwrap();
        fs::create_dir_all(repo.join("build")).unwrap();
        fs::write(repo.join(".gitignore"), "build/\n*.log\n").unwrap();
        fs::write(repo.join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(repo.join("docs/readme.md"), "docs\n").unwrap();
        fs::write(repo.join("build/cache.txt"), "ignored\n").unwrap();
        fs::write(repo.join("debug.log"), "ignored\n").unwrap();
        git(&repo, &["add", ".gitignore", "src/main.rs"]);

        let entries = list_directory_files_impl(repo.to_str().unwrap(), None).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["docs", "src", ".gitignore"]);
        assert!(entries
            .iter()
            .any(|entry| entry.path == "docs" && entry.entry_type == "directory"));
        assert!(!paths.contains(&"build"));
        assert!(!paths.contains(&"build/cache.txt"));
        assert!(!paths.contains(&"debug.log"));

        let entries = list_directory_files_impl(repo.to_str().unwrap(), Some("docs")).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["docs/readme.md"]
        );

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn list_directory_files_supports_non_git_directories() {
        let root = temp_repo("plain-directory");
        fs::create_dir_all(root.join("mission-a")).unwrap();
        fs::write(root.join("notes.md"), "notes\n").unwrap();

        let entries = list_directory_files_impl(root.to_str().unwrap(), None).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["mission-a", "notes.md"]
        );

        let _ = fs::remove_dir_all(root);
    }
}
