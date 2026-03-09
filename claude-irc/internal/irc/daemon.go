package irc

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// SocketRequest is a message sent to the daemon socket.
type SocketRequest struct {
	Type string `json:"type"` // "ping"
}

// SocketResponse is a message sent back from the daemon socket.
type SocketResponse struct {
	Type string `json:"type"` // "pong"
	Name string `json:"name"`
	PID  int    `json:"pid"`
}

// SpawnDaemon starts the daemon as a detached child process.
// Returns the daemon PID.
func (s *Store) SpawnDaemon(name string, sessionPID int) (int, error) {
	exePath, err := os.Executable()
	if err != nil {
		return 0, fmt.Errorf("failed to get executable path: %w", err)
	}

	cmd := exec.Command(exePath, "__daemon",
		"--name", name,
		"--session-pid", strconv.Itoa(sessionPID),
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true, // Detach from parent session
	}
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return 0, fmt.Errorf("failed to start daemon: %w", err)
	}

	pid := cmd.Process.Pid

	// Write PID file
	if err := s.writePIDFile(name, pid); err != nil {
		cmd.Process.Kill()
		return 0, fmt.Errorf("failed to write PID file: %w", err)
	}

	// Don't wait for the child
	cmd.Process.Release()

	return pid, nil
}

// RunDaemon runs the socket listener loop. This is called by the __daemon command.
func (s *Store) RunDaemon(name string, sessionPID int) error {
	socketPath := s.SocketPath(name)
	if err := ensurePrivateDir(filepath.Dir(socketPath)); err != nil {
		return fmt.Errorf("failed to create socket directory: %w", err)
	}
	os.Remove(socketPath) // Clean stale socket

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("failed to listen on socket: %w", err)
	}
	defer listener.Close()
	defer os.Remove(socketPath)
	defer os.Remove(s.PIDPath(name))

	// Signal handling for clean shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)

	// Monitor session PID: if the parent Claude Code session dies, self-terminate
	if sessionPID > 0 {
		go func() {
			for {
				time.Sleep(30 * time.Second)
				if !isProcessAlive(sessionPID) {
					listener.Close()
					return
				}
			}
		}()
	}

	go func() {
		<-sigCh
		listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			// Listener closed (shutdown)
			return nil
		}
		go s.handleConnection(conn, name)
	}
}

func (s *Store) writePIDFile(name string, pid int) error {
	if err := ensurePrivateDir(s.SocketsDir()); err != nil {
		return err
	}
	return writeFileAtomic(s.PIDPath(name), []byte(strconv.Itoa(pid)), privateFilePerm)
}

func (s *Store) handleConnection(conn net.Conn, name string) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(2 * time.Second))

	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		return
	}

	var req SocketRequest
	if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
		return
	}

	if req.Type == "ping" {
		resp := SocketResponse{
			Type: "pong",
			Name: name,
			PID:  os.Getpid(),
		}
		data, _ := json.Marshal(resp)
		data = append(data, '\n')
		conn.Write(data)
	}
}

// KillDaemon reads the PID file and sends SIGTERM to the daemon.
func (s *Store) KillDaemon(name string) error {
	pidPath := s.PIDPath(name)
	data, err := os.ReadFile(pidPath)
	if err != nil {
		// PID file not found, try to clean up socket directly
		os.Remove(s.SocketPath(name))
		return nil
	}

	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		os.Remove(pidPath)
		os.Remove(s.SocketPath(name))
		return nil
	}

	// Send SIGTERM
	proc, err := os.FindProcess(pid)
	if err == nil {
		proc.Signal(syscall.SIGTERM)
		// Give it a moment to clean up
		time.Sleep(100 * time.Millisecond)
	}

	// Clean up files in case daemon didn't
	os.Remove(pidPath)
	os.Remove(s.SocketPath(name))
	return nil
}

func isProcessAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	return err == nil
}
