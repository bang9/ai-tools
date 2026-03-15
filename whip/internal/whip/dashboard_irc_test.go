package whip

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestIRC_PressIOpensIRCView(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "whip-abc12", Online: true},
		{Name: "whip-def34", Online: false},
	}
	m.view = viewList

	model, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'i'}})
	dm := model.(DashboardModel)
	if dm.view != viewIRC {
		t.Errorf("expected viewIRC, got %d", dm.view)
	}
	// First peer is at index 1 (after Ungrouped header at 0)
	if dm.ircCursor != 1 {
		t.Errorf("expected ircCursor=1, got %d", dm.ircCursor)
	}
}

func TestIRC_PressIWithNoPeers(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = nil
	m.view = viewList

	model, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'i'}})
	dm := model.(DashboardModel)
	if dm.view != viewList {
		t.Error("should stay in viewList when no peers exist")
	}
}

func TestIRC_FilterUserFromPeers(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "user", Online: true},
		{Name: "whip-abc12", Online: true},
	}

	peers := m.ircPeers()
	if len(peers) != 1 {
		t.Fatalf("expected 1 peer after filtering, got %d", len(peers))
	}
	if peers[0].Name != "whip-abc12" {
		t.Errorf("expected whip-abc12, got %s", peers[0].Name)
	}
}

func TestIRC_NavigatePeers(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "peer-a", Online: true},
		{Name: "peer-b", Online: true},
		{Name: "peer-c", Online: false},
	}
	m.view = viewIRC
	// Rows: [header:Ungrouped(0), peer-a(1), peer-b(2), peer-c(3)]
	m.ircCursor = 1

	model, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dm := model.(DashboardModel)
	if dm.ircCursor != 2 {
		t.Errorf("expected ircCursor=2, got %d", dm.ircCursor)
	}

	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dm = model.(DashboardModel)
	if dm.ircCursor != 3 {
		t.Errorf("expected ircCursor=3, got %d", dm.ircCursor)
	}

	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dm = model.(DashboardModel)
	if dm.ircCursor != 1 {
		t.Errorf("expected ircCursor=1 (wrap, skip header), got %d", dm.ircCursor)
	}

	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	dm = model.(DashboardModel)
	if dm.ircCursor != 3 {
		t.Errorf("expected ircCursor=3 (wrap up, skip header), got %d", dm.ircCursor)
	}
}

func TestIRC_SelectPeerOpensMsg(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{{Name: "whip-abc12", Online: true}}
	m.view = viewIRC
	// Row 0 is header, row 1 is the peer
	m.ircCursor = 1

	model, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	dm := model.(DashboardModel)
	if dm.view != viewIRCMsg {
		t.Errorf("expected viewIRCMsg, got %d", dm.view)
	}
	if dm.ircTarget != "whip-abc12" {
		t.Errorf("expected target whip-abc12, got %s", dm.ircTarget)
	}
	if dm.ircInput != "" {
		t.Error("expected empty ircInput")
	}
}

func TestIRC_EscFromIRCGoesBack(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.view = viewIRC

	model, _ := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	dm := model.(DashboardModel)
	if dm.view != viewList {
		t.Errorf("expected viewList, got %d", dm.view)
	}
}

func TestIRCMsg_TextInput(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.view = viewIRCMsg
	m.ircTarget = "whip-abc12"

	model, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'h'}})
	dm := model.(DashboardModel)
	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'i'}})
	dm = model.(DashboardModel)
	if dm.ircInput != "hi" {
		t.Errorf("expected 'hi', got '%s'", dm.ircInput)
	}

	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeySpace})
	dm = model.(DashboardModel)
	if dm.ircInput != "hi " {
		t.Errorf("expected 'hi ', got '%s'", dm.ircInput)
	}

	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	dm = model.(DashboardModel)
	if dm.ircInput != "hi" {
		t.Errorf("expected 'hi' after backspace, got '%s'", dm.ircInput)
	}
}

func TestIRCMsg_EnterSends(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.view = viewIRCMsg
	m.ircTarget = "whip-abc12"
	m.ircInput = "hello world"

	model, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	dm := model.(DashboardModel)
	if dm.ircInput != "" {
		t.Errorf("expected cleared input after send, got '%s'", dm.ircInput)
	}
	if cmd == nil {
		t.Error("expected a command for sending IRC message")
	}
	if dm.view != viewIRCMsg {
		t.Errorf("expected to stay in viewIRCMsg, got %d", dm.view)
	}
}

func TestIRCMsg_EmptyEnterDoesNotSend(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.view = viewIRCMsg
	m.ircTarget = "whip-abc12"
	m.ircInput = ""

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd != nil {
		t.Error("should not send when input is empty")
	}
}

func TestIRCMsg_EscGoesBack(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.view = viewIRCMsg
	m.ircInput = "draft"

	model, _ := m.Update(tea.KeyMsg{Type: tea.KeyEsc})
	dm := model.(DashboardModel)
	if dm.view != viewIRC {
		t.Errorf("expected viewIRC, got %d", dm.view)
	}
	if dm.ircInput != "" {
		t.Error("expected ircInput cleared on esc")
	}
}

func TestIRC_RenderView(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "whip-abc12", Online: true},
		{Name: "whip-def34", Online: false},
	}
	m.view = viewIRC
	m.ircCursor = 0

	output := m.View()
	if !strings.Contains(output, "IRC") {
		t.Error("expected IRC breadcrumb in output")
	}
	if !strings.Contains(output, "whip-abc12") {
		t.Error("expected peer name in output")
	}
}

func TestIRC_MultipleMastersAllVisible(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-master-aaa", Online: true},
		{Name: "wp-master-bbb", Online: true},
		{Name: "whip-worker1", Online: true},
	}

	peers := m.ircPeers()
	if len(peers) != 3 {
		t.Fatalf("expected 3 peers, got %d", len(peers))
	}
	// Both masters should appear, not just the last one
	names := make([]string, len(peers))
	for i, p := range peers {
		names[i] = p.Name
	}
	for _, want := range []string{"wp-master-aaa", "wp-master-bbb", "whip-worker1"} {
		found := false
		for _, n := range names {
			if n == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected peer %s in list, got %v", want, names)
		}
	}
}

func TestIRC_SortOrder_OnlineMasterFirst(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "whip-zzz", Online: true},
		{Name: "wp-master-bbb", Online: false},
		{Name: "whip-aaa", Online: false},
		{Name: "wp-master-aaa", Online: true},
		{Name: "whip-mmm", Online: true},
		{Name: "wp-master-ccc", Online: true},
	}

	peers := m.ircPeers()
	expected := []string{
		// online masters (ABC)
		"wp-master-aaa",
		"wp-master-ccc",
		// online others (ABC)
		"whip-mmm",
		"whip-zzz",
		// offline masters (ABC)
		"wp-master-bbb",
		// offline others (ABC)
		"whip-aaa",
	}
	if len(peers) != len(expected) {
		t.Fatalf("expected %d peers, got %d", len(expected), len(peers))
	}
	for i, want := range expected {
		if peers[i].Name != want {
			t.Errorf("peers[%d]: expected %s, got %s", i, want, peers[i].Name)
		}
	}
}

func TestIRC_RenderDeps_Overflow(t *testing.T) {
	// 3 deps should not overflow column width
	deps := []string{"995c9309", "15f40e6b", "b28249d5"}
	maxWidth := 14
	result := renderDeps(deps, maxWidth)
	// Strip ANSI for width check
	plain := stripAnsi(result)
	if len(plain) > maxWidth {
		t.Errorf("renderDeps overflow: %q is %d chars, max %d", plain, len(plain), maxWidth)
	}
	if !strings.Contains(plain, "+") {
		t.Errorf("expected +N suffix for 3 deps in %d width, got %q", maxWidth, plain)
	}
}

func TestIRC_RenderDeps_TwoFit(t *testing.T) {
	deps := []string{"995c9309", "15f40e6b"}
	maxWidth := 14
	result := renderDeps(deps, maxWidth)
	plain := stripAnsi(result)
	if len(plain) > maxWidth {
		t.Errorf("renderDeps overflow: %q is %d chars, max %d", plain, len(plain), maxWidth)
	}
	// 2 deps should fit without +N
	if strings.Contains(plain, "+") {
		t.Errorf("2 deps should fit in %d width without +N, got %q", maxWidth, plain)
	}
}

func stripAnsi(s string) string {
	// Simple ANSI escape stripper for test assertions
	result := make([]byte, 0, len(s))
	i := 0
	for i < len(s) {
		if s[i] == '\x1b' && i+1 < len(s) && s[i+1] == '[' {
			j := i + 2
			for j < len(s) && !((s[j] >= 'A' && s[j] <= 'Z') || (s[j] >= 'a' && s[j] <= 'z')) {
				j++
			}
			if j < len(s) {
				j++
			}
			i = j
		} else {
			result = append(result, s[i])
			i++
		}
	}
	return string(result)
}

func TestIRCMsg_RenderView(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.view = viewIRCMsg
	m.ircTarget = "whip-abc12"
	m.ircInput = "hello"

	output := m.View()
	if !strings.Contains(output, "whip-abc12") {
		t.Error("expected target name in breadcrumb")
	}
	if !strings.Contains(output, "hello") {
		t.Error("expected input text in output")
	}
}
