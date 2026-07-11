package vaultkey

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigLegacyMigration(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	dir := filepath.Join(home, configDirName)
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	legacy := `{"repo_path": "/some/path/repo"}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}

	if cfg.LegacyRepoPath != "" {
		t.Errorf("LegacyRepoPath should be cleared after normalize, got %q", cfg.LegacyRepoPath)
	}
	if cfg.DefaultVault != DefaultVaultName {
		t.Errorf("DefaultVault = %q, want %q", cfg.DefaultVault, DefaultVaultName)
	}
	entry, ok := cfg.Vaults[DefaultVaultName]
	if !ok {
		t.Fatalf("legacy repo not migrated into Vaults: %+v", cfg.Vaults)
	}
	if entry.RepoPath != "/some/path/repo" {
		t.Errorf("RepoPath = %q, want /some/path/repo", entry.RepoPath)
	}

	// Round-trip: saving must not write the legacy field back
	if err := SaveConfig(cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) == legacy {
		t.Error("config not rewritten in multi-vault format")
	}
	cfg2, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig after save: %v", err)
	}
	if cfg2.Vaults[DefaultVaultName].RepoPath != "/some/path/repo" {
		t.Errorf("round-trip lost repo path: %+v", cfg2)
	}
}

func TestLoadConfigNotInitialized(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	if _, err := LoadConfig(); err == nil {
		t.Fatal("expected error for missing config")
	}

	cfg, err := LoadConfigIfExists()
	if err != nil {
		t.Fatalf("LoadConfigIfExists: %v", err)
	}
	if len(cfg.Vaults) != 0 {
		t.Errorf("expected empty vaults, got %+v", cfg.Vaults)
	}
}

func TestConfigResolve(t *testing.T) {
	cfg := &Config{
		DefaultVault: "personal",
		Vaults: map[string]VaultEntry{
			"personal": {RepoPath: "/repos/personal"},
			"work":     {RepoPath: "/repos/work"},
		},
	}

	name, entry, err := cfg.Resolve("")
	if err != nil {
		t.Fatalf("Resolve(default): %v", err)
	}
	if name != "personal" || entry.RepoPath != "/repos/personal" {
		t.Errorf("Resolve(default) = %q %q", name, entry.RepoPath)
	}

	name, entry, err = cfg.Resolve("work")
	if err != nil {
		t.Fatalf("Resolve(work): %v", err)
	}
	if name != "work" || entry.RepoPath != "/repos/work" {
		t.Errorf("Resolve(work) = %q %q", name, entry.RepoPath)
	}

	if _, _, err := cfg.Resolve("nope"); err == nil {
		t.Error("expected error for unknown vault")
	}

	// No default set with multiple vaults → must error, not guess
	cfg.DefaultVault = ""
	if _, _, err := cfg.Resolve(""); err == nil {
		t.Error("expected error when no default vault is set")
	}
}

func TestNormalizeSingleVaultBecomesDefault(t *testing.T) {
	cfg := &Config{
		Vaults: map[string]VaultEntry{
			"work": {RepoPath: "/repos/work"},
		},
	}
	cfg.normalize()
	if cfg.DefaultVault != "work" {
		t.Errorf("DefaultVault = %q, want work", cfg.DefaultVault)
	}
}

func TestValidateVaultName(t *testing.T) {
	valid := []string{"default", "work", "my-team", "team_2", "A1"}
	for _, name := range valid {
		if err := ValidateVaultName(name); err != nil {
			t.Errorf("ValidateVaultName(%q) = %v, want nil", name, err)
		}
	}

	invalid := []string{"", "-lead", "_x", "..", "a/b", "a b", "한글", "a.b"}
	for _, name := range invalid {
		if err := ValidateVaultName(name); err == nil {
			t.Errorf("ValidateVaultName(%q) = nil, want error", name)
		}
	}
}
