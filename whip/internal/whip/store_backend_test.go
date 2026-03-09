package whip

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBackendPersistence(t *testing.T) {
	s := tempStore(t)
	task := NewTask("Backend Test", "desc", "/tmp")
	task.Backend = "claude"
	s.SaveTask(task)

	loaded, err := s.LoadTask(task.ID)
	if err != nil {
		t.Fatalf("LoadTask: %v", err)
	}
	if loaded.Backend != "claude" {
		t.Errorf("Backend = %q, want %q", loaded.Backend, "claude")
	}
}

func TestBackendEmptyDefault(t *testing.T) {
	s := tempStore(t)
	task := NewTask("No Backend", "desc", "/tmp")
	s.SaveTask(task)

	loaded, err := s.LoadTask(task.ID)
	if err != nil {
		t.Fatalf("LoadTask: %v", err)
	}
	if loaded.Backend != "" {
		t.Errorf("Backend = %q, want empty", loaded.Backend)
	}

	b, err := GetBackend(loaded.Backend)
	if err != nil {
		t.Fatalf("GetBackend: %v", err)
	}
	if b.Name() != "claude" {
		t.Errorf("default backend = %q, want %q", b.Name(), "claude")
	}
}

func TestConfig(t *testing.T) {
	s := tempStore(t)

	cfg, err := s.LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.MasterIRCName != "" {
		t.Errorf("default MasterIRCName = %q, want empty", cfg.MasterIRCName)
	}

	cfg.MasterIRCName = "whip-master"
	if err := s.SaveConfig(cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}

	cfg2, err := s.LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig after save: %v", err)
	}
	if cfg2.MasterIRCName != "whip-master" {
		t.Errorf("MasterIRCName = %q, want %q", cfg2.MasterIRCName, "whip-master")
	}
}

func TestResolveWhipBaseDir_UsesEnvOverride(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	override := filepath.Join(tmpHome, whipDir, "custom-whip-home")
	t.Setenv("WHIP_HOME", override)

	got, err := ResolveWhipBaseDir()
	if err != nil {
		t.Fatalf("ResolveWhipBaseDir: %v", err)
	}
	want, err := canonicalizeStorePath(override)
	if err != nil {
		t.Fatalf("canonicalizeStorePath: %v", err)
	}
	if got != want {
		t.Fatalf("ResolveWhipBaseDir = %q, want %q", got, want)
	}
}

func TestResolveWhipBaseDir_UsesDefaultRoot(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	got, err := ResolveWhipBaseDir()
	if err != nil {
		t.Fatalf("ResolveWhipBaseDir: %v", err)
	}

	want, err := canonicalizeStorePath(filepath.Join(tmpHome, whipDir))
	if err != nil {
		t.Fatalf("canonicalizeStorePath: %v", err)
	}
	if got != want {
		t.Fatalf("ResolveWhipBaseDir = %q, want %q", got, want)
	}

	assertMode(t, got, privateDirPerm)
	assertMode(t, filepath.Join(got, storeMetaFile), privateFilePerm)
}

func TestResolveWhipBaseDir_AcceptsPrivateSubpath(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	override := filepath.Join(tmpHome, whipDir, "installs", "primary")
	t.Setenv("WHIP_HOME", override)

	got, err := ResolveWhipBaseDir()
	if err != nil {
		t.Fatalf("ResolveWhipBaseDir: %v", err)
	}
	want, err := canonicalizeStorePath(override)
	if err != nil {
		t.Fatalf("canonicalizeStorePath: %v", err)
	}
	if got != want {
		t.Fatalf("ResolveWhipBaseDir = %q, want %q", got, want)
	}

	assertMode(t, got, privateDirPerm)
	assertMode(t, filepath.Join(got, storeMetaFile), privateFilePerm)
}

func TestResolveWhipBaseDir_RejectsPathOutsideCanonicalRoot(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("WHIP_HOME", filepath.Join(t.TempDir(), "outside"))

	_, err := ResolveWhipBaseDir()
	if err == nil || !strings.Contains(err.Error(), "outside canonical root") {
		t.Fatalf("ResolveWhipBaseDir error = %v, want outside canonical root", err)
	}
}

func TestResolveWhipBaseDir_RejectsSymlinkEscape(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	root := filepath.Join(tmpHome, whipDir)
	if err := os.MkdirAll(root, privateDirPerm); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	outside := t.TempDir()
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("Symlink: %v", err)
	}

	t.Setenv("WHIP_HOME", filepath.Join(link, "nested"))
	_, err := ResolveWhipBaseDir()
	if err == nil || !strings.Contains(err.Error(), "outside canonical root") {
		t.Fatalf("ResolveWhipBaseDir error = %v, want outside canonical root", err)
	}
}

func TestResolveWhipBaseDir_RejectsSymlinkedDefaultRoot(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	defaultRoot := filepath.Join(tmpHome, whipDir)
	outside := t.TempDir()
	if err := os.Symlink(outside, defaultRoot); err != nil {
		t.Fatalf("Symlink: %v", err)
	}

	_, err := ResolveWhipBaseDir()
	if err == nil || !strings.Contains(err.Error(), "must not be a symlink") {
		t.Fatalf("ResolveWhipBaseDir error = %v, want symlink rejection", err)
	}
}

func TestResolveWhipBaseDir_RejectsInsecurePermissions(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	root := filepath.Join(tmpHome, whipDir)
	if err := os.MkdirAll(root, privateDirPerm); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.Chmod(root, 0o777); err != nil {
		t.Fatalf("Chmod: %v", err)
	}

	_, err := ResolveWhipBaseDir()
	if err == nil || !strings.Contains(err.Error(), "group/world writable") {
		t.Fatalf("ResolveWhipBaseDir error = %v, want group/world writable rejection", err)
	}
}

func TestResolveWhipBaseDir_RejectsMarkerMismatch(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	root := filepath.Join(tmpHome, whipDir)
	if err := os.MkdirAll(root, privateDirPerm); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	meta := storeMetadata{
		StoreKind:     "claude-irc",
		OwnerUID:      os.Geteuid(),
		CanonicalRoot: root,
		CreatedAt:     time.Now().UTC(),
		InstallID:     "bad-install",
	}
	writeStoreMetadataFixture(t, filepath.Join(root, storeMetaFile), meta)

	_, err := ResolveWhipBaseDir()
	if err == nil || !strings.Contains(err.Error(), "store kind mismatch") {
		t.Fatalf("ResolveWhipBaseDir error = %v, want store kind mismatch", err)
	}
}

func TestNewStore_CreatesPrivateSensitiveFiles(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	assertMode(t, store.BaseDir, privateDirPerm)
	assertMode(t, filepath.Join(store.BaseDir, storeMetaFile), privateFilePerm)

	cfg := &Config{MasterIRCName: "whip-master"}
	if err := store.SaveConfig(cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	assertMode(t, filepath.Join(store.BaseDir, configFile), privateFilePerm)
	assertMode(t, filepath.Join(store.BaseDir, configLock), privateFilePerm)

	task := NewTask("Secure task", "desc", "/tmp")
	if err := store.SaveTask(task); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}
	assertMode(t, store.taskLockPath(task.ID), privateFilePerm)
}

func writeStoreMetadataFixture(t *testing.T, path string, meta storeMetadata) {
	t.Helper()

	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent: %v", err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(path, data, privateFilePerm); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat(%q): %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %o, want %o", path, got, want)
	}
}
