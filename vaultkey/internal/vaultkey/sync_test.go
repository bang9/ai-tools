package vaultkey

import (
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func mustGit(t *testing.T, repoPath string, args ...string) {
	t.Helper()
	out, err := git(repoPath, args...)
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// setupSyncRepos creates a bare remote with one synced clone and returns
// (remote, clone). The clone has a pushed vault containing app/KEY.
func setupSyncRepos(t *testing.T, password string) (string, string) {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	clone := filepath.Join(root, "clone")

	if out, err := exec.Command("git", "init", "--bare", remote).CombinedOutput(); err != nil {
		t.Fatalf("git init --bare: %v\n%s", err, out)
	}
	if err := GitClone(remote, clone); err != nil {
		t.Fatalf("GitClone: %v", err)
	}
	configureTestGit(t, clone)

	v, err := CreateVault(clone, password)
	if err != nil {
		t.Fatalf("CreateVault: %v", err)
	}
	if err := v.Set("app", "KEY", "base"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := GitSync(clone); err != nil {
		t.Fatalf("GitSync: %v", err)
	}
	return remote, clone
}

func configureTestGit(t *testing.T, repoPath string) {
	t.Helper()
	mustGit(t, repoPath, "config", "user.name", "test")
	mustGit(t, repoPath, "config", "user.email", "test@example.com")
	mustGit(t, repoPath, "config", "commit.gpgsign", "false")
}

func cloneSecond(t *testing.T, remote string) string {
	t.Helper()
	second := filepath.Join(t.TempDir(), "clone2")
	if err := GitClone(remote, second); err != nil {
		t.Fatalf("GitClone second: %v", err)
	}
	configureTestGit(t, second)
	return second
}

// breakRemote points origin at a nonexistent path so pushes/pulls fail.
func breakRemote(t *testing.T, repoPath string) (restore func()) {
	t.Helper()
	out, err := git(repoPath, "remote", "get-url", "origin")
	if err != nil {
		t.Fatalf("remote get-url: %v\n%s", err, out)
	}
	original := strings.TrimSpace(string(out))
	mustGit(t, repoPath, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "missing.git"))
	return func() {
		mustGit(t, repoPath, "remote", "set-url", "origin", original)
	}
}

func TestGitSyncPushesPreviouslyUnpushedCommits(t *testing.T) {
	const pw = "pw"
	_, clone := setupSyncRepos(t, pw)

	// Commit while the remote is unreachable — sync fails, commit stays local
	restore := breakRemote(t, clone)
	v, err := LoadVault(clone, pw)
	if err != nil {
		t.Fatalf("LoadVault: %v", err)
	}
	if err := v.Set("app", "KEY", "offline"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := GitSync(clone); err == nil {
		t.Fatal("expected sync to fail with broken remote")
	}
	if AheadCount(clone) != 1 {
		t.Fatalf("expected 1 unpushed commit, got %d", AheadCount(clone))
	}

	// Remote is back: a plain push (GitSync with nothing staged) must
	// actually push the leftover commit, not silently report success.
	restore()
	if err := GitPush(clone); err != nil {
		t.Fatalf("GitPush: %v", err)
	}
	if got := AheadCount(clone); got != 0 {
		t.Fatalf("commit still unpushed after GitPush (ahead=%d)", got)
	}
}

func TestGitPullConflictAbortsRebaseAndReturnsGuidance(t *testing.T) {
	const pw = "pw"
	remote, cloneA := setupSyncRepos(t, pw)
	cloneB := cloneSecond(t, remote)

	// B commits a conflicting change while "offline"
	restore := breakRemote(t, cloneB)
	vb, err := LoadVault(cloneB, pw)
	if err != nil {
		t.Fatalf("LoadVault B: %v", err)
	}
	if err := vb.Set("app", "KEY", "from-B"); err != nil {
		t.Fatalf("Set B: %v", err)
	}
	_ = GitSync(cloneB) // commits locally, push fails
	restore()

	// A pushes a change to the same key
	va, err := LoadVault(cloneA, pw)
	if err != nil {
		t.Fatalf("LoadVault A: %v", err)
	}
	if err := va.Set("app", "KEY", "from-A"); err != nil {
		t.Fatalf("Set A: %v", err)
	}
	if err := GitSync(cloneA); err != nil {
		t.Fatalf("GitSync A: %v", err)
	}

	// B pulls → rebase conflict → must abort and return SyncConflictError
	err = GitPull(cloneB)
	var conflict *SyncConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected SyncConflictError, got %v", err)
	}
	if RebaseInProgress(cloneB) {
		t.Fatal("rebase left in progress after conflicted pull")
	}
	// The vault must still be readable — no conflict markers on disk
	if _, err := LoadVault(cloneB, pw); err != nil {
		t.Fatalf("vault unreadable after conflicted pull: %v", err)
	}

	// SyncMutation must refuse to build on the diverged state
	err = SyncMutation(cloneB, pw, func(v *Vault) error {
		return v.Set("other", "K2", "x")
	})
	if !errors.As(err, &conflict) {
		t.Fatalf("expected SyncConflictError from SyncMutation, got %v", err)
	}

	// repair --take-remote equivalent: reset to upstream and sync
	if err := ResetToUpstream(cloneB); err != nil {
		t.Fatalf("ResetToUpstream: %v", err)
	}
	if err := GitSync(cloneB); err != nil {
		t.Fatalf("GitSync after reset: %v", err)
	}
	vb2, err := LoadVault(cloneB, pw)
	if err != nil {
		t.Fatalf("LoadVault B after repair: %v", err)
	}
	got, err := vb2.Get("app", "KEY")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != "from-A" {
		t.Fatalf("expected remote value from-A after take-remote, got %q", got)
	}
}

func TestLoadVaultReportsConflictMarkers(t *testing.T) {
	const pw = "pw"
	_, clone := setupSyncRepos(t, pw)

	vaultPath := filepath.Join(clone, "vault.json")
	conflicted := "<<<<<<< HEAD\n{\"version\":2}\n=======\n{\"version\":2}\n>>>>>>> other\n"
	if err := writeFileAtomically(vaultPath, []byte(conflicted), 0600); err != nil {
		t.Fatalf("write conflicted vault: %v", err)
	}

	_, err := LoadVault(clone, pw)
	var conflict *SyncConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected SyncConflictError for conflicted vault.json, got %v", err)
	}
	if !VaultFileHasConflictMarkers(clone) {
		t.Fatal("VaultFileHasConflictMarkers should be true")
	}

	// repair path: restore from HEAD
	if err := RestoreVaultFile(clone); err != nil {
		t.Fatalf("RestoreVaultFile: %v", err)
	}
	if _, err := LoadVault(clone, pw); err != nil {
		t.Fatalf("vault still unreadable after restore: %v", err)
	}
}

func TestSyncMutationHappyPath(t *testing.T) {
	const pw = "pw"
	remote, cloneA := setupSyncRepos(t, pw)
	cloneB := cloneSecond(t, remote)

	// A pushes a new value; B mutates a different key afterwards — B must
	// pick up A's change and push cleanly.
	if err := SyncMutation(cloneA, pw, func(v *Vault) error {
		return v.Set("app", "KEY", "from-A")
	}); err != nil {
		t.Fatalf("SyncMutation A: %v", err)
	}
	if err := SyncMutation(cloneB, pw, func(v *Vault) error {
		return v.Set("other", "K2", "x")
	}); err != nil {
		t.Fatalf("SyncMutation B: %v", err)
	}
	if got := AheadCount(cloneB); got != 0 {
		t.Fatalf("B has %d unpushed commits", got)
	}

	vb, err := LoadVault(cloneB, pw)
	if err != nil {
		t.Fatalf("LoadVault: %v", err)
	}
	if got, _ := vb.Get("app", "KEY"); got != "from-A" {
		t.Fatalf("B missing A's change, got %q", got)
	}
}
