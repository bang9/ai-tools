package whip

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

func (m DashboardModel) listModeTitle() string {
	if m.listMode == listModeArchived {
		return "Archived Tasks"
	}
	return "Active Tasks"
}

func (m DashboardModel) listModeLabel() string {
	if m.listMode == listModeArchived {
		return "archived"
	}
	return "active"
}

func (m DashboardModel) toggleModeLabel() string {
	if m.listMode == listModeArchived {
		return "active"
	}
	return "archived"
}

func (m DashboardModel) renderListView(w int) string {
	var b strings.Builder

	b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(colorAccent).Render("  " + m.listModeTitle()))
	b.WriteString("\n\n")

	b.WriteString(m.renderTable())
	b.WriteString("\n")

	if len(m.tasks) == 0 {
		empty := "  No tasks yet — create one with: whip task create \"title\" --desc \"description\""
		if m.listMode == listModeArchived {
			empty = "  No archived tasks."
		}
		b.WriteString(lipgloss.NewStyle().
			Foreground(colorSubtle).
			Italic(true).
			Render(empty))
		b.WriteString("\n")
	} else {
		b.WriteString(" " + lipgloss.NewStyle().Foreground(colorPrimary).Render(strings.Repeat("━", w-2)))
		b.WriteString("\n")
		b.WriteString(m.renderSummary())
	}

	b.WriteString("\n")
	b.WriteString(m.renderPeers())
	b.WriteString("\n")
	b.WriteString(m.renderServeStatus())
	b.WriteString("\n")
	b.WriteString(m.renderListFooter())

	return b.String()
}

type detailField struct {
	label string
	value string // raw text, no ANSI
	style lipgloss.Style
}

func (m DashboardModel) renderDetailView(w int) string {
	var b strings.Builder
	t := m.selectedTask
	if t == nil {
		return ""
	}

	const labelWidth = 14
	labelStyle := lipgloss.NewStyle().Bold(true).Foreground(colorMuted).Width(labelWidth)
	valStyle := lipgloss.NewStyle().Foreground(colorText)
	dimStyle := lipgloss.NewStyle().Foreground(colorDim)

	modeLabel := lipgloss.NewStyle().Foreground(colorAccent).Render(m.listModeTitle())
	if m.listMode == listModeArchived {
		modeLabel = lipgloss.NewStyle().Foreground(colorWarning).Render(m.listModeTitle())
	}
	breadcrumb := lipgloss.NewStyle().Foreground(colorSubtle).Render("  Tasks") +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		modeLabel +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render(t.Title)
	b.WriteString(breadcrumb + "\n\n")

	diffDisplay := t.Difficulty
	if diffDisplay == "" {
		diffDisplay = "default"
	}

	roleDisplay := t.Role
	if roleDisplay == "" {
		roleDisplay = "worker"
	}

	fields := []detailField{
		{"ID", t.ID, idStyle},
		{"Workspace", t.WorkspaceName(), valStyle},
		{"Title", t.Title, valStyle},
		{"Status", string(t.Status), valStyle},
		{"Backend", t.Backend, valStyle},
		{"Role", roleDisplay, valStyle},
		{"Difficulty", diffDisplay, valStyle},
		{"Review", fmt.Sprintf("%v", t.Review), valStyle},
		{"Runner", t.Runner, valStyle},
	}

	if t.IRCName != "" {
		fields = append(fields, detailField{"IRC", t.IRCName, valStyle})
	}
	if t.MasterIRCName != "" {
		fields = append(fields, detailField{"Master IRC", t.MasterIRCName, valStyle})
	}
	if t.ShellPID > 0 {
		fields = append(fields, detailField{"Shell PID", fmt.Sprintf("%d", t.ShellPID), valStyle})
	}
	if t.Note != "" {
		fields = append(fields, detailField{"Note", t.Note, lipgloss.NewStyle().Foreground(colorMuted)})
	}
	if len(t.DependsOn) > 0 {
		fields = append(fields, detailField{"Depends on", strings.Join(t.DependsOn, ", "), lipgloss.NewStyle().Foreground(colorWarning)})
	}
	if t.CWD != "" {
		fields = append(fields, detailField{"CWD", t.CWD, lipgloss.NewStyle().Foreground(colorSubtle)})
	}

	fields = append(fields, detailField{"Created", t.CreatedAt.Format(time.RFC3339), lipgloss.NewStyle().Foreground(colorSubtle)})
	fields = append(fields, detailField{"Updated", t.UpdatedAt.Format(time.RFC3339), lipgloss.NewStyle().Foreground(colorSubtle)})
	if t.AssignedAt != nil {
		fields = append(fields, detailField{"Assigned", t.AssignedAt.Format(time.RFC3339), lipgloss.NewStyle().Foreground(colorSubtle)})
	}
	if t.CompletedAt != nil {
		label := "Completed"
		if t.Status == StatusCanceled {
			label = "Canceled"
		}
		fields = append(fields, detailField{label, t.CompletedAt.Format(time.RFC3339), lipgloss.NewStyle().Foreground(colorSubtle)})
	}

	// Special rendering for Backend, Runner, Shell PID which use custom render funcs
	contentWidth := w - 2 - labelWidth - 1 // 2 indent + 14 label + 1 space
	indent := "  " + strings.Repeat(" ", labelWidth+1)

	for _, f := range fields {
		var rendered string
		switch f.label {
		case "Backend":
			rendered = renderBackend(f.value)
		case "Runner":
			rendered = renderRunner(f.value)
		case "Shell PID":
			rendered = renderPID(t)
		default:
			rendered = wrapWithIndent(f.style.Render(f.value), contentWidth, indent)
		}
		b.WriteString("  " + labelStyle.Render(f.label) + " " + rendered + "\n")
	}

	if t.Description != "" {
		b.WriteString("\n")
		descLabel := "Description"
		descContentWidth := w - 4 // 2 indent each side

		// Word-wrap each raw description line, then flatten to get total visible lines
		rawLines := strings.Split(t.Description, "\n")
		var wrappedLines []string
		for _, line := range rawLines {
			wrapped := wordWrap(line, descContentWidth)
			for _, wl := range strings.Split(wrapped, "\n") {
				wrappedLines = append(wrappedLines, wl)
			}
		}

		overhead := 2 + 2 + len(fields) + 2 + 3 + 2
		maxDescLines := m.height - overhead
		if maxDescLines < 3 {
			maxDescLines = 3
		}

		totalDesc := len(wrappedLines)
		maxScroll := totalDesc - maxDescLines
		if maxScroll < 0 {
			maxScroll = 0
		}
		if m.detailScroll > maxScroll {
			m.detailScroll = maxScroll
		}

		if totalDesc > maxDescLines {
			scrollInfo := lipgloss.NewStyle().Foreground(colorSubtle).Render(
				fmt.Sprintf(" (%d-%d/%d ↑↓)", m.detailScroll+1, min(m.detailScroll+maxDescLines, totalDesc), totalDesc))
			descLabel += scrollInfo
		}

		b.WriteString("  " + lipgloss.NewStyle().Bold(true).Foreground(colorAccent).Render("Description") + descLabel[len("Description"):] + "\n")
		b.WriteString("  " + dimStyle.Render(strings.Repeat("─", w-4)) + "\n")

		end := m.detailScroll + maxDescLines
		if end > totalDesc {
			end = totalDesc
		}
		visible := wrappedLines[m.detailScroll:end]
		for _, line := range visible {
			b.WriteString("  " + lipgloss.NewStyle().Foreground(colorMuted).Render(line) + "\n")
		}
	}

	b.WriteString("\n")
	b.WriteString(m.renderDetailFooter())
	return b.String()
}

func (m DashboardModel) renderTable() string {
	colID := 8
	colTitle := 24
	colStatus := 10
	colWorkspace := 12
	colRole := 6
	colBackend := 7
	colIRC := 10
	colDeps := 14
	colNote := 14
	colUpdated := 8

	sep := styledSep()
	hdrStyle := lipgloss.NewStyle().Bold(true).Foreground(colorMuted)
	hdrCells := []string{
		padRight(hdrStyle.Render("ID"), colID),
		padRight(hdrStyle.Render("WORKSPACE"), colWorkspace),
		padRight(hdrStyle.Render("TITLE"), colTitle),
		padRight(hdrStyle.Render("STATUS"), colStatus),
		padRight(hdrStyle.Render("BACKEND"), colBackend),
		padRight(hdrStyle.Render("ROLE"), colRole),
		padRight(hdrStyle.Render("IRC"), colIRC),
		padRight(hdrStyle.Render("BLOCKED BY"), colDeps),
		padRight(hdrStyle.Render("NOTE"), colNote),
		padRight(hdrStyle.Render("UPDATED"), colUpdated),
	}
	header := "  " + strings.Join(hdrCells, sep)
	underline := "  " + lipgloss.NewStyle().Foreground(colorDim).Render(strings.Repeat("─", lipgloss.Width(header)-2))

	var rows []string
	rows = append(rows, header, underline)

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

		roleStr := t.Role
		if roleStr == "" {
			roleStr = lipgloss.NewStyle().Foreground(colorDim).Render("worker")
		} else {
			roleStr = lipgloss.NewStyle().Foreground(colorPrimary).Render(roleStr)
		}
		role := padRight(roleStr, colRole)

		ircName := truncate(t.IRCName, colIRC)
		if ircName == "" {
			ircName = lipgloss.NewStyle().Foreground(colorDim).Render("—")
		}
		irc := padRight(ircName, colIRC)

		deps := padRight(renderDeps(t.DependsOn, colDeps), colDeps)
		noteStr := truncate(t.Note, colNote)
		if noteStr == "" {
			noteStr = lipgloss.NewStyle().Foreground(colorDim).Render("—")
		} else {
			noteStr = lipgloss.NewStyle().Foreground(colorMuted).Render(noteStr)
		}
		note := padRight(noteStr, colNote)
		updated := padRight(lipgloss.NewStyle().Foreground(colorSubtle).Render(timeAgo(t.UpdatedAt)), colUpdated)

		workspace := padRight(truncate(t.WorkspaceName(), colWorkspace), colWorkspace)
		row := indicator + strings.Join([]string{id, workspace, title, status, backend, role, irc, deps, note, updated}, sep)
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
		lipgloss.NewStyle().Bold(true).Foreground(colorText).Render(fmt.Sprintf("%d %s", total, m.listModeLabel())),
	}
	if n := counts[StatusCreated]; n > 0 {
		parts = append(parts, renderStatusCount(StatusCreated, n))
	}
	if n := counts[StatusAssigned]; n > 0 {
		parts = append(parts, renderStatusCount(StatusAssigned, n))
	}
	if n := counts[StatusInProgress]; n > 0 {
		parts = append(parts, renderStatusCount(StatusInProgress, n))
	}
	if n := counts[StatusReview]; n > 0 {
		parts = append(parts, renderStatusCount(StatusReview, n))
	}
	if n := counts[StatusApproved]; n > 0 {
		parts = append(parts, renderStatusCount(StatusApproved, n))
	}
	if n := counts[StatusCompleted]; n > 0 {
		parts = append(parts, renderStatusCount(StatusCompleted, n))
	}
	if n := counts[StatusFailed]; n > 0 {
		parts = append(parts, renderStatusCount(StatusFailed, n))
	}
	if n := counts[StatusCanceled]; n > 0 {
		parts = append(parts, renderStatusCount(StatusCanceled, n))
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

func (m DashboardModel) renderListFooter() string {
	dot := lipgloss.NewStyle().Foreground(colorDim).Render("  ·  ")
	refresh := lipgloss.NewStyle().Foreground(colorDim).Render("↻ 2s")

	var remoteHint string
	if m.serveProcess != nil {
		remoteHint = footerKey("R", "remote status")
	} else {
		remoteHint = footerKey("R", "remote")
	}

	line := "  " + footerKey("↑↓", "navigate") + dot + footerKey("enter", "detail") + dot + footerKey("tab", m.toggleModeLabel()) + dot + footerKey("i", "irc") + dot + remoteHint + dot + footerKey("q", "quit")
	if m.listMode == listModeActive {
		line += dot + footerKey("c", "clean")
	} else if len(m.tasks) > 0 && m.cursor < len(m.tasks) && m.canDeleteTask(m.tasks[m.cursor]) {
		line += dot + footerKey("d", "delete")
	}
	line += dot + refresh
	return lipgloss.NewStyle().MarginTop(1).Render(line)
}

func (m DashboardModel) renderDetailFooter() string {
	dot := lipgloss.NewStyle().Foreground(colorDim).Render("  ·  ")
	line := "  " + footerKey("←/esc", "back") + dot + footerKey("↑↓", "scroll")

	if m.canArchiveSelectedTask() {
		line += dot + footerKey("a", "archive")
	}
	if m.selectedTask != nil && m.selectedTask.Runner == "tmux" && IsTmuxSession(m.selectedTask.ID) {
		line += dot + footerKey("t", "attach tmux")
	}
	if m.canDeleteSelectedTask() {
		line += dot + footerKey("d", "delete")
	}
	if m.selectedTask != nil && len(m.selectedTask.Notes) > 0 {
		line += dot + footerKey("n", "notes")
	}
	if m.selectedTask != nil && (m.selectedTask.IRCName != "" || m.store.HasMessages(m.selectedTask.ID)) {
		line += dot + footerKey("m", "messages")
	}
	if m.selectedTask != nil && m.selectedTask.SessionID != "" {
		line += dot + footerKey("r", "rewind")
	}

	return lipgloss.NewStyle().MarginTop(1).Render(line)
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

func renderDeps(deps []string, maxWidth int) string {
	if len(deps) == 0 {
		return lipgloss.NewStyle().Foreground(colorDim).Render("—")
	}
	const shortLen = 5
	short := make([]string, len(deps))
	for i, d := range deps {
		if len(d) > shortLen {
			short[i] = d[:shortLen]
		} else {
			short[i] = d
		}
	}

	result := short[0]
	shown := 1
	for i := 1; i < len(short); i++ {
		next := result + "," + short[i]
		remaining := len(short) - i - 1
		needed := len(next)
		if remaining > 0 {
			needed += len(fmt.Sprintf(" +%d", remaining))
		}
		if needed > maxWidth {
			break
		}
		result = next
		shown = i + 1
	}

	if shown < len(short) {
		result += fmt.Sprintf(" +%d", len(short)-shown)
	}

	if len(result) > maxWidth {
		result = truncate(result, maxWidth)
	}

	return lipgloss.NewStyle().Foreground(colorWarning).Render(result)
}
