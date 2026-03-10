package whip

import (
	"os"
	"os/exec"
)

func tmuxSessionName(taskID string) string {
	return "wp-" + taskID
}

func SpawnTmuxSession(sessionName string, shellCmd string) error {
	cmd := exec.Command("tmux", "new-session", "-d",
		"-s", sessionName,
		"-x", "120", "-y", "40",
		shellCmd,
	)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func SpawnTmux(taskID string, shellCmd string) error {
	return SpawnTmuxSession(tmuxSessionName(taskID), shellCmd)
}

func IsTmuxSessionName(sessionName string) bool {
	cmd := exec.Command("tmux", "has-session", "-t", sessionName)
	return cmd.Run() == nil
}

func IsTmuxSession(taskID string) bool {
	return IsTmuxSessionName(tmuxSessionName(taskID))
}

func KillTmuxSessionName(sessionName string) error {
	cmd := exec.Command("tmux", "kill-session", "-t", sessionName)
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func KillTmuxSession(taskID string) error {
	return KillTmuxSessionName(tmuxSessionName(taskID))
}

func AttachTmuxSessionName(sessionName string) error {
	cmd := exec.Command("tmux", "attach", "-t", sessionName)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func AttachTmuxSession(taskID string) error {
	return AttachTmuxSessionName(tmuxSessionName(taskID))
}

func CaptureTmuxPaneBySessionName(sessionName string) (string, error) {
	cmd := exec.Command("tmux", "capture-pane", "-t", sessionName, "-p")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func CaptureTmuxPane(taskID string) (string, error) {
	return CaptureTmuxPaneBySessionName(tmuxSessionName(taskID))
}
