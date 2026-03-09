package irc

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// ErrAlreadyJoined is returned when the same session tries to re-join with the same name.
var ErrAlreadyJoined = errors.New("already joined")

// PeerInfo stores metadata about a registered peer.
type PeerInfo struct {
	Name         string    `json:"name"`
	PID          int       `json:"pid"`
	DaemonPID    int       `json:"daemon_pid,omitempty"`
	CWD          string    `json:"cwd"`
	RegisteredAt time.Time `json:"registered_at"`
	LastSeen     time.Time `json:"last_seen"`
}

// Registry holds all registered peers for a repo.
type Registry struct {
	Peers map[string]PeerInfo `json:"peers"`
}

// Register adds a peer to the registry.
// If a peer with the same name exists but is not responding, re-registration is allowed.
func (s *Store) Register(name string, pid int) error {
	return s.withRegistryLock(func(reg *Registry) error {
		if existing, exists := reg.Peers[name]; exists {
			// Allow re-registration if daemon is not responding (dead/zombie)
			if !s.CheckPresence(name) {
				// Clean up stale artifacts
				os.Remove(s.SocketPath(name))
				os.Remove(s.PIDPath(name))
			} else if existing.PID == pid {
				// Same session re-joining with same name — idempotent
				return ErrAlreadyJoined
			} else {
				return fmt.Errorf("peer '%s' already exists (use 'quit' first)", name)
			}
		}

		cwd, _ := os.Getwd()
		reg.Peers[name] = PeerInfo{
			Name:         name,
			PID:          pid,
			CWD:          cwd,
			RegisteredAt: time.Now(),
			LastSeen:     time.Now(),
		}
		return nil
	})
}

// SetDaemonPID updates the daemon PID for a peer.
func (s *Store) SetDaemonPID(name string, daemonPID int) error {
	return s.withRegistryLock(func(reg *Registry) error {
		info, exists := reg.Peers[name]
		if !exists {
			return fmt.Errorf("peer '%s' not found", name)
		}
		info.DaemonPID = daemonPID
		reg.Peers[name] = info
		return nil
	})
}

// Unregister removes a peer from the registry.
func (s *Store) Unregister(name string) error {
	return s.withRegistryLock(func(reg *Registry) error {
		delete(reg.Peers, name)
		return nil
	})
}

// ListPeers returns all registered peers.
func (s *Store) ListPeers() (map[string]PeerInfo, error) {
	var peers map[string]PeerInfo
	err := s.withRegistryLock(func(reg *Registry) error {
		peers = make(map[string]PeerInfo, len(reg.Peers))
		for k, v := range reg.Peers {
			peers[k] = v
		}
		return nil
	})
	return peers, err
}

// withRegistryLock acquires an exclusive file lock, reads the registry,
// runs the callback, and writes it back atomically.
func (s *Store) withRegistryLock(fn func(*Registry) error) error {
	lockPath := s.LockPath()

	// Ensure parent dir exists
	if err := ensurePrivateDir(filepath.Dir(lockPath)); err != nil {
		return fmt.Errorf("ensuring lock directory: %w", err)
	}

	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, privateFilePerm)
	if err != nil {
		return fmt.Errorf("opening lock file: %w", err)
	}
	defer f.Close()
	if err := f.Chmod(privateFilePerm); err != nil {
		return fmt.Errorf("setting lock permissions: %w", err)
	}

	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("acquiring lock: %w", err)
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)

	reg, err := readRegistry(s.RegistryPath())
	if err != nil {
		reg = &Registry{Peers: make(map[string]PeerInfo)}
	}

	if err := fn(reg); err != nil {
		return err
	}

	return writeRegistryAtomic(s.RegistryPath(), reg)
}

func readRegistry(path string) (*Registry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var reg Registry
	if err := json.Unmarshal(data, &reg); err != nil {
		return nil, err
	}
	if reg.Peers == nil {
		reg.Peers = make(map[string]PeerInfo)
	}
	return &reg, nil
}

func writeRegistryAtomic(path string, reg *Registry) error {
	data, err := json.MarshalIndent(reg, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling registry: %w", err)
	}
	data = append(data, '\n')

	dir := filepath.Dir(path)
	if err := ensurePrivateDir(dir); err != nil {
		return fmt.Errorf("ensuring registry directory: %w", err)
	}

	tmp, err := os.CreateTemp(dir, ".registry-*.tmp")
	if err != nil {
		return fmt.Errorf("creating temp file: %w", err)
	}

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return fmt.Errorf("writing temp file: %w", err)
	}
	tmp.Close()

	return os.Rename(tmp.Name(), path)
}
