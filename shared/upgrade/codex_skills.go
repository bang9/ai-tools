package upgrade

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func codexSkillsRawURL(repo, version, toolName, path string) string {
	return fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s/skills-codex/%s", repo, version, toolName, path)
}

func codexHome() string {
	if h := os.Getenv("CODEX_HOME"); h != "" {
		return h
	}
	return filepath.Join(os.Getenv("HOME"), ".codex")
}

func fetchCodexSkillManifest(repo, version, toolName string) ([]string, error) {
	url := codexSkillsRawURL(repo, version, toolName, "manifest.txt")
	body, err := downloadBytes(url)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch codex skills manifest: %w", err)
	}

	var files []string
	scanner := bufio.NewScanner(strings.NewReader(string(body)))
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

func downloadCodexSkill(url, dest string) error {
	tmp := dest + ".tmp"
	if err := downloadToFile(url, tmp); err != nil {
		os.Remove(tmp)
		return err
	}
	os.Remove(dest)
	return os.Rename(tmp, dest)
}

// InstallCodexSkills returns a PostUpgrade callback that installs codex skills
// for the given tool from its skills-codex/ manifest.
func InstallCodexSkills(toolName string) func(repo, version string) error {
	return func(repo, version string) error {
		home := codexHome()
		if _, err := os.Stat(home); os.IsNotExist(err) {
			return nil
		}

		skillFiles, err := fetchCodexSkillManifest(repo, version, toolName)
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

			url := codexSkillsRawURL(repo, version, toolName, skill)
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
}
