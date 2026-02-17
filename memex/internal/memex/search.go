package memex

import (
	"math"
	"os"
	"sort"
	"strings"
)

// Search finds notes matching the given parameters.
func (s *Store) Search(params SearchParams) ([]Note, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Collect candidate IDs from index lookups
	var candidateSets []map[string]bool

	// Filter by tag
	if params.Tag != "" {
		set := make(map[string]bool)
		for _, id := range s.tags[params.Tag] {
			set[id] = true
		}
		candidateSets = append(candidateSets, set)
	}

	// Filter by source (prefix match)
	if params.Source != "" {
		set := make(map[string]bool)
		for key, ids := range s.sources {
			if strings.HasPrefix(key, params.Source) {
				for _, id := range ids {
					set[id] = true
				}
			}
		}
		candidateSets = append(candidateSets, set)
	}

	// Intersect candidate sets (if multiple filters, require all to match)
	var candidateIDs map[string]bool
	if len(candidateSets) > 0 {
		candidateIDs = candidateSets[0]
		for i := 1; i < len(candidateSets); i++ {
			intersected := make(map[string]bool)
			for id := range candidateIDs {
				if candidateSets[i][id] {
					intersected[id] = true
				}
			}
			candidateIDs = intersected
		}
	}

	// Load candidate notes
	var candidates []Note
	if candidateIDs != nil {
		for id := range candidateIDs {
			note, err := s.readNote(id)
			if err != nil {
				continue
			}
			candidates = append(candidates, *note)
		}
	} else {
		// No index filter — scan all notes
		notesDir := s.baseDir + "/notes"
		entries, err := readDirSafe(notesDir)
		if err != nil {
			return nil, err
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			id := strings.TrimSuffix(entry.Name(), ".json")
			note, err := s.readNote(id)
			if err != nil {
				continue
			}
			candidates = append(candidates, *note)
		}
	}

	// Post-filter by type
	if params.Type != "" {
		filtered := candidates[:0]
		for _, n := range candidates {
			if n.Type == params.Type {
				filtered = append(filtered, n)
			}
		}
		candidates = filtered
	}

	// Post-filter by status
	if params.Status != "" {
		filtered := candidates[:0]
		for _, n := range candidates {
			if n.Status == params.Status {
				filtered = append(filtered, n)
			}
		}
		candidates = filtered
	}

	// Rank by query if provided
	if params.Query != "" {
		candidates = bm25Rank(candidates, params.Query)
	}

	return candidates, nil
}

// Context performs BFS graph traversal from notes matching a source path.
func (s *Store) Context(source string, maxHops int) ([]NoteWithRelations, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if maxHops <= 0 {
		maxHops = 3
	}

	// Find seed note IDs matching source prefix
	seeds := make(map[string]bool)
	for key, ids := range s.sources {
		if strings.HasPrefix(key, source) {
			for _, id := range ids {
				seeds[id] = true
			}
		}
	}

	if len(seeds) == 0 {
		return []NoteWithRelations{}, nil
	}

	// BFS traversal
	visited := make(map[string]bool)
	queue := make([]string, 0, len(seeds))
	depth := make(map[string]int)

	for id := range seeds {
		queue = append(queue, id)
		depth[id] = 0
		visited[id] = true
	}

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		currentDepth := depth[current]
		if currentDepth >= maxHops {
			continue
		}

		// Follow outgoing edges
		for _, edge := range s.graph[current] {
			if !visited[edge.TargetID] {
				visited[edge.TargetID] = true
				depth[edge.TargetID] = currentDepth + 1
				queue = append(queue, edge.TargetID)
			}
		}

		// Follow incoming edges (reverse graph traversal)
		for nid, edges := range s.graph {
			for _, edge := range edges {
				if edge.TargetID == current && !visited[nid] {
					visited[nid] = true
					depth[nid] = currentDepth + 1
					queue = append(queue, nid)
				}
			}
		}
	}

	// Load visited notes with relation metadata
	var results []NoteWithRelations
	for id := range visited {
		note, err := s.readNote(id)
		if err != nil {
			continue
		}

		nwr := NoteWithRelations{Note: *note}

		// Find incoming edges
		for nid, edges := range s.graph {
			if nid == id {
				continue
			}
			for _, edge := range edges {
				if edge.TargetID == id {
					nwr.Incoming = append(nwr.Incoming, Relation{
						TargetID: nid,
						Type:     edge.Type,
					})
				}
			}
		}

		results = append(results, nwr)
	}

	return results, nil
}

// --- BM25 Ranking ---

func bm25Rank(notes []Note, query string) []Note {
	queryTerms := tokenize(query)
	if len(queryTerms) == 0 {
		return notes
	}

	// Compute document frequencies
	df := make(map[string]int)
	for _, note := range notes {
		terms := uniqueTokens(note.Content)
		for t := range terms {
			df[t]++
		}
	}

	// Compute average document length
	totalLen := 0
	for _, note := range notes {
		totalLen += len(tokenize(note.Content))
	}
	avgDL := float64(totalLen) / math.Max(float64(len(notes)), 1)

	N := float64(len(notes))
	k1 := 1.2
	b := 0.75

	type scored struct {
		note  Note
		score float64
	}

	var scoredNotes []scored
	for _, note := range notes {
		docTerms := tokenize(note.Content)
		tf := make(map[string]int)
		for _, t := range docTerms {
			tf[t]++
		}

		dl := float64(len(docTerms))
		score := 0.0

		for _, qt := range queryTerms {
			if tf[qt] == 0 {
				continue
			}
			// Use positive-only IDF (BM25+ variant for small collections)
			idf := math.Log(1 + (N-float64(df[qt])+0.5)/(float64(df[qt])+0.5))
			tfNorm := (float64(tf[qt]) * (k1 + 1)) / (float64(tf[qt]) + k1*(1-b+b*dl/avgDL))
			score += idf * tfNorm
		}

		if score > 0 {
			scoredNotes = append(scoredNotes, scored{note: note, score: score})
		}
	}

	sort.Slice(scoredNotes, func(i, j int) bool {
		return scoredNotes[i].score > scoredNotes[j].score
	})

	result := make([]Note, len(scoredNotes))
	for i, sn := range scoredNotes {
		result[i] = sn.note
	}
	return result
}

func tokenize(text string) []string {
	text = strings.ToLower(text)
	var tokens []string
	var current strings.Builder
	for _, r := range text {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' {
			current.WriteRune(r)
		} else {
			if current.Len() > 0 {
				tokens = append(tokens, current.String())
				current.Reset()
			}
		}
	}
	if current.Len() > 0 {
		tokens = append(tokens, current.String())
	}
	return tokens
}

func uniqueTokens(text string) map[string]bool {
	result := make(map[string]bool)
	for _, t := range tokenize(text) {
		result[t] = true
	}
	return result
}

// CosineSimilarity computes cosine similarity between two vectors.
func CosineSimilarity(a, b []float32) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, normA, normB float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		normA += float64(a[i]) * float64(a[i])
		normB += float64(b[i]) * float64(b[i])
	}
	if normA == 0 || normB == 0 {
		return 0
	}
	return dot / (math.Sqrt(normA) * math.Sqrt(normB))
}

func readDirSafe(dir string) ([]os.DirEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	return entries, nil
}
