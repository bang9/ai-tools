package whip

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCreateAndLoadTask(t *testing.T) {
	s := tempStore(t)
	task := NewTask("Test Task", "A test description", "/tmp")

	if err := s.SaveTask(task); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}

	loaded, err := s.LoadTask(task.ID)
	if err != nil {
		t.Fatalf("LoadTask: %v", err)
	}

	if loaded.Title != "Test Task" {
		t.Errorf("Title = %q, want %q", loaded.Title, "Test Task")
	}
	if loaded.Status != StatusCreated {
		t.Errorf("Status = %q, want %q", loaded.Status, StatusCreated)
	}
	if loaded.CWD != "/tmp" {
		t.Errorf("CWD = %q, want %q", loaded.CWD, "/tmp")
	}
}

func TestListTasks(t *testing.T) {
	s := tempStore(t)

	t1 := NewTask("First", "desc1", "/tmp")
	t2 := NewTask("Second", "desc2", "/tmp")
	s.SaveTask(t1)
	s.SaveTask(t2)

	tasks, err := s.ListTasks()
	if err != nil {
		t.Fatalf("ListTasks: %v", err)
	}
	if len(tasks) != 2 {
		t.Fatalf("len(tasks) = %d, want 2", len(tasks))
	}
}

func TestResolveID(t *testing.T) {
	s := tempStore(t)
	task := NewTask("Test", "desc", "/tmp")
	s.SaveTask(task)

	id, err := s.ResolveID(task.ID)
	if err != nil {
		t.Fatalf("ResolveID exact: %v", err)
	}
	if id != task.ID {
		t.Errorf("ResolveID = %q, want %q", id, task.ID)
	}

	id, err = s.ResolveID(task.ID[:3])
	if err != nil {
		t.Fatalf("ResolveID prefix: %v", err)
	}
	if id != task.ID {
		t.Errorf("ResolveID prefix = %q, want %q", id, task.ID)
	}

	_, err = s.ResolveID("zzzzz")
	if err == nil {
		t.Error("ResolveID should fail for unknown ID")
	}
}

func TestDeleteTask(t *testing.T) {
	s := tempStore(t)
	task := NewTask("Delete Me", "desc", "/tmp")
	s.SaveTask(task)

	if err := s.DeleteTask(task.ID); err != nil {
		t.Fatalf("DeleteTask: %v", err)
	}

	_, err := s.LoadTask(task.ID)
	if err == nil {
		t.Error("LoadTask should fail after delete")
	}
}

func TestCleanTerminal(t *testing.T) {
	s := tempStore(t)

	t1 := NewTask("Active", "desc", "/tmp")
	t1.Status = StatusInProgress
	s.SaveTask(t1)

	t2 := NewTask("Done", "desc", "/tmp")
	t2.Status = StatusCompleted
	s.SaveTask(t2)

	t3 := NewTask("Failed", "desc", "/tmp")
	t3.Status = StatusFailed
	s.SaveTask(t3)

	count, err := s.CleanTerminal()
	if err != nil {
		t.Fatalf("CleanTerminal: %v", err)
	}
	if count != 2 {
		t.Errorf("count = %d, want 2", count)
	}

	tasks, _ := s.ListTasks()
	if len(tasks) != 1 {
		t.Errorf("remaining tasks = %d, want 1", len(tasks))
	}
}

func TestDependencies(t *testing.T) {
	s := tempStore(t)

	t1 := NewTask("Auth", "auth", "/tmp")
	t1.Status = StatusCompleted
	s.SaveTask(t1)

	t2 := NewTask("API", "api", "/tmp")
	t2.Status = StatusInProgress
	s.SaveTask(t2)

	t3 := NewTask("Deploy", "deploy", "/tmp")
	t3.DependsOn = []string{t1.ID, t2.ID}
	s.SaveTask(t3)

	met, unmet, err := s.AreDependenciesMet(t3)
	if err != nil {
		t.Fatalf("AreDependenciesMet: %v", err)
	}
	if met {
		t.Error("should not be met")
	}
	if len(unmet) != 1 || unmet[0] != t2.ID {
		t.Errorf("unmet = %v, want [%s]", unmet, t2.ID)
	}

	t2.Status = StatusCompleted
	s.SaveTask(t2)

	met, _, err = s.AreDependenciesMet(t3)
	if err != nil {
		t.Fatalf("AreDependenciesMet: %v", err)
	}
	if !met {
		t.Error("should be met")
	}

	deps, err := s.GetDependents(t1.ID)
	if err != nil {
		t.Fatalf("GetDependents: %v", err)
	}
	if len(deps) != 1 || deps[0].ID != t3.ID {
		t.Errorf("dependents = %v, want [%s]", deps, t3.ID)
	}
}

func TestSavePrompt(t *testing.T) {
	s := tempStore(t)
	task := NewTask("Test", "desc", "/tmp")
	s.SaveTask(task)

	content := "Test prompt content"
	if err := s.SavePrompt(task.ID, content); err != nil {
		t.Fatalf("SavePrompt: %v", err)
	}

	data, err := os.ReadFile(s.PromptPath(task.ID))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != content {
		t.Errorf("prompt = %q, want %q", string(data), content)
	}
}

func TestSaveTaskAndPrompt_UsePrivatePermissions(t *testing.T) {
	s := tempStore(t)
	task := NewTask("Secure Task", "desc", "/tmp")

	if err := s.SaveTask(task); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}

	taskDir := filepath.Join(s.BaseDir, tasksDir, task.ID)
	assertMode(t, taskDir, privateDirPerm)
	assertMode(t, filepath.Join(taskDir, taskFile), privateFilePerm)

	if err := s.SavePrompt(task.ID, "secure prompt"); err != nil {
		t.Fatalf("SavePrompt: %v", err)
	}
	assertMode(t, s.PromptPath(task.ID), privateFilePerm)
}

func TestSaveTask_UsesLegacyGlobalPathByDefault(t *testing.T) {
	s := tempStore(t)
	task := NewTask("Global Task", "desc", "/tmp")

	if err := s.SaveTask(task); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}

	if _, err := os.Stat(filepath.Join(s.BaseDir, tasksDir, task.ID, taskFile)); err != nil {
		t.Fatalf("expected legacy global path: %v", err)
	}
}

func TestSaveTask_UsesWorkspaceNamespace(t *testing.T) {
	s := tempStore(t)
	task := NewTask("Workspace Task", "desc", "/tmp")
	task.Workspace = "issue-sweep"

	if err := s.SaveTask(task); err != nil {
		t.Fatalf("SaveTask: %v", err)
	}

	taskPath := filepath.Join(s.BaseDir, workspacesDir, "issue-sweep", tasksDir, task.ID, taskFile)
	if _, err := os.Stat(taskPath); err != nil {
		t.Fatalf("expected workspace task path: %v", err)
	}

	promptContent := "workspace prompt"
	if err := s.SavePrompt(task.ID, promptContent); err != nil {
		t.Fatalf("SavePrompt: %v", err)
	}

	promptPath := filepath.Join(s.BaseDir, workspacesDir, "issue-sweep", tasksDir, task.ID, promptFile)
	data, err := os.ReadFile(promptPath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != promptContent {
		t.Fatalf("prompt = %q, want %q", string(data), promptContent)
	}
}
