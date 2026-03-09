package whip

import (
	"bytes"
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/mdp/qrterminal/v3"
)

var (
	// ── Color palette ──────────────────────────────────────────────
	colorPrimary   = lipgloss.Color("#8B5CF6") // vibrant purple
	colorSecondary = lipgloss.Color("#818CF8") // soft indigo
	colorAccent    = lipgloss.Color("#A78BFA") // light purple
	colorSuccess   = lipgloss.Color("#34D399") // emerald
	colorWarning   = lipgloss.Color("#FBBF24") // amber
	colorDanger    = lipgloss.Color("#F87171") // rose
	colorText      = lipgloss.Color("#F3F4F6") // gray-100
	colorMuted     = lipgloss.Color("#9CA3AF") // gray-400
	colorSubtle    = lipgloss.Color("#6B7280") // gray-500
	colorDim       = lipgloss.Color("#374151") // gray-700

	colorReview = lipgloss.Color("#F472B6") // pink

	// ── Status styles ──────────────────────────────────────────────
	statusCreated    = lipgloss.NewStyle().Foreground(colorSubtle)
	statusAssigned   = lipgloss.NewStyle().Foreground(colorWarning)
	statusInProgress = lipgloss.NewStyle().Foreground(colorSecondary).Bold(true)
	statusReview     = lipgloss.NewStyle().Foreground(colorReview).Bold(true)
	statusCompleted  = lipgloss.NewStyle().Foreground(colorSuccess)
	statusFailed     = lipgloss.NewStyle().Foreground(colorDanger)

	// ── Cell styles ────────────────────────────────────────────────
	idStyle        = lipgloss.NewStyle().Foreground(colorWarning)
	pidAliveStyle  = lipgloss.NewStyle().Foreground(colorSuccess)
	pidExitedStyle = lipgloss.NewStyle().Foreground(colorWarning)
	pidDeadStyle   = lipgloss.NewStyle().Foreground(colorDanger)

	spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
)

type tickMsg time.Time
type cleanedMsg int
type retryResultMsg struct{ err error }
type approveResultMsg struct{ err error }

type peerInfo struct {
	Name   string
	Online bool
}
type peersMsg []peerInfo

type viewState int

const (
	viewList viewState = iota
	viewDetail
	viewTmux
	viewIRC          // peer selection list
	viewIRCMsg       // message text input
	viewRemoteConfig // tunnel/port config input
	viewRemoteStatus // remote running status page
)

type ircSendResultMsg struct{ err error }

type DashboardModel struct {
	store         *Store
	tasks         []*Task
	peers         []peerInfo
	version       string
	width         int
	height        int
	err           error
	spinnerIndex  int
	tickCount     int
	cursor        int
	view          viewState
	selectedTask  *Task
	detailScroll  int
	tmuxContent   string
	pendingAttach string

	ircCursor      int
	ircInput       string
	ircTarget      string
	ircLastSendErr error
	ircLastSendAt  time.Time

	// Remote/serve state
	serveProcess   *exec.Cmd
	serveURL       string
	shortURL       string
	webURL         string
	masterAlive    bool
	remoteStarting bool
	remoteErr      error

	// Remote config input
	tunnelInput  string
	portInput    string
	configCursor int // 0=tunnel, 1=port
	cwd          string
}

func (m DashboardModel) PendingAttach() string {
	return m.pendingAttach
}

// Cleanup gracefully stops the serve process if it's still running.
// Sends SIGTERM so claude-irc can clean up its child processes (e.g. cloudflared).
func (m DashboardModel) Cleanup() {
	if m.serveProcess == nil || m.serveProcess.Process == nil {
		return
	}
	// SIGTERM for graceful shutdown (cloudflared cleanup)
	m.serveProcess.Process.Signal(syscall.SIGTERM)
	done := make(chan error, 1)
	go func() { done <- m.serveProcess.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		m.serveProcess.Process.Kill()
		<-done
	}
}

func NewDashboardModel(store *Store, version string) DashboardModel {
	cwd, _ := os.Getwd()
	return DashboardModel{
		store:   store,
		version: version,
		width:   120,
		cwd:     cwd,
	}
}

func (m DashboardModel) Init() tea.Cmd {
	return tea.Batch(
		m.loadTasks(),
		loadPeers(),
		tickCmd(),
	)
}

func tickCmd() tea.Cmd {
	return tea.Tick(time.Second*2, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func (m DashboardModel) cleanTasks() tea.Cmd {
	return func() tea.Msg {
		count, _ := m.store.CleanTerminal()
		return cleanedMsg(count)
	}
}

func (m DashboardModel) loadTasks() tea.Cmd {
	return func() tea.Msg {
		tasks, err := m.store.ListTasks()
		if err != nil {
			return err
		}
		return tasks
	}
}

func loadPeers() tea.Cmd {
	return func() tea.Msg {
		out, err := exec.Command("claude-irc", "who").Output()
		if err != nil {
			return peersMsg(nil)
		}
		var peers []peerInfo
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 || fields[0] == "PEER" {
				continue
			}
			peers = append(peers, peerInfo{
				Name:   fields[0],
				Online: fields[1] == "online",
			})
		}
		return peersMsg(peers)
	}
}

func (m DashboardModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch m.view {
		case viewList:
			return m.updateList(msg)
		case viewDetail:
			return m.updateDetail(msg)
		case viewTmux:
			return m.updateTmux(msg)
		case viewIRC:
			return m.updateIRC(msg)
		case viewIRCMsg:
			return m.updateIRCMsg(msg)
		case viewRemoteConfig:
			return m.updateRemoteConfig(msg)
		case viewRemoteStatus:
			return m.updateRemoteStatus(msg)
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case []*Task:
		m.tasks = msg
		m.err = nil
		if m.cursor >= len(m.tasks) && len(m.tasks) > 0 {
			m.cursor = len(m.tasks) - 1
		}
		// Refresh selectedTask if viewing detail/tmux
		if m.selectedTask != nil {
			for _, t := range m.tasks {
				if t.ID == m.selectedTask.ID {
					m.selectedTask = t
					break
				}
			}
		}

	case peersMsg:
		m.peers = []peerInfo(msg)

	case retryResultMsg:
		if msg.err != nil {
			m.err = msg.err
		}
		return m, m.loadTasks()

	case approveResultMsg:
		if msg.err != nil {
			m.err = msg.err
		}
		return m, m.loadTasks()

	case resumeResultMsg:
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}
		if msg.sessionName != "" {
			m.pendingAttach = msg.sessionName
			return m, tea.Quit
		}
		return m, nil

	case ircSendResultMsg:
		m.ircLastSendErr = msg.err
		m.ircLastSendAt = time.Now()
		return m, nil

	case cleanedMsg:
		return m, m.loadTasks()

	case error:
		m.err = msg

	case remoteStartedMsg:
		m.remoteStarting = false
		if msg.err != nil {
			m.remoteErr = msg.err
			m.view = viewRemoteConfig
			return m, nil
		}
		m.remoteErr = nil
		m.serveProcess = msg.cmd
		m.serveURL = msg.url
		m.shortURL = msg.shortURL
		if msg.shortURL != "" {
			m.webURL = msg.shortURL
		} else if msg.url != "" {
			m.webURL = fmt.Sprintf("https://whip.bang9.dev#%s", msg.url)
		}
		m.masterAlive = IsMasterSessionAlive()
		m.view = viewRemoteStatus
		return m, m.loadTasks()

	case remoteStoppedMsg:
		m.serveProcess = nil
		m.serveURL = ""
		m.shortURL = ""
		m.webURL = ""
		m.masterAlive = false
		m.view = viewList
		return m, nil

	case tickMsg:
		m.spinnerIndex = (m.spinnerIndex + 1) % len(spinnerFrames)
		m.tickCount++
		cmds := []tea.Cmd{m.loadTasks(), loadPeers(), tickCmd()}
		// Auto-refresh tmux content
		if m.view == viewTmux && m.selectedTask != nil {
			if content, err := CaptureTmuxPane(m.selectedTask.ID); err == nil {
				m.tmuxContent = content
			}
		}
		// Check remote state
		if m.serveProcess != nil {
			m.masterAlive = IsMasterSessionAlive()
			// Check if serve process died
			if m.serveProcess.ProcessState != nil {
				m.serveProcess = nil
				m.serveURL = ""
				m.masterAlive = false
			}
		}
		return m, tea.Batch(cmds...)
	}

	return m, nil
}

func (m DashboardModel) updateList(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "c":
		return m, m.cleanTasks()
	case "up", "k":
		if len(m.tasks) > 0 {
			m.cursor--
			if m.cursor < 0 {
				m.cursor = len(m.tasks) - 1
			}
		}
	case "down", "j":
		if len(m.tasks) > 0 {
			m.cursor++
			if m.cursor >= len(m.tasks) {
				m.cursor = 0
			}
		}
	case "enter":
		if len(m.tasks) > 0 && m.cursor < len(m.tasks) {
			m.selectedTask = m.tasks[m.cursor]
			m.detailScroll = 0
			m.view = viewDetail
		}
	case "i":
		peers := m.ircPeers()
		if len(peers) > 0 {
			m.ircCursor = 0
			m.view = viewIRC
		}
	case "R":
		if m.serveProcess != nil {
			// Show remote status page (stop from there)
			m.view = viewRemoteStatus
		} else {
			cfg, _ := m.store.LoadConfig()
			m.tunnelInput = cfg.Tunnel
			if cfg.RemotePort > 0 {
				m.portInput = strconv.Itoa(cfg.RemotePort)
			} else {
				m.portInput = "8585"
			}
			m.configCursor = 0
			m.view = viewRemoteConfig
		}
	}
	return m, nil
}

func (m DashboardModel) updateDetail(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "backspace", "left":
		m.view = viewList
		m.selectedTask = nil
		m.detailScroll = 0
	case "up", "k":
		if m.detailScroll > 0 {
			m.detailScroll--
		}
	case "down", "j":
		if m.selectedTask != nil {
			if m.detailScroll < m.detailMaxScroll() {
				m.detailScroll++
			}
		}
	case "a":
		if m.selectedTask != nil && m.selectedTask.Runner == "tmux" && IsTmuxSession(m.selectedTask.ID) {
			m.view = viewTmux
			if content, err := CaptureTmuxPane(m.selectedTask.ID); err == nil {
				m.tmuxContent = content
			}
		}
	case "A":
		if m.selectedTask != nil && m.selectedTask.Status == StatusReview {
			return m, m.approveTask(m.selectedTask.ID)
		}
	case "r":
		if m.selectedTask != nil && m.selectedTask.Status == StatusFailed {
			return m, m.retryTask(m.selectedTask.ID)
		}
	case "s":
		if m.selectedTask != nil && m.selectedTask.Status != StatusCompleted && m.selectedTask.SessionID != "" && m.selectedTask.ShellPID > 0 && !IsProcessAlive(m.selectedTask.ShellPID) {
			return m, m.resumeTask(m.selectedTask)
		}
	case "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

func (m DashboardModel) retryTask(taskID string) tea.Cmd {
	return func() tea.Msg {
		task, err := m.store.LoadTask(taskID)
		if err != nil {
			return retryResultMsg{err: err}
		}

		if err := task.Retry(); err != nil {
			return retryResultMsg{err: err}
		}

		cfg, err := m.store.LoadConfig()
		if err != nil {
			return retryResultMsg{err: err}
		}
		if cfg.MasterIRCName == "" {
			cfg.MasterIRCName = "whip-master"
		}

		task.IRCName = "whip-" + task.ID
		task.MasterIRCName = cfg.MasterIRCName

		// Normalize legacy empty-backend tasks on retry
		if task.Backend == "" {
			task.Backend = DefaultBackendName
		}

		prompt := GeneratePrompt(task)
		if err := m.store.SavePrompt(task.ID, prompt); err != nil {
			return retryResultMsg{err: err}
		}

		runner, err := Spawn(task, m.store.PromptPath(task.ID))
		if err != nil {
			return retryResultMsg{err: fmt.Errorf("failed to spawn session: %w", err)}
		}
		task.Runner = runner

		task.Status = StatusAssigned
		now := time.Now()
		task.AssignedAt = &now
		task.UpdatedAt = now
		if err := m.store.SaveTask(task); err != nil {
			return retryResultMsg{err: err}
		}

		return retryResultMsg{}
	}
}

func (m DashboardModel) approveTask(taskID string) tea.Cmd {
	return func() tea.Msg {
		task, err := m.store.LoadTask(taskID)
		if err != nil {
			return approveResultMsg{err: err}
		}

		if task.Status != StatusReview {
			return approveResultMsg{err: fmt.Errorf("task %s is %s, must be review to approve", taskID, task.Status)}
		}

		// Notify agent via IRC to commit and complete (don't transition status)
		if task.IRCName != "" {
			msg := fmt.Sprintf("Task %s approved. Please commit your changes and run `whip status %s completed --note \"...\"` to finalize.", taskID, taskID)
			exec.Command("claude-irc", "msg", task.IRCName, msg).Run()
		}

		return approveResultMsg{}
	}
}

type resumeResultMsg struct {
	err         error
	sessionName string
}

func (m DashboardModel) resumeTask(task *Task) tea.Cmd {
	return func() tea.Msg {
		backend, err := GetBackend(task.Backend)
		if err != nil {
			return resumeResultMsg{err: err}
		}

		sessionName := tmuxResumeSessionName(task.ID)
		if IsTmuxSessionName(sessionName) {
			return resumeResultMsg{sessionName: sessionName}
		}

		shellCmd := fmt.Sprintf(
			`cd %s && WHIP_SHELL_PID=$$ WHIP_TASK_ID=%s whip heartbeat %s >/dev/null 2>&1; WHIP_SHELL_PID=$$ WHIP_TASK_ID=%s %s ; exit`,
			shellEscape(task.CWD),
			shellEscape(task.ID),
			shellEscape(task.ID),
			shellEscape(task.ID),
			backend.BuildResumeCmd(task),
		)
		if err := SpawnTmuxSession(sessionName, shellCmd); err != nil {
			return resumeResultMsg{err: fmt.Errorf("failed to spawn resume session: %w", err)}
		}
		return resumeResultMsg{sessionName: sessionName}
	}
}

func (m DashboardModel) updateTmux(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "backspace", "left":
		m.view = viewDetail
		m.tmuxContent = ""
	case "enter":
		if m.selectedTask != nil && IsTmuxSession(m.selectedTask.ID) {
			m.pendingAttach = tmuxSessionName(m.selectedTask.ID)
			return m, tea.Quit
		}
	case "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

// ircPeers returns the peer list with 'user' filtered out,
// sorted alphabetically with 'whip-master' always first.
func (m DashboardModel) ircPeers() []peerInfo {
	var master *peerInfo
	var rest []peerInfo
	for _, p := range m.peers {
		if p.Name == "user" {
			continue
		}
		if p.Name == "whip-master" {
			cp := p
			master = &cp
		} else {
			rest = append(rest, p)
		}
	}
	sort.Slice(rest, func(i, j int) bool {
		return rest[i].Name < rest[j].Name
	})
	var result []peerInfo
	if master != nil {
		result = append(result, *master)
	}
	result = append(result, rest...)
	return result
}

func (m DashboardModel) updateIRC(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	peers := m.ircPeers()
	switch msg.String() {
	case "esc", "backspace", "left":
		m.view = viewList
	case "up", "k":
		if len(peers) > 0 {
			m.ircCursor--
			if m.ircCursor < 0 {
				m.ircCursor = len(peers) - 1
			}
		}
	case "down", "j":
		if len(peers) > 0 {
			m.ircCursor++
			if m.ircCursor >= len(peers) {
				m.ircCursor = 0
			}
		}
	case "enter":
		if len(peers) > 0 && m.ircCursor < len(peers) {
			m.ircTarget = peers[m.ircCursor].Name
			m.ircInput = ""
			m.ircLastSendErr = nil
			m.ircLastSendAt = time.Time{}
			m.view = viewIRCMsg
		}
	case "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

func (m DashboardModel) updateIRCMsg(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyRunes:
		m.ircInput += string(msg.Runes)
	case tea.KeySpace:
		m.ircInput += " "
	case tea.KeyBackspace:
		runes := []rune(m.ircInput)
		if len(runes) > 0 {
			m.ircInput = string(runes[:len(runes)-1])
		}
	case tea.KeyEnter:
		if strings.TrimSpace(m.ircInput) != "" {
			cmd := m.sendIRCMsg(m.ircTarget, m.ircInput)
			m.ircInput = ""
			return m, cmd
		}
	case tea.KeyEsc:
		m.ircInput = ""
		m.view = viewIRC
	case tea.KeyCtrlC:
		return m, tea.Quit
	}
	return m, nil
}

func (m DashboardModel) sendIRCMsg(target, message string) tea.Cmd {
	return func() tea.Msg {
		fullMsg := message + "\n\n---\n[Sent from dashboard operator via TUI]"
		err := exec.Command("claude-irc", "--name", "user", "msg", target, fullMsg).Run()
		return ircSendResultMsg{err: err}
	}
}

// ── Remote config ──────────────────────────────────────────────────

type remoteStartedMsg struct {
	cmd      *exec.Cmd
	url      string
	shortURL string
	err      error
}
type remoteStoppedMsg struct{}

func (m DashboardModel) updateRemoteConfig(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyRunes:
		if m.configCursor == 0 {
			m.tunnelInput += string(msg.Runes)
		} else {
			m.portInput += string(msg.Runes)
		}
	case tea.KeySpace:
		if m.configCursor == 0 {
			m.tunnelInput += " "
		} else {
			m.portInput += " "
		}
	case tea.KeyBackspace:
		if m.configCursor == 0 {
			runes := []rune(m.tunnelInput)
			if len(runes) > 0 {
				m.tunnelInput = string(runes[:len(runes)-1])
			}
		} else {
			runes := []rune(m.portInput)
			if len(runes) > 0 {
				m.portInput = string(runes[:len(runes)-1])
			}
		}
	case tea.KeyTab, tea.KeyUp, tea.KeyDown:
		m.configCursor = (m.configCursor + 1) % 2
	case tea.KeyEnter:
		if m.remoteStarting {
			return m, nil // already starting
		}
		port, _ := strconv.Atoi(strings.TrimSpace(m.portInput))
		if port <= 0 {
			port = 8585
		}
		cfg := RemoteConfig{
			Backend:    "claude",
			Difficulty: "hard",
			Tunnel:     strings.TrimSpace(m.tunnelInput),
			Port:       port,
			CWD:        m.cwd,
		}
		// Save to config for next time
		storeCfg, _ := m.store.LoadConfig()
		storeCfg.Tunnel = cfg.Tunnel
		storeCfg.RemotePort = cfg.Port
		m.store.SaveConfig(storeCfg)
		m.remoteStarting = true
		m.remoteErr = nil
		return m, m.startRemote(cfg)
	case tea.KeyEsc:
		m.view = viewList
	case tea.KeyCtrlC:
		return m, tea.Quit
	}
	return m, nil
}

func (m DashboardModel) startRemote(cfg RemoteConfig) tea.Cmd {
	return func() tea.Msg {
		// Spawn master session (skip if already alive)
		if !IsMasterSessionAlive() {
			if err := SpawnMasterSession(cfg); err != nil {
				return remoteStartedMsg{err: fmt.Errorf("spawn master: %w", err)}
			}
		}
		// Load saved token
		storeCfg, _ := m.store.LoadConfig()
		token := storeCfg.ServeToken

		// Start serve
		cmd, result, err := StartServe(context.Background(), cfg, token, true)
		if err != nil {
			return remoteStartedMsg{err: fmt.Errorf("start serve: %w", err)}
		}

		// Save token from connect URL
		if t := connectURLToken(result.ConnectURL); t != "" {
			storeCfg.ServeToken = t
			m.store.SaveConfig(storeCfg)
		}

		return remoteStartedMsg{cmd: cmd, url: result.ConnectURL, shortURL: result.ShortURL}
	}
}

func (m DashboardModel) stopRemote() tea.Cmd {
	return func() tea.Msg {
		if m.serveProcess != nil && m.serveProcess.Process != nil {
			m.serveProcess.Process.Signal(syscall.SIGTERM)
			done := make(chan error, 1)
			go func() { done <- m.serveProcess.Wait() }()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				m.serveProcess.Process.Kill()
				<-done
			}
		}
		StopMasterSession()
		return remoteStoppedMsg{}
	}
}

func (m DashboardModel) updateRemoteStatus(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "s", "S":
		// Stop remote
		m.view = viewList
		return m, m.stopRemote()
	case "o":
		// Open URL in browser
		openURL := m.shortURL
		if openURL == "" {
			openURL = m.webURL
		}
		if openURL != "" {
			exec.Command("open", openURL).Start()
		}
	case "c":
		// Copy URL to clipboard
		copyURL := m.shortURL
		if copyURL == "" {
			copyURL = m.serveURL
		}
		if copyURL != "" {
			copyCmd := exec.Command("pbcopy")
			copyCmd.Stdin = strings.NewReader(copyURL)
			copyCmd.Run()
		}
	case "t":
		// Reset token
		storeCfg, _ := m.store.LoadConfig()
		storeCfg.ServeToken = ""
		m.store.SaveConfig(storeCfg)
	case "T":
		if IsMasterSessionAlive() {
			m.pendingAttach = MasterSessionName
			return m, tea.Quit
		}
	case "esc", "left", "backspace":
		m.view = viewList
	case "q":
		return m, tea.Quit
	case "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

func (m DashboardModel) renderRemoteStatusView(w int) string {
	var b strings.Builder

	// Breadcrumb
	breadcrumb := lipgloss.NewStyle().Foreground(colorSubtle).Render("  Tasks") +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("Remote")
	b.WriteString(breadcrumb + "\n\n")

	labelStyle := lipgloss.NewStyle().Bold(true).Foreground(colorMuted).Width(14)
	valStyle := lipgloss.NewStyle().Foreground(colorText)

	// Status
	var statusDot string
	if m.serveProcess != nil {
		statusDot = lipgloss.NewStyle().Foreground(colorSuccess).Render("●") + " " +
			lipgloss.NewStyle().Foreground(colorSuccess).Render("running")
	} else {
		statusDot = lipgloss.NewStyle().Foreground(colorDanger).Render("●") + " " +
			lipgloss.NewStyle().Foreground(colorDanger).Render("stopped")
	}
	b.WriteString("  " + labelStyle.Render("Status") + " " + statusDot + "\n")

	// Master session
	var masterDot string
	if m.masterAlive {
		masterDot = lipgloss.NewStyle().Foreground(colorSuccess).Render("●") + " " +
			lipgloss.NewStyle().Foreground(colorSuccess).Render("alive")
	} else {
		masterDot = lipgloss.NewStyle().Foreground(colorDanger).Render("○") + " " +
			lipgloss.NewStyle().Foreground(colorSubtle).Render("dead")
	}
	b.WriteString("  " + labelStyle.Render("Master") + " " + masterDot + "\n")

	// URL (prefer short URL)
	urlLabel := labelStyle.Render("URL")
	displayURL := m.shortURL
	if displayURL == "" {
		displayURL = m.serveURL
	}
	if displayURL != "" {
		b.WriteString("  " + urlLabel + " " + valStyle.Render(displayURL) + "\n")
	} else {
		b.WriteString("  " + urlLabel + " " + lipgloss.NewStyle().Foreground(colorSubtle).Italic(true).Render("(parsing...)") + "\n")
	}

	// QR code (use short URL if available, otherwise web URL)
	qrTarget := m.shortURL
	if qrTarget == "" {
		qrTarget = m.webURL
	}
	if qrTarget != "" {
		qr := renderQR(qrTarget)
		if qr != "" {
			b.WriteString("\n")
			for _, line := range strings.Split(qr, "\n") {
				b.WriteString("  " + line + "\n")
			}
		}
	}

	// Footer
	b.WriteString("\n")
	dot := lipgloss.NewStyle().Foreground(colorDim).Render("  ·  ")
	var parts []string
	parts = append(parts, footerKey("←/esc", "back"))
	if m.shortURL != "" || m.serveURL != "" {
		parts = append(parts, footerKey("c", "copy URL"))
		parts = append(parts, footerKey("o", "open in browser"))
	}
	if IsMasterSessionAlive() {
		parts = append(parts, footerKey("T", "attach master"))
	}
	parts = append(parts, footerKey("t", "reset token"))
	parts = append(parts, footerKey("S", "stop remote"))
	line := "  " + strings.Join(parts, dot)
	b.WriteString(lipgloss.NewStyle().MarginTop(1).Render(line))

	return b.String()
}

func (m DashboardModel) renderRemoteConfigView(w int) string {
	var b strings.Builder

	// Breadcrumb
	breadcrumb := lipgloss.NewStyle().Foreground(colorSubtle).Render("  Tasks") +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("Remote Config")
	b.WriteString(breadcrumb + "\n\n")

	labelStyle := lipgloss.NewStyle().Bold(true).Foreground(colorMuted).Width(12)
	activeLabel := lipgloss.NewStyle().Bold(true).Foreground(colorAccent).Width(12)
	inputStyle := lipgloss.NewStyle().Foreground(colorText)
	cursor := lipgloss.NewStyle().Foreground(colorText).Render("█")

	// Tunnel field
	tLabel := labelStyle
	if m.configCursor == 0 {
		tLabel = activeLabel
	}
	tIndicator := "  "
	if m.configCursor == 0 {
		tIndicator = lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("▸ ")
	}
	tVal := inputStyle.Render(m.tunnelInput)
	if m.configCursor == 0 {
		tVal += cursor
	}
	if m.tunnelInput == "" && m.configCursor != 0 {
		tVal = lipgloss.NewStyle().Foreground(colorSubtle).Italic(true).Render("(empty = no tunnel)")
	}
	b.WriteString(tIndicator + tLabel.Render("Tunnel") + " " + tVal + "\n")

	// Port field
	pLabel := labelStyle
	if m.configCursor == 1 {
		pLabel = activeLabel
	}
	pIndicator := "  "
	if m.configCursor == 1 {
		pIndicator = lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("▸ ")
	}
	pVal := inputStyle.Render(m.portInput)
	if m.configCursor == 1 {
		pVal += cursor
	}
	b.WriteString(pIndicator + pLabel.Render("Port") + " " + pVal + "\n")

	// Info
	b.WriteString("\n")
	b.WriteString(lipgloss.NewStyle().Foreground(colorSubtle).Render("  Backend: claude  ·  Difficulty: hard") + "\n")

	// Loading state
	if m.remoteStarting {
		spinner := spinnerFrames[m.spinnerIndex%len(spinnerFrames)]
		b.WriteString("\n")
		b.WriteString(lipgloss.NewStyle().Foreground(colorAccent).Render("  "+spinner+" Starting remote...") + "\n")
	}

	// Error
	if m.remoteErr != nil {
		b.WriteString("\n")
		b.WriteString(lipgloss.NewStyle().Foreground(colorDanger).Render(fmt.Sprintf("  ✗ %v", m.remoteErr)) + "\n")
	}

	// Footer
	b.WriteString("\n")
	dot := lipgloss.NewStyle().Foreground(colorDim).Render("  ·  ")
	line := "  " + footerKey("tab/↑↓", "switch field") + dot + footerKey("enter", "start remote") + dot + footerKey("esc", "cancel")
	b.WriteString(lipgloss.NewStyle().MarginTop(1).Render(line))

	return b.String()
}

// detailMaxScroll returns the maximum scroll offset for the detail description.
func (m DashboardModel) detailMaxScroll() int {
	t := m.selectedTask
	if t == nil || t.Description == "" {
		return 0
	}

	fieldCount := 9 // ID, Title, Status, Backend, Difficulty, Review, Runner, Created, Updated
	if t.IRCName != "" {
		fieldCount++
	}
	if t.MasterIRCName != "" {
		fieldCount++
	}
	if t.ShellPID > 0 {
		fieldCount++
	}
	if t.Note != "" {
		fieldCount++
	}
	if len(t.DependsOn) > 0 {
		fieldCount++
	}
	if t.CWD != "" {
		fieldCount++
	}
	if t.AssignedAt != nil {
		fieldCount++
	}
	if t.CompletedAt != nil {
		fieldCount++
	}

	// header(2) + breadcrumb(2) + fields + desc header(2) + footer(3) + padding(2)
	overhead := 2 + 2 + fieldCount + 2 + 3 + 2
	maxDescLines := m.height - overhead
	if maxDescLines < 3 {
		maxDescLines = 3
	}

	descLines := strings.Split(t.Description, "\n")
	maxScroll := len(descLines) - maxDescLines
	if maxScroll < 0 {
		maxScroll = 0
	}
	return maxScroll
}

// ── Helpers ────────────────────────────────────────────────────────

// padRight pads a (possibly styled) string to the given visual width.
func padRight(s string, width int) string {
	w := lipgloss.Width(s)
	if w >= width {
		return s
	}
	return s + strings.Repeat(" ", width-w)
}

func styledSep() string {
	return lipgloss.NewStyle().Foreground(colorDim).Render(" │ ")
}

// ── View ───────────────────────────────────────────────────────────

func (m DashboardModel) View() string {
	var b strings.Builder
	w := min(m.width, 120)
	if m.view == viewList && len(m.tasks) > 0 {
		w = max(w, tableContentWidth()+1)
	}

	// ── Header ────────────────────────────────────────────
	b.WriteString(m.renderHeader(w))

	// ── Error ─────────────────────────────────────────────
	if m.err != nil {
		errLabel := lipgloss.NewStyle().Foreground(colorDanger).Bold(true).Render("  ✗ Error:")
		errMsg := lipgloss.NewStyle().Foreground(colorDanger).Render(fmt.Sprintf(" %v", m.err))
		b.WriteString(errLabel + errMsg + "\n")
	}

	// ── View-specific content ─────────────────────────────
	switch m.view {
	case viewList:
		b.WriteString(m.renderListView(w))
	case viewDetail:
		b.WriteString(m.renderDetailView(w))
	case viewTmux:
		b.WriteString(m.renderTmuxView(w))
	case viewIRC:
		b.WriteString(m.renderIRCView(w))
	case viewIRCMsg:
		b.WriteString(m.renderIRCMsgView(w))
	case viewRemoteConfig:
		b.WriteString(m.renderRemoteConfigView(w))
	case viewRemoteStatus:
		b.WriteString(m.renderRemoteStatusView(w))
	}

	return b.String()
}

func (m DashboardModel) renderHeader(w int) string {
	var b strings.Builder

	spinner := lipgloss.NewStyle().Foreground(colorSecondary).Render(spinnerFrames[m.spinnerIndex])

	badge := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("#FFFFFF")).
		Background(colorPrimary).
		Padding(0, 1).
		Render("WHIP")
	subtitle := lipgloss.NewStyle().Foreground(colorAccent).Render("Task Orchestrator")
	left := badge + " " + subtitle

	var rightParts []string
	if m.version != "" {
		rightParts = append(rightParts, lipgloss.NewStyle().Foreground(colorSubtle).Render(m.version))
	}
	rightParts = append(rightParts, spinner, lipgloss.NewStyle().Foreground(colorMuted).Render(time.Now().Format("15:04:05")))
	right := strings.Join(rightParts, "  ")

	leftW := lipgloss.Width(left)
	rightW := lipgloss.Width(right)
	gap := w - leftW - rightW - 2
	if gap < 2 {
		gap = 2
	}
	b.WriteString(" " + left + strings.Repeat(" ", gap) + right)
	b.WriteString("\n")

	// Accent separator
	b.WriteString(" " + lipgloss.NewStyle().Foreground(colorPrimary).Render(strings.Repeat("━", w-2)))
	b.WriteString("\n")

	return b.String()
}

func (m DashboardModel) renderListView(w int) string {
	var b strings.Builder

	if len(m.tasks) == 0 {
		b.WriteString("\n")
		b.WriteString(lipgloss.NewStyle().
			Foreground(colorSubtle).
			Italic(true).
			Render("  No tasks yet — create one with: whip create \"title\" --desc \"description\""))
		b.WriteString("\n")
	} else {
		b.WriteString(m.renderTable())
		b.WriteString("\n")
		b.WriteString(" " + lipgloss.NewStyle().Foreground(colorPrimary).Render(strings.Repeat("━", w-2)))
		b.WriteString("\n")
		b.WriteString(m.renderSummary())
	}

	// IRC
	b.WriteString("\n")
	b.WriteString(m.renderPeers())

	// Serve status
	b.WriteString("\n")
	b.WriteString(m.renderServeStatus())

	// Footer
	b.WriteString("\n")
	b.WriteString(m.renderListFooter())

	return b.String()
}

func (m DashboardModel) renderDetailView(w int) string {
	var b strings.Builder
	t := m.selectedTask
	if t == nil {
		return ""
	}

	labelStyle := lipgloss.NewStyle().Bold(true).Foreground(colorMuted).Width(14)
	valStyle := lipgloss.NewStyle().Foreground(colorText)
	dimStyle := lipgloss.NewStyle().Foreground(colorDim)

	// Breadcrumb
	breadcrumb := lipgloss.NewStyle().Foreground(colorSubtle).Render("  Tasks") +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render(t.Title)
	b.WriteString(breadcrumb + "\n\n")

	// Fields
	diffDisplay := t.Difficulty
	if diffDisplay == "" {
		diffDisplay = "default"
	}

	fields := []struct{ label, value string }{
		{"ID", idStyle.Render(t.ID)},
		{"Title", valStyle.Render(t.Title)},
		{"Status", renderStatus(t.Status)},
		{"Backend", renderBackend(t.Backend)},
		{"Difficulty", valStyle.Render(diffDisplay)},
		{"Review", valStyle.Render(fmt.Sprintf("%v", t.Review))},
		{"Runner", renderRunner(t.Runner)},
	}

	if t.IRCName != "" {
		fields = append(fields, struct{ label, value string }{"IRC", valStyle.Render(t.IRCName)})
	}
	if t.MasterIRCName != "" {
		fields = append(fields, struct{ label, value string }{"Master IRC", valStyle.Render(t.MasterIRCName)})
	}
	if t.ShellPID > 0 {
		fields = append(fields, struct{ label, value string }{"Shell PID", renderPID(t)})
	}
	if t.Note != "" {
		fields = append(fields, struct{ label, value string }{"Note", lipgloss.NewStyle().Foreground(colorMuted).Render(t.Note)})
	}
	if len(t.DependsOn) > 0 {
		fields = append(fields, struct{ label, value string }{"Depends on", lipgloss.NewStyle().Foreground(colorWarning).Render(strings.Join(t.DependsOn, ", "))})
	}
	if t.CWD != "" {
		fields = append(fields, struct{ label, value string }{"CWD", lipgloss.NewStyle().Foreground(colorSubtle).Render(t.CWD)})
	}

	fields = append(fields, struct{ label, value string }{"Created", lipgloss.NewStyle().Foreground(colorSubtle).Render(t.CreatedAt.Format(time.RFC3339))})
	fields = append(fields, struct{ label, value string }{"Updated", lipgloss.NewStyle().Foreground(colorSubtle).Render(t.UpdatedAt.Format(time.RFC3339))})
	if t.AssignedAt != nil {
		fields = append(fields, struct{ label, value string }{"Assigned", lipgloss.NewStyle().Foreground(colorSubtle).Render(t.AssignedAt.Format(time.RFC3339))})
	}
	if t.CompletedAt != nil {
		fields = append(fields, struct{ label, value string }{"Completed", lipgloss.NewStyle().Foreground(colorSubtle).Render(t.CompletedAt.Format(time.RFC3339))})
	}

	for _, f := range fields {
		b.WriteString("  " + labelStyle.Render(f.label) + " " + f.value + "\n")
	}

	// Description
	if t.Description != "" {
		b.WriteString("\n")
		descLabel := "Description"
		descLines := strings.Split(t.Description, "\n")

		// Calculate available lines for description
		overhead := 2 + 2 + len(fields) + 2 + 3 + 2
		maxDescLines := m.height - overhead
		if maxDescLines < 3 {
			maxDescLines = 3
		}

		totalDesc := len(descLines)

		// Clamp scroll for viewport changes (e.g. window resize)
		maxScroll := totalDesc - maxDescLines
		if maxScroll < 0 {
			maxScroll = 0
		}
		if m.detailScroll > maxScroll {
			m.detailScroll = maxScroll
		}

		// Scroll indicator
		if totalDesc > maxDescLines {
			scrollInfo := lipgloss.NewStyle().Foreground(colorSubtle).Render(
				fmt.Sprintf(" (%d-%d/%d ↑↓)", m.detailScroll+1, min(m.detailScroll+maxDescLines, totalDesc), totalDesc))
			descLabel += scrollInfo
		}

		b.WriteString("  " + lipgloss.NewStyle().Bold(true).Foreground(colorAccent).Render("Description") + descLabel[len("Description"):] + "\n")
		b.WriteString("  " + dimStyle.Render(strings.Repeat("─", w-4)) + "\n")

		// Apply scroll window
		end := m.detailScroll + maxDescLines
		if end > totalDesc {
			end = totalDesc
		}
		visible := descLines[m.detailScroll:end]
		for _, line := range visible {
			b.WriteString("  " + lipgloss.NewStyle().Foreground(colorMuted).Render(line) + "\n")
		}
	}

	// Footer
	b.WriteString("\n")
	b.WriteString(m.renderDetailFooter())

	return b.String()
}

func (m DashboardModel) renderTmuxView(w int) string {
	var b strings.Builder
	t := m.selectedTask
	if t == nil {
		return ""
	}

	// Breadcrumb
	breadcrumb := lipgloss.NewStyle().Foreground(colorSubtle).Render("  Tasks") +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorSubtle).Render(t.Title) +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorSecondary).Bold(true).Render("tmux")
	b.WriteString(breadcrumb + "\n")

	// Tmux pane content in a bordered box
	content := m.tmuxContent
	if content == "" {
		content = lipgloss.NewStyle().Foreground(colorSubtle).Italic(true).Render("(no output)")
	}

	// Limit height to fit terminal
	lines := strings.Split(strings.TrimRight(content, "\n"), "\n")
	maxLines := m.height - 8 // header + breadcrumb + footer margin
	if maxLines < 5 {
		maxLines = 5
	}
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorSecondary).
		Padding(0, 1).
		MarginLeft(2).
		Width(w - 6).
		Render(strings.Join(lines, "\n"))
	b.WriteString(box + "\n")

	// Footer
	b.WriteString("\n")
	b.WriteString(m.renderTmuxFooter())

	return b.String()
}

func (m DashboardModel) renderIRCView(w int) string {
	var b strings.Builder
	peers := m.ircPeers()

	// Breadcrumb
	breadcrumb := lipgloss.NewStyle().Foreground(colorSubtle).Render("  Tasks") +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("IRC")
	b.WriteString(breadcrumb + "\n\n")

	if len(peers) == 0 {
		b.WriteString(lipgloss.NewStyle().Foreground(colorSubtle).Italic(true).Render("  No peers available") + "\n")
	} else {
		for i, p := range peers {
			selected := i == m.ircCursor
			indicator := "  "
			if selected {
				indicator = lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("▸ ")
			}

			var dot, name string
			if p.Online {
				dot = lipgloss.NewStyle().Foreground(colorSuccess).Render("●")
				name = lipgloss.NewStyle().Foreground(colorText).Render(p.Name)
			} else {
				dot = lipgloss.NewStyle().Foreground(colorDim).Render("○")
				name = lipgloss.NewStyle().Foreground(colorSubtle).Render(p.Name)
			}

			row := indicator + dot + " " + name
			if selected {
				row = lipgloss.NewStyle().Background(lipgloss.Color("#1E1B4B")).Render(row)
			}
			b.WriteString(row + "\n")
		}
	}

	// Footer
	b.WriteString("\n")
	b.WriteString(m.renderIRCFooter())

	return b.String()
}

func (m DashboardModel) renderIRCMsgView(w int) string {
	var b strings.Builder

	// Breadcrumb
	breadcrumb := lipgloss.NewStyle().Foreground(colorSubtle).Render("  Tasks") +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorSubtle).Render("IRC") +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render(m.ircTarget)
	b.WriteString(breadcrumb + "\n\n")

	// Send feedback
	if !m.ircLastSendAt.IsZero() {
		if m.ircLastSendErr != nil {
			errMsg := lipgloss.NewStyle().Foreground(colorDanger).Render(fmt.Sprintf("  ✗ %v", m.ircLastSendErr))
			b.WriteString(errMsg + "\n")
		} else if time.Since(m.ircLastSendAt) < 3*time.Second {
			okMsg := lipgloss.NewStyle().Foreground(colorSuccess).Render(fmt.Sprintf("  ✓ sent to %s", m.ircTarget))
			b.WriteString(okMsg + "\n")
		}
	}

	// Input prompt
	prompt := lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("  > ")
	cursor := lipgloss.NewStyle().Foreground(colorText).Render("█")
	input := lipgloss.NewStyle().Foreground(colorText).Render(m.ircInput)
	b.WriteString(prompt + input + cursor + "\n")

	// Footer
	b.WriteString("\n")
	b.WriteString(m.renderIRCMsgFooter())

	return b.String()
}

func (m DashboardModel) renderIRCFooter() string {
	dot := lipgloss.NewStyle().Foreground(colorDim).Render("  ·  ")
	line := "  " + footerKey("←/esc", "back") + dot + footerKey("↑↓", "navigate") + dot + footerKey("enter", "message")
	return lipgloss.NewStyle().MarginTop(1).Render(line)
}

func (m DashboardModel) renderIRCMsgFooter() string {
	dot := lipgloss.NewStyle().Foreground(colorDim).Render("  ·  ")
	line := "  " + footerKey("esc", "back") + dot + footerKey("enter", "send")
	return lipgloss.NewStyle().MarginTop(1).Render(line)
}

func (m DashboardModel) renderTable() string {
	colID := 5
	colTitle := 24
	colStatus := 13
	colBackend := 7
	colRunner := 6
	colPID := 8
	colIRC := 10
	colDeps := 12
	colNote := 16
	colUpdated := 8

	sep := styledSep()

	// Header labels
	hdrStyle := lipgloss.NewStyle().Bold(true).Foreground(colorMuted)
	hdrCells := []string{
		padRight(hdrStyle.Render("ID"), colID),
		padRight(hdrStyle.Render("TITLE"), colTitle),
		padRight(hdrStyle.Render("STATUS"), colStatus),
		padRight(hdrStyle.Render("BACKEND"), colBackend),
		padRight(hdrStyle.Render("RUNNER"), colRunner),
		padRight(hdrStyle.Render("PID"), colPID),
		padRight(hdrStyle.Render("IRC"), colIRC),
		padRight(hdrStyle.Render("DEPS"), colDeps),
		padRight(hdrStyle.Render("NOTE"), colNote),
		padRight(hdrStyle.Render("UPDATED"), colUpdated),
	}
	header := "  " + strings.Join(hdrCells, sep)

	// Header underline
	underline := "  " + lipgloss.NewStyle().Foreground(colorDim).Render(strings.Repeat("─", lipgloss.Width(header)-2))

	var rows []string
	rows = append(rows, header)
	rows = append(rows, underline)

	for i, t := range m.tasks {
		selected := i == m.cursor
		indicator := "  "
		if selected {
			indicator = lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("▸ ")
		}

		id := padRight(idStyle.Render(truncate(t.ID, colID)), colID)
		title := padRight(truncate(t.Title, colTitle), colTitle)
		status := padRight(renderStatus(t.Status), colStatus)
		backend := padRight(renderBackend(t.Backend), colBackend)
		runner := padRight(renderRunner(t.Runner), colRunner)

		pid := padRight(renderPID(t), colPID)

		ircName := truncate(t.IRCName, colIRC)
		if ircName == "" {
			ircName = lipgloss.NewStyle().Foreground(colorDim).Render("—")
		}
		irc := padRight(ircName, colIRC)

		deps := padRight(renderDeps(t.DependsOn), colDeps)

		noteStr := truncate(t.Note, colNote)
		if noteStr == "" {
			noteStr = lipgloss.NewStyle().Foreground(colorDim).Render("—")
		} else {
			noteStr = lipgloss.NewStyle().Foreground(colorMuted).Render(noteStr)
		}
		note := padRight(noteStr, colNote)

		updated := padRight(lipgloss.NewStyle().Foreground(colorSubtle).Render(timeAgo(t.UpdatedAt)), colUpdated)

		row := indicator + strings.Join([]string{id, title, status, backend, runner, pid, irc, deps, note, updated}, sep)
		if selected {
			row = lipgloss.NewStyle().Background(lipgloss.Color("#1E1B4B")).Render(row)
		}
		rows = append(rows, row)
	}

	return strings.Join(rows, "\n")
}

func (m DashboardModel) renderSummary() string {
	counts := map[TaskStatus]int{}
	for _, t := range m.tasks {
		counts[t.Status]++
	}

	dot := lipgloss.NewStyle().Foreground(colorDim).Render(" │ ")
	total := len(m.tasks)

	parts := []string{
		lipgloss.NewStyle().Bold(true).Foreground(colorText).Render(fmt.Sprintf("%d total", total)),
	}
	if n := counts[StatusCreated]; n > 0 {
		parts = append(parts, statusCreated.Render(fmt.Sprintf("● %d created", n)))
	}
	if n := counts[StatusAssigned]; n > 0 {
		parts = append(parts, statusAssigned.Render(fmt.Sprintf("◐ %d assigned", n)))
	}
	if n := counts[StatusInProgress]; n > 0 {
		parts = append(parts, statusInProgress.Render(fmt.Sprintf("▶ %d in_progress", n)))
	}
	if n := counts[StatusReview]; n > 0 {
		parts = append(parts, statusReview.Render(fmt.Sprintf("◎ %d review", n)))
	}
	if n := counts[StatusCompleted]; n > 0 {
		parts = append(parts, statusCompleted.Render(fmt.Sprintf("✓ %d completed", n)))
	}
	if n := counts[StatusFailed]; n > 0 {
		parts = append(parts, statusFailed.Render(fmt.Sprintf("✗ %d failed", n)))
	}

	content := strings.Join(parts, dot)
	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorDim).
		Padding(0, 2).
		MarginLeft(2).
		Render(content)

	return box
}

func (m DashboardModel) renderPeers() string {
	label := lipgloss.NewStyle().Bold(true).Foreground(colorAccent).Render("IRC")

	var content string
	if m.peers == nil {
		content = lipgloss.NewStyle().Foreground(colorSubtle).Render("not connected")
	} else if len(m.peers) == 0 {
		content = lipgloss.NewStyle().Foreground(colorSubtle).Render("no peers online")
	} else {
		var parts []string
		for _, p := range m.ircPeers() {
			if p.Online {
				dot := lipgloss.NewStyle().Foreground(colorSuccess).Render("●")
				name := lipgloss.NewStyle().Foreground(colorText).Render(p.Name)
				parts = append(parts, dot+" "+name)
			} else {
				dot := lipgloss.NewStyle().Foreground(colorDim).Render("○")
				name := lipgloss.NewStyle().Foreground(colorSubtle).Render(p.Name)
				parts = append(parts, dot+" "+name)
			}
		}
		content = strings.Join(parts, lipgloss.NewStyle().Foreground(colorDim).Render("   "))
	}

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorDim).
		Padding(0, 2).
		MarginLeft(2).
		Render(label + "  " + content)

	return box
}

func (m DashboardModel) renderServeStatus() string {
	if m.serveProcess == nil {
		// Hint
		hint := lipgloss.NewStyle().Foreground(colorSubtle).Render("[R] remote")
		return lipgloss.NewStyle().MarginLeft(3).Render(hint)
	}

	label := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#FFFFFF")).
		Background(colorSuccess).Padding(0, 1).Render("SERVE")

	url := lipgloss.NewStyle().Foreground(colorText).Render(m.serveURL)

	var masterDot string
	if m.masterAlive {
		masterDot = lipgloss.NewStyle().Foreground(colorSuccess).Render("●") + " " +
			lipgloss.NewStyle().Foreground(colorText).Render("master")
	} else {
		masterDot = lipgloss.NewStyle().Foreground(colorDanger).Render("✗") + " " +
			lipgloss.NewStyle().Foreground(colorSubtle).Render("master")
	}

	sep := lipgloss.NewStyle().Foreground(colorDim).Render("  │  ")
	content := label + "  " + url + sep + masterDot

	box := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colorSuccess).
		Padding(0, 2).
		MarginLeft(2).
		Render(content)

	return box
}

func footerKey(k, desc string) string {
	return lipgloss.NewStyle().Bold(true).Foreground(colorText).Render(k) +
		" " +
		lipgloss.NewStyle().Foreground(colorSubtle).Render(desc)
}

func (m DashboardModel) renderListFooter() string {
	dot := lipgloss.NewStyle().Foreground(colorDim).Render("  ·  ")
	refresh := lipgloss.NewStyle().Foreground(colorDim).Render("↻ 2s")

	var remoteHint string
	if m.serveProcess != nil {
		remoteHint = footerKey("R", "remote status")
	} else {
		remoteHint = footerKey("R", "remote")
	}

	line := "  " + footerKey("↑↓", "navigate") + dot + footerKey("enter", "detail") + dot + footerKey("i", "irc") + dot + remoteHint + dot + footerKey("q", "quit") + dot + footerKey("c", "clean") + dot + refresh

	return lipgloss.NewStyle().MarginTop(1).Render(line)
}

func (m DashboardModel) renderDetailFooter() string {
	dot := lipgloss.NewStyle().Foreground(colorDim).Render("  ·  ")

	line := "  " + footerKey("←/esc", "back") + dot + footerKey("↑↓", "scroll")

	if m.selectedTask != nil && m.selectedTask.Runner == "tmux" && IsTmuxSession(m.selectedTask.ID) {
		line += dot + footerKey("a", "attach tmux")
	}
	if m.selectedTask != nil && m.selectedTask.Status == StatusReview {
		line += dot + footerKey("A", "approve")
	}
	if m.selectedTask != nil && m.selectedTask.Status == StatusFailed {
		line += dot + footerKey("r", "retry")
	}
	if m.selectedTask != nil && m.selectedTask.Status != StatusCompleted && m.selectedTask.SessionID != "" && m.selectedTask.ShellPID > 0 && !IsProcessAlive(m.selectedTask.ShellPID) {
		line += dot + footerKey("s", "resume")
	}

	return lipgloss.NewStyle().MarginTop(1).Render(line)
}

func (m DashboardModel) renderTmuxFooter() string {
	dot := lipgloss.NewStyle().Foreground(colorDim).Render("  ·  ")
	refresh := lipgloss.NewStyle().Foreground(colorDim).Render("↻ 2s auto-refreshing")

	detachHint := lipgloss.NewStyle().Foreground(colorSubtle).Render("(ctrl+b d to return)")
	line := "  " + footerKey("←/esc", "back") + dot + footerKey("enter", "attach") + " " + detachHint + dot + refresh

	return lipgloss.NewStyle().MarginTop(1).Render(line)
}

// ── Status / cell renderers ────────────────────────────────────────

func renderStatus(s TaskStatus) string {
	switch s {
	case StatusCreated:
		return statusCreated.Render("○ created")
	case StatusAssigned:
		return statusAssigned.Render("◐ assigned")
	case StatusInProgress:
		return statusInProgress.Render("▶ in_progress")
	case StatusReview:
		return statusReview.Render("◎ review")
	case StatusCompleted:
		return statusCompleted.Render("✓ completed")
	case StatusFailed:
		return statusFailed.Render("✗ failed")
	default:
		return string(s)
	}
}

func renderBackend(backend string) string {
	switch backend {
	case "claude":
		return lipgloss.NewStyle().Foreground(colorAccent).Render("claude")
	case "codex":
		return lipgloss.NewStyle().Foreground(colorSuccess).Render("codex")
	default:
		return lipgloss.NewStyle().Foreground(colorDim).Render("—")
	}
}

func renderRunner(runner string) string {
	switch runner {
	case "tmux":
		return lipgloss.NewStyle().Foreground(colorSecondary).Render("tmux")
	case "terminal":
		return lipgloss.NewStyle().Foreground(colorWarning).Render("term")
	default:
		return lipgloss.NewStyle().Foreground(colorDim).Render("—")
	}
}

func renderPID(t *Task) string {
	if t == nil || t.ShellPID <= 0 {
		return lipgloss.NewStyle().Foreground(colorDim).Render("—")
	}
	switch TaskProcessState(t) {
	case ProcessStateAlive:
		return pidAliveStyle.Render(fmt.Sprintf("● %d", t.ShellPID))
	case ProcessStateExited:
		return pidExitedStyle.Render(fmt.Sprintf("- %d", t.ShellPID))
	default:
		return pidDeadStyle.Render(fmt.Sprintf("✗ %d", t.ShellPID))
	}
}

func renderDeps(deps []string) string {
	if len(deps) == 0 {
		return lipgloss.NewStyle().Foreground(colorDim).Render("—")
	}
	short := make([]string, len(deps))
	for i, d := range deps {
		if len(d) > 5 {
			short[i] = d[:5]
		} else {
			short[i] = d
		}
	}
	return lipgloss.NewStyle().Foreground(colorWarning).Render(strings.Join(short, ","))
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	if max <= 3 {
		return s[:max]
	}
	return s[:max-2] + ".."
}

func timeAgo(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func connectURLToken(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	if t := u.Query().Get("token"); t != "" {
		return t
	}
	fragment, err := url.ParseQuery(u.Fragment)
	if err != nil {
		return ""
	}
	return fragment.Get("token")
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// tableContentWidth returns the visual width of a table row.
// Must stay in sync with column widths in renderTable().
func tableContentWidth() int {
	cols := []int{5, 24, 13, 7, 6, 8, 10, 12, 16, 8}
	total := 2 // indent ("  " or "▸ ")
	for i, c := range cols {
		total += c
		if i < len(cols)-1 {
			total += 3 // sep " │ " visual width
		}
	}
	return total
}

// renderQR generates a QR code using ANSI background colors (full-block mode).
func renderQR(text string) string {
	var buf bytes.Buffer
	qrterminal.Generate(text, qrterminal.L, &buf)
	return strings.TrimRight(buf.String(), "\n")
}
