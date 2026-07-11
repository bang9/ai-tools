use crate::process_env::enriched_path;
use crate::{DeepDirectoryListing, DirectoryFileEntry, WorkspaceFileContent};
use base64::Engine;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path};
use std::process::Command;

/// Hard cap on entries returned by the deep listing so expand-all stays
/// responsive on pathological trees; the response is flagged truncated.
const MAX_DEEP_ENTRIES: usize = 50_000;
const MAX_TEXT_FILE_SIZE: u64 = 10 * 1024 * 1024;
const MAX_IMAGE_FILE_SIZE: u64 = 20 * 1024 * 1024;
const BINARY_PROBE_BYTES: usize = 8192;

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

fn parent_of(path: &str) -> &str {
    match path.rfind('/') {
        Some(index) => &path[..index],
        None => "",
    }
}

fn sort_deep_entries(entries: &mut [DirectoryFileEntry]) {
    entries.sort_by(|left, right| {
        let left_dir = left.entry_type == "directory";
        let right_dir = right.entry_type == "directory";
        parent_of(&left.path)
            .cmp(parent_of(&right.path))
            .then_with(|| right_dir.cmp(&left_dir))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.path.cmp(&right.path))
    });
}

fn insert_with_ancestors(
    entries: &mut HashMap<String, DirectoryFileEntry>,
    file_path: &str,
) {
    let parts: Vec<&str> = file_path.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return;
    }

    let mut current = String::new();
    for (index, part) in parts.iter().enumerate() {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        let is_file = index == parts.len() - 1;
        entries
            .entry(current.clone())
            .or_insert_with(|| DirectoryFileEntry {
                path: current.clone(),
                name: (*part).to_string(),
                entry_type: if is_file { "file" } else { "directory" }.to_string(),
                depth: index,
            });
    }
}

fn list_git_deep(root: &Path) -> Result<DeepDirectoryListing, String> {
    let output = Command::new("git")
        .args(["ls-files", "-co", "--exclude-standard"])
        .current_dir(root)
        .env("PATH", enriched_path())
        .output()
        .map_err(|e| format!("Failed to list file browser entries: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to list file browser entries: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let mut entries: HashMap<String, DirectoryFileEntry> = HashMap::new();
    for raw_path in String::from_utf8_lossy(&output.stdout).lines() {
        let path = raw_path.trim_end_matches('\r');
        if path.is_empty() {
            continue;
        }
        insert_with_ancestors(&mut entries, path);
    }

    let mut result = entries.into_values().collect::<Vec<_>>();
    sort_deep_entries(&mut result);
    let truncated = result.len() > MAX_DEEP_ENTRIES;
    result.truncate(MAX_DEEP_ENTRIES);
    Ok(DeepDirectoryListing {
        entries: result,
        truncated,
    })
}

fn list_fs_deep(root: &Path) -> Result<DeepDirectoryListing, String> {
    let mut result = Vec::new();
    let mut queue = std::collections::VecDeque::from([String::new()]);
    let mut truncated = false;

    while let Some(parent) = queue.pop_front() {
        // Subdirectories can disappear or be unreadable mid-walk; skip them
        // instead of failing the whole listing.
        let Ok(children) = list_fs_children(root, &parent) else {
            continue;
        };
        for child in children {
            if result.len() >= MAX_DEEP_ENTRIES {
                truncated = true;
                break;
            }
            if child.entry_type == "directory" {
                queue.push_back(child.path.clone());
            }
            result.push(child);
        }
        if truncated {
            break;
        }
    }

    sort_deep_entries(&mut result);
    Ok(DeepDirectoryListing {
        entries: result,
        truncated,
    })
}

pub fn list_directory_files_deep_impl(root_path: &str) -> Result<DeepDirectoryListing, String> {
    let root = Path::new(root_path);
    if !root.is_dir() {
        return Err("File browser root does not exist".to_string());
    }

    if is_git_worktree(root) {
        list_git_deep(root)
    } else {
        list_fs_deep(root)
    }
}

fn image_mime_for_name(name: &str) -> Option<&'static str> {
    let extension = name.rsplit_once('.')?.1.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

pub fn read_workspace_file_impl(
    root_path: &str,
    file_path: &str,
) -> Result<WorkspaceFileContent, String> {
    let root = Path::new(root_path);
    if !root.is_dir() {
        return Err("File browser root does not exist".to_string());
    }

    let relative = normalize_parent_path(Some(file_path))?;
    if relative.is_empty() {
        return Err("File path is required".to_string());
    }

    let full_path = root.join(&relative);
    if !full_path.is_file() {
        return Err("File does not exist".to_string());
    }

    let size = fs::metadata(&full_path)
        .map_err(|e| format!("Failed to read file metadata: {e}"))?
        .len();
    let name = relative.rsplit('/').next().unwrap_or(&relative);

    if let Some(mime_type) = image_mime_for_name(name) {
        if size > MAX_IMAGE_FILE_SIZE {
            return Ok(WorkspaceFileContent {
                kind: "tooLarge".to_string(),
                content: String::new(),
                size,
                mime_type: Some(mime_type.to_string()),
            });
        }
        let bytes = fs::read(&full_path).map_err(|e| format!("Failed to read file: {e}"))?;
        return Ok(WorkspaceFileContent {
            kind: "image".to_string(),
            content: base64::engine::general_purpose::STANDARD.encode(bytes),
            size,
            mime_type: Some(mime_type.to_string()),
        });
    }

    // Probe the head of the file first so huge binaries are classified without
    // reading them fully.
    let mut probe = vec![0_u8; BINARY_PROBE_BYTES];
    let probe_len = {
        let mut file =
            fs::File::open(&full_path).map_err(|e| format!("Failed to read file: {e}"))?;
        let mut filled = 0;
        loop {
            let read = file
                .read(&mut probe[filled..])
                .map_err(|e| format!("Failed to read file: {e}"))?;
            if read == 0 || filled + read == BINARY_PROBE_BYTES {
                filled += read;
                break;
            }
            filled += read;
        }
        filled
    };
    if probe[..probe_len].contains(&0) {
        return Ok(WorkspaceFileContent {
            kind: "binary".to_string(),
            content: String::new(),
            size,
            mime_type: None,
        });
    }

    if size > MAX_TEXT_FILE_SIZE {
        return Ok(WorkspaceFileContent {
            kind: "tooLarge".to_string(),
            content: String::new(),
            size,
            mime_type: None,
        });
    }

    let bytes = fs::read(&full_path).map_err(|e| format!("Failed to read file: {e}"))?;
    if bytes.contains(&0) {
        return Ok(WorkspaceFileContent {
            kind: "binary".to_string(),
            content: String::new(),
            size,
            mime_type: None,
        });
    }

    Ok(WorkspaceFileContent {
        kind: "text".to_string(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
        size,
        mime_type: None,
    })
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
    fn list_directory_files_deep_lists_full_git_tree() {
        let _lock = env_lock();
        let repo = temp_repo("deep-git");

        git(&repo, &["init"]);
        fs::create_dir_all(repo.join("src/nested")).unwrap();
        fs::create_dir_all(repo.join("build")).unwrap();
        fs::write(repo.join(".gitignore"), "build/\n").unwrap();
        fs::write(repo.join("src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(repo.join("src/nested/mod.rs"), "// nested\n").unwrap();
        fs::write(repo.join("build/cache.txt"), "ignored\n").unwrap();
        git(&repo, &["add", "."]);

        let listing = list_directory_files_deep_impl(repo.to_str().unwrap()).unwrap();
        assert!(!listing.truncated);
        let paths = listing
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert!(paths.contains(&"src"));
        assert!(paths.contains(&"src/nested"));
        assert!(paths.contains(&"src/nested/mod.rs"));
        assert!(paths.contains(&"src/main.rs"));
        assert!(!paths.contains(&"build"));

        let nested_dir = listing
            .entries
            .iter()
            .find(|entry| entry.path == "src/nested")
            .unwrap();
        assert_eq!(nested_dir.entry_type, "directory");
        assert_eq!(nested_dir.depth, 1);
        let nested_file = listing
            .entries
            .iter()
            .find(|entry| entry.path == "src/nested/mod.rs")
            .unwrap();
        assert_eq!(nested_file.depth, 2);

        let _ = fs::remove_dir_all(repo);
    }

    #[test]
    fn list_directory_files_deep_walks_plain_directories() {
        let root = temp_repo("deep-plain");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("a/b/deep.txt"), "deep\n").unwrap();
        fs::write(root.join("top.md"), "top\n").unwrap();

        let listing = list_directory_files_deep_impl(root.to_str().unwrap()).unwrap();
        let paths = listing
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["a", "top.md", "a/b", "a/b/deep.txt"]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_workspace_file_reads_text() {
        let root = temp_repo("read-text");
        fs::write(root.join("hello.txt"), "hello world\n").unwrap();

        let result = read_workspace_file_impl(root.to_str().unwrap(), "hello.txt").unwrap();
        assert_eq!(result.kind, "text");
        assert_eq!(result.content, "hello world\n");
        assert_eq!(result.size, 12);
        assert_eq!(result.mime_type, None);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_workspace_file_detects_binary() {
        let root = temp_repo("read-binary");
        fs::write(root.join("blob.bin"), [0_u8, 159, 146, 150, 0, 1]).unwrap();

        let result = read_workspace_file_impl(root.to_str().unwrap(), "blob.bin").unwrap();
        assert_eq!(result.kind, "binary");
        assert!(result.content.is_empty());
        assert_eq!(result.size, 6);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_workspace_file_encodes_images_as_base64() {
        let root = temp_repo("read-image");
        let bytes = [0x89_u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        fs::write(root.join("pixel.png"), bytes).unwrap();

        let result = read_workspace_file_impl(root.to_str().unwrap(), "pixel.png").unwrap();
        assert_eq!(result.kind, "image");
        assert_eq!(result.mime_type.as_deref(), Some("image/png"));
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(result.content.as_bytes())
                .unwrap(),
            bytes
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_workspace_file_rejects_escaping_paths() {
        let root = temp_repo("read-escape");
        fs::write(root.join("inside.txt"), "inside\n").unwrap();

        assert!(read_workspace_file_impl(root.to_str().unwrap(), "../outside.txt").is_err());
        assert!(read_workspace_file_impl(root.to_str().unwrap(), "/etc/hosts").is_err());
        assert!(read_workspace_file_impl(root.to_str().unwrap(), "").is_err());
        assert!(read_workspace_file_impl(root.to_str().unwrap(), "missing.txt").is_err());

        let _ = fs::remove_dir_all(root);
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
