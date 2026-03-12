package vaultkey

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const configDirName = ".vaultkey"

type Config struct {
	RepoPath string `json:"repo_path"`
}

func ConfigDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, configDirName)
}

func ConfigPath() string {
	return filepath.Join(ConfigDir(), "config.json")
}

func LoadConfig() (*Config, error) {
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
			return nil, fmt.Errorf("not initialized (run 'vaultkey init' first)")
		}
		return nil, fmt.Errorf("reading config: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}
	return &cfg, nil
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
