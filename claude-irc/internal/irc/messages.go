package irc

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Message represents a single inbox message.
type Message struct {
	From      string    `json:"from"`
	Content   string    `json:"content"`
	Timestamp time.Time `json:"timestamp"`
	Read      bool      `json:"read"`
	filename  string    // internal, not serialized
}

// SendMessage writes a message to a peer's inbox directory.
func (s *Store) SendMessage(to, from, content string) error {
	if err := validatePeerName(to); err != nil {
		return err
	}

	dir := s.InboxDir(to)
	if err := ensurePrivateDir(dir); err != nil {
		return fmt.Errorf("failed to create inbox dir: %w", err)
	}

	msg := Message{
		From:      from,
		Content:   content,
		Timestamp: time.Now(),
		Read:      false,
	}

	data, err := json.MarshalIndent(msg, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal message: %w", err)
	}
	data = append(data, '\n')

	filename := fmt.Sprintf("%d.json", time.Now().UnixNano())
	return writeFileAtomic(filepath.Join(dir, filename), data, privateFilePerm)
}

// ReadInbox returns all messages for a peer, sorted chronologically.
func (s *Store) ReadInbox(name string) ([]Message, error) {
	if err := validatePeerName(name); err != nil {
		return nil, err
	}

	dir := s.InboxDir(name)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read inbox: %w", err)
	}

	var messages []Message
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		msg.filename = entry.Name()
		messages = append(messages, msg)
	}

	sort.Slice(messages, func(i, j int) bool {
		return messages[i].Timestamp.Before(messages[j].Timestamp)
	})

	return messages, nil
}

// UnreadMessages returns only unread messages for a peer.
func (s *Store) UnreadMessages(name string) ([]Message, error) {
	all, err := s.ReadInbox(name)
	if err != nil {
		return nil, err
	}

	var unread []Message
	for _, msg := range all {
		if !msg.Read {
			unread = append(unread, msg)
		}
	}
	return unread, nil
}

// UnreadCount returns the number of unread messages.
func (s *Store) UnreadCount(name string) (int, error) {
	msgs, err := s.UnreadMessages(name)
	if err != nil {
		return 0, err
	}
	return len(msgs), nil
}

// ClearInbox removes all messages from a peer's inbox.
func (s *Store) ClearInbox(name string) error {
	if err := validatePeerName(name); err != nil {
		return err
	}

	dir := s.InboxDir(name)
	return os.RemoveAll(dir)
}

// MarkAllRead marks all messages in a peer's inbox as read.
func (s *Store) MarkAllRead(name string) error {
	if err := validatePeerName(name); err != nil {
		return err
	}

	dir := s.InboxDir(name)
	info, err := os.Stat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("inbox path is not a directory: %s", dir)
	}
	if err := os.Chmod(dir, privateDirPerm); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}

		if !msg.Read {
			msg.Read = true
			updated, err := json.MarshalIndent(msg, "", "  ")
			if err != nil {
				continue
			}
			updated = append(updated, '\n')
			writeFileAtomic(path, updated, privateFilePerm)
		}
	}

	return nil
}
