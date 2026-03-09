package whip

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
)

func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := ensurePrivateDir(dir); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp.*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		tmp.Close()
		os.Remove(tmpPath)
	}

	if _, err := tmp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
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

func withFileLock(path string, fn func() error) error {
	if err := ensurePrivateDir(filepath.Dir(path)); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, privateFilePerm)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := f.Chmod(privateFilePerm); err != nil {
		return err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return fn()
}

func cloneTask(task *Task) (*Task, error) {
	data, err := json.Marshal(task)
	if err != nil {
		return nil, err
	}
	var cloned Task
	if err := json.Unmarshal(data, &cloned); err != nil {
		return nil, err
	}
	return &cloned, nil
}

func cloneConfig(cfg *Config) (*Config, error) {
	data, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	var cloned Config
	if err := json.Unmarshal(data, &cloned); err != nil {
		return nil, err
	}
	return &cloned, nil
}

func (s *Store) workspaceDir(workspace string) string {
	workspace = NormalizeWorkspaceName(workspace)
	if workspace == GlobalWorkspaceName {
		return s.BaseDir
	}
	return filepath.Join(s.BaseDir, workspacesDir, workspace)
}

func (s *Store) workspaceTasksDir(workspace string) string {
	return filepath.Join(s.workspaceDir(workspace), tasksDir)
}

func (s *Store) taskDirInWorkspace(workspace, id string) string {
	return filepath.Join(s.workspaceTasksDir(workspace), id)
}

func (s *Store) taskDir(id string) string {
	if workspace, ok := s.findTaskWorkspace(id); ok {
		return s.taskDirInWorkspace(workspace, id)
	}
	return s.taskDirInWorkspace(GlobalWorkspaceName, id)
}

func (s *Store) taskLockPath(id string) string {
	return filepath.Join(s.taskDir(id), taskLockFile)
}

func (s *Store) taskLockPathInWorkspace(workspace, id string) string {
	return filepath.Join(s.taskDirInWorkspace(workspace, id), taskLockFile)
}

func (s *Store) withTaskLock(id string, fn func() error) error {
	return withFileLock(s.taskLockPath(id), fn)
}

func (s *Store) withTaskLockInWorkspace(workspace, id string, fn func() error) error {
	return withFileLock(s.taskLockPathInWorkspace(workspace, id), fn)
}

func (s *Store) withConfigLock(fn func() error) error {
	return withFileLock(filepath.Join(s.BaseDir, configLock), fn)
}

func (s *Store) taskPath(id string) string {
	return filepath.Join(s.taskDir(id), taskFile)
}

func (s *Store) promptPath(id string) string {
	return filepath.Join(s.taskDir(id), promptFile)
}

func (s *Store) findTaskWorkspace(id string) (string, bool) {
	globalTaskPath := filepath.Join(s.taskDirInWorkspace(GlobalWorkspaceName, id), taskFile)
	if _, err := os.Stat(globalTaskPath); err == nil {
		return GlobalWorkspaceName, true
	}

	entries, err := os.ReadDir(filepath.Join(s.BaseDir, workspacesDir))
	if err != nil {
		return "", false
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		workspace := NormalizeWorkspaceName(entry.Name())
		taskPath := filepath.Join(s.taskDirInWorkspace(workspace, id), taskFile)
		if _, err := os.Stat(taskPath); err == nil {
			return workspace, true
		}
	}
	return "", false
}
