package whip

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type LaunchSource struct {
	Actor   string
	Command string
}

type taskRuntimeSnapshot struct {
	Status        TaskStatus
	Runner        string
	IRCName       string
	MasterIRCName string
	SessionID     string
	ShellPID      int
	AssignedAt    *time.Time
	HeartbeatAt   *time.Time
	CompletedAt   *time.Time
	UpdatedAt     time.Time
}

func DefaultMasterIRCName(cfg *Config) string {
	if cfg != nil && strings.TrimSpace(cfg.MasterIRCName) != "" {
		return strings.TrimSpace(cfg.MasterIRCName)
	}
	return DefaultGlobalMasterIRCName
}

func AssignTask(store *Store, id string, source LaunchSource, masterIRC string) (*Task, error) {
	var prev taskRuntimeSnapshot
	task, err := store.UpdateTask(id, func(task *Task) error {
		if err := requireTaskStatuses(task, StatusCreated, StatusFailed); err != nil {
			return err
		}

		met, unmet, err := store.AreDependenciesMet(task)
		if err != nil {
			return err
		}
		if !met {
			return fmt.Errorf("unmet dependencies: %s", strings.Join(unmet, ", "))
		}

		prev = captureTaskRuntimeSnapshot(task)
		from := task.Status
		resolvedMasterIRC := resolveTaskMasterIRC(store, task, masterIRC)
		prepareAssignedTask(task, resolvedMasterIRC)
		task.RecordEvent(source.Actor, source.Command, "assigned", from, task.Status, fmt.Sprintf("irc=%s master=%s", task.IRCName, task.MasterIRCName))
		return nil
	})
	if err != nil {
		return nil, err
	}

	if err := store.SavePrompt(task.ID, GeneratePrompt(task)); err != nil {
		_, _ = store.UpdateTask(task.ID, func(task *Task) error {
			restoreTaskRuntimeSnapshot(task, prev)
			task.UpdatedAt = currentTime()
			task.AddNote("assign aborted before spawn: failed to save prompt")
			task.RecordEvent(source.Actor, source.Command, "reverted", StatusAssigned, task.Status, "failed to save prompt")
			return nil
		})
		return nil, err
	}

	return finalizeAssignedTaskSpawn(store, task, source, func(task *Task, spawnErr error) {
		restoreTaskRuntimeSnapshot(task, prev)
		task.UpdatedAt = currentTime()
		task.AddNote(fmt.Sprintf("assign spawn failed: %v", spawnErr))
		task.RecordEvent(source.Actor, source.Command, "reverted", StatusAssigned, task.Status, spawnErr.Error())
	})
}

func StartTask(store *Store, id string, source LaunchSource, note string) (*Task, error) {
	return store.UpdateTask(id, func(task *Task) error {
		if err := requireTaskStatuses(task, StatusAssigned); err != nil {
			return err
		}

		shellPID, err := resolveStartShellPID(id)
		if err != nil {
			return err
		}

		from := task.Status
		now := currentTime()
		task.Status = StatusInProgress
		task.ShellPID = shellPID
		task.HeartbeatAt = cloneTimePtr(&now)
		task.UpdatedAt = now
		task.RecordEvent(source.Actor, source.Command, "started", from, task.Status, fmt.Sprintf("shell_pid=%d", shellPID))
		if strings.TrimSpace(note) != "" {
			task.AddNote(note)
			task.RecordEvent(source.Actor, source.Command, "note", task.Status, task.Status, note)
		}
		return nil
	})
}

func ReviewTask(store *Store, id string, source LaunchSource, note string) (*Task, error) {
	return transitionTaskStatus(store, id, source, "reviewed", StatusReview, note, StatusInProgress)
}

func RequestChangesTask(store *Store, id string, source LaunchSource, note string) (*Task, error) {
	return transitionTaskStatus(store, id, source, "requested_changes", StatusInProgress, note, StatusReview)
}

func ApproveTask(store *Store, id string, source LaunchSource, note string) (*Task, error) {
	return transitionTaskStatus(store, id, source, "approved", StatusApproved, note, StatusReview)
}

func CompleteTask(store *Store, id string, source LaunchSource, note string) (*Task, error) {
	return store.UpdateTask(id, func(task *Task) error {
		if err := requireTaskStatuses(task, StatusInProgress, StatusApproved); err != nil {
			return err
		}
		if task.Review && task.Status == StatusInProgress {
			return fmt.Errorf("task %s requires review; use `whip task review %s` first", task.ID, task.ID)
		}
		from := task.Status
		task.Status = StatusCompleted
		now := currentTime()
		task.CompletedAt = cloneTimePtr(&now)
		task.UpdatedAt = now
		task.RecordEvent(source.Actor, source.Command, "completed", from, task.Status, "")
		if strings.TrimSpace(note) != "" {
			task.AddNote(note)
			task.RecordEvent(source.Actor, source.Command, "note", task.Status, task.Status, note)
		}
		return nil
	})
}

func FailTask(store *Store, id string, source LaunchSource, note string) (*Task, error) {
	task, err := transitionTaskStatus(store, id, source, "failed", StatusFailed, note, StatusAssigned, StatusInProgress, StatusReview, StatusApproved)
	if err != nil {
		return nil, err
	}
	stopErr := stopTaskSession(task)
	task, err = store.UpdateTask(id, func(task *Task) error {
		clearTaskRuntime(task, false)
		task.UpdatedAt = currentTime()
		if stopErr != nil {
			task.RecordEvent(source.Actor, source.Command, "warning", task.Status, task.Status, stopErr.Error())
		}
		task.RecordEvent(source.Actor, source.Command, "runtime_cleared", task.Status, task.Status, "task session stopped after failure")
		return nil
	})
	return task, err
}

func CancelTask(store *Store, id string, source LaunchSource, note string) (*Task, error) {
	task, err := transitionTaskStatus(store, id, source, "canceled", StatusCanceled, note, StatusCreated, StatusAssigned, StatusInProgress, StatusReview, StatusApproved, StatusFailed)
	if err != nil {
		return nil, err
	}
	stopErr := stopTaskSession(task)
	task, err = store.UpdateTask(id, func(task *Task) error {
		clearTaskRuntime(task, false)
		task.UpdatedAt = currentTime()
		if stopErr != nil {
			task.RecordEvent(source.Actor, source.Command, "warning", task.Status, task.Status, stopErr.Error())
		}
		task.RecordEvent(source.Actor, source.Command, "runtime_cleared", task.Status, task.Status, "task session stopped after cancel")
		return nil
	})
	return task, err
}

func AddTaskNote(store *Store, id string, source LaunchSource, note string) (*Task, error) {
	if strings.TrimSpace(note) == "" {
		return nil, fmt.Errorf("note cannot be empty")
	}
	return store.UpdateTask(id, func(task *Task) error {
		task.AddNote(note)
		task.UpdatedAt = currentTime()
		task.RecordEvent(source.Actor, source.Command, "note", task.Status, task.Status, note)
		return nil
	})
}

func transitionTaskStatus(store *Store, id string, source LaunchSource, action string, newStatus TaskStatus, note string, allowedFrom ...TaskStatus) (*Task, error) {
	return store.UpdateTask(id, func(task *Task) error {
		if err := requireTaskStatuses(task, allowedFrom...); err != nil {
			return err
		}
		from := task.Status
		task.Status = newStatus
		now := currentTime()
		if task.Status.IsTerminal() {
			task.CompletedAt = cloneTimePtr(&now)
		} else {
			task.CompletedAt = nil
		}
		task.UpdatedAt = now
		task.RecordEvent(source.Actor, source.Command, action, from, task.Status, "")
		if strings.TrimSpace(note) != "" {
			task.AddNote(note)
			task.RecordEvent(source.Actor, source.Command, "note", task.Status, task.Status, note)
		}
		return nil
	})
}

func requireTaskStatuses(task *Task, allowed ...TaskStatus) error {
	for _, candidate := range allowed {
		if task.Status == candidate {
			return nil
		}
	}
	return fmt.Errorf("task %s is %s; expected %s", task.ID, task.Status, FormatTaskStatusSet(allowed))
}

func resolveTaskMasterIRC(store *Store, task *Task, masterIRC string) string {
	masterIRC = strings.TrimSpace(masterIRC)
	if masterIRC != "" {
		return masterIRC
	}
	// Lead tasks report to workspace master (human Master)
	if task.Role == TaskRoleLead {
		return WorkspaceMasterIRCName(task.WorkspaceName())
	}
	// Worker tasks in named workspaces: route to Lead if active
	if task.WorkspaceName() != GlobalWorkspaceName {
		lead, err := store.FindWorkspaceLead(task.WorkspaceName())
		if err == nil && lead != nil && lead.IRCName != "" {
			return lead.IRCName
		}
	}
	return WorkspaceMasterIRCName(task.WorkspaceName())
}

func prepareAssignedTask(task *Task, masterIRC string) {
	if task.Role == TaskRoleLead {
		task.IRCName = WorkspaceLeadIRCName(task.WorkspaceName())
	} else {
		task.IRCName = "wp-" + task.ID
	}
	task.MasterIRCName = masterIRC
	if task.Backend == "" {
		task.Backend = DefaultBackendName
	}
	task.Status = StatusAssigned
	task.Runner = ""
	task.ShellPID = 0
	task.HeartbeatAt = nil
	task.CompletedAt = nil
	now := currentTime()
	task.AssignedAt = &now
	task.UpdatedAt = now
}

func finalizeAssignedTaskSpawn(store *Store, task *Task, source LaunchSource, onSpawnFailure func(*Task, error)) (*Task, error) {
	runner, err := Spawn(task, store.PromptPath(task.ID))
	if err != nil {
		_, _ = store.UpdateTask(task.ID, func(task *Task) error {
			onSpawnFailure(task, err)
			return nil
		})
		return nil, fmt.Errorf("failed to spawn session: %w", err)
	}

	task, err = store.UpdateTask(task.ID, func(current *Task) error {
		current.Runner = runner
		if task.SessionID != "" {
			current.SessionID = task.SessionID
		}
		current.UpdatedAt = currentTime()
		current.RecordEvent(source.Actor, source.Command, "spawned", current.Status, current.Status, fmt.Sprintf("runner=%s session_id=%s", runner, current.SessionID))
		return nil
	})
	if err != nil {
		return nil, err
	}

	return task, nil
}

func captureTaskRuntimeSnapshot(task *Task) taskRuntimeSnapshot {
	return taskRuntimeSnapshot{
		Status:        task.Status,
		Runner:        task.Runner,
		IRCName:       task.IRCName,
		MasterIRCName: task.MasterIRCName,
		SessionID:     task.SessionID,
		ShellPID:      task.ShellPID,
		AssignedAt:    cloneTimePtr(task.AssignedAt),
		HeartbeatAt:   cloneTimePtr(task.HeartbeatAt),
		CompletedAt:   cloneTimePtr(task.CompletedAt),
		UpdatedAt:     task.UpdatedAt,
	}
}

func restoreTaskRuntimeSnapshot(task *Task, snapshot taskRuntimeSnapshot) {
	task.Status = snapshot.Status
	task.Runner = snapshot.Runner
	task.IRCName = snapshot.IRCName
	task.MasterIRCName = snapshot.MasterIRCName
	task.SessionID = snapshot.SessionID
	task.ShellPID = snapshot.ShellPID
	task.AssignedAt = cloneTimePtr(snapshot.AssignedAt)
	task.HeartbeatAt = cloneTimePtr(snapshot.HeartbeatAt)
	task.CompletedAt = cloneTimePtr(snapshot.CompletedAt)
	task.UpdatedAt = snapshot.UpdatedAt
}

func cloneTimePtr(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}

func clearTaskRuntime(task *Task, clearSession bool) {
	task.Runner = ""
	task.IRCName = ""
	task.MasterIRCName = ""
	task.ShellPID = 0
	task.AssignedAt = nil
	task.HeartbeatAt = nil
	if clearSession {
		task.SessionID = ""
	}
}

func stopTaskSession(task *Task) error {
	var errs []string
	if task.Runner == "tmux" && IsTmuxSession(task.ID) {
		if err := KillTmuxSession(task.ID); err != nil {
			errs = append(errs, fmt.Sprintf("kill tmux session: %v", err))
		}
	}
	if task.ShellPID > 0 && IsProcessAlive(task.ShellPID) {
		if err := KillProcess(task.ShellPID); err != nil {
			errs = append(errs, fmt.Sprintf("kill PID %d: %v", task.ShellPID, err))
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func resolveStartShellPID(id string) (int, error) {
	envTaskID := strings.TrimSpace(os.Getenv("WHIP_TASK_ID"))
	envPID := strings.TrimSpace(os.Getenv("WHIP_SHELL_PID"))
	if envTaskID != "" && envTaskID != id {
		return 0, fmt.Errorf("WHIP_TASK_ID=%s does not match task %s", envTaskID, id)
	}
	if envPID == "" {
		return os.Getpid(), nil
	}
	shellPID, err := strconv.Atoi(envPID)
	if err != nil {
		return 0, fmt.Errorf("invalid WHIP_SHELL_PID: %s", envPID)
	}
	return shellPID, nil
}

func sendIRCMessage(target, message string) error {
	cmd := exec.Command("claude-irc", "msg", target, message)
	return cmd.Run()
}
