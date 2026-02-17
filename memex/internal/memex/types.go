package memex

import "time"

// Note represents a single knowledge unit in the graph.
type Note struct {
	ID        string     `json:"id"`
	Content   string     `json:"content"`
	Type      string     `json:"type"`                  // decision, question, pattern, risk, observation, todo
	Tags      []string   `json:"tags"`                  // for categorization
	Sources   []Source   `json:"sources"`               // file path citations (project-relative)
	Relations []Relation `json:"relations"`             // graph edges
	Status    string     `json:"status"`                // open, resolved, superseded
	Embedding []float32  `json:"embedding,omitempty"`   // 384-dim (local, optional)
	CreatedAt string     `json:"created_at"`
	UpdatedAt string     `json:"updated_at"`
}

// Source links a note to a specific file in a project.
type Source struct {
	Project string `json:"project"` // git remote name or dir name
	Path    string `json:"path"`    // relative to project root
}

// SourceKey returns "project:path" for index lookup.
func (s Source) Key() string {
	if s.Project == "" {
		return s.Path
	}
	return s.Project + ":" + s.Path
}

// Relation represents a directed edge in the knowledge graph.
type Relation struct {
	TargetID string `json:"target_id"`
	Type     string `json:"type"` // relates_to, depends_on, contradicts, supersedes, elaborates, blocks
}

// Config holds user-configurable settings.
type Config struct {
	APIKey           string `json:"api_key,omitempty"`
	EmbeddingEnabled bool   `json:"embedding_enabled"`
	Model            string `json:"model,omitempty"` // default: claude-haiku-4-5-20251001
}

// DefaultConfig returns config with sensible defaults.
func DefaultConfig() Config {
	return Config{
		Model: "claude-haiku-4-5-20251001",
	}
}

// TagIndex maps tag → note IDs.
type TagIndex map[string][]string

// SourceIndex maps source key → note IDs.
type SourceIndex map[string][]string

// GraphEdge represents an edge in the adjacency list.
type GraphEdge struct {
	TargetID string `json:"target_id"`
	Type     string `json:"type"`
}

// GraphIndex maps note ID → outgoing edges.
type GraphIndex map[string][]GraphEdge

// EmbeddingIndex maps note ID → embedding vector.
type EmbeddingIndex map[string][]float32

// NoteWithRelations is returned by context queries.
type NoteWithRelations struct {
	Note     Note       `json:"note"`
	Incoming []Relation `json:"incoming,omitempty"` // edges pointing to this note
}

// NoteSummary is returned by list queries.
type NoteSummary struct {
	ID      string   `json:"id"`
	Preview string   `json:"preview"` // first line of content
	Type    string   `json:"type"`
	Tags    []string `json:"tags"`
	Status  string   `json:"status"`
}

// EnrichmentResult is returned by the LLM enricher.
type EnrichmentResult struct {
	Relations  []Relation `json:"relations"`
	Superseded []string   `json:"superseded,omitempty"` // note IDs that are superseded
}

// SearchParams holds search query parameters.
type SearchParams struct {
	Tag    string `json:"tag,omitempty"`
	Source string `json:"source,omitempty"`
	Query  string `json:"query,omitempty"`
	Type   string `json:"type,omitempty"`
	Status string `json:"status,omitempty"`
}

// NowRFC3339 returns the current time in RFC3339 format.
func NowRFC3339() string {
	return time.Now().Format(time.RFC3339)
}
