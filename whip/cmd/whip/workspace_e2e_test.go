package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	whiplib "github.com/bang9/ai-tools/whip/internal/whip"
)

func TestWorkspaceDropGitWorktreeFlow(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	store := tempWhipStore(t)
	repo := initWhipCLIRepo(t)
	repoAppDir := filepath.Join(repo, "app")

	runWhipCLI(t, "task", "create", "API task", "--workspace", "issue-sweep", "--cwd", repoAppDir, "--desc", "test task")

	tasks, err := store.ListTasks()
	if err != nil {
		t.Fatalf("ListTasks after create: %v", err)
	}
	if len(tasks) != 1 {
		t.Fatalf("ListTasks count = %d, want 1", len(tasks))
	}

	workspace, err := store.LoadWorkspace("issue-sweep")
	if err != nil {
		t.Fatalf("LoadWorkspace: %v", err)
	}
	if workspace.EffectiveExecutionModel() != whiplib.WorkspaceExecutionModelGitWorktree {
		t.Fatalf("EffectiveExecutionModel = %q, want %q", workspace.EffectiveExecutionModel(), whiplib.WorkspaceExecutionModelGitWorktree)
	}
	if workspace.WorktreePath == "" {
		t.Fatalf("WorktreePath should be set for git-backed workspace")
	}
	if taskCWD := tasks[0].CWD; taskCWD != filepath.Join(workspace.WorktreePath, "app") {
		t.Fatalf("Task.CWD = %q, want %q", taskCWD, filepath.Join(workspace.WorktreePath, "app"))
	}
	if _, err := os.Stat(workspace.WorktreePath); err != nil {
		t.Fatalf("worktree path should exist before drop: %v", err)
	}

	runWhipCLI(t, "workspace", "drop", "issue-sweep")

	if _, err := store.LoadWorkspace("issue-sweep"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("LoadWorkspace after drop = %v, want not found", err)
	}
	tasks, err = store.ListTasks()
	if err != nil {
		t.Fatalf("ListTasks after drop: %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("ListTasks count after drop = %d, want 0", len(tasks))
	}
	if _, err := os.Stat(workspace.WorktreePath); !os.IsNotExist(err) {
		t.Fatalf("worktree path should be removed after drop, got err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(repo, "app", "main.txt")); err != nil {
		t.Fatalf("original repo should remain intact after drop: %v", err)
	}
}

func TestWorkspaceDropDirectCWDFlow(t *testing.T) {
	store := tempWhipStore(t)
	nonGitDir := canonicalTestPath(t, t.TempDir())
	markerPath := filepath.Join(nonGitDir, "marker.txt")
	if err := os.WriteFile(markerPath, []byte("keep"), 0o644); err != nil {
		t.Fatalf("write marker: %v", err)
	}

	runWhipCLI(t, "task", "create", "Docs task", "--workspace", "docs-lane", "--cwd", nonGitDir, "--desc", "docs")

	workspace, err := store.LoadWorkspace("docs-lane")
	if err != nil {
		t.Fatalf("LoadWorkspace: %v", err)
	}
	if workspace.EffectiveExecutionModel() != whiplib.WorkspaceExecutionModelDirectCWD {
		t.Fatalf("EffectiveExecutionModel = %q, want %q", workspace.EffectiveExecutionModel(), whiplib.WorkspaceExecutionModelDirectCWD)
	}
	if workspace.WorktreePath != "" {
		t.Fatalf("WorktreePath = %q, want empty", workspace.WorktreePath)
	}

	runWhipCLI(t, "workspace", "drop", "docs-lane")

	if _, err := os.Stat(markerPath); err != nil {
		t.Fatalf("original non-git cwd content should remain after drop: %v", err)
	}
	tasks, err := store.ListTasks()
	if err != nil {
		t.Fatalf("ListTasks after drop: %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("ListTasks count after drop = %d, want 0", len(tasks))
	}
	if _, err := store.LoadWorkspace("docs-lane"); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("LoadWorkspace after drop = %v, want not found", err)
	}
}

func TestWorkspaceDropRejectsActiveTaskWithoutForce(t *testing.T) {
	store := tempWhipStore(t)
	nonGitDir := canonicalTestPath(t, t.TempDir())

	runWhipCLI(t, "task", "create", "Docs task", "--workspace", "docs-lane", "--cwd", nonGitDir, "--desc", "docs")

	tasks, err := store.ListTasks()
	if err != nil {
		t.Fatalf("ListTasks: %v", err)
	}
	if len(tasks) != 1 {
		t.Fatalf("ListTasks count = %d, want 1", len(tasks))
	}
	task := tasks[0]
	task.Status = whiplib.StatusAssigned
	if err := store.SaveTask(task); err != nil {
		t.Fatalf("SaveTask assigned: %v", err)
	}

	err = execWhipCLI("workspace", "drop", "docs-lane")
	if err == nil {
		t.Fatalf("workspace drop should fail when active task exists")
	}
	if !strings.Contains(err.Error(), "rerun with --force") {
		t.Fatalf("workspace drop error = %v, want rerun with --force", err)
	}

	runWhipCLI(t, "workspace", "drop", "docs-lane", "--force")

	tasks, err = store.ListTasks()
	if err != nil {
		t.Fatalf("ListTasks after forced drop: %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("ListTasks count after forced drop = %d, want 0", len(tasks))
	}
}

func tempWhipStore(t *testing.T) *whiplib.Store {
	t.Helper()

	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("WHIP_HOME", filepath.Join(tmpHome, ".whip", "test-store"))

	store, err := whiplib.NewStore()
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return store
}

func runWhipCLI(t *testing.T, args ...string) {
	t.Helper()
	if err := execWhipCLI(args...); err != nil {
		t.Fatalf("whip %s: %v", strings.Join(args, " "), err)
	}
}

func execWhipCLI(args ...string) error {
	root := newRootCmd()
	root.SetArgs(args)
	return root.Execute()
}

func initWhipCLIRepo(t *testing.T) string {
	t.Helper()

	repo := canonicalTestPath(t, t.TempDir())
	runWhipGit(t, repo, "init")
	runWhipGit(t, repo, "config", "user.name", "Whip CLI Test")
	runWhipGit(t, repo, "config", "user.email", "whip-cli@example.com")

	if err := os.MkdirAll(filepath.Join(repo, "app"), 0o755); err != nil {
		t.Fatalf("mkdir app: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write README: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, "app", "main.txt"), []byte("seed\n"), 0o644); err != nil {
		t.Fatalf("write app/main.txt: %v", err)
	}

	runWhipGit(t, repo, "add", "README.md", "app/main.txt")
	runWhipGit(t, repo, "commit", "-m", "init")
	return repo
}

func runWhipGit(t *testing.T, repo string, args ...string) {
	t.Helper()

	cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
}

func canonicalTestPath(t *testing.T, path string) string {
	t.Helper()

	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		t.Fatalf("Abs(%q): %v", path, err)
	}
	return abs
}
