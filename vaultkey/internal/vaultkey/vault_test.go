package vaultkey

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func tempRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	return dir
}

func TestCreateAndLoad(t *testing.T) {
	repo := tempRepo(t)
	pw := "test-password-123"

	v, err := CreateVault(repo, pw)
	if err != nil {
		t.Fatalf("CreateVault: %v", err)
	}

	if err := v.Set("app", "KEY", "secret-value"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	// Reload from disk
	v2, err := LoadVault(repo, pw)
	if err != nil {
		t.Fatalf("LoadVault: %v", err)
	}

	got, err := v2.Get("app", "KEY")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	if got != "secret-value" {
		t.Errorf("got %q, want %q", got, "secret-value")
	}
}

func TestWrongPassword(t *testing.T) {
	repo := tempRepo(t)

	v, err := CreateVault(repo, "correct-password")
	if err != nil {
		t.Fatalf("CreateVault: %v", err)
	}

	if err := v.Set("app", "KEY", "secret"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	v2, err := LoadVault(repo, "wrong-password")
	if err != nil {
		t.Fatalf("LoadVault: %v", err)
	}

	_, err = v2.Get("app", "KEY")
	if err == nil {
		t.Fatal("expected decryption error with wrong password")
	}
}

func TestScopeIsolation(t *testing.T) {
	repo := tempRepo(t)
	pw := "password"

	v, err := CreateVault(repo, pw)
	if err != nil {
		t.Fatalf("CreateVault: %v", err)
	}

	if err := v.Set("app/dev", "KEY", "dev-value"); err != nil {
		t.Fatalf("Set dev: %v", err)
	}
	if err := v.Set("app/prod", "KEY", "prod-value"); err != nil {
		t.Fatalf("Set prod: %v", err)
	}

	v2, err := LoadVault(repo, pw)
	if err != nil {
		t.Fatalf("LoadVault: %v", err)
	}

	dev, err := v2.Get("app/dev", "KEY")
	if err != nil {
		t.Fatalf("Get dev: %v", err)
	}
	prod, err := v2.Get("app/prod", "KEY")
	if err != nil {
		t.Fatalf("Get prod: %v", err)
	}

	if dev != "dev-value" {
		t.Errorf("dev: got %q, want %q", dev, "dev-value")
	}
	if prod != "prod-value" {
		t.Errorf("prod: got %q, want %q", prod, "prod-value")
	}
}

func TestListPrefixMatching(t *testing.T) {
	repo := tempRepo(t)
	pw := "password"

	v, err := CreateVault(repo, pw)
	if err != nil {
		t.Fatalf("CreateVault: %v", err)
	}

	v.Set("menulens/dev", "JWT", "a")
	v.Set("menulens/prod", "JWT", "b")
	v.Set("ponte", "API_KEY", "c")

	all := v.List("")
	if len(all) != 3 {
		t.Errorf("list all: got %d entries, want 3", len(all))
	}

	ml := v.List("menulens")
	if len(ml) != 2 {
		t.Errorf("list menulens: got %d entries, want 2", len(ml))
	}

	ponte := v.List("ponte")
	if len(ponte) != 1 {
		t.Errorf("list ponte: got %d entries, want 1", len(ponte))
	}
}

func TestDelete(t *testing.T) {
	repo := tempRepo(t)
	pw := "password"

	v, err := CreateVault(repo, pw)
	if err != nil {
		t.Fatalf("CreateVault: %v", err)
	}

	v.Set("app", "A", "1")
	v.Set("app", "B", "2")

	if err := v.Delete("app", "A"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	if _, err := v.Get("app", "A"); err == nil {
		t.Error("expected error after delete")
	}

	got, err := v.Get("app", "B")
	if err != nil {
		t.Fatalf("Get B: %v", err)
	}
	if got != "2" {
		t.Errorf("B: got %q, want %q", got, "2")
	}
}

func TestDeleteRemovesEmptyScope(t *testing.T) {
	repo := tempRepo(t)
	pw := "password"

	v, err := CreateVault(repo, pw)
	if err != nil {
		t.Fatalf("CreateVault: %v", err)
	}

	v.Set("temp", "ONLY", "value")

	if err := v.Delete("temp", "ONLY"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	entries := v.List("temp")
	if len(entries) != 0 {
		t.Errorf("expected empty scope to be removed, got %v", entries)
	}
}

func TestCreateVaultAlreadyExists(t *testing.T) {
	repo := tempRepo(t)

	if _, err := CreateVault(repo, "pw"); err != nil {
		t.Fatalf("first create: %v", err)
	}

	_, err := CreateVault(repo, "pw")
	if err == nil {
		t.Fatal("expected error on duplicate create")
	}
}

func TestLoadVaultNotFound(t *testing.T) {
	_, err := LoadVault(t.TempDir(), "pw")
	if err == nil {
		t.Fatal("expected error when vault doesn't exist")
	}
}

func TestVaultFilePermissions(t *testing.T) {
	repo := tempRepo(t)

	if _, err := CreateVault(repo, "pw"); err != nil {
		t.Fatalf("CreateVault: %v", err)
	}

	info, err := os.Stat(filepath.Join(repo, vaultFileName))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}

	perm := info.Mode().Perm()
	if perm != 0600 {
		t.Errorf("vault file permissions: got %o, want 0600", perm)
	}
}

func TestLoadVaultRejectsSymlink(t *testing.T) {
	repo := tempRepo(t)

	salt := make([]byte, saltSize)
	payload, err := json.Marshal(VaultFile{
		Version: vaultVersion,
		Salt:    base64.StdEncoding.EncodeToString(salt),
		Scopes:  map[string]map[string]EncryptedValue{},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}

	target := filepath.Join(repo, "actual-vault.json")
	if err := os.WriteFile(target, payload, 0600); err != nil {
		t.Fatalf("write target: %v", err)
	}

	link := filepath.Join(repo, vaultFileName)
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	_, err = LoadVault(repo, "pw")
	if err == nil {
		t.Fatal("expected symlinked vault path to be rejected")
	}
	if !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink error, got %v", err)
	}
}

func TestCreateVaultRejectsBrokenSymlink(t *testing.T) {
	repo := tempRepo(t)

	link := filepath.Join(repo, vaultFileName)
	if err := os.Symlink(filepath.Join(repo, "missing-vault.json"), link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	_, err := CreateVault(repo, "pw")
	if err == nil {
		t.Fatal("expected create to fail when vault path is a symlink")
	}
	if !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("expected symlink error, got %v", err)
	}
}
