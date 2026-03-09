package whip

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

func (m DashboardModel) renderListView(w int) string {
	var b strings.Builder

	if len(m.tasks) == 0 {
		b.WriteString("\n")
		b.WriteString(lipgloss.NewStyle().
			Foreground(colorSubtle).
			Italic(true).
			Render("  No tasks yet — create one with: whip task create \"title\" --desc \"description\""))
		b.WriteString("\n")
	} else {
		b.WriteString(m.renderTable())
		b.WriteString("\n")
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

func (m DashboardModel) renderDetailView(w int) string {
	var b strings.Builder
	t := m.selectedTask
	if t == nil {
		return ""
	}

	labelStyle := lipgloss.NewStyle().Bold(true).Foreground(colorMuted).Width(14)
	valStyle := lipgloss.NewStyle().Foreground(colorText)
	dimStyle := lipgloss.NewStyle().Foreground(colorDim)

	breadcrumb := lipgloss.NewStyle().Foreground(colorSubtle).Render("  Tasks") +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render(t.Title)
	b.WriteString(breadcrumb + "\n\n")

	diffDisplay := t.Difficulty
	if diffDisplay == "" {
		diffDisplay = "default"
	}

	fields := []struct{ label, value string }{
		{"ID", idStyle.Render(t.ID)},
		{"Workspace", valStyle.Render(t.WorkspaceName())},
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

	if t.Description != "" {
		b.WriteString("\n")
		descLabel := "Description"
		descLines := strings.Split(t.Description, "\n")

		overhead := 2 + 2 + len(fields) + 2 + 3 + 2
		maxDescLines := m.height - overhead
		if maxDescLines < 3 {
			maxDescLines = 3
		}

		totalDesc := len(descLines)
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
		visible := descLines[m.detailScroll:end]
		for _, line := range visible {
			b.WriteString("  " + lipgloss.NewStyle().Foreground(colorMuted).Render(line) + "\n")
		}
	}

	b.WriteString("\n")
	b.WriteString(m.renderDetailFooter())
	return b.String()
}

func (m DashboardModel) renderTable() string {
	colID := 5
	colTitle := 24
	colStatus := 10
	colWorkspace := 12
	colBackend := 7
	colRunner := 6
	colPID := 8
	colIRC := 10
	colDeps := 12
	colNote := 16
	colUpdated := 8

	sep := styledSep()
	hdrStyle := lipgloss.NewStyle().Bold(true).Foreground(colorMuted)
	hdrCells := []string{
		padRight(hdrStyle.Render("ID"), colID),
		padRight(hdrStyle.Render("WORKSPACE"), colWorkspace),
		padRight(hdrStyle.Render("TITLE"), colTitle),
		padRight(hdrStyle.Render("STATUS"), colStatus),
		padRight(hdrStyle.Render("BACKEND"), colBackend),
		padRight(hdrStyle.Render("RUNNER"), colRunner),
		padRight(hdrStyle.Render("PID"), colPID),
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

		workspace := padRight(truncate(t.WorkspaceName(), colWorkspace), colWorkspace)
		row := indicator + strings.Join([]string{id, workspace, title, status, backend, runner, pid, irc, deps, note, updated}, sep)
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
	if n := counts[StatusApprovedPendingFinalize]; n > 0 {
		parts = append(parts, renderStatusCount(StatusApprovedPendingFinalize, n))
	}
	if n := counts[StatusCompleted]; n > 0 {
		parts = append(parts, renderStatusCount(StatusCompleted, n))
	}
	if n := counts[StatusFailed]; n > 0 {
		parts = append(parts, renderStatusCount(StatusFailed, n))
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

	line := "  " + footerKey("↑↓", "navigate") + dot + footerKey("enter", "detail") + dot + footerKey("i", "irc") + dot + remoteHint + dot + footerKey("q", "quit") + dot + footerKey("c", "clean") + dot + refresh
	return lipgloss.NewStyle().MarginTop(1).Render(line)
}

func (m DashboardModel) renderDetailFooter() string {
	dot := lipgloss.NewStyle().Foreground(colorDim).Render("  ·  ")
	line := "  " + footerKey("←/esc", "back") + dot + footerKey("↑↓", "scroll")

	if m.selectedTask != nil && m.selectedTask.Runner == "tmux" && IsTmuxSession(m.selectedTask.ID) {
		line += dot + footerKey("a", "attach tmux")
	}
	if m.selectedTask != nil && m.selectedTask.Status == StatusFailed {
		line += dot + footerKey("r", "retry")
	}
	if m.selectedTask != nil && m.selectedTask.Status != StatusCompleted && m.selectedTask.SessionID != "" && m.selectedTask.ShellPID > 0 && !IsProcessAlive(m.selectedTask.ShellPID) {
		line += dot + footerKey("s", "resume")
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
