use crate::process_env::enriched_path;
use crate::DirectoryFileEntry;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;

pub fn list_directory_files_impl(worktree_path: &str) -> Result<Vec<DirectoryFileEntry>, String> {
    let worktree = Path::new(worktree_path);
    if !worktree.is_dir() {
        return Err("Worktree path does not exist".to_string());
    }

    let output = Command::new("git")
        .args(["ls-files", "-co", "--exclude-standard"])
        .current_dir(worktree)
        .env("PATH", enriched_path())
        .output()
        .map_err(|e| format!("Failed to list directory files: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to list directory files: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let mut entries: HashMap<String, DirectoryFileEntry> = HashMap::new();
    for raw_path in String::from_utf8_lossy(&output.stdout).lines() {
        let path = raw_path.trim_end_matches('\r').to_string();
        if path.is_empty() {
            continue;
        }

        let parts = path
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        if parts.is_empty() {
            continue;
        }

        for depth in 0..parts.len().saturating_sub(1) {
            let dir_path = parts[..=depth].join("/");
            entries
                .entry(dir_path.clone())
                .or_insert_with(|| DirectoryFileEntry {
                    path: dir_path,
                    name: parts[depth].to_string(),
                    entry_type: "directory".to_string(),
                    depth,
                });
        }

        let depth = parts.len() - 1;
        entries.insert(
            path.clone(),
            DirectoryFileEntry {
                path: path.clone(),
                name: parts[depth].to_string(),
                entry_type: "file".to_string(),
                depth,
            },
        );
    }

    let mut result = entries.into_values().collect::<Vec<_>>();
    result.sort_by(|left, right| left.path.split('/').cmp(right.path.split('/')));
    Ok(result)
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
    fn list_directory_files_includes_tracked_untracked_and_ignores_gitignored() {
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

        let entries = list_directory_files_impl(repo.to_str().unwrap()).unwrap();
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            paths,
            vec![".gitignore", "docs", "docs/readme.md", "src", "src/main.rs",]
        );
        assert!(entries
            .iter()
            .any(|entry| entry.path == "docs" && entry.entry_type == "directory"));
        assert!(entries
            .iter()
            .any(|entry| entry.path == "docs/readme.md" && entry.entry_type == "file"));
        assert!(!paths.contains(&"build"));
        assert!(!paths.contains(&"build/cache.txt"));
        assert!(!paths.contains(&"debug.log"));

        let _ = fs::remove_dir_all(repo);
    }
}
