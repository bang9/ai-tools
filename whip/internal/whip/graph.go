package whip

import (
	"fmt"
	"strings"
)

// GraphNode represents a single node in a task dependency graph.
type GraphNode struct {
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Status    string   `json:"status,omitempty"`
	DependsOn []string `json:"deps"`
}

// RenderGraph takes a list of graph nodes and returns an ASCII box diagram
// showing dependency relationships. Nodes at the same depth are placed on
// the same row. Dependencies are shown with vertical arrows.
func RenderGraph(nodes []GraphNode) string {
	if len(nodes) == 0 {
		return ""
	}

	// Build adjacency: parent -> children (reverse of DependsOn)
	nodeMap := make(map[string]*GraphNode)
	for i := range nodes {
		nodeMap[nodes[i].ID] = &nodes[i]
	}

	// Assign layers via topological sort (BFS-based)
	layers := assignLayers(nodes)
	if layers == nil {
		return "Error: cycle detected in dependency graph"
	}

	// Group nodes by layer
	maxLayer := 0
	for _, l := range layers {
		if l > maxLayer {
			maxLayer = l
		}
	}

	layerGroups := make([][]string, maxLayer+1)
	for id, l := range layers {
		layerGroups[l] = append(layerGroups[l], id)
	}

	// Stabilize order within each layer: preserve input order
	inputOrder := make(map[string]int)
	for i, n := range nodes {
		inputOrder[n.ID] = i
	}
	for l := range layerGroups {
		sortByInputOrder(layerGroups[l], inputOrder)
	}

	// Insert passthrough nodes for cross-layer edges
	passthroughs := map[string]map[int]bool{} // parentID -> set of layers it passes through
	for _, n := range nodes {
		for _, dep := range n.DependsOn {
			parentLayer := layers[dep]
			childLayer := layers[n.ID]
			if childLayer-parentLayer > 1 {
				if passthroughs[dep] == nil {
					passthroughs[dep] = map[int]bool{}
				}
				for l := parentLayer + 1; l < childLayer; l++ {
					passthroughs[dep][l] = true
				}
			}
		}
	}

	// Render boxes
	const (
		padH = 1 // horizontal padding inside box
		maxW = 20
		hGap = 4 // horizontal gap between boxes
	)

	// Calculate box widths per node
	boxWidth := make(map[string]int)
	for _, n := range nodes {
		label := formatLabel(n.ID, n.Title)
		w := len([]rune(label)) + padH*2 + 2 // +2 for border chars
		if w > maxW {
			w = maxW
		}
		boxWidth[n.ID] = w
	}

	// Calculate x-positions: each layer is laid out horizontally
	// xPos is the left edge of each box
	xPos := make(map[string]int)
	for _, group := range layerGroups {
		x := 0
		for _, id := range group {
			xPos[id] = x
			x += boxWidth[id] + hGap
		}
	}

	// Render each layer
	var result []string
	for l, group := range layerGroups {
		if len(group) == 0 {
			continue
		}

		// Top border line
		topLine := renderTopBorder(group, boxWidth, hGap)
		// Middle line (label)
		midLine := renderMiddle(group, nodes, nodeMap, boxWidth, padH, hGap)
		// Bottom border line
		botLine := renderBottomBorder(group, boxWidth, hGap, l < maxLayer, layers, nodeMap, nodes)

		// Overlay passthrough vertical lines through this layer's box rows
		var ptPositions []int
		for parentID, layerSet := range passthroughs {
			if layerSet[l] {
				ptPositions = append(ptPositions, xPos[parentID]+boxWidth[parentID]/2)
			}
		}
		if len(ptPositions) > 0 {
			topLine = overlayPassthroughs(topLine, ptPositions)
			midLine = overlayPassthroughs(midLine, ptPositions)
			botLine = overlayPassthroughs(botLine, ptPositions)
		}

		result = append(result, topLine)
		result = append(result, midLine)
		result = append(result, botLine)

		// Draw vertical connectors to next layer
		if l < maxLayer {
			connectors := renderConnectors(group, layerGroups[l+1], boxWidth, hGap, xPos, layers, nodeMap, nodes, passthroughs, l)
			if connectors != "" {
				result = append(result, connectors)
			}
		}
	}

	return strings.Join(result, "\n")
}

// assignLayers assigns each node to a layer (depth) based on its dependencies.
// Layer 0 = no dependencies. Returns nil if a cycle is detected.
func assignLayers(nodes []GraphNode) map[string]int {
	// Build in-degree and adjacency
	inDegree := make(map[string]int)
	children := make(map[string][]string) // dep -> nodes that depend on it
	idSet := make(map[string]bool)

	for _, n := range nodes {
		idSet[n.ID] = true
		if _, ok := inDegree[n.ID]; !ok {
			inDegree[n.ID] = 0
		}
		for _, dep := range n.DependsOn {
			if !idSet[dep] {
				idSet[dep] = true
			}
			children[dep] = append(children[dep], n.ID)
			inDegree[n.ID]++
		}
	}

	// Ensure all deps referenced have entries
	for _, n := range nodes {
		for _, dep := range n.DependsOn {
			if _, ok := inDegree[dep]; !ok {
				inDegree[dep] = 0
			}
		}
	}

	// BFS topological sort
	layers := make(map[string]int)
	queue := []string{}

	for _, n := range nodes {
		if inDegree[n.ID] == 0 {
			queue = append(queue, n.ID)
			layers[n.ID] = 0
		}
	}

	processed := 0
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		processed++

		for _, child := range children[id] {
			newLayer := layers[id] + 1
			if newLayer > layers[child] {
				layers[child] = newLayer
			}
			inDegree[child]--
			if inDegree[child] == 0 {
				queue = append(queue, child)
			}
		}
	}

	// Check for cycle: only count nodes that are in our input list
	nodeCount := len(nodes)
	if processed < nodeCount {
		return nil
	}

	return layers
}

func sortByInputOrder(ids []string, order map[string]int) {
	// Simple insertion sort (layers are small)
	for i := 1; i < len(ids); i++ {
		for j := i; j > 0 && order[ids[j]] < order[ids[j-1]]; j-- {
			ids[j], ids[j-1] = ids[j-1], ids[j]
		}
	}
}

func formatLabel(id, title string) string {
	if title == "" {
		return id
	}
	return fmt.Sprintf("%s: %s", id, title)
}

func truncateRunes(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	if maxLen <= 1 {
		return string(runes[:maxLen])
	}
	return string(runes[:maxLen-1]) + "…"
}

func overlayPassthroughs(line string, positions []int) string {
	runes := []rune(line)
	maxNeeded := 0
	for _, x := range positions {
		if x+1 > maxNeeded {
			maxNeeded = x + 1
		}
	}
	for len(runes) < maxNeeded {
		runes = append(runes, ' ')
	}
	for _, x := range positions {
		if x < len(runes) && runes[x] == ' ' {
			runes[x] = '│'
		}
	}
	return strings.TrimRight(string(runes), " ")
}

func renderTopBorder(group []string, boxWidth map[string]int, hGap int) string {
	var parts []string
	for _, id := range group {
		w := boxWidth[id]
		parts = append(parts, "┌"+strings.Repeat("─", w-2)+"┐")
	}
	return strings.Join(parts, strings.Repeat(" ", hGap))
}

func renderMiddle(group []string, nodes []GraphNode, nodeMap map[string]*GraphNode, boxWidth map[string]int, padH, hGap int) string {
	var parts []string
	for _, id := range group {
		n := nodeMap[id]
		w := boxWidth[id]
		innerW := w - 2 // subtract border chars
		label := formatLabel(n.ID, n.Title)
		label = truncateRunes(label, innerW-padH*2)

		// Pad label to fill inner width
		labelRunes := []rune(label)
		leftPad := padH
		rightPad := innerW - leftPad - len(labelRunes)
		if rightPad < 0 {
			rightPad = 0
		}

		parts = append(parts, "│"+strings.Repeat(" ", leftPad)+string(labelRunes)+strings.Repeat(" ", rightPad)+"│")
	}
	return strings.Join(parts, strings.Repeat(" ", hGap))
}

func renderBottomBorder(group []string, boxWidth map[string]int, hGap int, hasNextLayer bool, layers map[string]int, nodeMap map[string]*GraphNode, nodes []GraphNode) string {
	var parts []string
	for _, id := range group {
		w := boxWidth[id]
		// Check if this node has any children in the next layer
		hasChild := false
		if hasNextLayer {
			for _, n := range nodes {
				for _, dep := range n.DependsOn {
					if dep == id && layers[n.ID] > layers[id] {
						hasChild = true
						break
					}
				}
				if hasChild {
					break
				}
			}
		}

		if hasChild {
			mid := (w - 2) / 2
			parts = append(parts, "└"+strings.Repeat("─", mid)+"┬"+strings.Repeat("─", w-3-mid)+"┘")
		} else {
			parts = append(parts, "└"+strings.Repeat("─", w-2)+"┘")
		}
	}
	return strings.Join(parts, strings.Repeat(" ", hGap))
}

// direction flags for connector character mapping
const (
	dirUp    = 1 << 0
	dirDown  = 1 << 1
	dirLeft  = 1 << 2
	dirRight = 1 << 3
)

var dirToRune = map[int]rune{
	dirUp | dirDown:                      '│',
	dirLeft | dirRight:                   '─',
	dirUp | dirRight:                     '└',
	dirUp | dirLeft:                      '┘',
	dirDown | dirRight:                   '┌',
	dirDown | dirLeft:                    '┐',
	dirUp | dirDown | dirRight:           '├',
	dirUp | dirDown | dirLeft:            '┤',
	dirDown | dirLeft | dirRight:         '┬',
	dirUp | dirLeft | dirRight:           '┴',
	dirUp | dirDown | dirLeft | dirRight: '┼',
	dirUp:                                '│',
	dirDown:                              '│',
	dirLeft:                              '─',
	dirRight:                             '─',
}

func renderConnectors(parentGroup, childGroup []string, boxWidth map[string]int, hGap int, xPos map[string]int, layers map[string]int, nodeMap map[string]*GraphNode, nodes []GraphNode, passthroughs map[string]map[int]bool, currentLayer int) string {
	type edge struct {
		parentID string
		childID  string
	}
	var edges []edge
	parentSet := make(map[string]bool, len(parentGroup))
	for _, id := range parentGroup {
		parentSet[id] = true
	}
	for _, childID := range childGroup {
		n := nodeMap[childID]
		if n == nil {
			continue
		}
		for _, dep := range n.DependsOn {
			if parentSet[dep] {
				// Direct edge: parent is in current layer's group
				edges = append(edges, edge{dep, childID})
			} else if depLayer, ok := layers[dep]; ok && depLayer < currentLayer {
				// Landing edge: parent from an earlier layer connects to this child
				edges = append(edges, edge{dep, childID})
			}
		}
	}

	// Passthrough edges: parents from earlier layers passing through this gap
	passthroughCenters := map[int]bool{}
	for parentID, layerSet := range passthroughs {
		if layerSet[currentLayer+1] {
			// This parent passes through the next layer — draw vertical line
			cx := xPos[parentID] + boxWidth[parentID]/2
			passthroughCenters[cx] = true
		}
	}

	if len(edges) == 0 && len(passthroughCenters) == 0 {
		return ""
	}

	parentCenter := make(map[string]int)
	for _, id := range parentGroup {
		parentCenter[id] = xPos[id] + boxWidth[id]/2
	}
	// Add centers for landing parents (from earlier layers)
	for _, e := range edges {
		if _, ok := parentCenter[e.parentID]; !ok {
			parentCenter[e.parentID] = xPos[e.parentID] + boxWidth[e.parentID]/2
		}
	}
	childCenter := make(map[string]int)
	for _, id := range childGroup {
		childCenter[id] = xPos[id] + boxWidth[id]/2
	}

	// Find the total width we need
	maxX := 0
	for _, id := range parentGroup {
		if end := xPos[id] + boxWidth[id]; end > maxX {
			maxX = end
		}
	}
	for _, id := range childGroup {
		if end := xPos[id] + boxWidth[id]; end > maxX {
			maxX = end
		}
	}
	// Extend for landing parents from earlier layers
	for _, e := range edges {
		if !parentSet[e.parentID] {
			if end := xPos[e.parentID] + boxWidth[e.parentID]; end > maxX {
				maxX = end
			}
		}
	}

	// Build direction grid for connector line
	dirs := make([]int, maxX)

	for _, e := range edges {
		px := parentCenter[e.parentID]
		cx := childCenter[e.childID]

		if px == cx {
			if px < maxX {
				dirs[px] |= dirUp | dirDown
			}
		} else {
			lo, hi := px, cx
			if lo > hi {
				lo, hi = hi, lo
			}
			if px < maxX {
				dirs[px] |= dirUp
				if cx > px {
					dirs[px] |= dirRight
				} else {
					dirs[px] |= dirLeft
				}
			}
			if cx < maxX {
				dirs[cx] |= dirDown
				if px > cx {
					dirs[cx] |= dirRight
				} else {
					dirs[cx] |= dirLeft
				}
			}
			for x := lo + 1; x < hi && x < maxX; x++ {
				dirs[x] |= dirLeft | dirRight
			}
		}
	}

	// Add passthrough vertical lines
	for cx := range passthroughCenters {
		if cx < maxX {
			dirs[cx] |= dirUp | dirDown
		}
	}

	// Convert direction grid to runes
	line1 := make([]rune, maxX)
	for i := range line1 {
		if dirs[i] == 0 {
			line1[i] = ' '
		} else if r, ok := dirToRune[dirs[i]]; ok {
			line1[i] = r
		} else {
			line1[i] = '┼'
		}
	}

	// Build arrow line: ▼ at each unique child center, │ for passthroughs
	line2 := make([]rune, maxX)
	for i := range line2 {
		line2[i] = ' '
	}
	for _, e := range edges {
		cx := childCenter[e.childID]
		if cx < maxX {
			line2[cx] = '▼'
		}
	}
	for cx := range passthroughCenters {
		if cx < maxX && line2[cx] == ' ' {
			line2[cx] = '│'
		}
	}

	s1 := strings.TrimRight(string(line1), " ")
	s2 := strings.TrimRight(string(line2), " ")

	if s1 == "" && s2 == "" {
		return ""
	}

	return s1 + "\n" + s2
}

// TasksToGraphNodes converts a slice of Tasks to GraphNodes for rendering.
func TasksToGraphNodes(tasks []*Task) []GraphNode {
	taskIDs := make(map[string]struct{}, len(tasks))
	for _, t := range tasks {
		taskIDs[t.ID] = struct{}{}
	}

	nodes := make([]GraphNode, len(tasks))
	for i, t := range tasks {
		deps := make([]string, 0, len(t.DependsOn))
		for _, dep := range t.DependsOn {
			if _, ok := taskIDs[dep]; ok {
				deps = append(deps, dep)
			}
		}

		nodes[i] = GraphNode{
			ID:        t.ID,
			Title:     t.Title,
			Status:    string(t.Status),
			DependsOn: deps,
		}
	}
	return nodes
}
