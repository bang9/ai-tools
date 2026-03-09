package irc

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func setupTestServer(t *testing.T) (*httptest.Server, *Store, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := NewStoreWithBaseDir(dir)
	if err != nil {
		t.Fatalf("NewStoreWithBaseDir: %v", err)
	}

	token := "test-token-abc123"
	handler := buildHandler(store, token, shortCodeFromToken(token), "")
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)

	return ts, store, token
}

func setupTestServerWithMaster(t *testing.T, masterTmux string) (*httptest.Server, *Store, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := NewStoreWithBaseDir(dir)
	if err != nil {
		t.Fatalf("NewStoreWithBaseDir: %v", err)
	}

	token := "test-token-abc123"
	handler := buildHandler(store, token, shortCodeFromToken(token), masterTmux)
	ts := httptest.NewServer(handler)
	t.Cleanup(ts.Close)

	return ts, store, token
}

func doRequest(t *testing.T, ts *httptest.Server, token, method, path string, body interface{}) *http.Response {
	t.Helper()
	var reqBody *bytes.Buffer
	if body != nil {
		data, _ := json.Marshal(body)
		reqBody = bytes.NewBuffer(data)
	} else {
		reqBody = bytes.NewBuffer(nil)
	}

	req, err := http.NewRequest(method, ts.URL+path, reqBody)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	return resp
}

func decodeJSON(t *testing.T, resp *http.Response, v interface{}) {
	t.Helper()
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}
}

func runServerForTest(t *testing.T, cfg ServerConfig) ServerInfo {
	t.Helper()

	var gotInfo ServerInfo
	ready := make(chan struct{})
	cfg.OnReady = func(info ServerInfo) {
		gotInfo = info
		close(ready)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- RunServer(ctx, cfg)
	}()

	select {
	case <-ready:
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("server did not become ready in time")
	}

	t.Cleanup(func() {
		cancel()
		select {
		case err := <-errCh:
			if err != nil {
				t.Errorf("RunServer returned error: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Error("server did not shut down in time")
		}
	})

	return gotInfo
}

func assertListenHost(t *testing.T, listenAddr, wantHost string) {
	t.Helper()

	gotHost, _, err := net.SplitHostPort(listenAddr)
	if err != nil {
		t.Fatalf("SplitHostPort(%q): %v", listenAddr, err)
	}
	if gotHost != wantHost {
		t.Fatalf("expected listen host %q, got %q", wantHost, gotHost)
	}
}

func listenHost(t *testing.T, listenAddr string) string {
	t.Helper()

	host, _, err := net.SplitHostPort(listenAddr)
	if err != nil {
		t.Fatalf("SplitHostPort(%q): %v", listenAddr, err)
	}
	return host
}

func localURLHost(t *testing.T, localURL string) string {
	t.Helper()

	parsed, err := url.Parse(localURL)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", localURL, err)
	}
	host, _, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatalf("SplitHostPort(%q): %v", parsed.Host, err)
	}
	return host
}

func mustNonLoopbackIPv4(t *testing.T) string {
	t.Helper()

	host, ok := firstNonLoopbackInterfaceAddr(false)
	if !ok {
		t.Skip("no non-loopback IPv4 interface available for explicit bind test")
	}
	return host
}

// --- Auth tests ---

func TestAPIAuthBearerToken(t *testing.T) {
	ts, _, token := setupTestServer(t)
	resp := doRequest(t, ts, token, "GET", "/api/peers", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

func TestAPIAuthQueryParamPeers(t *testing.T) {
	ts, _, token := setupTestServer(t)
	resp := doRequest(t, ts, "", "GET", "/api/peers?token="+token, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

func TestAPIAuthQueryParamTasks(t *testing.T) {
	ts, _, token := setupTestServer(t)
	resp := doRequest(t, ts, "", "GET", "/api/tasks?token="+token, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

func TestAPIAuthQueryParamRejectsMessages(t *testing.T) {
	ts, _, token := setupTestServer(t)
	resp := doRequest(t, ts, "", "GET", "/api/messages/user?token="+token, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestAPIAuthQueryParamRejectsMutatingEndpoints(t *testing.T) {
	ts, _, token := setupTestServer(t)
	resp := doRequest(t, ts, "", "POST", "/api/messages?token="+token, map[string]string{
		"from":    "user",
		"to":      "alice",
		"content": "hello",
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestAPIAuthMissingToken(t *testing.T) {
	ts, _, _ := setupTestServer(t)
	resp := doRequest(t, ts, "", "GET", "/api/peers", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
	var body map[string]string
	decodeJSON(t, resp, &body)
	if body["error"] != "unauthorized" {
		t.Errorf("expected error 'unauthorized', got %q", body["error"])
	}
}

func TestAPIAuthWrongToken(t *testing.T) {
	ts, _, _ := setupTestServer(t)
	resp := doRequest(t, ts, "wrong-token", "GET", "/api/peers", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

// --- CORS tests ---

func TestAPICORSAllowedOrigin(t *testing.T) {
	ts, _, token := setupTestServer(t)

	req, _ := http.NewRequest("GET", ts.URL+"/api/peers", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Origin", "https://whip.bang9.dev")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://whip.bang9.dev" {
		t.Errorf("expected ACAO 'https://whip.bang9.dev', got %q", got)
	}
}

func TestAPICORSLocalhostAllowed(t *testing.T) {
	ts, _, token := setupTestServer(t)

	req, _ := http.NewRequest("GET", ts.URL+"/api/peers", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Origin", "http://localhost:3000")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://localhost:3000" {
		t.Errorf("expected ACAO 'http://localhost:3000', got %q", got)
	}
}

func TestAPICORSRejectedOrigin(t *testing.T) {
	ts, _, token := setupTestServer(t)

	req, _ := http.NewRequest("GET", ts.URL+"/api/peers", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Origin", "https://evil.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("expected no ACAO header, got %q", got)
	}
}

func TestAPICORSPreflight(t *testing.T) {
	ts, _, _ := setupTestServer(t)

	req, _ := http.NewRequest("OPTIONS", ts.URL+"/api/peers", nil)
	req.Header.Set("Origin", "https://whip.bang9.dev")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("expected 204, got %d", resp.StatusCode)
	}
}

func TestAPICORSPreflightRejected(t *testing.T) {
	ts, _, _ := setupTestServer(t)

	req, _ := http.NewRequest("OPTIONS", ts.URL+"/api/peers", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("expected 403 for rejected preflight, got %d", resp.StatusCode)
	}
}

// --- Peers ---

func TestAPIGetPeers(t *testing.T) {
	ts, _, token := setupTestServer(t)
	resp := doRequest(t, ts, token, "GET", "/api/peers", nil)

	var peers []PeerStatus
	decodeJSON(t, resp, &peers)
	// Empty store should return empty array
	if len(peers) != 0 {
		t.Errorf("expected 0 peers, got %d", len(peers))
	}
}

// --- Messages ---

func TestAPIMessagesCRUD(t *testing.T) {
	ts, store, token := setupTestServer(t)

	// Send a message
	resp := doRequest(t, ts, token, "POST", "/api/messages", map[string]string{
		"to":      "alice",
		"from":    "user",
		"content": "hello alice",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/messages: expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Send another
	store.SendMessage("alice", "charlie", "hi from charlie")

	// GET unread messages
	resp = doRequest(t, ts, token, "GET", "/api/messages/alice", nil)
	var msgs []Message
	decodeJSON(t, resp, &msgs)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 unread messages, got %d", len(msgs))
	}

	// Mark all read
	resp = doRequest(t, ts, token, "POST", "/api/messages/alice/read", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/messages/alice/read: expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// GET unread should now be empty
	resp = doRequest(t, ts, token, "GET", "/api/messages/alice", nil)
	decodeJSON(t, resp, &msgs)
	if len(msgs) != 0 {
		t.Errorf("expected 0 unread messages, got %d", len(msgs))
	}

	// GET all messages should still return 2
	resp = doRequest(t, ts, token, "GET", "/api/messages/alice?all=true", nil)
	decodeJSON(t, resp, &msgs)
	if len(msgs) != 2 {
		t.Errorf("expected 2 total messages, got %d", len(msgs))
	}

	// DELETE messages
	resp = doRequest(t, ts, token, "DELETE", "/api/messages/alice", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE /api/messages/alice: expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Verify deleted
	resp = doRequest(t, ts, token, "GET", "/api/messages/alice?all=true", nil)
	decodeJSON(t, resp, &msgs)
	if len(msgs) != 0 {
		t.Errorf("expected 0 messages after delete, got %d", len(msgs))
	}
}

func TestAPIPostMessageValidation(t *testing.T) {
	ts, _, token := setupTestServer(t)

	tests := []struct {
		name string
		body map[string]string
	}{
		{"missing to", map[string]string{"from": "bob", "content": "hi"}},
		{"missing from", map[string]string{"to": "alice", "content": "hi"}},
		{"missing content", map[string]string{"to": "alice", "from": "bob"}},
		{"empty to", map[string]string{"to": "", "from": "bob", "content": "hi"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			resp := doRequest(t, ts, token, "POST", "/api/messages", tc.body)
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("expected 400, got %d", resp.StatusCode)
			}
		})
	}
}

func TestAPIPostMessageRejectsOversizedBody(t *testing.T) {
	ts, _, token := setupTestServer(t)

	resp := doRequest(t, ts, token, "POST", "/api/messages", map[string]string{
		"to":      "agent-1",
		"from":    "user",
		"content": strings.Repeat("a", int(maxHTTPJSONBodyBytes)),
	})
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", resp.StatusCode)
	}

	var body map[string]string
	decodeJSON(t, resp, &body)
	if body["error"] != "request body too large" {
		t.Fatalf("unexpected error: %q", body["error"])
	}
}

func TestAPIPostMessageRejectsOversizedContent(t *testing.T) {
	ts, _, token := setupTestServer(t)

	content := strings.Repeat("a", maxHTTPMessageContentSize+1)
	resp := doRequest(t, ts, token, "POST", "/api/messages", map[string]string{
		"to":      "agent-1",
		"from":    "user",
		"content": content,
	})
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}

	var body map[string]string
	decodeJSON(t, resp, &body)
	want := "content too large (10241 bytes, max 10240 bytes)"
	if body["error"] != want {
		t.Fatalf("unexpected error: %q", body["error"])
	}
}

func TestAPIPostMessageRejectsNonUserSender(t *testing.T) {
	ts, store, token := setupTestServer(t)

	resp := doRequest(t, ts, token, "POST", "/api/messages", map[string]string{
		"to":      "agent-1",
		"from":    "whip-master",
		"content": "spoofed",
	})
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", resp.StatusCode)
	}

	var body map[string]string
	decodeJSON(t, resp, &body)
	if body["error"] != "only 'user' may send messages over HTTP" {
		t.Fatalf("unexpected error: %q", body["error"])
	}

	messages, err := store.ReadInbox("agent-1")
	if err != nil {
		t.Fatalf("failed to read inbox: %v", err)
	}
	if len(messages) != 0 {
		t.Fatalf("expected no delivered messages, got %d", len(messages))
	}
}

func TestAPIUserInboxFlow(t *testing.T) {
	ts, store, token := setupTestServer(t)

	resp := doRequest(t, ts, token, "POST", "/api/messages", map[string]string{
		"to":      "agent-1",
		"from":    "user",
		"content": "reply via dashboard",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/messages: expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	messages, err := store.ReadInbox("agent-1")
	if err != nil {
		t.Fatalf("failed to read agent inbox: %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected 1 delivered message, got %d", len(messages))
	}
	if messages[0].From != "user" {
		t.Fatalf("expected delivered message from user, got %q", messages[0].From)
	}

	if err := store.SendMessage("user", "agent-1", "hello from agent"); err != nil {
		t.Fatalf("failed to seed user inbox: %v", err)
	}

	resp = doRequest(t, ts, token, "GET", "/api/messages/user", nil)
	var unread []Message
	decodeJSON(t, resp, &unread)
	if len(unread) != 1 {
		t.Fatalf("expected 1 unread user message, got %d", len(unread))
	}
	if unread[0].From != "agent-1" {
		t.Fatalf("expected unread message from agent-1, got %q", unread[0].From)
	}

	resp = doRequest(t, ts, token, "POST", "/api/messages/user/read", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/messages/user/read: expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	resp = doRequest(t, ts, token, "GET", "/api/messages/user?all=true", nil)
	var all []Message
	decodeJSON(t, resp, &all)
	if len(all) != 1 {
		t.Fatalf("expected 1 total user message, got %d", len(all))
	}
	if !all[0].Read {
		t.Fatal("expected user message to be marked read")
	}

	resp = doRequest(t, ts, token, "DELETE", "/api/messages/user", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE /api/messages/user: expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	resp = doRequest(t, ts, token, "GET", "/api/messages/user?all=true", nil)
	decodeJSON(t, resp, &all)
	if len(all) != 0 {
		t.Fatalf("expected empty user inbox after delete, got %d messages", len(all))
	}
}

func TestAPIMessageRoutesRejectInvalidIdentifiers(t *testing.T) {
	ts, store, token := setupTestServer(t)

	sentinel := filepath.Join(store.BaseDir, "sentinel.txt")
	if err := os.WriteFile(sentinel, []byte("keep"), 0644); err != nil {
		t.Fatalf("failed to write sentinel: %v", err)
	}

	postBodies := []map[string]string{
		{"to": "..", "from": "user", "content": "blocked traversal"},
		{"to": "agent/1", "from": "user", "content": "blocked separator"},
	}
	for _, body := range postBodies {
		resp := doRequest(t, ts, token, "POST", "/api/messages", body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("POST /api/messages with %q: expected 400, got %d", body["to"], resp.StatusCode)
		}
		var result map[string]string
		decodeJSON(t, resp, &result)
		if result["error"] != "invalid identifier: invalid peer name" {
			t.Fatalf("POST /api/messages with %q: unexpected error %q", body["to"], result["error"])
		}
	}

	matches, err := filepath.Glob(filepath.Join(store.BaseDir, "*.json"))
	if err != nil {
		t.Fatalf("failed to glob base dir: %v", err)
	}
	if len(matches) != 0 {
		t.Fatalf("expected no root-level message files after invalid POSTs, got %v", matches)
	}

	for _, tc := range []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/api/messages/.."},
		{method: http.MethodPost, path: "/api/messages/../read"},
		{method: http.MethodDelete, path: "/api/messages/.."},
	} {
		resp := doRequest(t, ts, token, tc.method, tc.path, nil)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s %s: expected 400, got %d", tc.method, tc.path, resp.StatusCode)
		}
		var result map[string]string
		decodeJSON(t, resp, &result)
		if result["error"] != "invalid identifier: invalid peer name" {
			t.Fatalf("%s %s: unexpected error %q", tc.method, tc.path, result["error"])
		}
	}

	if _, err := os.Stat(sentinel); err != nil {
		t.Fatalf("expected sentinel to survive invalid inbox paths: %v", err)
	}
}

// --- Tasks ---

func TestAPITasks(t *testing.T) {
	// Create temp whip tasks dir
	origHome := os.Getenv("HOME")
	tmpHome := t.TempDir()
	os.Setenv("HOME", tmpHome)
	t.Cleanup(func() { os.Setenv("HOME", origHome) })

	tasksDir := filepath.Join(tmpHome, ".whip", "tasks")

	// Create two task directories
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

	// List tasks
	resp := doRequest(t, ts, token, "GET", "/api/tasks", nil)
	var tasks []whipTask
	decodeJSON(t, resp, &tasks)
	if len(tasks) != 2 {
		t.Fatalf("expected 2 tasks, got %d", len(tasks))
	}
	// Should be sorted by created_at (oldest first)
	if tasks[0].ID != "abc12" {
		t.Errorf("expected first task 'abc12', got %q", tasks[0].ID)
	}
	// pid_alive should be false for pid 0
	if tasks[0].PIDAlive {
		t.Error("expected pid_alive=false for shell_pid 0")
	}

	// Get single task
	resp = doRequest(t, ts, token, "GET", "/api/tasks/abc12", nil)
	var task whipTask
	decodeJSON(t, resp, &task)
	if task.Title != "First task" {
		t.Errorf("expected 'First task', got %q", task.Title)
	}

	// Get non-existent task
	resp = doRequest(t, ts, token, "GET", "/api/tasks/zzzzz", nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("expected 404, got %d", resp.StatusCode)
	}
}

func TestAPITaskPIDAlive(t *testing.T) {
	origHome := os.Getenv("HOME")
	tmpHome := t.TempDir()
	os.Setenv("HOME", tmpHome)
	t.Cleanup(func() { os.Setenv("HOME", origHome) })

	tasksDir := filepath.Join(tmpHome, ".whip", "tasks")

	// Use our own PID (guaranteed alive)
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

// --- Master ---

func TestAPIMasterKeysRejectsOversizedBody(t *testing.T) {
	ts, _, token := setupTestServerWithMaster(t, "master-session")

	resp := doRequest(t, ts, token, "POST", "/api/master/keys", map[string]string{
		"keys": strings.Repeat("a", int(maxHTTPJSONBodyBytes)),
	})
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", resp.StatusCode)
	}

	var body map[string]string
	decodeJSON(t, resp, &body)
	if body["error"] != "request body too large" {
		t.Fatalf("unexpected error: %q", body["error"])
	}
}

func TestAPIMasterStatusRejectsQueryAuth(t *testing.T) {
	ts, _, token := setupTestServerWithMaster(t, "master-session")

	resp := doRequest(t, ts, "", "GET", "/api/master/status?token="+token, nil)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestAPIMasterKeysRejectsQueryAuth(t *testing.T) {
	ts, _, token := setupTestServerWithMaster(t, "master-session")

	resp := doRequest(t, ts, "", "POST", "/api/master/keys?token="+token, map[string]string{
		"keys": "whoami",
	})
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestAPIMasterKeysRejectsOversizedKeys(t *testing.T) {
	ts, _, token := setupTestServerWithMaster(t, "master-session")

	keys := strings.Repeat("a", maxHTTPMasterKeysSize+1)
	resp := doRequest(t, ts, token, "POST", "/api/master/keys", map[string]string{
		"keys": keys,
	})
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}

	var body map[string]string
	decodeJSON(t, resp, &body)
	want := "keys too large (10241 bytes, max 10240 bytes)"
	if body["error"] != want {
		t.Fatalf("unexpected error: %q", body["error"])
	}
}

// --- Not found ---

func TestAPINotFound(t *testing.T) {
	ts, _, token := setupTestServer(t)

	paths := []string{"/api/unknown", "/api", "/foo"}
	for _, p := range paths {
		resp := doRequest(t, ts, token, "GET", p, nil)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("GET %s: expected 404, got %d", p, resp.StatusCode)
		}
	}
}

// --- RunServer ---

func TestAPIRunServer(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStoreWithBaseDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	cfg := ServerConfig{
		Port:  0, // random port
		Store: store,
	}
	gotInfo := runServerForTest(t, cfg)

	if gotInfo.Token == "" {
		t.Error("expected non-empty token")
	}
	if gotInfo.LocalURL == "" {
		t.Error("expected non-empty local URL")
	}
	assertListenHost(t, gotInfo.ListenAddr, defaultServerBindHost)
	if got := localURLHost(t, gotInfo.LocalURL); got != defaultServerAdvertiseHost {
		t.Fatalf("expected default local URL host %q, got %q", defaultServerAdvertiseHost, got)
	}

	// Make a request to verify it works
	req, _ := http.NewRequest("GET", gotInfo.LocalURL+"/api/peers?token="+gotInfo.Token, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request to running server: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}

	// Token should be 32 hex chars
	if len(gotInfo.Token) != 32 {
		t.Errorf("expected 32-char token, got %d chars", len(gotInfo.Token))
	}
}

func TestAPIShortURLRedirectUsesFragmentConnectURL(t *testing.T) {
	ts, _, token := setupTestServer(t)

	req, err := http.NewRequest(http.MethodGet, ts.URL+"/s/"+shortCodeFromToken(token), nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}

	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusFound {
		t.Fatalf("expected 302, got %d", resp.StatusCode)
	}

	wantLocation := DashboardURL(ConnectURL(ts.URL, token))
	if got := resp.Header.Get("Location"); got != wantLocation {
		t.Fatalf("expected redirect to %q, got %q", wantLocation, got)
	}
}

func TestAPIRunServerWithExplicitBindAdvertisesConfiguredHost(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStoreWithBaseDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	bindHost := mustNonLoopbackIPv4(t)

	gotInfo := runServerForTest(t, ServerConfig{
		Port:     0,
		BindHost: bindHost,
		Store:    store,
	})

	assertListenHost(t, gotInfo.ListenAddr, bindHost)
	if got := localURLHost(t, gotInfo.LocalURL); got != bindHost {
		t.Fatalf("expected local URL host %q, got %q", bindHost, got)
	}

	req, _ := http.NewRequest("GET", gotInfo.LocalURL+"/api/peers?token="+gotInfo.Token, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request to running server: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

func TestAPIRunServerWithWildcardBindAdvertisesReachableHost(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStoreWithBaseDir(dir)
	if err != nil {
		t.Fatal(err)
	}

	expectedHost := mustNonLoopbackIPv4(t)

	gotInfo := runServerForTest(t, ServerConfig{
		Port:     0,
		BindHost: "0.0.0.0",
		Store:    store,
	})

	listenIP := net.ParseIP(listenHost(t, gotInfo.ListenAddr))
	if listenIP == nil || !listenIP.IsUnspecified() {
		t.Fatalf("expected wildcard bind to listen on an unspecified address, got %q", gotInfo.ListenAddr)
	}
	if got := localURLHost(t, gotInfo.LocalURL); got != expectedHost {
		t.Fatalf("expected wildcard bind local URL host %q, got %q", expectedHost, got)
	}

	req, _ := http.NewRequest("GET", gotInfo.LocalURL+"/api/peers?token="+gotInfo.Token, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("request to running server: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}
