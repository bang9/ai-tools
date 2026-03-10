package whip

import (
	"fmt"
	"time"

	"github.com/google/uuid"
)

// ClaudeBackend implements SessionBackend for Claude Code.
type ClaudeBackend struct{}

func (b *ClaudeBackend) Name() string { return "claude" }

func (b *ClaudeBackend) GeneratePrompt(task *Task) string {
	if task.Role == TaskRoleLead {
		return generateClaudeLeadPrompt(task)
	}
	return generateClaudePrompt(task)
}

func (b *ClaudeBackend) BuildLaunchCmd(task *Task, promptPath string) string {
	sessionFlag := b.prepareSessionFlag(task)
	modelFlags := b.prepareModelFlags(task)

	flags := sessionFlag
	if modelFlags != "" {
		flags = modelFlags + " " + flags
	}

	return fmt.Sprintf(
		`claude --dangerously-skip-permissions %s "Read and follow %s"`,
		flags,
		shellEscape(promptPath),
	)
}

func (b *ClaudeBackend) SyncSession(task *Task, promptPath string, launchedAt time.Time) error {
	return nil
}

// prepareSessionFlag sets up the Claude session flag for a task spawn.
// Each assignment starts a fresh backend session and overwrites SessionID.
func (b *ClaudeBackend) prepareSessionFlag(task *Task) string {
	task.SessionID = uuid.New().String()
	return "--session-id " + shellEscape(task.SessionID)
}

// prepareModelFlags returns CLI flags for claude based on task difficulty.
func (b *ClaudeBackend) prepareModelFlags(task *Task) string {
	switch task.Difficulty {
	case "hard":
		return "--model opus --effort high"
	case "medium":
		return "--model opus --effort medium"
	case "easy":
		return "--model sonnet"
	default:
		return ""
	}
}
