package vaultkey

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	configDirName    = ".vaultkey"
	DefaultVaultName = "default"
)

var vaultNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`)

type VaultEntry struct {
	RepoPath string `json:"repo_path"`
}

type Config struct {
	DefaultVault string                `json:"default_vault,omitempty"`
	Vaults       map[string]VaultEntry `json:"vaults,omitempty"`

	// LegacyRepoPath is the pre-multi-vault single repo path. It is
	// normalized into Vaults on load and never written back.
	LegacyRepoPath string `json:"repo_path,omitempty"`
}

func ConfigDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, configDirName)
}

func ConfigPath() string {
	return filepath.Join(ConfigDir(), "config.json")
}

// ReposDir is where repos for newly initialized vaults are cloned
// (legacy configs may point elsewhere, e.g. ~/.vaultkey/repo).
func ReposDir() string {
	return filepath.Join(ConfigDir(), "repos")
}

func ValidateVaultName(name string) error {
	if !vaultNamePattern.MatchString(name) {
		return fmt.Errorf("invalid vault name %q (must start with a letter or digit, and contain only letters, digits, '-' or '_')", name)
	}
	return nil
}

// LoadConfig reads the config and fails if vaultkey was never initialized.
func LoadConfig() (*Config, error) {
	cfg, err := LoadConfigIfExists()
	if err != nil {
		return nil, err
	}
	if len(cfg.Vaults) == 0 {
		return nil, fmt.Errorf("not initialized (run 'vaultkey init' first)")
	}
	return cfg, nil
}

// LoadConfigIfExists reads the config, returning an empty config if the
// file does not exist yet.
func LoadConfigIfExists() (*Config, error) {
	configDir := ConfigDir()
	if err := EnsurePathNotSymlink(configDir); err != nil {
		return nil, fmt.Errorf("checking config dir: %w", err)
	}

	configPath := ConfigPath()
	if err := EnsurePathNotSymlink(configPath); err != nil {
		return nil, fmt.Errorf("checking config path: %w", err)
	}

	raw, err := os.ReadFile(configPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &Config{Vaults: make(map[string]VaultEntry)}, nil
		}
		return nil, fmt.Errorf("reading config: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}
	cfg.normalize()
	return &cfg, nil
}

// normalize upgrades a legacy single-vault config to the multi-vault form.
func (c *Config) normalize() {
	if c.Vaults == nil {
		c.Vaults = make(map[string]VaultEntry)
	}
	if c.LegacyRepoPath != "" {
		if _, exists := c.Vaults[DefaultVaultName]; !exists {
			c.Vaults[DefaultVaultName] = VaultEntry{RepoPath: c.LegacyRepoPath}
		}
		c.LegacyRepoPath = ""
	}
	if c.DefaultVault == "" && len(c.Vaults) == 1 {
		for name := range c.Vaults {
			c.DefaultVault = name
		}
	}
}

// Resolve picks a vault by name. An empty name falls back to the default
// vault. Returns the resolved name and its entry.
func (c *Config) Resolve(name string) (string, VaultEntry, error) {
	if name == "" {
		name = c.DefaultVault
	}
	if name == "" {
		return "", VaultEntry{}, fmt.Errorf("no default vault set (run 'vaultkey use <name>' or pass --vault; available: %s)", c.vaultNames())
	}
	entry, ok := c.Vaults[name]
	if !ok {
		return "", VaultEntry{}, fmt.Errorf("vault %q not found (available: %s)", name, c.vaultNames())
	}
	return name, entry, nil
}

func (c *Config) VaultNames() []string {
	names := make([]string, 0, len(c.Vaults))
	for name := range c.Vaults {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func (c *Config) vaultNames() string {
	names := c.VaultNames()
	if len(names) == 0 {
		return "none"
	}
	return strings.Join(names, ", ")
}

func SaveConfig(cfg *Config) error {
	dir := ConfigDir()
	if err := EnsurePathNotSymlink(dir); err != nil {
		return fmt.Errorf("checking config dir: %w", err)
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("creating config dir: %w", err)
	}

	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling config: %w", err)
	}
	raw = append(raw, '\n')

	if err := writeFileAtomically(ConfigPath(), raw, 0600); err != nil {
		return fmt.Errorf("writing config: %w", err)
	}
	return nil
}
