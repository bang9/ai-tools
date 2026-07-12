//! Finding the REAL agent binary — i.e. every `claude` on PATH except grove's own shim.
//!
//! This is the one part of the launcher that can fail CATASTROPHICALLY rather than
//! merely uselessly: a resolver that hands back grove's own wrapper execs it, which
//! execs `grove-agent launch`, which resolves… A dead pane at 100% CPU, and in `exec`
//! form it is not even a fork bomb — one process spinning forever. So the exclusions are
//! layered, and each layer catches a case the one above it cannot:
//!
//! | # | Exclusion | The case it catches |
//! |---|---|---|
//! | D0 | `$GROVE_BIN_DIR` (fallback `~/.grove/bin`) | the normal one. Passed explicitly by `daemon_child_env` so it never has to be inferred. |
//! | D1 | `dirname(current_exe)` | `grove-agent` invoked from somewhere other than `~/.grove/bin` (a dev tree, an app bundle). |
//! | D2 | a candidate that IS our own exe | a `claude` symlinked to `grove-agent`. |
//! | D3 | a file containing `GROVE_AGENT_WRAPPER` | a grove shim reachable through an UNEXPECTED PATH entry (a user copied it, a dotfile added a dir). |
//! | D4 | `$GROVE_AGENT_SKIP` — canonical paths already exec'd in this chain | a version-manager shim (rbenv/asdf/mise) that re-execs `claude` BY NAME and lands straight back in grove's wrapper. Nothing above catches this: the shim is a legitimate, non-grove binary. |
//! | — | `GROVE_AGENT_DEPTH` cap | the absolute backstop. At the cap we strip `~/.grove/bin` from the child's PATH and exec: it always terminates. |
//!
//! We compare CANONICAL paths but **exec the path as found on PATH** (`~/.local/bin/claude`,
//! not `…/versions/2.1.207/claude`), so a version manager that swaps the symlink under us
//! does not pin the user to a stale build.

use std::path::{Path, PathBuf};

/// Marker every grove shim carries in its source. D3.
pub const WRAPPER_MARKER: &str = "GROVE_AGENT_WRAPPER";
/// Colon-separated canonical paths already exec'd in this launch chain. D4.
pub const SKIP_ENV: &str = "GROVE_AGENT_SKIP";
/// How many grove wrappers this chain has already been through.
pub const DEPTH_ENV: &str = "GROVE_AGENT_DEPTH";
/// `~/.grove/bin`, exported by `daemon_child_env`. D0.
pub const BIN_DIR_ENV: &str = "GROVE_BIN_DIR";
/// The absolute backstop: past this, strip grove's bin dir from the child's PATH.
pub const DEPTH_CAP: u32 = 8;

/// Everything the resolver needs, gathered from the environment so the algorithm itself
/// is pure and testable.
#[derive(Debug, Clone, Default)]
pub struct ResolveCtx {
    /// `$PATH`, in order.
    pub path: Vec<PathBuf>,
    /// Canonical `~/.grove/bin`.
    pub grove_bin: Option<PathBuf>,
    /// Canonical `dirname(current_exe)`.
    pub self_dir: Option<PathBuf>,
    /// Canonical `current_exe`.
    pub self_exe: Option<PathBuf>,
    /// Canonical paths this chain has already exec'd.
    pub skip: Vec<PathBuf>,
    pub depth: u32,
}

impl ResolveCtx {
    /// Read the context out of the process environment.
    pub fn from_env() -> Self {
        let self_exe = std::env::current_exe().ok().and_then(canonical);
        let self_dir = self_exe.as_deref().and_then(Path::parent).map(Path::to_path_buf);
        Self {
            path: std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).collect())
                .unwrap_or_default(),
            grove_bin: grove_bin_dir().and_then(canonical),
            self_dir,
            self_exe,
            skip: std::env::var_os(SKIP_ENV)
                .map(|s| std::env::split_paths(&s).collect())
                .unwrap_or_default(),
            depth: std::env::var(DEPTH_ENV)
                .ok()
                .and_then(|d| d.parse().ok())
                .unwrap_or(0),
        }
    }
}

/// `$GROVE_BIN_DIR`, else `~/.grove/bin`. Never inferred from `current_exe` — that is
/// exactly the inference that produced an infinite exec loop when `grove-agent` shipped
/// outside `~/.grove/bin`.
pub fn grove_bin_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(BIN_DIR_ENV).filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    Some(dirs::home_dir()?.join(".grove").join("bin"))
}

fn canonical(path: PathBuf) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// The real `tool`, or `None`. Returns the path AS FOUND on PATH (never canonicalized).
pub fn find_real_binary(tool: &str, ctx: &ResolveCtx) -> Option<PathBuf> {
    // At the depth cap we still refuse grove's own directories (otherwise we would exec
    // ourselves), but we ignore the skip list: something is bouncing, and the child's
    // PATH will have `~/.grove/bin` stripped, so this exec is the last one in the chain.
    let honor_skip = ctx.depth < DEPTH_CAP;

    for dir in &ctx.path {
        let canon_dir = canonical(dir.clone());
        if let Some(canon_dir) = &canon_dir {
            if Some(canon_dir) == ctx.grove_bin.as_ref() || Some(canon_dir) == ctx.self_dir.as_ref()
            {
                continue; // D0 / D1
            }
        }
        let candidate = dir.join(tool);
        if !is_executable_file(&candidate) {
            continue;
        }
        let canon = canonical(candidate.clone());
        if let Some(canon) = &canon {
            if Some(canon) == ctx.self_exe.as_ref() {
                continue; // D2
            }
            if honor_skip && ctx.skip.contains(canon) {
                continue; // D4
            }
        }
        if is_grove_wrapper(&candidate) {
            continue; // D3
        }
        return Some(candidate);
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// Content-sniff for the shim marker. Reads at most the first 4 KiB — a real agent binary
/// is a multi-megabyte Mach-O and we must not slurp it.
fn is_grove_wrapper(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut head = [0u8; 4096];
    let Ok(read) = file.read(&mut head) else {
        return false;
    };
    String::from_utf8_lossy(&head[..read]).contains(WRAPPER_MARKER)
}

/// The child's `PATH`. Normally UNCHANGED — `~/.grove/bin` must stay on it, because it
/// also carries the `open` link-interception wrapper, and dropping it silently breaks
/// link interception (a rewrite did exactly that once).
///
/// Only at [`DEPTH_CAP`] do we strip it, as the loop backstop: with grove's shims off the
/// child's PATH, a binary that re-execs `claude` by name cannot come back to us.
pub fn child_path(ctx: &ResolveCtx) -> Option<String> {
    if ctx.depth < DEPTH_CAP {
        return None;
    }
    let kept: Vec<PathBuf> = ctx
        .path
        .iter()
        .filter(|dir| canonical((*dir).clone()).as_ref() != ctx.grove_bin.as_ref())
        .cloned()
        .collect();
    std::env::join_paths(kept)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// The `GROVE_AGENT_SKIP` value for the child: this chain's skips plus the binary we are
/// about to exec.
pub fn child_skip(ctx: &ResolveCtx, chosen: &Path) -> Option<String> {
    let mut skip = ctx.skip.clone();
    if let Some(canon) = canonical(chosen.to_path_buf()) {
        if !skip.contains(&canon) {
            skip.push(canon);
        }
    }
    std::env::join_paths(skip)
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    struct Tree(PathBuf);

    impl Tree {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "grove-resolve-{name}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn bin(&self, dir: &str, name: &str, body: &str) -> PathBuf {
            let d = self.0.join(dir);
            fs::create_dir_all(&d).unwrap();
            let p = d.join(name);
            fs::write(&p, body).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
            p
        }
        fn dir(&self, dir: &str) -> PathBuf {
            let d = self.0.join(dir);
            fs::create_dir_all(&d).unwrap();
            fs::canonicalize(d).unwrap()
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn ctx(tree: &Tree, dirs: &[&str]) -> ResolveCtx {
        ResolveCtx {
            path: dirs.iter().map(|d| tree.0.join(d)).collect(),
            grove_bin: Some(tree.dir("grove")),
            ..Default::default()
        }
    }

    #[test]
    fn the_real_binary_wins_and_groves_shim_is_never_chosen() {
        let tree = Tree::new("basic");
        tree.bin("grove", "claude", "#!/bin/sh\n# GROVE_AGENT_WRAPPER\n");
        let real = tree.bin("local", "claude", "#!/bin/sh\necho real\n");

        // grove's bin is FIRST on PATH (that is the whole point of the shim) — and it is
        // still skipped.
        let found = find_real_binary("claude", &ctx(&tree, &["grove", "local"])).unwrap();
        assert_eq!(fs::canonicalize(found).unwrap(), fs::canonicalize(real).unwrap());
    }

    #[test]
    fn a_wrapper_on_an_unexpected_path_entry_is_content_sniffed_and_skipped() {
        // D3: the user copied grove's shim somewhere else, or a dotfile put a stray dir on
        // PATH. The dir-based exclusions cannot see this; the marker can. Without it, we
        // would exec the wrapper, which execs us, forever.
        let tree = Tree::new("sniff");
        tree.bin(
            "stray",
            "claude",
            "#!/usr/bin/env bash\n# GROVE_AGENT_WRAPPER — Grove-managed claude shim\nexec grove-agent launch claude -- \"$@\"\n",
        );
        let real = tree.bin("local", "claude", "#!/bin/sh\necho real\n");
        let found = find_real_binary("claude", &ctx(&tree, &["stray", "local"])).unwrap();
        assert_eq!(fs::canonicalize(found).unwrap(), fs::canonicalize(real).unwrap());
    }

    #[test]
    fn a_version_manager_shim_that_bounces_back_is_skipped_the_second_time() {
        // D4, the one nothing else catches. `~/.local/bin/claude` is an rbenv-style shim:
        // a legitimate, non-grove binary that re-execs `claude` BY NAME. Without the skip
        // list it finds grove's wrapper again and the chain never terminates.
        let tree = Tree::new("skip");
        let shim = tree.bin("local", "claude", "#!/bin/sh\nexec claude \"$@\"\n");
        let real = tree.bin("versions", "claude", "#!/bin/sh\necho real\n");

        let mut c = ctx(&tree, &["local", "versions"]);
        let first = find_real_binary("claude", &c).unwrap();
        assert_eq!(
            fs::canonicalize(&first).unwrap(),
            fs::canonicalize(&shim).unwrap(),
            "the first pass takes the shim — it looks exactly like the real thing"
        );

        // …and the second pass, carrying the skip the first one exported, moves past it.
        c.skip = std::env::split_paths(&child_skip(&c, &first).unwrap()).collect();
        let second = find_real_binary("claude", &c).unwrap();
        assert_eq!(
            fs::canonicalize(second).unwrap(),
            fs::canonicalize(real).unwrap()
        );
    }

    #[test]
    fn a_candidate_that_is_our_own_exe_is_skipped() {
        // D2: `claude` symlinked straight at grove-agent.
        let tree = Tree::new("selfexe");
        let me = tree.bin("app", "grove-agent", "#!/bin/sh\n");
        let link = tree.0.join("bin");
        fs::create_dir_all(&link).unwrap();
        std::os::unix::fs::symlink(&me, link.join("claude")).unwrap();
        let real = tree.bin("local", "claude", "#!/bin/sh\necho real\n");

        let c = ResolveCtx {
            path: vec![tree.0.join("bin"), tree.0.join("local")],
            self_exe: Some(fs::canonicalize(&me).unwrap()),
            // NOT self_dir: the point is that the candidate itself is us, found through a
            // directory we have no reason to exclude.
            ..Default::default()
        };
        assert_eq!(
            fs::canonicalize(find_real_binary("claude", &c).unwrap()).unwrap(),
            fs::canonicalize(real).unwrap()
        );
    }

    #[test]
    fn no_binary_anywhere_is_none_not_a_panic() {
        let tree = Tree::new("missing");
        assert!(find_real_binary("claude", &ctx(&tree, &["local"])).is_none());
    }

    #[test]
    fn the_child_keeps_grove_bin_on_path_until_the_depth_cap_strips_it() {
        let tree = Tree::new("depth");
        tree.bin("grove", "claude", "#!/bin/sh\n# GROVE_AGENT_WRAPPER\n");
        tree.bin("local", "claude", "#!/bin/sh\n");
        let mut c = ctx(&tree, &["grove", "local"]);

        // The normal case: PATH is passed through untouched. `~/.grove/bin` MUST stay on
        // it — it also carries the `open` link-interception wrapper.
        assert_eq!(child_path(&c), None, "no PATH rewrite below the cap");

        // The backstop: at the cap, grove's dir is stripped, so a binary that re-execs by
        // name cannot find the shim again. The chain always terminates.
        c.depth = DEPTH_CAP;
        let path = child_path(&c).expect("the cap rewrites PATH");
        let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
        assert!(!dirs.iter().any(|d| fs::canonicalize(d).ok() == c.grove_bin));
        assert!(dirs.iter().any(|d| d.ends_with("local")));
    }
}
