package whip

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	whipHomeDirName      = "home"
	whipHomePromptFile   = "prompt.md"
	whipHomePromptCodex  = "prompt-codex.md"
	whipHomeMemoryFile   = "memory.md"
	whipHomeProjectsFile = "projects.md"
)

type whipHomePaths struct {
	Dir         string
	Prompt      string
	PromptCodex string
	Memory      string
	Projects    string
}

func whipHomePathsFor(baseDir string) whipHomePaths {
	dir := filepath.Join(baseDir, whipHomeDirName)
	return whipHomePaths{
		Dir:         dir,
		Prompt:      filepath.Join(dir, whipHomePromptFile),
		PromptCodex: filepath.Join(dir, whipHomePromptCodex),
		Memory:      filepath.Join(dir, whipHomeMemoryFile),
		Projects:    filepath.Join(dir, whipHomeProjectsFile),
	}
}

func ensureWhipHome(baseDir string) (whipHomePaths, error) {
	paths := whipHomePathsFor(baseDir)
	if err := os.MkdirAll(paths.Dir, 0755); err != nil {
		return whipHomePaths{}, fmt.Errorf("create whip home directory: %w", err)
	}

	seeds := map[string]string{
		paths.Prompt:   defaultMasterPrompt(),
		paths.Memory:   defaultWhipMemoryTemplate(),
		paths.Projects: defaultWhipProjectsTemplate(),
	}
	for path, content := range seeds {
		if err := seedFileIfMissing(path, content); err != nil {
			return whipHomePaths{}, err
		}
	}

	return paths, nil
}

func seedFileIfMissing(path string, content string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		if os.IsExist(err) {
			return nil
		}
		return fmt.Errorf("seed %s: %w", path, err)
	}
	defer file.Close()

	if _, err := io.WriteString(file, content); err != nil {
		return fmt.Errorf("seed %s: %w", path, err)
	}
	return nil
}

func prepareMasterPrompt(paths whipHomePaths, backend string) (string, error) {
	switch backend {
	case "codex":
		return prepareCodexMasterPrompt(paths)
	default:
		return paths.Prompt, nil
	}
}

func prepareCodexMasterPrompt(paths whipHomePaths) (string, error) {
	basePrompt, err := os.ReadFile(paths.Prompt)
	if err != nil {
		return "", fmt.Errorf("read shared master prompt: %w", err)
	}
	derived := renderMasterPromptForBackend(string(basePrompt), "codex")
	if err := atomicWriteHomeFile(paths.PromptCodex, derived); err != nil {
		return "", fmt.Errorf("write Codex master prompt: %w", err)
	}
	return paths.PromptCodex, nil
}

func atomicWriteHomeFile(path string, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp.*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		tmp.Close()
		os.Remove(tmpPath)
	}

	if _, err := io.WriteString(tmp, content); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Chmod(0644); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}

func renderMasterPromptForBackend(basePrompt string, backend string) string {
	switch backend {
	case "codex":
		return appendMasterPromptSection(basePrompt, codexMasterPromptAppendix(), codexMasterPromptHeading)
	default:
		return basePrompt
	}
}

func appendMasterPromptSection(basePrompt, appendix, heading string) string {
	if strings.Contains(basePrompt, heading) {
		return basePrompt
	}

	base := strings.TrimRight(basePrompt, "\n")
	extra := strings.TrimLeft(appendix, "\n")
	if base == "" {
		return extra
	}
	return base + "\n\n" + extra
}

const codexMasterPromptHeading = "## Codex Worker Silent Session Fallback"

func codexMasterPromptAppendix() string {
	return `## Codex Worker Silent Session Fallback
Use this only for Codex-backed worker sessions. Claude workers can keep polling IRC with /loop, but Codex workers do not have an equivalent background inbox polling loop in this workflow.

If a Codex worker has been silent for a while and it is running in tmux:
- Attach to the tmux session or send input to it.
- Tell the worker to run: claude-irc inbox
- Press Enter / submit the prompt so the worker actually processes the instruction.
- Then continue normal IRC coordination after it resumes.
`
}

func defaultMasterPrompt() string {
	return `You are the whip master session managing task agents.

## Getting Started
Run these commands to initialize your session:

1. Join the communication channel:
   claude-irc join "${WHIP_MASTER_IRC:-wp-master}"

2. Enable periodic message check:
   /loop 1m claude-irc inbox

3. Read the home files before assigning work or replying:
   - WHIP_HOME/home/memory.md (default: ~/.whip/home/memory.md)
   - WHIP_HOME/home/projects.md (default: ~/.whip/home/projects.md)

4. Treat those files as reference context while coordinating agents, then wait for instructions from the dashboard operator.

## Task Lifecycle Commands
- Use explicit task lifecycle commands when changing state: assign, start, review, request-changes, approve, complete, fail, cancel.
- Run 'whip task lifecycle' to inspect the full state machine.
- Run 'whip task <action> --help' for the exact transition and side effects of one action.

## Home Directory
WHIP_HOME/home/ (default: ~/.whip/home/) persists across master sessions.

- prompt.md: This system prompt. Treat it as the source of truth for master-session behavior.
- memory.md: Durable user preferences, operational patterns, and judgment criteria. Read it first; only update it when the operator explicitly asks you to persist new guidance.
- projects.md: Project registry with paths, tech stacks, status, and notes. Read it first; only update it when the operator explicitly asks you to persist project metadata.

## Workspace Context
- The current workspace master identity is passed via the WHIP_MASTER_IRC environment variable.
- Use that value consistently for claude-irc join, approvals, and coordination.
- wp-master is only the legacy default for the global workspace.

## Memory Management
- Default to read-only use.
- Only save durable context that will still matter in future sessions when the operator explicitly requests persistence.
- Prefer concrete user preferences, workflow expectations, review standards, environment quirks, and proven operating heuristics.
- Do not store secrets, access tokens, or one-off transient notes.
- If asked to update memory.md, edit it in place with concise changes instead of rewriting the whole file.

## Projects Management
- Default to read-only use.
- Keep projects.md factual and compact when updates are explicitly requested.
- Add or update rows only after the operator asks you to persist confirmed project metadata.
- Preserve existing information when possible; edit only the parts that changed.
- If details are uncertain, mark them as uncertain instead of guessing.

## Restrictions
NEVER use interactive or user-facing tools such as AskUserQuestion, webform, or any tool that requires user input via the terminal or browser. You are a background agent — all communication must go through claude-irc.
`
}

func defaultWhipMemoryTemplate() string {
	return `# Memory
## User Preferences

## Operational Patterns

## Judgment Criteria
`
}

func defaultWhipProjectsTemplate() string {
	return `# Projects
| Project | Path | Stack | Status | Notes |
|---------|------|-------|--------|-------|
`
}
