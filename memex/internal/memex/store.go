package memex

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Store manages per-note files and inverted indexes.
type Store struct {
	baseDir string
	mu      sync.RWMutex

	// In-memory caches (flushed to disk on change)
	tags       TagIndex
	sources    SourceIndex
	graph      GraphIndex
	embeddings EmbeddingIndex
}

// NewStore creates a Store at the default location (~/.memex).
func NewStore() (*Store, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to get home directory: %w", err)
	}
	return NewStoreAt(filepath.Join(homeDir, ".memex"))
}

// NewStoreAt creates a Store at the specified directory.
func NewStoreAt(baseDir string) (*Store, error) {
	dirs := []string{
		filepath.Join(baseDir, "notes"),
		filepath.Join(baseDir, "index"),
		filepath.Join(baseDir, "embeddings"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return nil, fmt.Errorf("failed to create directory %s: %w", d, err)
		}
	}

	s := &Store{
		baseDir:    baseDir,
		tags:       make(TagIndex),
		sources:    make(SourceIndex),
		graph:      make(GraphIndex),
		embeddings: make(EmbeddingIndex),
	}

	// Load indexes from disk
	s.loadIndex("tags.json", &s.tags)
	s.loadIndex("sources.json", &s.sources)
	s.loadIndex("graph.json", &s.graph)
	s.loadEmbeddings()

	return s, nil
}

// generateID returns an 8-char random hex string.
func generateID() string {
	b := make([]byte, 4)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// --- CRUD Operations ---

// Add stores a new note, updates indexes, and returns the assigned ID.
func (s *Store) Add(note Note) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if note.ID == "" {
		note.ID = generateID()
	}
	now := NowRFC3339()
	note.CreatedAt = now
	note.UpdatedAt = now

	if note.Status == "" {
		note.Status = "open"
	}
	if note.Tags == nil {
		note.Tags = []string{}
	}
	if note.Sources == nil {
		note.Sources = []Source{}
	}
	if note.Relations == nil {
		note.Relations = []Relation{}
	}

	// Write note file
	if err := s.writeNote(note); err != nil {
		return "", err
	}

	// Update indexes
	s.indexAdd(note)
	if err := s.flushIndexes(); err != nil {
		return "", err
	}

	return note.ID, nil
}

// Get retrieves a note by ID.
func (s *Store) Get(id string) (*Note, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.readNote(id)
}

// Update modifies an existing note and re-indexes.
func (s *Store) Update(id string, updates map[string]interface{}) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	note, err := s.readNote(id)
	if err != nil {
		return err
	}

	// Remove old index entries
	s.indexRemove(*note)

	// Apply updates
	if v, ok := updates["content"]; ok {
		note.Content = v.(string)
	}
	if v, ok := updates["type"]; ok {
		note.Type = v.(string)
	}
	if v, ok := updates["status"]; ok {
		note.Status = v.(string)
	}
	if v, ok := updates["tags"]; ok {
		note.Tags = v.([]string)
	}
	if v, ok := updates["sources"]; ok {
		note.Sources = v.([]Source)
	}
	note.UpdatedAt = NowRFC3339()

	// Write updated note
	if err := s.writeNote(*note); err != nil {
		return err
	}

	// Re-index
	s.indexAdd(*note)
	return s.flushIndexes()
}

// Delete removes a note and cleans up all indexes.
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	note, err := s.readNote(id)
	if err != nil {
		return err
	}

	// Remove note file
	notePath := filepath.Join(s.baseDir, "notes", id+".json")
	if err := os.Remove(notePath); err != nil {
		return fmt.Errorf("failed to delete note: %w", err)
	}

	// Remove from indexes
	s.indexRemove(*note)

	// Remove from graph (both outgoing and incoming edges)
	delete(s.graph, id)
	for nid, edges := range s.graph {
		filtered := edges[:0]
		for _, e := range edges {
			if e.TargetID != id {
				filtered = append(filtered, e)
			}
		}
		if len(filtered) == 0 {
			delete(s.graph, nid)
		} else {
			s.graph[nid] = filtered
		}
	}

	// Remove embedding
	delete(s.embeddings, id)

	return s.flushIndexes()
}

// List returns summaries of all notes.
func (s *Store) List() ([]NoteSummary, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	notesDir := filepath.Join(s.baseDir, "notes")
	entries, err := os.ReadDir(notesDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []NoteSummary{}, nil
		}
		return nil, fmt.Errorf("failed to read notes directory: %w", err)
	}

	var summaries []NoteSummary
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		note, err := s.readNote(id)
		if err != nil {
			continue
		}
		preview := note.Content
		if idx := strings.IndexByte(preview, '\n'); idx >= 0 {
			preview = preview[:idx]
		}
		if len(preview) > 80 {
			preview = preview[:80] + "..."
		}
		summaries = append(summaries, NoteSummary{
			ID:      note.ID,
			Preview: preview,
			Type:    note.Type,
			Tags:    note.Tags,
			Status:  note.Status,
		})
	}

	return summaries, nil
}

// AddRelations adds relation edges to a note and updates the graph index.
func (s *Store) AddRelations(id string, relations []Relation) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	note, err := s.readNote(id)
	if err != nil {
		return err
	}

	note.Relations = append(note.Relations, relations...)
	note.UpdatedAt = NowRFC3339()

	if err := s.writeNote(*note); err != nil {
		return err
	}

	// Update graph index
	for _, rel := range relations {
		s.graph[id] = append(s.graph[id], GraphEdge{
			TargetID: rel.TargetID,
			Type:     rel.Type,
		})
	}

	return s.flushIndexes()
}

// UpdateStatus updates only the status field of a note.
func (s *Store) UpdateStatus(id string, status string) error {
	return s.Update(id, map[string]interface{}{"status": status})
}

// SetEmbedding stores an embedding vector for a note.
func (s *Store) SetEmbedding(id string, embedding []float32) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.embeddings[id] = embedding
	return s.flushEmbeddings()
}

// GetEmbedding returns the embedding for a note, or nil if not set.
func (s *Store) GetEmbedding(id string) []float32 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.embeddings[id]
}

// AllEmbeddings returns all note IDs that have embeddings.
func (s *Store) AllEmbeddings() map[string][]float32 {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make(map[string][]float32, len(s.embeddings))
	for k, v := range s.embeddings {
		result[k] = v
	}
	return result
}

// GetConfig reads the config file.
func (s *Store) GetConfig() Config {
	cfg := DefaultConfig()
	data, err := os.ReadFile(filepath.Join(s.baseDir, "config.json"))
	if err != nil {
		return cfg
	}
	json.Unmarshal(data, &cfg)
	if cfg.Model == "" {
		cfg.Model = DefaultConfig().Model
	}
	return cfg
}

// SetConfig writes a config key-value pair.
func (s *Store) SetConfig(key, value string) error {
	cfg := s.GetConfig()
	switch key {
	case "api_key":
		cfg.APIKey = value
	case "embedding_enabled":
		cfg.EmbeddingEnabled = value == "true"
	case "model":
		cfg.Model = value
	default:
		return fmt.Errorf("unknown config key: %s", key)
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(s.baseDir, "config.json"), data)
}

// BaseDir returns the base directory path.
func (s *Store) BaseDir() string {
	return s.baseDir
}

// TagsIndex returns a copy of the tags index for read-only use.
func (s *Store) TagsIndex() TagIndex {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make(TagIndex, len(s.tags))
	for k, v := range s.tags {
		ids := make([]string, len(v))
		copy(ids, v)
		result[k] = ids
	}
	return result
}

// SourcesIndex returns a copy of the sources index.
func (s *Store) SourcesIndex() SourceIndex {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make(SourceIndex, len(s.sources))
	for k, v := range s.sources {
		ids := make([]string, len(v))
		copy(ids, v)
		result[k] = ids
	}
	return result
}

// GraphIdx returns a copy of the graph index.
func (s *Store) GraphIdx() GraphIndex {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make(GraphIndex, len(s.graph))
	for k, v := range s.graph {
		edges := make([]GraphEdge, len(v))
		copy(edges, v)
		result[k] = edges
	}
	return result
}

// --- Internal helpers ---

func (s *Store) notePath(id string) string {
	return filepath.Join(s.baseDir, "notes", id+".json")
}

func (s *Store) readNote(id string) (*Note, error) {
	data, err := os.ReadFile(s.notePath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("note not found: %s", id)
		}
		return nil, fmt.Errorf("failed to read note: %w", err)
	}
	var note Note
	if err := json.Unmarshal(data, &note); err != nil {
		return nil, fmt.Errorf("failed to parse note: %w", err)
	}
	return &note, nil
}

func (s *Store) writeNote(note Note) error {
	data, err := json.MarshalIndent(note, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal note: %w", err)
	}
	return atomicWrite(s.notePath(note.ID), data)
}

func (s *Store) indexAdd(note Note) {
	for _, tag := range note.Tags {
		s.tags[tag] = appendUnique(s.tags[tag], note.ID)
	}
	for _, src := range note.Sources {
		key := src.Key()
		s.sources[key] = appendUnique(s.sources[key], note.ID)
	}
	for _, rel := range note.Relations {
		s.graph[note.ID] = append(s.graph[note.ID], GraphEdge{
			TargetID: rel.TargetID,
			Type:     rel.Type,
		})
	}
}

func (s *Store) indexRemove(note Note) {
	for _, tag := range note.Tags {
		s.tags[tag] = removeFromSlice(s.tags[tag], note.ID)
		if len(s.tags[tag]) == 0 {
			delete(s.tags, tag)
		}
	}
	for _, src := range note.Sources {
		key := src.Key()
		s.sources[key] = removeFromSlice(s.sources[key], note.ID)
		if len(s.sources[key]) == 0 {
			delete(s.sources, key)
		}
	}
	delete(s.graph, note.ID)
}

func (s *Store) flushIndexes() error {
	if err := s.saveIndex("tags.json", s.tags); err != nil {
		return err
	}
	if err := s.saveIndex("sources.json", s.sources); err != nil {
		return err
	}
	return s.saveIndex("graph.json", s.graph)
}

func (s *Store) loadIndex(filename string, target interface{}) {
	data, err := os.ReadFile(filepath.Join(s.baseDir, "index", filename))
	if err != nil {
		return
	}
	json.Unmarshal(data, target)
}

func (s *Store) saveIndex(filename string, data interface{}) error {
	b, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal index %s: %w", filename, err)
	}
	return atomicWrite(filepath.Join(s.baseDir, "index", filename), b)
}

func (s *Store) loadEmbeddings() {
	data, err := os.ReadFile(filepath.Join(s.baseDir, "embeddings", "vectors.json"))
	if err != nil {
		return
	}
	json.Unmarshal(data, &s.embeddings)
}

func (s *Store) flushEmbeddings() error {
	b, err := json.MarshalIndent(s.embeddings, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal embeddings: %w", err)
	}
	return atomicWrite(filepath.Join(s.baseDir, "embeddings", "vectors.json"), b)
}

// atomicWrite writes data to a temp file then renames.
func atomicWrite(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return fmt.Errorf("failed to write temp file: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("failed to rename temp file: %w", err)
	}
	return nil
}

func appendUnique(slice []string, item string) []string {
	for _, s := range slice {
		if s == item {
			return slice
		}
	}
	return append(slice, item)
}

func removeFromSlice(slice []string, item string) []string {
	result := slice[:0]
	for _, s := range slice {
		if s != item {
			result = append(result, s)
		}
	}
	return result
}
