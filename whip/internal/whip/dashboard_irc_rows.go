package whip

import (
	"sort"
	"strings"
)

type ircRowKind int

const (
	ircRowHeader ircRowKind = iota
	ircRowPeer
)

type ircRow struct {
	kind      ircRowKind
	workspace string   // group name for headers; resolved workspace for peers
	peer      peerInfo // only for ircRowPeer
	role      string   // "master", "lead", "worker"
}

const ungroupedLabel = "Ungrouped"

func classifyRole(name string) string {
	if name == MasterIRCPrefix || strings.HasPrefix(name, MasterIRCPrefix+"-") {
		return "master"
	}
	if strings.HasPrefix(name, LeadIRCPrefix+"-") {
		return "lead"
	}
	return "worker"
}

func rolePriority(role string) int {
	switch role {
	case "master":
		return 0
	case "lead":
		return 1
	default:
		return 2
	}
}

func resolveWorkspaceFromName(name string) string {
	masterDash := MasterIRCPrefix + "-"
	leadDash := LeadIRCPrefix + "-"
	if strings.HasPrefix(name, masterDash) {
		return strings.TrimPrefix(name, masterDash)
	}
	if name == MasterIRCPrefix {
		return GlobalWorkspaceName
	}
	if strings.HasPrefix(name, leadDash) {
		return strings.TrimPrefix(name, leadDash)
	}
	return ""
}

func (m DashboardModel) ircRows() []ircRow {
	// Build ircName → workspace map from tasks
	ircToWs := make(map[string]string)
	for _, t := range m.tasks {
		ws := t.WorkspaceName()
		if t.IRCName != "" {
			ircToWs[t.IRCName] = ws
		}
		if t.MasterIRCName != "" {
			ircToWs[t.MasterIRCName] = ws
		}
	}

	// Group peers by workspace
	groups := make(map[string][]ircRow)
	for _, p := range m.peers {
		if p.Name == "user" {
			continue
		}
		role := classifyRole(p.Name)

		// Resolve workspace: task map first, then naming convention fallback
		ws := ircToWs[p.Name]
		if ws == "" {
			ws = resolveWorkspaceFromName(p.Name)
		}
		if ws == "" {
			ws = ungroupedLabel
		}

		groups[ws] = append(groups[ws], ircRow{
			kind:      ircRowPeer,
			workspace: ws,
			peer:      p,
			role:      role,
		})
	}

	// Sort peers within each group: online before offline, then role priority, then alphabetical
	for ws := range groups {
		sort.Slice(groups[ws], func(i, j int) bool {
			a, b := groups[ws][i], groups[ws][j]
			// online before offline
			if a.peer.Online != b.peer.Online {
				return a.peer.Online
			}
			// role priority (master=0, lead=1, worker=2)
			ap, bp := rolePriority(a.role), rolePriority(b.role)
			if ap != bp {
				return ap < bp
			}
			// alphabetical
			return a.peer.Name < b.peer.Name
		})
	}

	// Sort group names: online-groups alphabetical, then offline-groups alphabetical, then Ungrouped last
	var onlineGroups, offlineGroups []string
	for ws, rows := range groups {
		if ws == ungroupedLabel {
			continue
		}
		hasOnline := false
		for _, r := range rows {
			if r.peer.Online {
				hasOnline = true
				break
			}
		}
		if hasOnline {
			onlineGroups = append(onlineGroups, ws)
		} else {
			offlineGroups = append(offlineGroups, ws)
		}
	}
	sort.Strings(onlineGroups)
	sort.Strings(offlineGroups)

	ordered := make([]string, 0, len(onlineGroups)+len(offlineGroups)+1)
	ordered = append(ordered, onlineGroups...)
	ordered = append(ordered, offlineGroups...)
	if _, ok := groups[ungroupedLabel]; ok {
		ordered = append(ordered, ungroupedLabel)
	}

	// Build final rows with headers
	var rows []ircRow
	for _, ws := range ordered {
		rows = append(rows, ircRow{
			kind:      ircRowHeader,
			workspace: ws,
		})
		rows = append(rows, groups[ws]...)
	}
	return rows
}

// nextPeerIndex finds the next ircRowPeer index in the given direction, wrapping around.
// dir should be +1 (down) or -1 (up).
func nextPeerIndex(rows []ircRow, current, dir int) int {
	n := len(rows)
	if n == 0 {
		return 0
	}
	idx := current
	for range n {
		idx += dir
		if idx < 0 {
			idx = n - 1
		} else if idx >= n {
			idx = 0
		}
		if rows[idx].kind == ircRowPeer {
			return idx
		}
	}
	return current
}

// firstPeerIndex returns the index of the first ircRowPeer, or len(rows) if none.
func firstPeerIndex(rows []ircRow) int {
	for i, r := range rows {
		if r.kind == ircRowPeer {
			return i
		}
	}
	return len(rows)
}
