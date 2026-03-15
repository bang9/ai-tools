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
	// Should select the first peer by name
	if dm.ircSelectedPeer != "whip-abc12" {
		t.Errorf("expected ircSelectedPeer=whip-abc12, got %s", dm.ircSelectedPeer)
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
	m.ircSelectedPeer = "peer-a"

	model, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dm := model.(DashboardModel)
	if dm.ircSelectedPeer != "peer-b" {
		t.Errorf("expected peer-b, got %s", dm.ircSelectedPeer)
	}

	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dm = model.(DashboardModel)
	if dm.ircSelectedPeer != "peer-c" {
		t.Errorf("expected peer-c, got %s", dm.ircSelectedPeer)
	}

	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dm = model.(DashboardModel)
	if dm.ircSelectedPeer != "peer-a" {
		t.Errorf("expected peer-a (wrap), got %s", dm.ircSelectedPeer)
	}

	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	dm = model.(DashboardModel)
	if dm.ircSelectedPeer != "peer-c" {
		t.Errorf("expected peer-c (wrap up), got %s", dm.ircSelectedPeer)
	}
}

func TestIRC_SelectPeerOpensMsg(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{{Name: "whip-abc12", Online: true}}
	m.view = viewIRC
	m.ircSelectedPeer = "whip-abc12"

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
	m.ircSelectedPeer = "whip-abc12"

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

// ---------------------------------------------------------------------------
// Workspace-grouped IRC regression tests
// ---------------------------------------------------------------------------

func TestIRC_WorkspaceResolutionFromTasks(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-6b8638f9", Online: true},
		{Name: "wp-lead-myws", Online: true},
		{Name: "wp-master-myws", Online: true},
	}
	m.tasks = []*Task{
		{IRCName: "wp-6b8638f9", Workspace: "myws"},
		{MasterIRCName: "wp-master-myws", Workspace: "myws"},
	}

	rows := m.ircRows()

	// All three peers should resolve to workspace "myws" via task map or naming convention
	peerRows := filterPeerRows(rows)
	if len(peerRows) != 3 {
		t.Fatalf("expected 3 peer rows, got %d", len(peerRows))
	}
	for _, r := range peerRows {
		if r.workspace != "myws" {
			t.Errorf("peer %s: expected workspace 'myws', got %q", r.peer.Name, r.workspace)
		}
	}
}

func TestIRC_WorkspaceResolutionNamingFallback(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-master-alpha", Online: true},
		{Name: "wp-lead-beta", Online: true},
	}
	// No tasks — relies entirely on naming convention
	m.tasks = nil

	rows := m.ircRows()
	peerRows := filterPeerRows(rows)
	if len(peerRows) != 2 {
		t.Fatalf("expected 2 peer rows, got %d", len(peerRows))
	}

	wsMap := make(map[string]string)
	for _, r := range peerRows {
		wsMap[r.peer.Name] = r.workspace
	}
	if wsMap["wp-master-alpha"] != "alpha" {
		t.Errorf("wp-master-alpha: expected workspace 'alpha', got %q", wsMap["wp-master-alpha"])
	}
	if wsMap["wp-lead-beta"] != "beta" {
		t.Errorf("wp-lead-beta: expected workspace 'beta', got %q", wsMap["wp-lead-beta"])
	}
}

func TestIRC_GroupingByWorkspace(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-master-alpha", Online: true},
		{Name: "wp-lead-alpha", Online: true},
		{Name: "wp-master-beta", Online: true},
		{Name: "whip-unknown", Online: true},
	}
	m.tasks = nil

	rows := m.ircRows()

	// Expect headers for: global first, then alpha, beta (all online, alphabetical)
	headers := filterHeaderRows(rows)
	if len(headers) != 3 {
		t.Fatalf("expected 3 headers, got %d: %v", len(headers), headerNames(headers))
	}
	if headers[0].workspace != GlobalWorkspaceName {
		t.Errorf("first header: expected %q, got %q", GlobalWorkspaceName, headers[0].workspace)
	}
	if headers[1].workspace != "alpha" {
		t.Errorf("second header: expected 'alpha', got %q", headers[1].workspace)
	}
	if headers[2].workspace != "beta" {
		t.Errorf("third header: expected 'beta', got %q", headers[2].workspace)
	}

	// Check peers under each header
	groups := groupRowsByHeader(rows)
	if len(groups["alpha"]) != 2 {
		t.Errorf("alpha group: expected 2 peers, got %d", len(groups["alpha"]))
	}
	if len(groups["beta"]) != 1 {
		t.Errorf("beta group: expected 1 peer, got %d", len(groups["beta"]))
	}
	if len(groups[GlobalWorkspaceName]) != 1 {
		t.Errorf("Ungrouped: expected 1 peer, got %d", len(groups[GlobalWorkspaceName]))
	}
}

func TestIRC_SortOrderWithinGroups(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-worker-z", Online: true},  // worker, resolves to ws via task
		{Name: "wp-lead-ws1", Online: true},   // lead
		{Name: "wp-master-ws1", Online: true},  // master
		{Name: "wp-worker-a", Online: false},  // offline worker
		{Name: "wp-lead-offline", Online: false}, // offline lead, resolves to ws via task
	}
	m.tasks = []*Task{
		{IRCName: "wp-worker-z", Workspace: "ws1"},
		{IRCName: "wp-worker-a", Workspace: "ws1"},
		{IRCName: "wp-lead-offline", Workspace: "ws1"},
	}

	rows := m.ircRows()
	peers := filterPeerRows(rows)

	// All should be in ws1. Within group:
	// online master, online lead, online worker, then offline lead, offline worker
	expected := []string{
		"wp-master-ws1",   // online master
		"wp-lead-ws1",     // online lead
		"wp-worker-z",     // online worker
		"wp-lead-offline", // offline lead
		"wp-worker-a",     // offline worker
	}
	if len(peers) != len(expected) {
		t.Fatalf("expected %d peers, got %d", len(expected), len(peers))
	}
	for i, want := range expected {
		if peers[i].peer.Name != want {
			t.Errorf("peers[%d]: expected %s, got %s", i, want, peers[i].peer.Name)
		}
	}
}

func TestIRC_GroupSortOrder_OnlineFirst(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-master-zeta", Online: false},   // offline group
		{Name: "wp-master-alpha", Online: true},    // online group
		{Name: "wp-master-gamma", Online: true},    // online group
		{Name: "wp-master-beta", Online: false},    // offline group
		{Name: "whip-orphan", Online: true},        // global
	}
	m.tasks = nil

	rows := m.ircRows()
	headers := filterHeaderRows(rows)

	// Expected order: global first, then online groups alphabetical (alpha, gamma), then offline groups alphabetical (beta, zeta)
	expectedHeaders := []string{GlobalWorkspaceName, "alpha", "gamma", "beta", "zeta"}
	if len(headers) != len(expectedHeaders) {
		t.Fatalf("expected %d headers, got %d: %v", len(expectedHeaders), len(headers), headerNames(headers))
	}
	for i, want := range expectedHeaders {
		if headers[i].workspace != want {
			t.Errorf("header[%d]: expected %q, got %q", i, want, headers[i].workspace)
		}
	}
}

func TestIRC_HeaderRowsAtGroupBoundaries(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-master-ws1", Online: true},
		{Name: "wp-lead-ws1", Online: true},
		{Name: "wp-master-ws2", Online: true},
	}
	m.tasks = nil

	rows := m.ircRows()

	// Verify structure: header, peers, header, peers, ...
	if len(rows) != 5 { // 2 headers + 3 peers
		t.Fatalf("expected 5 rows, got %d", len(rows))
	}
	if rows[0].kind != ircRowHeader || rows[0].workspace != "ws1" {
		t.Errorf("row 0: expected header for ws1, got kind=%d ws=%q", rows[0].kind, rows[0].workspace)
	}
	if rows[1].kind != ircRowPeer {
		t.Error("row 1: expected peer")
	}
	if rows[2].kind != ircRowPeer {
		t.Error("row 2: expected peer")
	}
	if rows[3].kind != ircRowHeader || rows[3].workspace != "ws2" {
		t.Errorf("row 3: expected header for ws2, got kind=%d ws=%q", rows[3].kind, rows[3].workspace)
	}
	if rows[4].kind != ircRowPeer {
		t.Error("row 4: expected peer")
	}
}

func TestIRC_CursorSkipsHeaders(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-master-ws1", Online: true},
		{Name: "wp-master-ws2", Online: true},
	}
	m.tasks = nil
	m.view = viewIRC

	// Rows: [header:ws1(0), peer(1), header:ws2(2), peer(3)]
	rows := m.ircRows()
	if len(rows) != 4 {
		t.Fatalf("expected 4 rows, got %d", len(rows))
	}

	// Start at first peer
	m.ircSelectedPeer = "wp-master-ws1"
	// Press j → should land on ws2 master (skipping header)
	model, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dm := model.(DashboardModel)
	if dm.ircSelectedPeer != "wp-master-ws2" {
		t.Errorf("j from ws1: expected wp-master-ws2, got %s", dm.ircSelectedPeer)
	}

	// Press j again → should wrap to ws1 master (skipping headers)
	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dm = model.(DashboardModel)
	if dm.ircSelectedPeer != "wp-master-ws1" {
		t.Errorf("j from ws2: expected wp-master-ws1 (wrap), got %s", dm.ircSelectedPeer)
	}

	// Press k → should wrap to ws2 master (skipping headers)
	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	dm = model.(DashboardModel)
	if dm.ircSelectedPeer != "wp-master-ws2" {
		t.Errorf("k from ws1: expected wp-master-ws2 (wrap up), got %s", dm.ircSelectedPeer)
	}

	// Press k → should land on ws1 master (skipping header)
	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'k'}})
	dm = model.(DashboardModel)
	if dm.ircSelectedPeer != "wp-master-ws1" {
		t.Errorf("k from ws2: expected wp-master-ws1, got %s", dm.ircSelectedPeer)
	}
}

func TestIRC_CursorStartsOnFirstPeer(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-master-ws1", Online: true},
		{Name: "whip-worker", Online: true},
	}
	m.tasks = nil
	m.view = viewList

	// Press 'i' to enter IRC view
	model, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'i'}})
	dm := model.(DashboardModel)

	if dm.view != viewIRC {
		t.Fatalf("expected viewIRC, got %d", dm.view)
	}

	// Should select the first peer by name (ws1 master, since ws1 is alphabetically first online group)
	if dm.ircSelectedPeer == "" {
		t.Fatal("expected a selected peer, got empty")
	}
	// Verify it's actually a peer in the rows
	rows := dm.ircRows()
	if findPeerIndex(rows, dm.ircSelectedPeer) < 0 {
		t.Errorf("selected peer %q not found in rows", dm.ircSelectedPeer)
	}
}

func TestIRC_SelectGroupedPeerOpensCorrectTarget(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-master-myws", Online: true},
		{Name: "wp-lead-myws", Online: true},
		{Name: "wp-master-other", Online: true},
	}
	m.tasks = nil
	m.view = viewIRC

	// Select the lead
	m.ircSelectedPeer = "wp-lead-myws"
	model, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	dm := model.(DashboardModel)
	if dm.view != viewIRCMsg {
		t.Fatalf("expected viewIRCMsg, got %d", dm.view)
	}
	if dm.ircTarget != "wp-lead-myws" {
		t.Errorf("expected target 'wp-lead-myws', got %q", dm.ircTarget)
	}

	// Go back, select the master in "other" group
	dm.view = viewIRC
	dm.ircSelectedPeer = "wp-master-other"
	model, _ = dm.Update(tea.KeyMsg{Type: tea.KeyEnter})
	dm = model.(DashboardModel)
	if dm.ircTarget != "wp-master-other" {
		t.Errorf("expected target 'wp-master-other', got %q", dm.ircTarget)
	}
}

func TestIRC_NoPeersNoHeaders(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = nil
	m.tasks = nil

	rows := m.ircRows()
	if len(rows) != 0 {
		t.Errorf("expected 0 rows for no peers, got %d", len(rows))
	}
}

func TestIRC_SingleWorkspaceStillHasHeader(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-master-solo", Online: true},
	}
	m.tasks = nil

	rows := m.ircRows()
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows (1 header + 1 peer), got %d", len(rows))
	}
	if rows[0].kind != ircRowHeader {
		t.Error("first row should be a header")
	}
	if rows[0].workspace != "solo" {
		t.Errorf("header workspace: expected 'solo', got %q", rows[0].workspace)
	}
	if rows[1].kind != ircRowPeer {
		t.Error("second row should be a peer")
	}
}

func TestIRC_AllPeersGlobal(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "whip-aaa", Online: true},
		{Name: "whip-bbb", Online: false},
		{Name: "whip-ccc", Online: true},
	}
	m.tasks = nil

	rows := m.ircRows()
	headers := filterHeaderRows(rows)
	if len(headers) != 1 {
		t.Fatalf("expected 1 header (global), got %d", len(headers))
	}
	if headers[0].workspace != GlobalWorkspaceName {
		t.Errorf("expected header %q, got %q", GlobalWorkspaceName, headers[0].workspace)
	}
	peerRows := filterPeerRows(rows)
	if len(peerRows) != 3 {
		t.Errorf("expected 3 peer rows, got %d", len(peerRows))
	}
	// All peers should be in global
	for _, r := range peerRows {
		if r.workspace != GlobalWorkspaceName {
			t.Errorf("peer %s: expected workspace %q, got %q", r.peer.Name, GlobalWorkspaceName, r.workspace)
		}
	}
}

func TestIRC_UserFilteredFromRows(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "user", Online: true},
		{Name: "wp-master-ws1", Online: true},
	}
	m.tasks = nil

	rows := m.ircRows()
	for _, r := range rows {
		if r.kind == ircRowPeer && r.peer.Name == "user" {
			t.Error("'user' should be filtered out of ircRows")
		}
	}
	peerRows := filterPeerRows(rows)
	if len(peerRows) != 1 {
		t.Errorf("expected 1 peer row after filtering 'user', got %d", len(peerRows))
	}
}

func TestIRC_TaskMapTakesPrecedenceOverNaming(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	// wp-master-alpha would resolve to "alpha" by naming, but task says "override-ws"
	m.peers = []peerInfo{
		{Name: "wp-master-alpha", Online: true},
	}
	m.tasks = []*Task{
		{MasterIRCName: "wp-master-alpha", Workspace: "override-ws"},
	}

	rows := m.ircRows()
	peerRows := filterPeerRows(rows)
	if len(peerRows) != 1 {
		t.Fatalf("expected 1 peer row, got %d", len(peerRows))
	}
	if peerRows[0].workspace != "override-ws" {
		t.Errorf("expected workspace 'override-ws' (from task), got %q", peerRows[0].workspace)
	}
}

func TestIRC_RoleClassification(t *testing.T) {
	tests := []struct {
		name     string
		wantRole string
	}{
		{"wp-master-foo", "master"},
		{"wp-master", "master"},
		{"wp-lead-bar", "lead"},
		{"whip-worker1", "worker"},
		{"wp-abc123", "worker"},
		{"random-peer", "worker"},
		{"wp-masterblaster", "worker"}, // must not match master prefix without "-"
	}
	for _, tt := range tests {
		got := classifyRole(tt.name)
		if got != tt.wantRole {
			t.Errorf("classifyRole(%q): expected %q, got %q", tt.name, tt.wantRole, got)
		}
	}
}

func TestIRC_ResolveWorkspaceFromName(t *testing.T) {
	tests := []struct {
		name    string
		wantWs  string
	}{
		{"wp-master-alpha", "alpha"},
		{"wp-master", GlobalWorkspaceName},
		{"wp-lead-beta", "beta"},
		{"whip-worker1", ""},
		{"random-name", ""},
	}
	for _, tt := range tests {
		got := resolveWorkspaceFromName(tt.name)
		if got != tt.wantWs {
			t.Errorf("resolveWorkspaceFromName(%q): expected %q, got %q", tt.name, tt.wantWs, got)
		}
	}
}

func TestIRC_CursorNavigationMultipleGroups(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-master-a", Online: true},
		{Name: "wp-lead-a", Online: true},
		{Name: "wp-master-b", Online: true},
		{Name: "whip-orphan", Online: true},
	}
	m.tasks = nil
	m.view = viewIRC

	// Rows: [header:global(0), orphan(1), header:a(2), master-a(3), lead-a(4), header:b(5), master-b(6)]
	rows := m.ircRows()
	var peerNames []string
	for _, r := range rows {
		if r.kind == ircRowPeer {
			peerNames = append(peerNames, r.peer.Name)
		}
	}
	if len(peerNames) != 4 {
		t.Fatalf("expected 4 peers, got %d", len(peerNames))
	}

	// Navigate through all peers with j, verify we visit each peer exactly once before wrapping
	m.ircSelectedPeer = peerNames[0]
	visited := []string{m.ircSelectedPeer}
	for i := 0; i < len(peerNames)-1; i++ {
		model, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
		dm := model.(DashboardModel)
		visited = append(visited, dm.ircSelectedPeer)
		m = dm
	}

	// Should have visited all 4 peer names
	if len(visited) != 4 {
		t.Errorf("expected to visit 4 peers, visited %d", len(visited))
	}
	// All visited should be valid peer names
	for _, name := range visited {
		if findPeerIndex(rows, name) < 0 {
			t.Errorf("visited unknown peer %q", name)
		}
	}

	// One more j should wrap back to first peer
	model, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	dm := model.(DashboardModel)
	if dm.ircSelectedPeer != peerNames[0] {
		t.Errorf("wrap: expected %s, got %s", peerNames[0], dm.ircSelectedPeer)
	}
}

func TestIRC_PeerDisappearsReselectsOnRefresh(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{
		{Name: "wp-master-ws1", Online: true},
		{Name: "wp-lead-ws1", Online: true},
	}
	m.view = viewIRC
	m.ircSelectedPeer = "wp-lead-ws1"

	// Peer disappears
	model, _ := m.Update(peersMsg([]peerInfo{
		{Name: "wp-master-ws1", Online: true},
	}))
	dm := model.(DashboardModel)
	if dm.ircSelectedPeer != "wp-master-ws1" {
		t.Errorf("expected fallback to wp-master-ws1, got %q", dm.ircSelectedPeer)
	}
}

func TestIRC_EmptyPeersRepopulateReselects(t *testing.T) {
	store := tempStore(t)
	m := NewDashboardModel(store, "test")
	m.peers = []peerInfo{{Name: "peer-a", Online: true}}
	m.view = viewIRC
	m.ircSelectedPeer = "peer-a"

	// Peers become empty
	model, _ := m.Update(peersMsg(nil))
	dm := model.(DashboardModel)
	if dm.ircSelectedPeer != "" {
		t.Errorf("expected empty selection when no peers, got %q", dm.ircSelectedPeer)
	}

	// Peers return
	model, _ = dm.Update(peersMsg([]peerInfo{{Name: "peer-b", Online: true}}))
	dm = model.(DashboardModel)
	if dm.ircSelectedPeer != "peer-b" {
		t.Errorf("expected reselect to peer-b, got %q", dm.ircSelectedPeer)
	}
}

// Test helpers for grouped IRC rows

func filterPeerRows(rows []ircRow) []ircRow {
	var result []ircRow
	for _, r := range rows {
		if r.kind == ircRowPeer {
			result = append(result, r)
		}
	}
	return result
}

func filterHeaderRows(rows []ircRow) []ircRow {
	var result []ircRow
	for _, r := range rows {
		if r.kind == ircRowHeader {
			result = append(result, r)
		}
	}
	return result
}

func headerNames(headers []ircRow) []string {
	names := make([]string, len(headers))
	for i, h := range headers {
		names[i] = h.workspace
	}
	return names
}

func groupRowsByHeader(rows []ircRow) map[string][]ircRow {
	groups := make(map[string][]ircRow)
	currentWs := ""
	for _, r := range rows {
		if r.kind == ircRowHeader {
			currentWs = r.workspace
		} else if currentWs != "" {
			groups[currentWs] = append(groups[currentWs], r)
		}
	}
	return groups
}
