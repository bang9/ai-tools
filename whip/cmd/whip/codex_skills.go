package main

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var (
	codexSkillsHTTPClient = &http.Client{Timeout: 30 * time.Second}

	codexSkillsRawURL = func(repo, version, path string) string {
		return fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/whip/skills-codex/%s", repo, version, path)
	}
)

func codexHome() string {
	if h := os.Getenv("CODEX_HOME"); h != "" {
		return h
	}
	return filepath.Join(os.Getenv("HOME"), ".codex")
}

func fetchCodexSkillManifest(repo, version string) ([]string, error) {
	url := codexSkillsRawURL(repo, version, "manifest.txt")
	resp, err := codexSkillsHTTPClient.Get(url)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch codex skills manifest: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %s for %s", resp.Status, url)
	}

	var files []string
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.Contains(line, "..") || filepath.IsAbs(line) {
			continue
		}
		files = append(files, line)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("failed to read codex skills manifest: %w", err)
	}

	if len(files) == 0 {
		return nil, fmt.Errorf("codex skills manifest is empty")
	}

	return files, nil
}

func installCodexSkills(repo, version string) error {
	home := codexHome()
	if _, err := os.Stat(home); os.IsNotExist(err) {
		return nil
	}

	skillFiles, err := fetchCodexSkillManifest(repo, version)
	if err != nil {
		return err
	}

	skillsDir := filepath.Join(home, "skills")
	var lastErr error

	for _, skill := range skillFiles {
		dest := filepath.Join(skillsDir, skill)
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			lastErr = err
			continue
		}

		url := codexSkillsRawURL(repo, version, skill)
		if err := downloadCodexSkill(url, dest); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to download %s: %v\n", skill, err)
			lastErr = err
			continue
		}
	}

	if lastErr != nil {
		return fmt.Errorf("some codex skills failed to install: %w", lastErr)
	}

	fmt.Fprintf(os.Stderr, "Codex skills installed to %s\n", skillsDir)
	return nil
}

func downloadCodexSkill(url, dest string) error {
	resp, err := codexSkillsHTTPClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status %s for %s", resp.Status, url)
	}

	tmp := dest + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}

	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}

	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}

	os.Remove(dest)
	return os.Rename(tmp, dest)
}
