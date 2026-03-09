package irc

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Path helpers

func (s *Store) RegistryPath() string          { return filepath.Join(s.BaseDir, "registry.json") }
func (s *Store) LockPath() string              { return filepath.Join(s.BaseDir, "registry.lock") }
func (s *Store) SocketsDir() string            { return filepath.Join(s.BaseDir, "sockets") }
func (s *Store) SocketPath(name string) string { return filepath.Join(s.SocketsDir(), name+".sock") }
func (s *Store) PIDPath(name string) string    { return filepath.Join(s.SocketsDir(), name+".pid") }
func (s *Store) InboxDir(name string) string   { return filepath.Join(s.BaseDir, "inbox", name) }

// Session marker: allows check command to detect current session without running git.
// Markers are keyed by daemonPID (unique per peer) and store "name\nsessionPID".

func (s *Store) SessionMarkerPath(daemonPID int) string {
	return filepath.Join(s.BaseDir, fmt.Sprintf(".session_%d", daemonPID))
}

func (s *Store) WriteSessionMarker(name string, daemonPID int, sessionPID int) error {
	content := fmt.Sprintf("%s\n%d", name, sessionPID)
	path := s.SessionMarkerPath(daemonPID)
	if err := os.WriteFile(path, []byte(content), privateFilePerm); err != nil {
		return err
	}
	return os.Chmod(path, privateFilePerm)
}

func (s *Store) RemoveSessionMarker(daemonPID int) error {
	return os.Remove(s.SessionMarkerPath(daemonPID))
}

// parseSessionMarker parses marker content returning (name, sessionPID).
// Handles both new format "name\nsessionPID" and legacy format "name" (sessionPID=0).
func parseSessionMarker(data []byte) (name string, sessionPID int) {
	content := strings.TrimSpace(string(data))
	parts := strings.SplitN(content, "\n", 2)
	name = strings.TrimSpace(parts[0])
	if len(parts) >= 2 {
		sessionPID, _ = strconv.Atoi(strings.TrimSpace(parts[1]))
	}
	return
}

// sessionMarkerInfo holds parsed session marker data.
type sessionMarkerInfo struct {
	name       string
	daemonPID  int
	sessionPID int
}
