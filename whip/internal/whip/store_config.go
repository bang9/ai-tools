package whip

import (
	"encoding/json"
	"os"
	"path/filepath"
)

func (s *Store) LoadConfig() (*Config, error) {
	path := filepath.Join(s.BaseDir, configFile)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Config{}, nil
		}
		return nil, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (s *Store) SaveConfig(cfg *Config) error {
	return s.withConfigLock(func() error {
		data, err := json.MarshalIndent(cfg, "", "  ")
		if err != nil {
			return err
		}
		return atomicWriteFile(filepath.Join(s.BaseDir, configFile), data, privateFilePerm)
	})
}

func (s *Store) UpdateConfig(fn func(*Config) error) (*Config, error) {
	var updated *Config
	err := s.withConfigLock(func() error {
		cfg, err := s.LoadConfig()
		if err != nil {
			return err
		}
		if err := fn(cfg); err != nil {
			return err
		}
		data, err := json.MarshalIndent(cfg, "", "  ")
		if err != nil {
			return err
		}
		if err := atomicWriteFile(filepath.Join(s.BaseDir, configFile), data, privateFilePerm); err != nil {
			return err
		}
		updated, err = cloneConfig(cfg)
		return err
	})
	return updated, err
}
