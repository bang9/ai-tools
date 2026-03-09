package whip

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func (s *Store) SaveTask(task *Task) error {
	task.Workspace = NormalizeWorkspaceName(task.Workspace)
	return s.withTaskLockInWorkspace(task.Workspace, task.ID, func() error {
		return s.saveTaskUnlocked(task)
	})
}

func (s *Store) saveTaskUnlocked(task *Task) error {
	task.Workspace = NormalizeWorkspaceName(task.Workspace)
	dir := s.taskDirInWorkspace(task.Workspace, task.ID)
	if err := ensurePrivateDir(dir); err != nil {
		return err
	}
	data, err := json.MarshalIndent(task, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(filepath.Join(dir, taskFile), data, privateFilePerm)
}

func (s *Store) LoadTask(id string) (*Task, error) {
	return s.loadTaskUnlocked(id)
}

func (s *Store) loadTaskUnlocked(id string) (*Task, error) {
	data, err := os.ReadFile(s.taskPath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("task %s not found", id)
		}
		return nil, err
	}
	var task Task
	if err := json.Unmarshal(data, &task); err != nil {
		return nil, fmt.Errorf("corrupt task %s: %w", id, err)
	}
	task.Workspace = NormalizeWorkspaceName(task.Workspace)
	return &task, nil
}

func (s *Store) UpdateTask(id string, fn func(*Task) error) (*Task, error) {
	var updated *Task
	err := s.withTaskLock(id, func() error {
		task, err := s.loadTaskUnlocked(id)
		if err != nil {
			return err
		}
		if err := fn(task); err != nil {
			return err
		}
		if err := s.saveTaskUnlocked(task); err != nil {
			return err
		}
		updated, err = cloneTask(task)
		return err
	})
	return updated, err
}

func (s *Store) ListTasks() ([]*Task, error) {
	var tasks []*Task
	for _, workspace := range s.listWorkspaceNames() {
		dir := s.workspaceTasksDir(workspace)
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			task, err := s.LoadTask(e.Name())
			if err != nil {
				continue
			}
			tasks = append(tasks, task)
		}
	}

	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].CreatedAt.Before(tasks[j].CreatedAt)
	})
	return tasks, nil
}

func (s *Store) DeleteTask(id string) error {
	return os.RemoveAll(s.taskDir(id))
}

func (s *Store) SavePrompt(id, content string) error {
	return s.withTaskLock(id, func() error {
		return atomicWriteFile(s.promptPath(id), []byte(content), privateFilePerm)
	})
}

func (s *Store) PromptPath(id string) string {
	return s.promptPath(id)
}

// ResolveID finds a task by exact or prefix match.
func (s *Store) ResolveID(idPrefix string) (string, error) {
	var matches []string
	foundAny := false
	for _, workspace := range s.listWorkspaceNames() {
		dir := s.workspaceTasksDir(workspace)
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return "", err
		}
		foundAny = true
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			if e.Name() == idPrefix {
				return idPrefix, nil
			}
			if strings.HasPrefix(e.Name(), idPrefix) {
				matches = append(matches, e.Name())
			}
		}
	}
	if !foundAny {
		return "", fmt.Errorf("no tasks found")
	}

	switch len(matches) {
	case 0:
		return "", fmt.Errorf("task %s not found", idPrefix)
	case 1:
		return matches[0], nil
	default:
		return "", fmt.Errorf("ambiguous id prefix %s: matches %s", idPrefix, strings.Join(matches, ", "))
	}
}

func (s *Store) listWorkspaceNames() []string {
	workspaces := []string{GlobalWorkspaceName}
	entries, err := os.ReadDir(filepath.Join(s.BaseDir, workspacesDir))
	if err != nil {
		return workspaces
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		workspaces = append(workspaces, NormalizeWorkspaceName(entry.Name()))
	}
	return workspaces
}

// GetDependents returns tasks that depend on the given task ID.
func (s *Store) GetDependents(id string) ([]*Task, error) {
	tasks, err := s.ListTasks()
	if err != nil {
		return nil, err
	}
	var deps []*Task
	for _, t := range tasks {
		for _, dep := range t.DependsOn {
			if dep == id {
				deps = append(deps, t)
				break
			}
		}
	}
	return deps, nil
}

// AreDependenciesMet checks if all dependencies of a task are completed.
func (s *Store) AreDependenciesMet(task *Task) (bool, []string, error) {
	var unmet []string
	for _, depID := range task.DependsOn {
		dep, err := s.LoadTask(depID)
		if err != nil {
			return false, nil, fmt.Errorf("dependency %s not found: %w", depID, err)
		}
		if dep.Status != StatusCompleted {
			unmet = append(unmet, depID)
		}
	}
	return len(unmet) == 0, unmet, nil
}

// CleanTerminal removes all completed/failed tasks.
func (s *Store) CleanTerminal() (int, error) {
	tasks, err := s.ListTasks()
	if err != nil {
		return 0, err
	}
	count := 0
	for _, t := range tasks {
		if t.Status.IsTerminal() {
			if err := s.DeleteTask(t.ID); err != nil {
				return count, err
			}
			count++
		}
	}
	return count, nil
}
