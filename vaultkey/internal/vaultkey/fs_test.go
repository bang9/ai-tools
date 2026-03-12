package vaultkey

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsurePathNotSymlinkRejectsSymlinkedPath(t *testing.T) {
	root := t.TempDir()
	realDir := filepath.Join(root, "real")
	if err := os.MkdirAll(realDir, 0700); err != nil {
		t.Fatalf("mkdir real dir: %v", err)
	}

	linkDir := filepath.Join(root, "link")
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Fatalf("symlink dir: %v", err)
	}

	err := EnsurePathNotSymlink(linkDir)
	if err == nil {
		t.Fatal("expected symlinked path to be rejected")
	}
	if !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink error, got %v", err)
	}
}

func TestWriteFileAtomicallyRejectsSymlinkedPath(t *testing.T) {
	root := t.TempDir()
	targetFile := filepath.Join(root, "target.json")
	if err := os.WriteFile(targetFile, []byte("secret"), 0600); err != nil {
		t.Fatalf("write target file: %v", err)
	}

	linkFile := filepath.Join(root, "link.json")
	if err := os.Symlink(targetFile, linkFile); err != nil {
		t.Fatalf("symlink file: %v", err)
	}

	err := writeFileAtomically(linkFile, []byte("secret"), 0600)
	if err == nil {
		t.Fatal("expected write through symlinked path to be rejected")
	}
	if !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink error, got %v", err)
	}
}

func TestSaveConfigRejectsSymlinkedConfigDir(t *testing.T) {
	homeDir := t.TempDir()
	realConfigDir := filepath.Join(homeDir, "real-vaultkey")
	if err := os.MkdirAll(realConfigDir, 0700); err != nil {
		t.Fatalf("mkdir real config dir: %v", err)
	}

	configLink := filepath.Join(homeDir, configDirName)
	if err := os.Symlink(realConfigDir, configLink); err != nil {
		t.Fatalf("symlink config dir: %v", err)
	}

	t.Setenv("HOME", homeDir)

	err := SaveConfig(&Config{RepoPath: filepath.Join(homeDir, "repo")})
	if err == nil {
		t.Fatal("expected symlinked config dir to be rejected")
	}
	if !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink error, got %v", err)
	}
}

func TestLoadVaultRejectsSymlinkedRepoPath(t *testing.T) {
	root := t.TempDir()
	repoTarget := filepath.Join(root, "repo-target")
	if err := os.MkdirAll(repoTarget, 0700); err != nil {
		t.Fatalf("mkdir repo target: %v", err)
	}

	v, err := CreateVault(repoTarget, "pw")
	if err != nil {
		t.Fatalf("CreateVault: %v", err)
	}
	if err := v.Set("app", "KEY", "secret"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	repoLink := filepath.Join(root, "repo-link")
	if err := os.Symlink(repoTarget, repoLink); err != nil {
		t.Fatalf("symlink repo path: %v", err)
	}

	_, err = LoadVault(repoLink, "pw")
	if err == nil {
		t.Fatal("expected symlinked repo path to be rejected")
	}
	if !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink error, got %v", err)
	}
}

func TestCreateVaultRejectsSymlinkedRepoPath(t *testing.T) {
	root := t.TempDir()
	repoTarget := filepath.Join(root, "repo-target")
	if err := os.MkdirAll(repoTarget, 0700); err != nil {
		t.Fatalf("mkdir repo target: %v", err)
	}

	repoLink := filepath.Join(root, "repo-link")
	if err := os.Symlink(repoTarget, repoLink); err != nil {
		t.Fatalf("symlink repo path: %v", err)
	}

	_, err := CreateVault(repoLink, "pw")
	if err == nil {
		t.Fatal("expected symlinked repo path to be rejected")
	}
	if !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink error, got %v", err)
	}
}
