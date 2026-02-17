package memex

import (
	"log"
	"math"
	"sort"
	"strings"
)

// Embedder computes embeddings for notes in the background.
// When embedding is disabled (default), it uses BM25-based text similarity as fallback.
type Embedder struct {
	queue   chan string
	store   *Store
	enabled bool
}

// NewEmbedder creates an Embedder. If not enabled, the queue is a no-op.
func NewEmbedder(store *Store, enabled bool) *Embedder {
	e := &Embedder{
		queue:   make(chan string, 100),
		store:   store,
		enabled: enabled,
	}
	if enabled {
		go e.processLoop()
	}
	return e
}

// Enqueue adds a note ID to the embedding queue.
func (e *Embedder) Enqueue(id string) {
	if !e.enabled {
		return
	}
	select {
	case e.queue <- id:
	default:
		log.Printf("embedder: queue full, dropping note %s", id)
	}
}

// IsEnabled returns whether embedding is active.
func (e *Embedder) IsEnabled() bool {
	return e.enabled
}

func (e *Embedder) processLoop() {
	for id := range e.queue {
		if err := e.processNote(id); err != nil {
			log.Printf("embedder: failed to process note %s: %v", id, err)
		}
	}
}

func (e *Embedder) processNote(id string) error {
	note, err := e.store.Get(id)
	if err != nil {
		return err
	}

	// Use simple bag-of-words embedding as a baseline.
	// When kelindar/search is integrated, this will be replaced with
	// proper sentence-transformer embeddings (all-MiniLM-L6-v2).
	embedding := bowEmbedding(note.Content)

	return e.store.SetEmbedding(id, embedding)
}

// bowEmbedding creates a simple bag-of-words embedding.
// This is a placeholder that provides basic semantic similarity
// until the proper sentence-transformer model is integrated.
func bowEmbedding(text string) []float32 {
	tokens := tokenize(text)
	if len(tokens) == 0 {
		return make([]float32, 384)
	}

	// Hash tokens into a fixed-size vector
	vec := make([]float32, 384)
	for _, token := range tokens {
		// Simple hash-based projection
		h := hashString(token)
		for i := 0; i < 3; i++ {
			idx := (h + uint32(i)*2654435761) % 384
			if h&(1<<uint(i)) != 0 {
				vec[idx] += 1.0
			} else {
				vec[idx] -= 1.0
			}
		}
	}

	// L2 normalize
	var norm float64
	for _, v := range vec {
		norm += float64(v) * float64(v)
	}
	if norm > 0 {
		norm = math.Sqrt(norm)
		for i := range vec {
			vec[i] = float32(float64(vec[i]) / norm)
		}
	}

	return vec
}

func hashString(s string) uint32 {
	var h uint32 = 2166136261
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	return h
}

// SimilarNotes finds notes similar to the given query text using embeddings.
func (e *Embedder) SimilarNotes(query string, k int) []string {
	if !e.enabled {
		return nil
	}

	queryEmb := bowEmbedding(query)
	allEmbs := e.store.AllEmbeddings()

	type scored struct {
		id    string
		score float64
	}

	var results []scored
	for id, emb := range allEmbs {
		sim := CosineSimilarity(queryEmb, emb)
		if sim > 0.1 {
			results = append(results, scored{id, sim})
		}
	}

	sort.Slice(results, func(i, j int) bool {
		return results[i].score > results[j].score
	})

	limit := k
	if len(results) < limit {
		limit = len(results)
	}

	ids := make([]string, limit)
	for i := 0; i < limit; i++ {
		ids[i] = results[i].id
	}
	return ids
}

// FindSimilarByContent finds notes with content similar to the given text.
// Uses BM25 when embeddings are disabled, cosine similarity when enabled.
func FindSimilarByContent(store *Store, text string, k int) []string {
	notes, err := store.Search(SearchParams{Query: text})
	if err != nil || len(notes) == 0 {
		return nil
	}

	limit := k
	if len(notes) < limit {
		limit = len(notes)
	}

	ids := make([]string, limit)
	for i := 0; i < limit; i++ {
		ids[i] = notes[i].ID
	}
	return ids
}

// KeywordOverlapScore computes the fraction of shared tokens between two texts.
func KeywordOverlapScore(a, b string) float64 {
	tokensA := uniqueTokens(a)
	tokensB := uniqueTokens(b)

	if len(tokensA) == 0 || len(tokensB) == 0 {
		return 0
	}

	overlap := 0
	for t := range tokensA {
		if tokensB[t] {
			overlap++
		}
	}

	// Jaccard similarity
	union := len(tokensA) + len(tokensB) - overlap
	if union == 0 {
		return 0
	}
	return float64(overlap) / float64(union)
}

// DetectProject attempts to detect the project name and relative path for a file.
func DetectProject(filePath string) Source {
	// Normalize path
	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		return Source{}
	}

	// Simple heuristic: split on common project indicators
	// In practice, the AI provides source in "project:path" format
	if idx := strings.Index(filePath, ":"); idx >= 0 {
		return Source{
			Project: filePath[:idx],
			Path:    filePath[idx+1:],
		}
	}

	return Source{Path: filePath}
}
