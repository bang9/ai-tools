package whip

import (
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func (m DashboardModel) ircPeers() []peerInfo {
	var master *peerInfo
	var online, offline []peerInfo
	for _, p := range m.peers {
		if p.Name == "user" {
			continue
		}
		if strings.HasPrefix(p.Name, "wp-master") {
			cp := p
			master = &cp
		} else if p.Online {
			online = append(online, p)
		} else {
			offline = append(offline, p)
		}
	}
	sort.Slice(online, func(i, j int) bool { return online[i].Name < online[j].Name })
	sort.Slice(offline, func(i, j int) bool { return offline[i].Name < offline[j].Name })
	var result []peerInfo
	if master != nil {
		result = append(result, *master)
	}
	result = append(result, online...)
	result = append(result, offline...)
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
