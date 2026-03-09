package whip

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureWorkspaceUsesGitWorktreeModelAndReusesWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	store := tempStore(t)
	repo := initWorkspaceTestRepo(t)

	workspace, resolvedApp, err := store.EnsureWorkspace("issue-sweep", filepath.Join(repo, "app"))
	if err != nil {
		t.Fatalf("EnsureWorkspace app: %v", err)
	}
	assertWorkspaceModel(t, workspace, WorkspaceExecutionModelGitWorktree)

	wantWorktreePath, err := canonicalizeStorePath(store.workspaceWorktreePath("issue-sweep"))
	if err != nil {
		t.Fatalf("canonicalize worktree path: %v", err)
	}
	if workspace.WorktreePath != wantWorktreePath {
		t.Fatalf("WorktreePath = %q, want %q", workspace.WorktreePath, wantWorktreePath)
	}
	if workspace.OriginalRepoPath != repo {
		t.Fatalf("OriginalRepoPath = %q, want %q", workspace.OriginalRepoPath, repo)
	}
	if resolvedApp != filepath.Join(workspace.WorktreePath, "app") {
		t.Fatalf("resolved app cwd = %q, want %q", resolvedApp, filepath.Join(workspace.WorktreePath, "app"))
	}
	if _, err := os.Stat(workspace.WorktreePath); err != nil {
		t.Fatalf("worktree path should exist: %v", err)
	}

	workspaceAgain, resolvedAPI, err := store.EnsureWorkspace("issue-sweep", filepath.Join(repo, "api"))
	if err != nil {
		t.Fatalf("EnsureWorkspace api: %v", err)
	}
	assertWorkspaceModel(t, workspaceAgain, WorkspaceExecutionModelGitWorktree)
	if workspaceAgain.WorktreePath != workspace.WorktreePath {
		t.Fatalf("WorktreePath changed across ensure calls: %q vs %q", workspaceAgain.WorktreePath, workspace.WorktreePath)
	}
	if resolvedAPI != filepath.Join(workspace.WorktreePath, "api") {
		t.Fatalf("resolved api cwd = %q, want %q", resolvedAPI, filepath.Join(workspace.WorktreePath, "api"))
	}

	loaded, err := store.LoadWorkspace("issue-sweep")
	if err != nil {
		t.Fatalf("LoadWorkspace: %v", err)
	}
	assertWorkspaceModel(t, loaded, WorkspaceExecutionModelGitWorktree)
}

func TestEnsureWorkspaceAcceptsExistingWorktreePath(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	store := tempStore(t)
	repo := initWorkspaceTestRepo(t)

	workspace, _, err := store.EnsureWorkspace("issue-sweep", filepath.Join(repo, "app"))
	if err != nil {
		t.Fatalf("EnsureWorkspace first call: %v", err)
	}

	worktreeAppDir := filepath.Join(workspace.WorktreePath, "app")
	workspaceAgain, resolved, err := store.EnsureWorkspace("issue-sweep", worktreeAppDir)
	if err != nil {
		t.Fatalf("EnsureWorkspace from existing worktree dir: %v", err)
	}
	assertWorkspaceModel(t, workspaceAgain, WorkspaceExecutionModelGitWorktree)
	if resolved != worktreeAppDir {
		t.Fatalf("resolved cwd = %q, want %q", resolved, worktreeAppDir)
	}
}

func TestEnsureWorkspaceRejectsNonGitCWDForGitBackedWorkspace(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	store := tempStore(t)
	repo := initWorkspaceTestRepo(t)
	subdir := filepath.Join(repo, "app")

	workspace, resolved, err := store.EnsureWorkspace("issue-sweep", subdir)
	if err != nil {
		t.Fatalf("EnsureWorkspace first call: %v", err)
	}
	if workspace.OriginalRepoPath == "" {
		t.Fatalf("OriginalRepoPath should be set for git-backed workspace")
	}
	if !strings.Contains(resolved, filepath.Join("workspaces", "issue-sweep", "worktree", "app")) {
		t.Fatalf("resolved cwd = %q, want workspace worktree app path", resolved)
	}

	nonGitDir := t.TempDir()
	_, _, err = store.EnsureWorkspace("issue-sweep", nonGitDir)
	if err == nil {
		t.Fatalf("EnsureWorkspace should reject non-git cwd for existing git-backed workspace")
	}
	if !strings.Contains(err.Error(), "is bound to repo") {
		t.Fatalf("EnsureWorkspace error = %v, want repo binding error", err)
	}
}

func TestEnsureWorkspaceFallsBackToNonGitCWD(t *testing.T) {
	store := tempStore(t)
	nonGitDir := t.TempDir()
	canonicalNonGitDir, err := canonicalizeStorePath(nonGitDir)
	if err != nil {
		t.Fatalf("canonicalizeStorePath: %v", err)
	}

	workspace, resolved, err := store.EnsureWorkspace("docs-lane", nonGitDir)
	if err != nil {
		t.Fatalf("EnsureWorkspace: %v", err)
	}
	if resolved != canonicalNonGitDir {
		t.Fatalf("resolved cwd = %q, want %q", resolved, canonicalNonGitDir)
	}
	if workspace.OriginalCWD != canonicalNonGitDir {
		t.Fatalf("OriginalCWD = %q, want %q", workspace.OriginalCWD, canonicalNonGitDir)
	}
	if workspace.OriginalRepoPath != "" {
		t.Fatalf("OriginalRepoPath = %q, want empty", workspace.OriginalRepoPath)
	}
	if workspace.WorktreePath != "" {
		t.Fatalf("WorktreePath = %q, want empty", workspace.WorktreePath)
	}
	assertWorkspaceModel(t, workspace, WorkspaceExecutionModelDirectCWD)

	loaded, err := store.LoadWorkspace("docs-lane")
	if err != nil {
		t.Fatalf("LoadWorkspace: %v", err)
	}
	if loaded.OriginalCWD != canonicalNonGitDir {
		t.Fatalf("loaded OriginalCWD = %q, want %q", loaded.OriginalCWD, canonicalNonGitDir)
	}
	if loaded.OriginalRepoPath != "" || loaded.WorktreePath != "" {
		t.Fatalf("loaded workspace should remain non-git fallback: %+v", loaded)
	}
	assertWorkspaceModel(t, loaded, WorkspaceExecutionModelDirectCWD)
}

func TestEnsureWorkspaceKeepsDirectCWDModelAcrossNonGitCWDs(t *testing.T) {
	store := tempStore(t)
	firstDir := t.TempDir()
	secondDir := t.TempDir()

	firstCanonical, err := canonicalizeStorePath(firstDir)
	if err != nil {
		t.Fatalf("canonicalize first dir: %v", err)
	}
	secondCanonical, err := canonicalizeStorePath(secondDir)
	if err != nil {
		t.Fatalf("canonicalize second dir: %v", err)
	}

	workspace, _, err := store.EnsureWorkspace("docs-lane", firstDir)
	if err != nil {
		t.Fatalf("EnsureWorkspace first dir: %v", err)
	}
	assertWorkspaceModel(t, workspace, WorkspaceExecutionModelDirectCWD)

	workspaceAgain, resolved, err := store.EnsureWorkspace("docs-lane", secondDir)
	if err != nil {
		t.Fatalf("EnsureWorkspace second dir: %v", err)
	}
	assertWorkspaceModel(t, workspaceAgain, WorkspaceExecutionModelDirectCWD)
	if workspaceAgain.OriginalCWD != firstCanonical {
		t.Fatalf("OriginalCWD = %q, want first non-git cwd %q", workspaceAgain.OriginalCWD, firstCanonical)
	}
	if resolved != secondCanonical {
		t.Fatalf("resolved cwd = %q, want %q", resolved, secondCanonical)
	}
}

func TestEnsureWorkspaceRejectsGitCWDForDirectCWDWorkspace(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	store := tempStore(t)
	nonGitDir := t.TempDir()
	if _, _, err := store.EnsureWorkspace("docs-lane", nonGitDir); err != nil {
		t.Fatalf("EnsureWorkspace non-git: %v", err)
	}

	repo := initWorkspaceTestRepo(t)
	_, _, err := store.EnsureWorkspace("docs-lane", filepath.Join(repo, "app"))
	if err == nil {
		t.Fatalf("EnsureWorkspace should reject git cwd for direct-cwd workspace")
	}
	if !strings.Contains(err.Error(), "cannot be rebound to git repo") {
		t.Fatalf("EnsureWorkspace error = %v, want direct-cwd rebound error", err)
	}
}

func TestRemoveWorkspaceWorktreeRemovesGitWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	store := tempStore(t)
	repo := initWorkspaceTestRepo(t)

	workspace, _, err := store.EnsureWorkspace("issue-sweep", filepath.Join(repo, "app"))
	if err != nil {
		t.Fatalf("EnsureWorkspace: %v", err)
	}
	if _, err := os.Stat(workspace.WorktreePath); err != nil {
		t.Fatalf("worktree path should exist before cleanup: %v", err)
	}

	if err := RemoveWorkspaceWorktree(workspace); err != nil {
		t.Fatalf("RemoveWorkspaceWorktree: %v", err)
	}
	if _, err := os.Stat(workspace.WorktreePath); !os.IsNotExist(err) {
		t.Fatalf("worktree path should be removed, got err=%v", err)
	}
}

func TestRemoveWorkspaceWorktreeIsNoopForNonGitWorkspace(t *testing.T) {
	originalDir := t.TempDir()
	markerPath := filepath.Join(originalDir, "marker.txt")
	if err := os.WriteFile(markerPath, []byte("keep me"), 0o644); err != nil {
		t.Fatalf("write marker: %v", err)
	}

	workspace := &Workspace{
		Name:           "docs-lane",
		ExecutionModel: WorkspaceExecutionModelDirectCWD,
		OriginalCWD:    originalDir,
	}
	if err := RemoveWorkspaceWorktree(workspace); err != nil {
		t.Fatalf("RemoveWorkspaceWorktree: %v", err)
	}
	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("original cwd content should remain after noop cleanup: %v", err)
	}
}

func initWorkspaceTestRepo(t *testing.T) string {
	t.Helper()

	repo, err := canonicalizeStorePath(t.TempDir())
	if err != nil {
		t.Fatalf("canonicalize repo dir: %v", err)
	}
	runWorkspaceGit(t, repo, "init")
	runWorkspaceGit(t, repo, "config", "user.name", "Whip Test")
	runWorkspaceGit(t, repo, "config", "user.email", "whip@example.com")

	if err := os.MkdirAll(filepath.Join(repo, "app"), 0o755); err != nil {
		t.Fatalf("mkdir app: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(repo, "api"), 0o755); err != nil {
		t.Fatalf("mkdir api: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, "app", "main.txt"), []byte("seed\n"), 0o644); err != nil {
		t.Fatalf("write app/main.txt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, "api", "main.txt"), []byte("seed\n"), 0o644); err != nil {
		t.Fatalf("write api/main.txt: %v", err)
	}

	runWorkspaceGit(t, repo, "add", "README.md", "app/main.txt", "api/main.txt")
	runWorkspaceGit(t, repo, "commit", "-m", "init")
	return repo
}

func assertWorkspaceModel(t *testing.T, workspace *Workspace, want WorkspaceExecutionModel) {
	t.Helper()

	if workspace == nil {
		t.Fatalf("workspace is nil")
	}
	if got := workspace.EffectiveExecutionModel(); got != want {
		t.Fatalf("EffectiveExecutionModel = %q, want %q", got, want)
	}
	if got := workspace.ExecutionModelLabel(); got != string(want) {
		t.Fatalf("ExecutionModelLabel = %q, want %q", got, want)
	}
}

func runWorkspaceGit(t *testing.T, repo string, args ...string) {
	t.Helper()

	cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
}
