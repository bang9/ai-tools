package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bang9/ai-tools/claude-irc/internal/irc"
)

// noSessionDetect simulates no active session being found.
func noSessionDetect(pid int) (*irc.Store, string, error) {
	return nil, "", fmt.Errorf("no active session for pid %d", pid)
}

// TestResolveMyName_NoFallbackToSinglePeer verifies that resolveMyName does NOT
// fall back to the only registered peer when session detection fails.
// This is a regression test for: SessionEnd hook running "claude-irc quit" from
// an unrelated session would resolve to whip-master (the only peer) and kill it.
func TestResolveMyName_NoFallbackToSinglePeer(t *testing.T) {
	// Override session detection to simulate no active session
	origDetect := detectSession
	detectSession = noSessionDetect
	defer func() { detectSession = origDetect }()

	// Create a temp store
	tmpDir := t.TempDir()
	store, err := irc.NewStoreWithBaseDir(tmpDir)
	if err != nil {
		t.Fatal(err)
	}

	// Register a peer (simulating whip-master)
	if err := store.Register("whip-master", os.Getpid()); err != nil {
		t.Fatal(err)
	}

	// Reset global nameFlag to ensure no --name override
	nameFlag = ""

	// resolveMyName should fail because:
	// - DetectSession won't find a session marker for this test process
	// - There's exactly 1 peer registered
	// - The old code would fallback to that peer (BUG)
	// - The fix should return an error instead
	_, err = resolveMyName(store)
	if err == nil {
		t.Fatal("resolveMyName should have returned error when no session marker exists, even with 1 peer registered")
	}
}

// TestResolveMyName_NameUserAllowedWithoutSession verifies that --name user works
// when no session is detected (reserved observer name).
func TestResolveMyName_NameUserAllowedWithoutSession(t *testing.T) {
	origDetect := detectSession
	detectSession = noSessionDetect
	defer func() { detectSession = origDetect }()

	tmpDir := t.TempDir()
	store, err := irc.NewStoreWithBaseDir(tmpDir)
	if err != nil {
		t.Fatal(err)
	}

	nameFlag = "user"
	defer func() { nameFlag = "" }()

	name, err := resolveMyName(store)
	if err != nil {
		t.Fatalf("resolveMyName with --name user should succeed: %v", err)
	}
	if name != "user" {
		t.Fatalf("expected 'user', got '%s'", name)
	}
}

// TestResolveMyName_NameNonUserRejectedWithoutSession verifies that --name with
// any name other than "user" is rejected when no session is detected.
func TestResolveMyName_NameNonUserRejectedWithoutSession(t *testing.T) {
	origDetect := detectSession
	detectSession = noSessionDetect
	defer func() { detectSession = origDetect }()

	tmpDir := t.TempDir()
	store, err := irc.NewStoreWithBaseDir(tmpDir)
	if err != nil {
		t.Fatal(err)
	}

	nameFlag = "fake-agent"
	defer func() { nameFlag = "" }()

	_, err = resolveMyName(store)
	if err == nil {
		t.Fatal("resolveMyName with --name fake-agent should fail without active session")
	}
	if !strings.Contains(err.Error(), "not allowed without an active session") {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestMsgCmd_SendToUserWhenRegistered(t *testing.T) {
	origDetect := detectSession
	defer func() { detectSession = origDetect }()

	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	store, err := irc.NewStoreWithBaseDir(filepath.Join(tmpHome, ".claude-irc"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Register("agent-1", os.Getpid()); err != nil {
		t.Fatal(err)
	}
	if err := store.Register("user", os.Getpid()); err != nil {
		t.Fatal(err)
	}

	detectSession = func(pid int) (*irc.Store, string, error) {
		return store, "agent-1", nil
	}

	nameFlag = ""

	cmd := msgCmd()
	if err := cmd.RunE(cmd, []string{"user", "reply"}); err != nil {
		t.Fatalf("msgCmd should allow sending to user: %v", err)
	}

	messages, err := store.ReadInbox("user")
	if err != nil {
		t.Fatalf("failed to read user inbox: %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(messages))
	}
	if messages[0].From != "agent-1" {
		t.Fatalf("expected message from 'agent-1', got %q", messages[0].From)
	}
	if messages[0].Content != "reply" {
		t.Fatalf("expected message content 'reply', got %q", messages[0].Content)
	}
}

func TestMsgCmd_SendToUserWithoutRegistration(t *testing.T) {
	origDetect := detectSession
	defer func() { detectSession = origDetect }()

	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	store, err := irc.NewStoreWithBaseDir(filepath.Join(tmpHome, ".claude-irc"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Register("agent-1", os.Getpid()); err != nil {
		t.Fatal(err)
	}

	detectSession = func(pid int) (*irc.Store, string, error) {
		return store, "agent-1", nil
	}

	nameFlag = ""

	cmd := msgCmd()
	if err := cmd.RunE(cmd, []string{"user", "reply"}); err != nil {
		t.Fatalf("msgCmd should allow sending to virtual user inbox: %v", err)
	}

	messages, err := store.ReadInbox("user")
	if err != nil {
		t.Fatalf("failed to read user inbox: %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(messages))
	}
	if messages[0].From != "agent-1" {
		t.Fatalf("expected message from 'agent-1', got %q", messages[0].From)
	}
	if messages[0].Content != "reply" {
		t.Fatalf("expected message content 'reply', got %q", messages[0].Content)
	}
}

// TestMsgCmd_UserCanSend verifies that "user" can send messages (acts as sender).
func TestMsgCmd_UserCanSend(t *testing.T) {
	origDetect := detectSession
	detectSession = noSessionDetect
	defer func() { detectSession = origDetect }()

	tmpDir := t.TempDir()
	store, err := irc.NewStoreWithBaseDir(tmpDir)
	if err != nil {
		t.Fatal(err)
	}

	// Register target peer
	if err := store.Register("agent-1", os.Getpid()); err != nil {
		t.Fatal(err)
	}

	// Resolve as user (observer)
	nameFlag = "user"
	defer func() { nameFlag = "" }()

	from, err := resolveMyName(store)
	if err != nil {
		t.Fatalf("resolveMyName as user should succeed: %v", err)
	}
	if from != "user" {
		t.Fatalf("expected 'user', got '%s'", from)
	}

	// Send message from user to agent-1
	if err := store.SendMessage("agent-1", from, "hello from observer"); err != nil {
		t.Fatalf("user should be able to send messages: %v", err)
	}

	// Verify message was delivered
	messages, err := store.ReadInbox("agent-1")
	if err != nil {
		t.Fatalf("failed to read inbox: %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(messages))
	}
	if messages[0].From != "user" {
		t.Fatalf("expected message from 'user', got '%s'", messages[0].From)
	}
	if messages[0].Content != "hello from observer" {
		t.Fatalf("unexpected message content: %s", messages[0].Content)
	}
}

func TestServeKeyboardLoopWithDeps_Shortcuts(t *testing.T) {
	ctx, stop := context.WithCancel(context.Background())
	defer stop()

	var stderr bytes.Buffer
	var opened string
	var copied string
	restoreCalls := 0
	cancelled := false

	serveKeyboardLoopWithDeps(ctx, "https://web.example", "https://connect.example", func() {
		cancelled = true
		stop()
	}, keyboardLoopDeps{
		stdin:  bytes.NewBufferString("ocq"),
		stderr: &stderr,
		makeRaw: func() (func(), error) {
			return func() {
				restoreCalls++
			}, nil
		},
		openURL: func(url string) error {
			opened = url
			return nil
		},
		copyText: func(text string) error {
			copied = text
			return nil
		},
	})

	if opened != "https://web.example" {
		t.Fatalf("expected browser URL to be opened, got %q", opened)
	}
	if copied != "https://connect.example" {
		t.Fatalf("expected connect URL to be copied, got %q", copied)
	}
	if !cancelled {
		t.Fatal("expected keyboard shortcut loop to call cancel on q")
	}
	if restoreCalls != 1 {
		t.Fatalf("expected terminal restore to run once, got %d", restoreCalls)
	}

	output := stderr.String()
	if !strings.Contains(output, "Opened in browser") {
		t.Fatalf("expected browser confirmation in stderr, got %q", output)
	}
	if !strings.Contains(output, "Copied to clipboard") {
		t.Fatalf("expected clipboard confirmation in stderr, got %q", output)
	}
}

func TestServeKeyboardLoopWithDeps_MakeRawError(t *testing.T) {
	var stderr bytes.Buffer

	serveKeyboardLoopWithDeps(context.Background(), "https://web.example", "https://connect.example", func() {}, keyboardLoopDeps{
		stdin:  bytes.NewBufferString("o"),
		stderr: &stderr,
		makeRaw: func() (func(), error) {
			return nil, errors.New("tty unavailable")
		},
		openURL: func(string) error {
			t.Fatal("openURL should not be called when raw mode setup fails")
			return nil
		},
		copyText: func(string) error {
			t.Fatal("copyText should not be called when raw mode setup fails")
			return nil
		},
	})

	if !strings.Contains(stderr.String(), "Shortcuts unavailable: tty unavailable") {
		t.Fatalf("expected raw mode failure to be reported, got %q", stderr.String())
	}
}

func TestServeURLs_LocalConnectURLUsesFragmentToken(t *testing.T) {
	info := irc.ServerInfo{
		Token:     "test-token",
		ShortCode: "abc12345",
		LocalURL:  "http://localhost:8585",
	}

	connectURL, shortURL, webURL := serveURLs(info, "")

	if connectURL != "http://localhost:8585#token=test-token" {
		t.Fatalf("unexpected connect URL: %q", connectURL)
	}
	if shortURL != "http://localhost:8585/s/abc12345" {
		t.Fatalf("unexpected short URL: %q", shortURL)
	}
	if webURL != "https://whip.bang9.dev#http://localhost:8585#token=test-token" {
		t.Fatalf("unexpected web URL: %q", webURL)
	}
}

func TestServeURLs_PublicURLOverridesLocalURL(t *testing.T) {
	info := irc.ServerInfo{
		Token:     "test-token",
		ShortCode: "abc12345",
		LocalURL:  "http://localhost:8585",
	}

	connectURL, shortURL, webURL := serveURLs(info, "https://public.example")

	if connectURL != "https://public.example#token=test-token" {
		t.Fatalf("unexpected connect URL: %q", connectURL)
	}
	if shortURL != "https://public.example/s/abc12345" {
		t.Fatalf("unexpected short URL: %q", shortURL)
	}
	if webURL != "https://whip.bang9.dev#https://public.example#token=test-token" {
		t.Fatalf("unexpected web URL: %q", webURL)
	}
}
