package whip

import (
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// CodexBackend implements SessionBackend for the Codex CLI.
type CodexBackend struct{}

func (b *CodexBackend) Name() string { return "codex" }

func (b *CodexBackend) GeneratePrompt(task *Task) string {
	if task.Role == TaskRoleLead {
		return generateCodexLeadPrompt(task)
	}
	return generateCodexPrompt(task)
}

func (b *CodexBackend) BuildLaunchCmd(task *Task, promptPath string) string {
	args := append([]string{"codex"}, b.commonArgs(task)...)
	prompt := codexPromptArg(promptPath)
	args = append(args, prompt)
	return shellJoin(args)
}

func (b *CodexBackend) SyncSession(task *Task, promptPath string, launchedAt time.Time) error {
	if _, err := exec.LookPath("codex"); err != nil {
		return fmt.Errorf("codex CLI not found. Install it with: npm install -g @openai/codex")
	}
	id, err := waitForCodexSession(task.CWD, promptPath, launchedAt, 30*time.Second)
	if err != nil {
		return err
	}
	task.SessionID = id
	return nil
}

func (b *CodexBackend) commonArgs(task *Task) []string {
	args := []string{
		"--dangerously-bypass-approvals-and-sandbox",
		"--no-alt-screen",
	}

	model, effort := b.modelConfig(task)
	if model != "" {
		args = append(args, "-m", model)
	}
	if effort != "" {
		args = append(args, "-c", fmt.Sprintf("model_reasoning_effort=%q", effort))
	}

	return args
}

func (b *CodexBackend) modelConfig(task *Task) (model string, effort string) {
	model = "gpt-5.4"
	switch task.Difficulty {
	case "hard":
		return model, "xhigh"
	case "medium":
		return model, "xhigh"
	case "easy":
		return model, "high"
	default:
		return model, "xhigh"
	}
}

func codexPromptArg(promptPath string) string {
	return fmt.Sprintf("Read and follow %s", promptPath)
}

func shellJoin(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, arg := range args {
		if strings.TrimSpace(arg) == "" {
			continue
		}
		quoted = append(quoted, shellEscape(arg))
	}
	return strings.Join(quoted, " ")
}
