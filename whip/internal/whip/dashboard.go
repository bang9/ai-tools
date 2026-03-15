package whip

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

var (
	colorPrimary   = lipgloss.Color("#8B5CF6")
	colorSecondary = lipgloss.Color("#818CF8")
	colorAccent    = lipgloss.Color("#A78BFA")
	colorSuccess   = lipgloss.Color("#34D399")
	colorWarning   = lipgloss.Color("#FBBF24")
	colorDanger    = lipgloss.Color("#F87171")
	colorText      = lipgloss.Color("#F3F4F6")
	colorMuted     = lipgloss.Color("#9CA3AF")
	colorSubtle    = lipgloss.Color("#6B7280")
	colorDim       = lipgloss.Color("#374151")

	colorReview   = lipgloss.Color("#F472B6")
	colorApproved = lipgloss.Color("#22C55E")
	colorCanceled = lipgloss.Color("#94A3B8")

	statusCreated    = lipgloss.NewStyle().Foreground(colorSubtle)
	statusAssigned   = lipgloss.NewStyle().Foreground(colorWarning)
	statusInProgress = lipgloss.NewStyle().Foreground(colorSecondary).Bold(true)
	statusReview     = lipgloss.NewStyle().Foreground(colorReview).Bold(true)
	statusApproved   = lipgloss.NewStyle().Foreground(colorApproved).Bold(true)
	statusCompleted  = lipgloss.NewStyle().Foreground(colorSuccess)
	statusFailed     = lipgloss.NewStyle().Foreground(colorDanger)
	statusCanceled   = lipgloss.NewStyle().Foreground(colorCanceled)

	idStyle        = lipgloss.NewStyle().Foreground(colorWarning)
	pidAliveStyle  = lipgloss.NewStyle().Foreground(colorSuccess)
	pidExitedStyle = lipgloss.NewStyle().Foreground(colorWarning)
	pidDeadStyle   = lipgloss.NewStyle().Foreground(colorDanger)

	spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
)

type tickMsg time.Time
type cleanedMsg int
type serveNoticeMsg string
type taskArchivedMsg struct{ err error }
type taskDeletedMsg struct{ err error }
type tasksLoadedMsg struct {
	tasks []*Task
	mode  taskListMode
}

type peerInfo struct {
	Name   string
	Online bool
}

type peersMsg []peerInfo

type viewState int
type taskListMode int

const (
	viewList viewState = iota
	viewDetail
	viewTmux
	viewIRC
	viewIRCMsg
	viewRemoteConfig
	viewRemoteStatus
	viewNoteHistory
	viewMsgHistory
)

const (
	listModeActive taskListMode = iota
	listModeArchived
)

type ircMessage struct {
	From      string    `json:"from"`
	Content   string    `json:"content"`
	Timestamp time.Time `json:"timestamp"`
}

type ircSendResultMsg struct{ err error }

type DashboardModel struct {
	store             *Store
	tasks             []*Task
	peers             []peerInfo
	version           string
	width             int
	height            int
	err               error
	spinnerIndex      int
	tickCount         int
	cursor            int
	view              viewState
	listMode          taskListMode
	expandedWorkspace string
	selectedTask      *Task
	detailScroll      int
	tmuxContent       string
	pendingAttach     string
	archiveableTasks  map[string]bool

	ircSelectedPeer string
	ircInput        string
	ircTarget       string
	ircLastSendErr error
	ircLastSendAt  time.Time

	serveProcess    *exec.Cmd
	serveURL        string
	shortURL        string
	webURL          string
	masterAlive     bool
	remoteStarting  bool
	remoteErr       error
	remoteWorkspace string
	serveNotices    []string

	noteHistoryScroll int
	msgHistoryScroll  int
	msgHistoryLines   []ircMessage

	programRef *programHolder

	tunnelInput    string
	portInput      string
	workspaceInput string
	configCursor   int
	cwd            string
}

type programHolder struct {
	p *tea.Program
}

func (m *DashboardModel) SetProgram(p *tea.Program) {
	m.programRef.p = p
}

func (m DashboardModel) PendingAttach() string {
	return m.pendingAttach
}

func (m DashboardModel) Cleanup() {
	if m.serveProcess == nil || m.serveProcess.Process == nil {
		return
	}
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
		store:            store,
		version:          version,
		width:            120,
		cwd:              cwd,
		remoteWorkspace:  GlobalWorkspaceName,
		programRef:       &programHolder{},
		archiveableTasks: map[string]bool{},
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
		case viewNoteHistory:
			return m.updateNoteHistory(msg)
		case viewMsgHistory:
			return m.updateMsgHistory(msg)
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height

	case tasksLoadedMsg:
		if msg.mode != m.listMode {
			return m, nil
		}
		m.tasks = msg.tasks
		m.err = nil
		if m.listMode == listModeActive {
			blockers := archiveDependencyBlockers(m.tasks)
			m.archiveableTasks = make(map[string]bool, len(m.tasks))
			for _, task := range m.tasks {
				archiveable, _ := taskArchiveability(task, blockers)
				if archiveable {
					m.archiveableTasks[task.ID] = true
				}
			}
		} else {
			m.archiveableTasks = map[string]bool{}
		}
		if m.expandedWorkspace != "" {
			keepExpanded := false
			for _, row := range buildDashboardTaskRows(m.tasks, m.expandedWorkspace) {
				if row.kind == dashboardTaskRowLead && row.groupWorkspace == m.expandedWorkspace && row.isExpanded {
					keepExpanded = true
					break
				}
			}
			if !keepExpanded {
				m.expandedWorkspace = ""
			}
		}
		m.clampCursorToRows()
		if m.selectedTask != nil {
			found := false
			for _, t := range m.tasks {
				if t.ID == m.selectedTask.ID {
					m.selectedTask = t
					found = true
					break
				}
			}
			if !found && m.view == viewDetail {
				m.selectedTask = nil
				m.detailScroll = 0
				m.view = viewList
			}
		}

	case peersMsg:
		m.peers = []peerInfo(msg)
		if m.view == viewIRC || m.view == viewIRCMsg || m.ircSelectedPeer != "" {
			rows := m.ircRows()
			if findPeerIndex(rows, m.ircSelectedPeer) < 0 {
				m.ircSelectedPeer = firstPeerName(rows)
			}
		}

	case ircSendResultMsg:
		m.ircLastSendErr = msg.err
		m.ircLastSendAt = time.Now()
		return m, nil

	case cleanedMsg:
		m.resetTaskListState()
		return m, m.loadTasks()

	case taskArchivedMsg:
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}
		m.resetTaskListState()
		return m, m.loadTasks()

	case taskDeletedMsg:
		if msg.err != nil {
			m.err = msg.err
			return m, nil
		}
		m.resetTaskListState()
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
		m.masterAlive = IsMasterSessionAlive(m.remoteWorkspace)
		m.view = viewRemoteStatus
		return m, m.loadTasks()

	case serveNoticeMsg:
		const maxNotices = 6
		m.serveNotices = append(m.serveNotices, string(msg))
		if len(m.serveNotices) > maxNotices {
			m.serveNotices = m.serveNotices[len(m.serveNotices)-maxNotices:]
		}
		return m, nil

	case remoteStoppedMsg:
		m.serveProcess = nil
		m.serveURL = ""
		m.shortURL = ""
		m.webURL = ""
		m.masterAlive = false
		m.serveNotices = nil
		m.view = viewList
		return m, nil

	case tickMsg:
		m.spinnerIndex = (m.spinnerIndex + 1) % len(spinnerFrames)
		m.tickCount++
		cmds := []tea.Cmd{m.loadTasks(), loadPeers(), tickCmd()}
		if m.view == viewTmux && m.selectedTask != nil {
			if content, err := CaptureTmuxPane(m.selectedTask.ID); err == nil {
				m.tmuxContent = content
			}
		}
		if m.view == viewMsgHistory && m.selectedTask != nil {
			if !m.selectedTask.Status.IsTerminal() {
				m.msgHistoryLines = loadTaskMessages(m.store, m.selectedTask)
			}
		}
		if m.serveProcess != nil {
			m.masterAlive = IsMasterSessionAlive(m.remoteWorkspace)
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
