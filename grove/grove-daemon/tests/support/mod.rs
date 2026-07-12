//! Shared harness bits for the daemon-backed pub-API tests.
//!
//! Every scratch dir a test makes is an RAII [`TempDir`]: HOME, the daemon base dir and
//! the fake worktrees are all under `/tmp`, and without a `Drop` that removes them each
//! `cargo test` run left a fresh set behind on the developer's machine.

#![allow(dead_code)] // each test binary compiles its own copy and uses a subset.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// A unique SHORT `/tmp` dir, removed when it drops (including on a test panic —
/// `remove_dir_all` runs during unwind).
///
/// SHORT because the daemon's unix socket lives under the base dir and
/// `sockaddr_un.sun_path` caps at ~104 bytes on macOS (the `$TMPDIR` under
/// `/var/folders/…` alone nearly exhausts it), so `std::env::temp_dir()` is unusable
/// here.
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(prefix: &str) -> Self {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            % 1_000_000;
        let path = PathBuf::from(format!("/tmp/gv-{prefix}-{pid}-{nanos}"));
        std::fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn to_path_buf(&self) -> PathBuf {
        self.path.clone()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

impl std::ops::Deref for TempDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.path
    }
}

impl AsRef<Path> for TempDir {
    fn as_ref(&self) -> &Path {
        &self.path
    }
}

impl AsRef<OsStr> for TempDir {
    fn as_ref(&self) -> &OsStr {
        self.path.as_os_str()
    }
}
