package irc

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAPITasks(t *testing.T) {
	origHome := os.Getenv("HOME")
	tmpHome := t.TempDir()
	os.Setenv("HOME", tmpHome)
	t.Cleanup(func() { os.Setenv("HOME", origHome) })

	tasksDir := filepath.Join(tmpHome, ".whip", "tasks")

	task1 := map[string]interface{}{
		"id":         "abc12",
		"title":      "First task",
		"status":     "in_progress",
		"shell_pid":  0,
		"depends_on": []string{},
		"created_at": time.Now().Add(-1 * time.Hour).Format(time.RFC3339Nano),
		"updated_at": time.Now().Format(time.RFC3339Nano),
	}
	task2 := map[string]interface{}{
		"id":         "def34",
		"title":      "Second task",
		"status":     "completed",
		"shell_pid":  0,
		"depends_on": []string{},
		"created_at": time.Now().Format(time.RFC3339Nano),
		"updated_at": time.Now().Format(time.RFC3339Nano),
	}

	for _, task := range []map[string]interface{}{task1, task2} {
		id := task["id"].(string)
		dir := filepath.Join(tasksDir, id)
		os.MkdirAll(dir, 0755)
		data, _ := json.MarshalIndent(task, "", "  ")
		os.WriteFile(filepath.Join(dir, "task.json"), data, 0644)
	}

	ts, _, token := setupTestServer(t)

	resp := doRequest(t, ts, token, "GET", "/api/tasks", nil)
	var tasks []whipTask
	decodeJSON(t, resp, &tasks)
	if len(tasks) != 2 {
		t.Fatalf("expected 2 tasks, got %d", len(tasks))
	}
	if tasks[0].ID != "abc12" {
		t.Errorf("expected first task 'abc12', got %q", tasks[0].ID)
	}
	if tasks[0].PIDAlive {
		t.Error("expected pid_alive=false for shell_pid 0")
	}

	resp = doRequest(t, ts, token, "GET", "/api/tasks/abc12", nil)
	var task whipTask
	decodeJSON(t, resp, &task)
	if task.Title != "First task" {
		t.Errorf("expected 'First task', got %q", task.Title)
	}

	resp = doRequest(t, ts, token, "GET", "/api/tasks/zzzzz", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404, got %d", resp.StatusCode)
	}
}

func TestAPITasks_IncludesWorkspaceNamespaces(t *testing.T) {
	origHome := os.Getenv("HOME")
	tmpHome := t.TempDir()
	os.Setenv("HOME", tmpHome)
	t.Cleanup(func() { os.Setenv("HOME", origHome) })

	globalDir := filepath.Join(tmpHome, ".whip", "tasks", "glob1")
	workspaceDir := filepath.Join(tmpHome, ".whip", "workspaces", "issue-sweep", "tasks", "work1")

	globalTask := map[string]interface{}{
		"id":         "glob1",
		"title":      "Global task",
		"status":     "in_progress",
		"shell_pid":  0,
		"depends_on": []string{},
		"created_at": time.Now().Add(-2 * time.Hour).Format(time.RFC3339Nano),
		"updated_at": time.Now().Format(time.RFC3339Nano),
	}
	workspaceTask := map[string]interface{}{
		"id":         "work1",
		"title":      "Workspace task",
		"workspace":  "issue-sweep",
		"status":     "review",
		"shell_pid":  0,
		"depends_on": []string{"glob1"},
		"created_at": time.Now().Add(-1 * time.Hour).Format(time.RFC3339Nano),
		"updated_at": time.Now().Format(time.RFC3339Nano),
	}

	if err := os.MkdirAll(globalDir, 0755); err != nil {
		t.Fatalf("mkdir global dir: %v", err)
	}
	if err := os.MkdirAll(workspaceDir, 0755); err != nil {
		t.Fatalf("mkdir workspace dir: %v", err)
	}

	data, _ := json.MarshalIndent(globalTask, "", "  ")
	if err := os.WriteFile(filepath.Join(globalDir, "task.json"), data, 0644); err != nil {
		t.Fatalf("write global task: %v", err)
	}
	data, _ = json.MarshalIndent(workspaceTask, "", "  ")
	if err := os.WriteFile(filepath.Join(workspaceDir, "task.json"), data, 0644); err != nil {
		t.Fatalf("write workspace task: %v", err)
	}

	ts, _, token := setupTestServer(t)

	resp := doRequest(t, ts, token, "GET", "/api/tasks", nil)
	var tasks []whipTask
	decodeJSON(t, resp, &tasks)
	if len(tasks) != 2 {
		t.Fatalf("expected 2 tasks, got %d", len(tasks))
	}

	workspaces := map[string]string{}
	for _, task := range tasks {
		workspaces[task.ID] = task.Workspace
	}
	if workspaces["glob1"] != "global" {
		t.Fatalf("global task workspace = %q, want %q", workspaces["glob1"], "global")
	}
	if workspaces["work1"] != "issue-sweep" {
		t.Fatalf("workspace task workspace = %q, want %q", workspaces["work1"], "issue-sweep")
	}

	resp = doRequest(t, ts, token, "GET", "/api/tasks/work1", nil)
	var task whipTask
	decodeJSON(t, resp, &task)
	if task.Workspace != "issue-sweep" {
		t.Fatalf("task.Workspace = %q, want %q", task.Workspace, "issue-sweep")
	}
}

func TestAPITaskPIDAlive(t *testing.T) {
	origHome := os.Getenv("HOME")
	tmpHome := t.TempDir()
	os.Setenv("HOME", tmpHome)
	t.Cleanup(func() { os.Setenv("HOME", origHome) })

	tasksDir := filepath.Join(tmpHome, ".whip", "tasks")
	pid := os.Getpid()
	task := map[string]interface{}{
		"id":         "alive1",
		"title":      "Alive task",
		"status":     "in_progress",
		"shell_pid":  pid,
		"depends_on": []string{},
		"created_at": time.Now().Format(time.RFC3339Nano),
		"updated_at": time.Now().Format(time.RFC3339Nano),
	}

	dir := filepath.Join(tasksDir, "alive1")
	os.MkdirAll(dir, 0755)
	data, _ := json.MarshalIndent(task, "", "  ")
	os.WriteFile(filepath.Join(dir, "task.json"), data, 0644)

	ts, _, token := setupTestServer(t)

	resp := doRequest(t, ts, token, "GET", "/api/tasks/alive1", nil)
	var result whipTask
	decodeJSON(t, resp, &result)
	if !result.PIDAlive {
		t.Error("expected pid_alive=true for our own PID")
	}
}

func TestAPITasksRejectInvalidID(t *testing.T) {
	origHome := os.Getenv("HOME")
	tmpHome := t.TempDir()
	os.Setenv("HOME", tmpHome)
	t.Cleanup(func() { os.Setenv("HOME", origHome) })

	whipDir := filepath.Join(tmpHome, ".whip")
	if err := os.MkdirAll(whipDir, 0755); err != nil {
		t.Fatalf("failed to create whip dir: %v", err)
	}

	escapedTask := map[string]interface{}{
		"id":         "escaped",
		"title":      "Should not be reachable",
		"status":     "in_progress",
		"shell_pid":  0,
		"depends_on": []string{},
		"created_at": time.Now().Format(time.RFC3339Nano),
		"updated_at": time.Now().Format(time.RFC3339Nano),
	}
	data, _ := json.MarshalIndent(escapedTask, "", "  ")
	if err := os.WriteFile(filepath.Join(whipDir, "task.json"), data, 0644); err != nil {
		t.Fatalf("failed to write escaped task: %v", err)
	}

	ts, _, token := setupTestServer(t)

	resp := doRequest(t, ts, token, "GET", "/api/tasks/..", nil)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}

	var body map[string]string
	decodeJSON(t, resp, &body)
	if body["error"] != "invalid identifier: invalid task id" {
		t.Fatalf("unexpected error: %q", body["error"])
	}
}

func TestWhipTasksDir_UsesWHIPHOMEOverride(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	override := filepath.Join(tmpHome, whipBaseDirName, "custom-whip-home")
	t.Setenv("WHIP_HOME", override)

	got, err := whipTasksDir()
	if err != nil {
		t.Fatalf("whipTasksDir: %v", err)
	}
	resolvedOverride, err := canonicalizeStorePath(override)
	if err != nil {
		t.Fatalf("canonicalizeStorePath: %v", err)
	}
	want := filepath.Join(resolvedOverride, "tasks")
	if got != want {
		t.Fatalf("whipTasksDir() = %q, want %q", got, want)
	}
}

func TestWhipTasksDir_RejectsPathOutsideCanonicalRoot(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("WHIP_HOME", filepath.Join(t.TempDir(), "outside"))

	_, err := whipTasksDir()
	if err == nil || !strings.Contains(err.Error(), "outside canonical root") {
		t.Fatalf("whipTasksDir error = %v, want outside canonical root", err)
	}
}

func TestWhipTasksDir_RejectsMarkerMismatch(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	root := filepath.Join(tmpHome, whipBaseDirName)
	if err := os.MkdirAll(root, privateDirPerm); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	meta := storeMetadata{
		StoreKind:     claudeIRCStoreKind,
		OwnerUID:      os.Geteuid(),
		CanonicalRoot: root,
		CreatedAt:     time.Now().UTC(),
		InstallID:     "bad-install",
	}
	writeStoreMetadataFixture(t, filepath.Join(root, storeMetaFile), meta)

	_, err := whipTasksDir()
	if err == nil || !strings.Contains(err.Error(), "store kind mismatch") {
		t.Fatalf("whipTasksDir error = %v, want store kind mismatch", err)
	}
}

func TestAPITasks_RejectsInvalidWhipHome(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("WHIP_HOME", filepath.Join(t.TempDir(), "outside"))

	ts, _, token := setupTestServer(t)

	resp := doRequest(t, ts, token, "GET", "/api/tasks", nil)
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d", resp.StatusCode)
	}

	var body map[string]string
	decodeJSON(t, resp, &body)
	if !strings.Contains(body["error"], "outside canonical root") {
		t.Fatalf("unexpected error: %q", body["error"])
	}
}
