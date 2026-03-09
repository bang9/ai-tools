package irc

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

func statusForIdentifierError(err error) int {
	if errors.Is(err, ErrInvalidIdentifier) {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

type whipNote struct {
	Timestamp time.Time `json:"timestamp"`
	Status    string    `json:"status"`
	Content   string    `json:"content"`
}

type whipTask struct {
	ID            string     `json:"id"`
	Title         string     `json:"title"`
	Description   string     `json:"description"`
	CWD           string     `json:"cwd"`
	Workspace     string     `json:"workspace"`
	Status        string     `json:"status"`
	Backend       string     `json:"backend,omitempty"`
	Runner        string     `json:"runner,omitempty"`
	IRCName       string     `json:"irc_name"`
	MasterIRCName string     `json:"master_irc_name"`
	SessionID     string     `json:"session_id,omitempty"`
	ShellPID      int        `json:"shell_pid"`
	Note          string     `json:"note"`
	Notes         []whipNote `json:"notes,omitempty"`
	Difficulty    string     `json:"difficulty,omitempty"`
	Review        bool       `json:"review,omitempty"`
	DependsOn     []string   `json:"depends_on"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	AssignedAt    *time.Time `json:"assigned_at"`
	CompletedAt   *time.Time `json:"completed_at"`
	PIDAlive      bool       `json:"pid_alive"`
}

const globalWorkspaceName = "global"

func whipBaseDir() (string, error) {
	return resolveWhipBaseDir()
}

func whipTasksDir() (string, error) {
	baseDir, err := whipBaseDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(baseDir, "tasks"), nil
}

func workspaceTasksDir(workspace string) (string, error) {
	baseDir, err := whipBaseDir()
	if err != nil {
		return "", err
	}
	if workspace == "" || workspace == globalWorkspaceName {
		return filepath.Join(baseDir, "tasks"), nil
	}
	return filepath.Join(baseDir, "workspaces", workspace, "tasks"), nil
}

func workspaceNames() ([]string, error) {
	baseDir, err := whipBaseDir()
	if err != nil {
		return nil, err
	}

	workspaces := []string{globalWorkspaceName}
	entries, err := os.ReadDir(filepath.Join(baseDir, "workspaces"))
	if err != nil {
		if os.IsNotExist(err) {
			return workspaces, nil
		}
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		workspaces = append(workspaces, entry.Name())
	}
	return workspaces, nil
}

func normalizeTaskWorkspace(workspace string) string {
	workspace = strings.TrimSpace(workspace)
	if workspace == "" {
		return globalWorkspaceName
	}
	return workspace
}

func readWhipTaskFromDir(taskPath string, workspace string) (*whipTask, error) {
	data, err := os.ReadFile(taskPath)
	if err != nil {
		return nil, err
	}

	var t whipTask
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, err
	}
	t.Workspace = normalizeTaskWorkspace(firstNonEmpty(t.Workspace, workspace))
	t.PIDAlive = isWhipPIDAlive(t.ShellPID)
	return &t, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func readAllWhipTasks() ([]whipTask, error) {
	var tasks []whipTask
	workspaces, err := workspaceNames()
	if err != nil {
		return nil, err
	}
	for _, workspace := range workspaces {
		dir, err := workspaceTasksDir(workspace)
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			taskPath := filepath.Join(dir, entry.Name(), "task.json")
			task, err := readWhipTaskFromDir(taskPath, workspace)
			if err != nil {
				continue
			}
			tasks = append(tasks, *task)
		}
	}

	sort.Slice(tasks, func(i, j int) bool {
		if tasks[i].CreatedAt.Equal(tasks[j].CreatedAt) {
			return tasks[i].ID < tasks[j].ID
		}
		return tasks[i].CreatedAt.Before(tasks[j].CreatedAt)
	})

	return tasks, nil
}

func readWhipTask(id string) (*whipTask, error) {
	if err := validateTaskID(id); err != nil {
		return nil, err
	}

	workspaces, err := workspaceNames()
	if err != nil {
		return nil, err
	}

	for _, workspace := range workspaces {
		dir, err := workspaceTasksDir(workspace)
		if err != nil {
			return nil, err
		}
		taskPath := filepath.Join(dir, id, "task.json")
		task, err := readWhipTaskFromDir(taskPath, workspace)
		if err == nil {
			return task, nil
		}
		if os.IsNotExist(err) {
			continue
		}
		return nil, err
	}
	return nil, fmt.Errorf("task %s not found", id)
}

func isWhipPIDAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	return syscall.Kill(pid, 0) == nil
}

func handleGetTasks(w http.ResponseWriter) {
	tasks, err := readAllWhipTasks()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if tasks == nil {
		tasks = []whipTask{}
	}
	writeJSON(w, http.StatusOK, tasks)
}

func handleGetTask(w http.ResponseWriter, id string) {
	task, err := readWhipTask(id)
	if err != nil {
		status := http.StatusInternalServerError
		switch {
		case errors.Is(err, ErrInvalidIdentifier):
			status = http.StatusBadRequest
		case os.IsNotExist(err), strings.Contains(err.Error(), "not found"):
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, task)
}
