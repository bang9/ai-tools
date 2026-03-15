package whip

import (
	"os"
	"os/exec"
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

func (m *DashboardModel) resetTaskListState() {
	m.tasks = nil
	m.archiveableTasks = map[string]bool{}
	m.cursor = 0
	m.expandedWorkspace = ""
	m.selectedTask = nil
	m.detailScroll = 0
	m.view = viewList
}

func (m DashboardModel) toggleListMode() (DashboardModel, tea.Cmd) {
	if m.listMode == listModeArchived {
		m.listMode = listModeActive
	} else {
		m.listMode = listModeArchived
	}
	m.resetTaskListState()
	return m, m.loadTasks()
}

func (m DashboardModel) canArchiveSelectedTask() bool {
	if m.listMode != listModeActive || m.selectedTask == nil {
		return false
	}
	return m.archiveableTasks[m.selectedTask.ID]
}

func (m DashboardModel) canDeleteSelectedTask() bool {
	return m.canDeleteTask(m.selectedTask)
}

func (m DashboardModel) canDeleteTask(task *Task) bool {
	if m.listMode != listModeArchived || task == nil {
		return false
	}
	workspace := task.WorkspaceName()
	if workspace == GlobalWorkspaceName {
		return true
	}
	loadedWorkspace, err := m.store.LoadWorkspace(workspace)
	if err != nil {
		return strings.Contains(err.Error(), "not found")
	}
	return loadedWorkspace.IsArchived()
}

func (m DashboardModel) updateList(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "tab":
		return m.toggleListMode()
	case "c":
		if m.listMode == listModeActive {
			return m, m.cleanTasks()
		}
	case "d":
		if selected := m.currentListTask(); m.listMode == listModeArchived && m.canDeleteTask(selected) {
			m.selectedTask = selected
			return m, m.deleteSelectedArchivedTask()
		}
	case "up", "k":
		m.moveTaskCursor(-1)
	case "down", "j":
		m.moveTaskCursor(1)
	case "right", "l":
		if row, ok := m.taskRowAtCursor(); ok && row.kind == dashboardTaskRowLead && !row.isExpanded {
			m.setExpandedWorkspace(row.groupWorkspace)
		}
	case "left", "h":
		if m.focusLeadForSelectedWorker() {
			return m, nil
		}
		m.collapseSelectedLeadRow()
	case "enter":
		if selected := m.currentListTask(); selected != nil {
			m.selectedTask = selected
			m.detailScroll = 0
			m.view = viewDetail
		}
	case "i":
		if m.listMode == listModeActive {
			rows := m.ircRows()
			if name := firstPeerName(rows); name != "" {
				m.ircSelectedPeer = name
				m.view = viewIRC
			}
		}
	case "R":
		if m.serveProcess != nil {
			m.view = viewRemoteStatus
		} else {
			cfg, _ := m.store.LoadConfig()
			m.tunnelInput = cfg.Tunnel
			if cfg.RemotePort > 0 {
				m.portInput = strconv.Itoa(cfg.RemotePort)
			} else {
				m.portInput = "8585"
			}
			if m.remoteWorkspace == "" {
				m.remoteWorkspace = GlobalWorkspaceName
			}
			m.workspaceInput = m.remoteWorkspace
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
		if m.selectedTask != nil && m.detailScroll < m.detailMaxScroll() {
			m.detailScroll++
		}
	case "a":
		if m.canArchiveSelectedTask() {
			return m, m.archiveSelectedTask()
		}
	case "d":
		if m.canDeleteSelectedTask() {
			return m, m.deleteSelectedArchivedTask()
		}
	case "t":
		if m.selectedTask != nil && m.selectedTask.Runner == "tmux" && IsTmuxSession(m.selectedTask.ID) {
			m.view = viewTmux
			if content, err := CaptureTmuxPane(m.selectedTask.ID); err == nil {
				m.tmuxContent = content
			}
		}
	case "n":
		if m.selectedTask != nil && len(m.selectedTask.Notes) > 0 {
			m.noteHistoryScroll = 0
			m.view = viewNoteHistory
		}
	case "m":
		if m.selectedTask != nil && (m.selectedTask.IRCName != "" || m.store.HasMessages(m.selectedTask.ID)) {
			m.msgHistoryScroll = 0
			m.msgHistoryLines = loadTaskMessages(m.store, m.selectedTask)
			m.view = viewMsgHistory
		}
	case "r":
		if m.selectedTask != nil && m.selectedTask.SessionID != "" {
			backend := m.selectedTask.Backend
			if backend == "" {
				backend = "claude"
			}
			cmd := exec.Command("rewind", backend, m.selectedTask.SessionID)
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			_ = cmd.Start()
		}
	case "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
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

func (m DashboardModel) updateNoteHistory(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "backspace", "left":
		m.view = viewDetail
		m.noteHistoryScroll = 0
	case "up", "k":
		if m.noteHistoryScroll > 0 {
			m.noteHistoryScroll--
		}
	case "down", "j":
		m.noteHistoryScroll++
	case "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

func (m DashboardModel) updateMsgHistory(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc", "backspace", "left":
		m.view = viewDetail
		m.msgHistoryScroll = 0
		m.msgHistoryLines = nil
	case "up", "k":
		if m.msgHistoryScroll > 0 {
			m.msgHistoryScroll--
		}
	case "down", "j":
		m.msgHistoryScroll++
	case "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

func (m DashboardModel) detailMaxScroll() int {
	t := m.selectedTask
	if t == nil || t.Description == "" {
		return 0
	}

	w := min(m.width, 120)
	descContentWidth := w - 4

	fieldCount := 10
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

	overhead := 2 + 2 + fieldCount + 2 + 3 + 2
	maxDescLines := m.height - overhead
	if maxDescLines < 3 {
		maxDescLines = 3
	}

	// Count wrapped lines, not raw lines
	rawLines := strings.Split(t.Description, "\n")
	totalWrapped := 0
	for _, line := range rawLines {
		wrapped := wordWrap(line, descContentWidth)
		totalWrapped += len(strings.Split(wrapped, "\n"))
	}

	maxScroll := totalWrapped - maxDescLines
	if maxScroll < 0 {
		maxScroll = 0
	}
	return maxScroll
}
