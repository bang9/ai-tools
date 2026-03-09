package irc

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSendAndReadMessage(t *testing.T) {
	store := newTestStore(t)

	if err := store.SendMessage("server", "client", "Hello!"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	messages, err := store.ReadInbox("server")
	if err != nil {
		t.Fatalf("ReadInbox failed: %v", err)
	}

	if len(messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(messages))
	}

	msg := messages[0]
	if msg.From != "client" {
		t.Errorf("expected from 'client', got '%s'", msg.From)
	}
	if msg.Content != "Hello!" {
		t.Errorf("expected content 'Hello!', got '%s'", msg.Content)
	}
	if msg.Read {
		t.Error("message should be unread")
	}
}

func TestUnreadCount(t *testing.T) {
	store := newTestStore(t)

	store.SendMessage("server", "client", "msg1")
	store.SendMessage("server", "client", "msg2")
	store.SendMessage("server", "client", "msg3")

	count, err := store.UnreadCount("server")
	if err != nil {
		t.Fatalf("UnreadCount failed: %v", err)
	}
	if count != 3 {
		t.Errorf("expected 3 unread, got %d", count)
	}
}

func TestMarkAllRead(t *testing.T) {
	store := newTestStore(t)

	store.SendMessage("server", "client", "msg1")
	store.SendMessage("server", "client", "msg2")

	if err := store.MarkAllRead("server"); err != nil {
		t.Fatalf("MarkAllRead failed: %v", err)
	}

	count, _ := store.UnreadCount("server")
	if count != 0 {
		t.Errorf("expected 0 unread after MarkAllRead, got %d", count)
	}

	// All messages should still be readable
	messages, _ := store.ReadInbox("server")
	if len(messages) != 2 {
		t.Errorf("expected 2 messages total, got %d", len(messages))
	}
}

func TestSendMessageAndMarkAllRead_UsePrivatePermissions(t *testing.T) {
	store := newTestStore(t)

	if err := store.SendMessage("server", "client", "msg1"); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}

	inboxDir := store.InboxDir("server")
	assertMode(t, inboxDir, privateDirPerm)

	entries, err := os.ReadDir(inboxDir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 message file, got %d", len(entries))
	}
	messagePath := filepath.Join(inboxDir, entries[0].Name())
	assertMode(t, messagePath, privateFilePerm)

	if err := store.MarkAllRead("server"); err != nil {
		t.Fatalf("MarkAllRead: %v", err)
	}
	assertMode(t, inboxDir, privateDirPerm)
	assertMode(t, messagePath, privateFilePerm)

	messages, err := store.ReadInbox("server")
	if err != nil {
		t.Fatalf("ReadInbox: %v", err)
	}
	if len(messages) != 1 || !messages[0].Read {
		t.Fatalf("expected one read message after MarkAllRead, got %+v", messages)
	}
}

func TestMessageOrdering(t *testing.T) {
	store := newTestStore(t)

	store.SendMessage("server", "client", "first")
	time.Sleep(10 * time.Millisecond)
	store.SendMessage("server", "client", "second")
	time.Sleep(10 * time.Millisecond)
	store.SendMessage("server", "client", "third")

	messages, _ := store.ReadInbox("server")
	if len(messages) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(messages))
	}

	if messages[0].Content != "first" || messages[1].Content != "second" || messages[2].Content != "third" {
		t.Errorf("messages not in chronological order: %v, %v, %v",
			messages[0].Content, messages[1].Content, messages[2].Content)
	}
}

func TestEmptyInbox(t *testing.T) {
	store := newTestStore(t)

	messages, err := store.ReadInbox("nobody")
	if err != nil {
		t.Fatalf("ReadInbox failed: %v", err)
	}
	if messages != nil {
		t.Errorf("expected nil for empty inbox, got %v", messages)
	}
}

func TestUnreadMessages(t *testing.T) {
	store := newTestStore(t)

	store.SendMessage("server", "client", "msg1")
	store.SendMessage("server", "client", "msg2")
	store.MarkAllRead("server")
	store.SendMessage("server", "client", "msg3")

	unread, err := store.UnreadMessages("server")
	if err != nil {
		t.Fatalf("UnreadMessages failed: %v", err)
	}
	if len(unread) != 1 {
		t.Errorf("expected 1 unread, got %d", len(unread))
	}
	if unread[0].Content != "msg3" {
		t.Errorf("expected 'msg3', got '%s'", unread[0].Content)
	}
}
