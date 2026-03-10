package whip

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

func TestTerminationCommand_Tmux(t *testing.T) {
	task := NewTask("test", "", "/tmp")
	task.ID = "abc12"
	task.Runner = "tmux"
	task.Status = StatusCompleted
	task.ShellPID = 1234

	cmd := terminationCommand(task)
	if !strings.Contains(cmd, "tmux kill-session -t 'wp-abc12'") {
		t.Fatalf("terminationCommand() = %q, want tmux session kill", cmd)
	}
}

func TestTerminationCommand_ProcessGroup(t *testing.T) {
	cmd := exec.Command("sh", "-c", "sleep 30")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start process group: %v", err)
	}
	defer func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}()

	task := NewTask("test", "", "/tmp")
	task.Runner = "terminal"
	task.Status = StatusCompleted
	task.ShellPID = cmd.Process.Pid

	termCmd := terminationCommand(task)
	want := "kill -TERM -- -" + strconv.Itoa(cmd.Process.Pid)
	if !strings.Contains(termCmd, want) {
		t.Fatalf("terminationCommand() = %q, want process-group TERM %q", termCmd, want)
	}
}

func TestScheduleTaskTermination_NoOpForNonTerminal(t *testing.T) {
	task := NewTask("test", "", "/tmp")
	task.Status = StatusInProgress
	task.ShellPID = 1234

	called := false
	orig := startDetachedShellCommand
	startDetachedShellCommand = func(command string) error {
		called = true
		return nil
	}
	defer func() { startDetachedShellCommand = orig }()

	if err := ScheduleTaskTermination(task); err != nil {
		t.Fatalf("ScheduleTaskTermination: %v", err)
	}
	if called {
		t.Fatal("ScheduleTaskTermination should not start a command for non-terminal tasks")
	}
}
