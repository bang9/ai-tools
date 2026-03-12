package vaultkey

import (
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

var credentialURLPattern = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)([^/\s@]+@)`)

func RedactURLCredentials(value string) string {
	return credentialURLPattern.ReplaceAllString(value, "${1}***@")
}

func gitCommandError(operation string, out []byte, err error) error {
	detail := strings.TrimSpace(RedactURLCredentials(string(out)))
	if detail == "" && err != nil {
		detail = strings.TrimSpace(RedactURLCredentials(err.Error()))
	}
	if detail == "" {
		return fmt.Errorf("%s failed", operation)
	}
	return fmt.Errorf("%s failed: %s", operation, detail)
}

func GitClone(repoURL, dest string) error {
	cmd := exec.Command("git", "clone", repoURL, dest)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return gitCommandError("git clone", out, err)
	}
	return nil
}

func GitPull(repoPath string) error {
	cmd := exec.Command("git", "-C", repoPath, "pull", "--rebase")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return gitCommandError("git pull", out, err)
	}
	return nil
}

func GitSync(repoPath string) error {
	// Stage vault.json
	add := exec.Command("git", "-C", repoPath, "add", vaultFileName)
	if out, err := add.CombinedOutput(); err != nil {
		return gitCommandError("git add", out, err)
	}

	// Check if there are staged changes
	diff := exec.Command("git", "-C", repoPath, "diff", "--cached", "--quiet")
	if err := diff.Run(); err == nil {
		// No local changes — just pull
		return GitPull(repoPath)
	}

	// Commit
	commit := exec.Command("git", "-C", repoPath, "commit", "-m", "vault: update secrets")
	if out, err := commit.CombinedOutput(); err != nil {
		return gitCommandError("git commit", out, err)
	}

	// Pull --rebase then push (skip pull if no upstream yet)
	if hasUpstream(repoPath) {
		if err := GitPull(repoPath); err != nil {
			return err
		}
	}

	push := exec.Command("git", "-C", repoPath, "push", "-u", "origin", "HEAD")
	out, err := push.CombinedOutput()
	if err != nil {
		return gitCommandError("git push", out, err)
	}
	return nil
}

func GitPush(repoPath string) error {
	return GitSync(repoPath)
}

func hasUpstream(repoPath string) bool {
	cmd := exec.Command("git", "-C", repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
	return cmd.Run() == nil
}
