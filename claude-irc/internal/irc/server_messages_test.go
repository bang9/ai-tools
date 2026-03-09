package irc

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAPIGetPeers(t *testing.T) {
	ts, _, token := setupTestServer(t)
	resp := doRequest(t, ts, token, "GET", "/api/peers", nil)

	var peers []PeerStatus
	decodeJSON(t, resp, &peers)
	if len(peers) != 0 {
		t.Errorf("expected 0 peers, got %d", len(peers))
	}
}

func TestAPIMessagesCRUD(t *testing.T) {
	ts, store, token := setupTestServer(t)

	resp := doRequest(t, ts, token, "POST", "/api/messages", map[string]string{
		"to":      "alice",
		"from":    "user",
		"content": "hello alice",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/messages: expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	store.SendMessage("alice", "charlie", "hi from charlie")

	resp = doRequest(t, ts, token, "GET", "/api/messages/alice", nil)
	var msgs []Message
	decodeJSON(t, resp, &msgs)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 unread messages, got %d", len(msgs))
	}

	resp = doRequest(t, ts, token, "POST", "/api/messages/alice/read", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/messages/alice/read: expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

	resp = doRequest(t, ts, token, "GET", "/api/messages/alice", nil)
	decodeJSON(t, resp, &msgs)
	if len(msgs) != 0 {
		t.Errorf("expected 0 unread messages, got %d", len(msgs))
	}

	resp = doRequest(t, ts, token, "GET", "/api/messages/alice?all=true", nil)
	decodeJSON(t, resp, &msgs)
	if len(msgs) != 2 {
		t.Errorf("expected 2 total messages, got %d", len(msgs))
	}

	resp = doRequest(t, ts, token, "DELETE", "/api/messages/alice", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE /api/messages/alice: expected 200, got %d", resp.StatusCode)
	}
	resp.Body.Close()

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
	filtered := matches[:0]
	for _, match := range matches {
		if filepath.Base(match) == storeMetaFile {
			continue
		}
		filtered = append(filtered, match)
	}
	if len(filtered) != 0 {
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
