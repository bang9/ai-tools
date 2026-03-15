package whip

import (
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func (m DashboardModel) ircPeers() []peerInfo {
	var onMasters, onOthers, offMasters, offOthers []peerInfo
	for _, p := range m.peers {
		if p.Name == "user" {
			continue
		}
		isMaster := strings.HasPrefix(p.Name, MasterIRCPrefix)
		if p.Online {
			if isMaster {
				onMasters = append(onMasters, p)
			} else {
				onOthers = append(onOthers, p)
			}
		} else {
			if isMaster {
				offMasters = append(offMasters, p)
			} else {
				offOthers = append(offOthers, p)
			}
		}
	}
	abc := func(s []peerInfo) { sort.Slice(s, func(i, j int) bool { return s[i].Name < s[j].Name }) }
	abc(onMasters)
	abc(onOthers)
	abc(offMasters)
	abc(offOthers)
	var result []peerInfo
	result = append(result, onMasters...)
	result = append(result, onOthers...)
	result = append(result, offMasters...)
	result = append(result, offOthers...)
	return result
}

func (m DashboardModel) updateIRC(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	rows := m.ircRows()
	switch msg.String() {
	case "esc", "backspace", "left":
		m.view = viewList
	case "up", "k":
		m.ircSelectedPeer = adjacentPeer(rows, m.ircSelectedPeer, -1)
	case "down", "j":
		m.ircSelectedPeer = adjacentPeer(rows, m.ircSelectedPeer, +1)
	case "enter":
		if m.ircSelectedPeer != "" && findPeerIndex(rows, m.ircSelectedPeer) >= 0 {
			m.ircTarget = m.ircSelectedPeer
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
