package vaultkey

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var credentialURLPattern = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)([^/\s@]+@)`)

func RedactURLCredentials(value string) string {
	return credentialURLPattern.ReplaceAllString(value, "${1}***@")
}

// SyncConflictError indicates local vault commits conflict with remote
// changes. The message carries full recovery instructions.
type SyncConflictError struct {
	RepoPath string
	Detail   string
}

func (e *SyncConflictError) Error() string {
	msg := "sync conflict: local vault commits conflict with remote changes\n" +
		"  repo:         " + e.RepoPath + "\n" +
		"  auto-recover: vaultkey repair --take-remote   (discard local unpushed changes, keep remote)\n" +
		"                vaultkey repair --keep-local    (overwrite remote with local state)\n" +
		"  manual:       cd " + e.RepoPath + " && git pull --rebase, resolve conflicts, then run 'vaultkey push'"
	if e.Detail != "" {
		msg += "\n  detail: " + e.Detail
	}
	return msg
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

func git(repoPath string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"-C", repoPath}, args...)...)
	return cmd.CombinedOutput()
}

func GitClone(repoURL, dest string) error {
	cmd := exec.Command("git", "clone", repoURL, dest)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return gitCommandError("git clone", out, err)
	}
	return nil
}

// RebaseInProgress reports whether repoPath has an unfinished rebase.
func RebaseInProgress(repoPath string) bool {
	for _, marker := range []string{"rebase-merge", "rebase-apply"} {
		out, err := git(repoPath, "rev-parse", "--git-path", marker)
		if err != nil {
			continue
		}
		p := strings.TrimSpace(string(out))
		if !filepath.IsAbs(p) {
			p = filepath.Join(repoPath, p)
		}
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return false
}

// AbortRebase aborts an in-progress rebase, restoring the pre-pull state.
func AbortRebase(repoPath string) {
	_, _ = git(repoPath, "rebase", "--abort")
}

// AheadCount returns how many local commits are not on the upstream branch.
func AheadCount(repoPath string) int {
	out, err := git(repoPath, "rev-list", "--count", "@{u}..HEAD")
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	return n
}

// ResetToUpstream discards local commits and working tree changes, resetting
// the branch to the latest upstream state.
func ResetToUpstream(repoPath string) error {
	if out, err := git(repoPath, "fetch", "origin"); err != nil {
		return gitCommandError("git fetch", out, err)
	}
	if out, err := git(repoPath, "reset", "--hard", "@{u}"); err != nil {
		return gitCommandError("git reset", out, err)
	}
	return nil
}

// GitPull pulls with rebase. On a rebase conflict it aborts the rebase so the
// repo is never left in a broken state, and returns a SyncConflictError with
// recovery instructions.
func GitPull(repoPath string) error {
	out, err := git(repoPath, "pull", "--rebase")
	if err != nil {
		if RebaseInProgress(repoPath) {
			AbortRebase(repoPath)
			return &SyncConflictError{RepoPath: repoPath}
		}
		return gitCommandError("git pull", out, err)
	}
	return nil
}

// GitSync commits any staged vault changes, reconciles with the remote, and
// pushes everything that is not on the remote yet (including commits left
// behind by a previously failed push).
func GitSync(repoPath string) error {
	if out, err := git(repoPath, "add", vaultFileName); err != nil {
		return gitCommandError("git add", out, err)
	}

	// Commit if there are staged changes
	if _, err := git(repoPath, "diff", "--cached", "--quiet"); err != nil {
		if out, err := git(repoPath, "commit", "-m", "vault: update secrets"); err != nil {
			return gitCommandError("git commit", out, err)
		}
	}

	if hasUpstream(repoPath) {
		if err := GitPull(repoPath); err != nil {
			return err
		}
		if AheadCount(repoPath) == 0 {
			return nil
		}
	}

	// Push, retrying once through a concurrent-push race
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		out, err := git(repoPath, "push", "-u", "origin", "HEAD")
		if err == nil {
			return nil
		}
		lastErr = gitCommandError("git push", out, err)
		if hasUpstream(repoPath) {
			if perr := GitPull(repoPath); perr != nil {
				return perr
			}
		}
	}
	return lastErr
}

func GitPush(repoPath string) error {
	return GitSync(repoPath)
}

// ForcePushLocal overwrites the remote branch with the local state. Used by
// 'repair --keep-local'; --force-with-lease still protects pushes that
// happened after our last fetch.
func ForcePushLocal(repoPath string) error {
	if out, err := git(repoPath, "fetch", "origin"); err != nil {
		return gitCommandError("git fetch", out, err)
	}
	if out, err := git(repoPath, "push", "--force-with-lease", "origin", "HEAD"); err != nil {
		return gitCommandError("git push --force-with-lease", out, err)
	}
	return nil
}

func hasUpstream(repoPath string) bool {
	cmd := exec.Command("git", "-C", repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
	return cmd.Run() == nil
}
