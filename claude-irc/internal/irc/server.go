package irc

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ServerConfig holds configuration for the HTTP API server.
type ServerConfig struct {
	Port       int
	BindHost   string
	Store      *Store
	MasterTmux string
	Token      string                // pre-set token; if empty, a new one is generated
	OnReady    func(info ServerInfo) // callback when server is ready
}

// ServerInfo contains details about a running server instance.
type ServerInfo struct {
	Token      string `json:"token"`
	ShortCode  string `json:"short_code"`
	LocalURL   string `json:"local_url"`
	ListenAddr string `json:"listen_addr"`
}

const dashboardOperatorName = "user"
const defaultServerBindHost = "127.0.0.1"
const defaultServerAdvertiseHost = "localhost"

const (
	maxHTTPJSONBodyBytes      int64 = 1 << 20
	maxHTTPMessageContentSize       = 10 << 10
	maxHTTPMasterKeysSize           = 10 << 10
)

// RunServer starts the HTTP API server and blocks until the context is cancelled.
func RunServer(ctx context.Context, cfg ServerConfig) error {
	token := cfg.Token
	if token == "" {
		var err error
		token, err = generateToken()
		if err != nil {
			return fmt.Errorf("generating token: %w", err)
		}
	}
	shortCode := shortCodeFromToken(token)

	mux := buildHandler(cfg.Store, token, shortCode, cfg.MasterTmux)

	bindHost := resolveBindHost(cfg.BindHost)
	listenAddr := net.JoinHostPort(bindHost, strconv.Itoa(cfg.Port))
	listener, err := net.Listen("tcp", listenAddr)
	if err != nil {
		// Try to kill the process occupying the port and retry once
		if killErr := killPortHolder(cfg.Port); killErr == nil {
			time.Sleep(500 * time.Millisecond)
			listener, err = net.Listen("tcp", listenAddr)
		}
		if err != nil {
			return fmt.Errorf("listen: %w", err)
		}
	}

	addr := listener.Addr().(*net.TCPAddr)
	info := ServerInfo{
		Token:      token,
		ShortCode:  shortCode,
		LocalURL:   localURLForHost(advertiseServerHost(bindHost), addr.Port),
		ListenAddr: listener.Addr().String(),
	}

	if cfg.OnReady != nil {
		cfg.OnReady(info)
	}

	srv := &http.Server{Handler: mux}

	go func() {
		<-ctx.Done()
		srv.Shutdown(context.Background())
	}()

	if err := srv.Serve(listener); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

func resolveBindHost(bindHost string) string {
	bindHost = normalizeHost(bindHost)
	if bindHost == "" {
		return defaultServerBindHost
	}
	return bindHost
}

func advertiseServerHost(bindHost string) string {
	bindHost = normalizeHost(bindHost)
	if bindHost == "" {
		return defaultServerAdvertiseHost
	}
	if ip := net.ParseIP(bindHost); ip != nil {
		switch {
		case ip.IsLoopback():
			return defaultServerAdvertiseHost
		case ip.IsUnspecified():
			if host, ok := firstNonLoopbackInterfaceAddr(ip.To4() == nil); ok {
				return host
			}
		default:
			if ipv4 := ip.To4(); ipv4 != nil {
				return ipv4.String()
			}
			return ip.String()
		}
	}
	if strings.EqualFold(bindHost, defaultServerAdvertiseHost) {
		return defaultServerAdvertiseHost
	}
	return bindHost
}

func normalizeHost(host string) string {
	host = strings.TrimSpace(host)
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") && len(host) >= 2 {
		return host[1 : len(host)-1]
	}
	return host
}

func firstNonLoopbackInterfaceAddr(wantIPv6 bool) (string, bool) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return "", false
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}

		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ip := interfaceAddrIP(addr)
			if ip == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() {
				continue
			}
			if wantIPv6 {
				if ip.To4() != nil {
					continue
				}
			} else {
				ipv4 := ip.To4()
				if ipv4 == nil {
					continue
				}
				ip = ipv4
			}
			return ip.String(), true
		}
	}
	return "", false
}

func interfaceAddrIP(addr net.Addr) net.IP {
	switch v := addr.(type) {
	case *net.IPNet:
		return v.IP
	case *net.IPAddr:
		return v.IP
	default:
		return nil
	}
}

func localURLForHost(host string, port int) string {
	return (&url.URL{
		Scheme: "http",
		Host:   net.JoinHostPort(host, strconv.Itoa(port)),
	}).String()
}

func shortCodeFromToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:4]) // 8 hex chars
}

func generateToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// buildHandler creates the HTTP handler with auth and CORS middleware.
func buildHandler(store *Store, token string, shortCode string, masterTmux string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Short URL redirect (no auth required)
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/s/") {
			code := strings.TrimPrefix(r.URL.Path, "/s/")
			if code == shortCode {
				host := r.Host
				connectURL := fmt.Sprintf("https://%s?token=%s", host, token)
				webURL := fmt.Sprintf("https://whip.bang9.dev#%s", connectURL)
				http.Redirect(w, r, webURL, http.StatusFound)
			} else {
				http.NotFound(w, r)
			}
			return
		}

		// CORS middleware
		origin := r.Header.Get("Origin")
		if isAllowedOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		}

		if r.Method == http.MethodOptions {
			if isAllowedOrigin(origin) {
				w.WriteHeader(http.StatusNoContent)
			} else {
				w.WriteHeader(http.StatusForbidden)
			}
			return
		}

		// Auth middleware
		if !checkAuth(r, token) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}

		// Route
		route(w, r, store, masterTmux)
	})
}

var localhostPattern = regexp.MustCompile(`^http://localhost(:\d+)?$`)

func isAllowedOrigin(origin string) bool {
	if origin == "https://whip.bang9.dev" {
		return true
	}
	return localhostPattern.MatchString(origin)
}

func checkAuth(r *http.Request, token string) bool {
	// Check Authorization header
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		if strings.TrimPrefix(auth, "Bearer ") == token {
			return true
		}
	}
	// Check query param
	if r.URL.Query().Get("token") == token {
		return true
	}
	return false
}

func route(w http.ResponseWriter, r *http.Request, store *Store, masterTmux string) {
	path := strings.TrimRight(r.URL.Path, "/")
	segments := strings.Split(strings.TrimPrefix(path, "/"), "/")

	// Match: /api/<resource>[/<param1>[/<param2>]]
	if len(segments) < 2 || segments[0] != "api" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}

	resource := segments[1]

	switch resource {
	case "peers":
		if r.Method == http.MethodGet && len(segments) == 2 {
			handleGetPeers(w, store)
			return
		}

	case "messages":
		if len(segments) == 2 {
			if r.Method == http.MethodPost {
				handlePostMessage(w, r, store)
				return
			}
		} else if len(segments) == 3 {
			name := segments[2]
			switch r.Method {
			case http.MethodGet:
				handleGetMessages(w, r, store, name)
				return
			case http.MethodDelete:
				handleDeleteMessages(w, store, name)
				return
			}
		} else if len(segments) == 4 && segments[3] == "read" {
			name := segments[2]
			if r.Method == http.MethodPost {
				handleMarkRead(w, store, name)
				return
			}
		}

	case "master":
		if masterTmux == "" {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "master session not configured"})
			return
		}
		if len(segments) == 3 {
			switch segments[2] {
			case "capture":
				if r.Method == http.MethodGet {
					handleMasterCapture(w, masterTmux)
					return
				}
			case "keys":
				if r.Method == http.MethodPost {
					handleMasterKeys(w, r, masterTmux)
					return
				}
			case "status":
				if r.Method == http.MethodGet {
					handleMasterStatus(w, masterTmux)
					return
				}
			}
		}

	case "tasks":
		if len(segments) == 2 && r.Method == http.MethodGet {
			handleGetTasks(w)
			return
		} else if len(segments) == 3 && r.Method == http.MethodGet {
			handleGetTask(w, segments[2])
			return
		}
	}

	writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
}

// IRC endpoint handlers

func handleGetPeers(w http.ResponseWriter, store *Store) {
	statuses, err := store.CheckAllPresence()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if statuses == nil {
		statuses = []PeerStatus{}
	}
	writeJSON(w, http.StatusOK, statuses)
}

func handlePostMessage(w http.ResponseWriter, r *http.Request, store *Store) {
	var body struct {
		To      string `json:"to"`
		From    string `json:"from"`
		Content string `json:"content"`
	}
	if !decodeLimitedJSONBody(w, r, &body, "invalid request body") {
		return
	}

	if body.To == "" || body.From == "" || body.Content == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "to, from, and content are required"})
		return
	}
	if err := validatePeerName(body.To); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if body.From != dashboardOperatorName {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only 'user' may send messages over HTTP"})
		return
	}
	if len(body.Content) > maxHTTPMessageContentSize {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("content too large (%d bytes, max %d bytes)", len(body.Content), maxHTTPMessageContentSize),
		})
		return
	}

	if err := store.SendMessage(body.To, body.From, body.Content); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

func handleGetMessages(w http.ResponseWriter, r *http.Request, store *Store, name string) {
	var messages []Message
	var err error

	if r.URL.Query().Get("all") == "true" {
		messages, err = store.ReadInbox(name)
	} else {
		messages, err = store.UnreadMessages(name)
	}

	if err != nil {
		writeJSON(w, statusForIdentifierError(err), map[string]string{"error": err.Error()})
		return
	}
	if messages == nil {
		messages = []Message{}
	}
	writeJSON(w, http.StatusOK, messages)
}

func handleMarkRead(w http.ResponseWriter, store *Store, name string) {
	if err := store.MarkAllRead(name); err != nil {
		writeJSON(w, statusForIdentifierError(err), map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handleDeleteMessages(w http.ResponseWriter, store *Store, name string) {
	if err := store.ClearInbox(name); err != nil {
		writeJSON(w, statusForIdentifierError(err), map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func statusForIdentifierError(err error) int {
	if errors.Is(err, ErrInvalidIdentifier) {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

// Whip task types (minimal, no whip package import)

type whipNote struct {
	Timestamp time.Time `json:"timestamp"`
	Status    string    `json:"status"`
	Content   string    `json:"content"`
}

type whipTask struct {
	ID            string     `json:"id"`
	Title         string     `json:"title"`
	Description   string     `json:"description"`
	CWD           string     `json:"cwd"`
	Status        string     `json:"status"`
	Backend       string     `json:"backend,omitempty"`
	Runner        string     `json:"runner,omitempty"`
	IRCName       string     `json:"irc_name"`
	MasterIRCName string     `json:"master_irc_name"`
	SessionID     string     `json:"session_id,omitempty"`
	ShellPID      int        `json:"shell_pid"`
	Note          string     `json:"note"`
	Notes         []whipNote `json:"notes,omitempty"`
	Difficulty    string     `json:"difficulty,omitempty"`
	Review        bool       `json:"review,omitempty"`
	DependsOn     []string   `json:"depends_on"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	AssignedAt    *time.Time `json:"assigned_at"`
	CompletedAt   *time.Time `json:"completed_at"`
	PIDAlive      bool       `json:"pid_alive"`
}

func whipTasksDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".whip", "tasks")
}

func readAllWhipTasks() ([]whipTask, error) {
	dir := whipTasksDir()
	if dir == "" {
		return nil, fmt.Errorf("cannot determine home directory")
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []whipTask{}, nil
		}
		return nil, err
	}

	var tasks []whipTask
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		taskPath := filepath.Join(dir, entry.Name(), "task.json")
		data, err := os.ReadFile(taskPath)
		if err != nil {
			continue
		}
		var t whipTask
		if err := json.Unmarshal(data, &t); err != nil {
			continue
		}
		t.PIDAlive = isWhipPIDAlive(t.ShellPID)
		tasks = append(tasks, t)
	}

	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].CreatedAt.Before(tasks[j].CreatedAt)
	})

	return tasks, nil
}

func readWhipTask(id string) (*whipTask, error) {
	if err := validateTaskID(id); err != nil {
		return nil, err
	}

	dir := whipTasksDir()
	if dir == "" {
		return nil, fmt.Errorf("cannot determine home directory")
	}

	taskPath := filepath.Join(dir, id, "task.json")
	data, err := os.ReadFile(taskPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("task %s not found", id)
		}
		return nil, err
	}

	var t whipTask
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, err
	}
	t.PIDAlive = isWhipPIDAlive(t.ShellPID)
	return &t, nil
}

func isWhipPIDAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil
}

func handleGetTasks(w http.ResponseWriter) {
	tasks, err := readAllWhipTasks()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if tasks == nil {
		tasks = []whipTask{}
	}
	writeJSON(w, http.StatusOK, tasks)
}

func handleGetTask(w http.ResponseWriter, id string) {
	task, err := readWhipTask(id)
	if err != nil {
		status := http.StatusInternalServerError
		switch {
		case errors.Is(err, ErrInvalidIdentifier):
			status = http.StatusBadRequest
		case os.IsNotExist(err), strings.Contains(err.Error(), "not found"):
			status = http.StatusNotFound
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, task)
}

// Master tmux handlers

func handleMasterCapture(w http.ResponseWriter, sessionName string) {
	cmd := exec.Command("tmux", "capture-pane", "-t", sessionName, "-p", "-S", "-500")
	out, err := cmd.Output()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "session not available"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"content": string(out)})
}

func handleMasterKeys(w http.ResponseWriter, r *http.Request, sessionName string) {
	var body struct {
		Keys string `json:"keys"`
	}
	if !decodeLimitedJSONBody(w, r, &body, "invalid body") {
		return
	}
	if body.Keys == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "keys required"})
		return
	}
	if len(body.Keys) > maxHTTPMasterKeysSize {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("keys too large (%d bytes, max %d bytes)", len(body.Keys), maxHTTPMasterKeysSize),
		})
		return
	}
	// Split into literal text and trailing Enter if present
	keys := body.Keys
	hasEnter := len(keys) > 0 && keys[len(keys)-1] == '\n'
	if hasEnter {
		keys = keys[:len(keys)-1]
	}
	if keys != "" {
		cmd := exec.Command("tmux", "send-keys", "-t", sessionName, "-l", keys)
		if err := cmd.Run(); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "session not available"})
			return
		}
	}
	if hasEnter {
		cmd := exec.Command("tmux", "send-keys", "-t", sessionName, "Enter")
		if err := cmd.Run(); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "session not available"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handleMasterStatus(w http.ResponseWriter, sessionName string) {
	alive := exec.Command("tmux", "has-session", "-t", sessionName).Run() == nil
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"session": sessionName,
		"alive":   alive,
	})
}

// Helpers

// killPortHolder finds and kills the process listening on the given port.
func killPortHolder(port int) error {
	// lsof -t -i :<port> returns PIDs
	out, err := exec.Command("lsof", "-t", "-i", fmt.Sprintf(":%d", port)).Output()
	if err != nil {
		return err
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		pid, err := strconv.Atoi(strings.TrimSpace(line))
		if err != nil || pid <= 0 {
			continue
		}
		syscall.Kill(pid, syscall.SIGTERM)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func decodeLimitedJSONBody(w http.ResponseWriter, r *http.Request, dst interface{}, invalidBodyMessage string) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxHTTPJSONBodyBytes)

	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request body too large"})
			return false
		}
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": invalidBodyMessage})
		return false
	}

	return true
}
