package whip

import (
	"strings"
	"testing"
)

func TestRenderGraph_Empty(t *testing.T) {
	result := RenderGraph(nil)
	if result != "" {
		t.Errorf("expected empty string for nil input, got %q", result)
	}
}

func TestRenderGraph_SingleNode(t *testing.T) {
	nodes := []GraphNode{
		{ID: "A", Title: "Auth", DependsOn: []string{}},
	}
	result := RenderGraph(nodes)
	if !strings.Contains(result, "A: Auth") {
		t.Errorf("expected label 'A: Auth' in output:\n%s", result)
	}
	if !strings.Contains(result, "┌") || !strings.Contains(result, "┘") {
		t.Errorf("expected box characters in output:\n%s", result)
	}
	// Single node should not have vertical arrows or connector tees
	if strings.Contains(result, "▼") || strings.Contains(result, "┬") {
		t.Errorf("single node should not have connectors:\n%s", result)
	}
}

func TestRenderGraph_LinearChain(t *testing.T) {
	nodes := []GraphNode{
		{ID: "A", Title: "Auth", DependsOn: []string{}},
		{ID: "B", Title: "API", DependsOn: []string{"A"}},
		{ID: "C", Title: "Frontend", DependsOn: []string{"B"}},
	}
	result := RenderGraph(nodes)

	// All nodes should appear
	if !strings.Contains(result, "A: Auth") {
		t.Errorf("missing A: Auth in:\n%s", result)
	}
	if !strings.Contains(result, "B: API") {
		t.Errorf("missing B: API in:\n%s", result)
	}
	if !strings.Contains(result, "C: Front") {
		t.Errorf("missing C: Front in:\n%s", result)
	}

	// Should have vertical connectors
	if !strings.Contains(result, "▼") {
		t.Errorf("expected vertical arrows in:\n%s", result)
	}

	// Each node should be on a different layer (different section)
	lines := strings.Split(result, "\n")
	boxTopCount := 0
	for _, line := range lines {
		if strings.Contains(line, "┌") {
			boxTopCount++
		}
	}
	if boxTopCount != 3 {
		t.Errorf("expected 3 box rows for linear chain, got %d:\n%s", boxTopCount, result)
	}
}

func TestRenderGraph_Parallel(t *testing.T) {
	nodes := []GraphNode{
		{ID: "A", Title: "Auth", DependsOn: []string{}},
		{ID: "B", Title: "API", DependsOn: []string{}},
	}
	result := RenderGraph(nodes)

	// Both nodes should be on the same row
	lines := strings.Split(result, "\n")
	boxTopCount := 0
	for _, line := range lines {
		if strings.Contains(line, "┌") {
			boxTopCount++
		}
	}
	if boxTopCount != 1 {
		t.Errorf("expected 1 box row for parallel nodes, got %d:\n%s", boxTopCount, result)
	}

	// Both labels should appear
	if !strings.Contains(result, "A: Auth") || !strings.Contains(result, "B: API") {
		t.Errorf("expected both labels in:\n%s", result)
	}
}

func TestRenderGraph_Diamond(t *testing.T) {
	nodes := []GraphNode{
		{ID: "A", Title: "Root", DependsOn: []string{}},
		{ID: "B", Title: "Left", DependsOn: []string{"A"}},
		{ID: "C", Title: "Right", DependsOn: []string{"A"}},
		{ID: "D", Title: "Merge", DependsOn: []string{"B", "C"}},
	}
	result := RenderGraph(nodes)

	// A should be alone on layer 0
	// B and C should be on layer 1 (same row)
	// D should be on layer 2
	if !strings.Contains(result, "A: Root") {
		t.Errorf("missing A: Root in:\n%s", result)
	}
	if !strings.Contains(result, "B: Left") {
		t.Errorf("missing B: Left in:\n%s", result)
	}
	if !strings.Contains(result, "C: Right") {
		t.Errorf("missing C: Right in:\n%s", result)
	}
	if !strings.Contains(result, "D: Merge") {
		t.Errorf("missing D: Merge in:\n%s", result)
	}

	// B and C should be on the same line (same layer)
	lines := strings.Split(result, "\n")
	for _, line := range lines {
		if strings.Contains(line, "B: Left") && strings.Contains(line, "C: Right") {
			return // Found them on the same line
		}
	}
	t.Errorf("B and C should be on the same row in diamond:\n%s", result)
}

func TestRenderGraph_Complex(t *testing.T) {
	// 5+ nodes with mixed dependencies
	nodes := []GraphNode{
		{ID: "A", Title: "Setup", DependsOn: []string{}},
		{ID: "B", Title: "Auth", DependsOn: []string{"A"}},
		{ID: "C", Title: "DB", DependsOn: []string{"A"}},
		{ID: "D", Title: "API", DependsOn: []string{"B", "C"}},
		{ID: "E", Title: "Tests", DependsOn: []string{"D"}},
		{ID: "F", Title: "Deploy", DependsOn: []string{"E"}},
	}
	result := RenderGraph(nodes)

	// All nodes should appear
	for _, n := range nodes {
		label := n.ID + ": " + n.Title
		if !strings.Contains(result, label) {
			t.Errorf("missing %s in:\n%s", label, result)
		}
	}

	// Should have connectors
	if !strings.Contains(result, "▼") {
		t.Errorf("expected arrows in:\n%s", result)
	}

	t.Logf("Complex graph output:\n%s", result)
}

func TestRenderGraph_CycleDetection(t *testing.T) {
	nodes := []GraphNode{
		{ID: "A", Title: "One", DependsOn: []string{"B"}},
		{ID: "B", Title: "Two", DependsOn: []string{"A"}},
	}
	result := RenderGraph(nodes)
	if !strings.Contains(result, "cycle") {
		t.Errorf("expected cycle error message, got:\n%s", result)
	}
}

func TestRenderGraph_WithStatus(t *testing.T) {
	nodes := []GraphNode{
		{ID: "A", Title: "Auth", Status: "completed", DependsOn: []string{}},
		{ID: "B", Title: "API", Status: "in_progress", DependsOn: []string{"A"}},
	}
	result := RenderGraph(nodes)
	if !strings.Contains(result, "A: Auth") {
		t.Errorf("missing label in:\n%s", result)
	}
	if !strings.Contains(result, "B: API") {
		t.Errorf("missing label in:\n%s", result)
	}
}

func TestAssignLayers(t *testing.T) {
	nodes := []GraphNode{
		{ID: "A", DependsOn: []string{}},
		{ID: "B", DependsOn: []string{"A"}},
		{ID: "C", DependsOn: []string{"A"}},
		{ID: "D", DependsOn: []string{"B", "C"}},
	}
	layers := assignLayers(nodes)
	if layers == nil {
		t.Fatal("expected layers, got nil (cycle detected)")
	}
	if layers["A"] != 0 {
		t.Errorf("A should be layer 0, got %d", layers["A"])
	}
	if layers["B"] != 1 {
		t.Errorf("B should be layer 1, got %d", layers["B"])
	}
	if layers["C"] != 1 {
		t.Errorf("C should be layer 1, got %d", layers["C"])
	}
	if layers["D"] != 2 {
		t.Errorf("D should be layer 2, got %d", layers["D"])
	}
}

func TestTasksToGraphNodes(t *testing.T) {
	tasks := []*Task{
		{ID: "abc123", Title: "Auth module", Status: StatusCompleted, DependsOn: []string{}},
		{ID: "def456", Title: "API client", Status: StatusInProgress, DependsOn: []string{"abc123"}},
	}
	nodes := TasksToGraphNodes(tasks)
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(nodes))
	}
	if nodes[0].ID != "abc123" || nodes[0].Title != "Auth module" {
		t.Errorf("unexpected node 0: %+v", nodes[0])
	}
	if nodes[1].Status != string(StatusInProgress) {
		t.Errorf("unexpected status: %+v", nodes[1])
	}
	if nodes[1].DependsOn[0] != "abc123" {
		t.Errorf("unexpected deps: %+v", nodes[1].DependsOn)
	}
}

func TestTasksToGraphNodes_FiltersMissingDependencies(t *testing.T) {
	tasks := []*Task{
		{ID: "child", Title: "Child", DependsOn: []string{"parent", "missing"}},
		{ID: "parent", Title: "Parent"},
	}

	nodes := TasksToGraphNodes(tasks)
	if len(nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(nodes))
	}

	if got := nodes[0].DependsOn; len(got) != 1 || got[0] != "parent" {
		t.Fatalf("expected missing dependencies to be filtered, got %+v", got)
	}
}
