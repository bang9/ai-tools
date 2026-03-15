package whip

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

func (m DashboardModel) renderIRCView(w int) string {
	var b strings.Builder
	rows := m.ircRows()

	breadcrumb := lipgloss.NewStyle().Foreground(colorSubtle).Render("  Tasks") +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("IRC")
	b.WriteString(breadcrumb + "\n\n")

	hasPeers := false
	for _, r := range rows {
		if r.kind == ircRowPeer {
			hasPeers = true
			break
		}
	}

	if !hasPeers {
		b.WriteString(lipgloss.NewStyle().Foreground(colorSubtle).Italic(true).Render("  No peers available") + "\n")
	} else {
		for _, r := range rows {
			if r.kind == ircRowHeader {
				headerStyle := lipgloss.NewStyle().Foreground(colorMuted).Bold(true)
				b.WriteString("  " + headerStyle.Render(r.workspace) + "\n")
				continue
			}

			selected := r.peer.Name == m.ircSelectedPeer
			indicator := "    "
			if selected {
				indicator = "  " + lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("▸ ")
			}

			var dot, name string
			if r.peer.Online {
				dot = lipgloss.NewStyle().Foreground(colorSuccess).Render("●")
				name = lipgloss.NewStyle().Foreground(colorText).Render(r.peer.Name)
			} else {
				dot = lipgloss.NewStyle().Foreground(colorDim).Render("○")
				name = lipgloss.NewStyle().Foreground(colorSubtle).Render(r.peer.Name)
			}

			row := indicator + dot + " " + name
			if selected {
				row = lipgloss.NewStyle().Background(lipgloss.Color("#1E1B4B")).Render(row)
			}
			b.WriteString(row + "\n")
		}
	}

	b.WriteString("\n")
	b.WriteString(m.renderIRCFooter())
	return b.String()
}

func (m DashboardModel) renderIRCMsgView(w int) string {
	var b strings.Builder

	breadcrumb := lipgloss.NewStyle().Foreground(colorSubtle).Render("  Tasks") +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorSubtle).Render("IRC") +
		lipgloss.NewStyle().Foreground(colorDim).Render(" › ") +
		lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render(m.ircTarget)
	b.WriteString(breadcrumb + "\n\n")

	if !m.ircLastSendAt.IsZero() {
		if m.ircLastSendErr != nil {
			errMsg := lipgloss.NewStyle().Foreground(colorDanger).Render(fmt.Sprintf("  ✗ %v", m.ircLastSendErr))
			b.WriteString(errMsg + "\n")
		} else if time.Since(m.ircLastSendAt) < 3*time.Second {
			okMsg := lipgloss.NewStyle().Foreground(colorSuccess).Render(fmt.Sprintf("  ✓ sent to %s", m.ircTarget))
			b.WriteString(okMsg + "\n")
		}
	}

	prompt := lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render("  > ")
	cursor := lipgloss.NewStyle().Foreground(colorText).Render("█")
	input := lipgloss.NewStyle().Foreground(colorText).Render(m.ircInput)
	b.WriteString(prompt + input + cursor + "\n")

	b.WriteString("\n")
	b.WriteString(m.renderIRCMsgFooter())
	return b.String()
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
