package memex

import (
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := NewStoreAt(dir)
	if err != nil {
		t.Fatalf("NewStoreAt failed: %v", err)
	}
	return s
}

func TestAddAndGet(t *testing.T) {
	s := newTestStore(t)

	id, err := s.Add(Note{
		Content: "gRPC chosen for type safety",
		Type:    "decision",
		Tags:    []string{"architecture", "grpc"},
		Sources: []Source{{Project: "ai-tools", Path: "cmd/main.go"}},
	})
	if err != nil {
		t.Fatalf("Add failed: %v", err)
	}
	if len(id) != 8 {
		t.Errorf("expected 8-char ID, got %q", id)
	}

	note, err := s.Get(id)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if note.Content != "gRPC chosen for type safety" {
		t.Errorf("unexpected content: %s", note.Content)
	}
	if note.Type != "decision" {
		t.Errorf("unexpected type: %s", note.Type)
	}
	if note.Status != "open" {
		t.Errorf("expected status open, got %s", note.Status)
	}
	if note.CreatedAt == "" || note.UpdatedAt == "" {
		t.Error("timestamps should be set")
	}
}

func TestGetNonexistent(t *testing.T) {
	s := newTestStore(t)

	_, err := s.Get("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent note")
	}
}

func TestUpdate(t *testing.T) {
	s := newTestStore(t)

	id, _ := s.Add(Note{
		Content: "original content",
		Type:    "observation",
		Tags:    []string{"test"},
	})

	err := s.Update(id, map[string]interface{}{
		"content": "updated content",
		"type":    "decision",
		"tags":    []string{"test", "updated"},
	})
	if err != nil {
		t.Fatalf("Update failed: %v", err)
	}

	note, _ := s.Get(id)
	if note.Content != "updated content" {
		t.Errorf("content not updated: %s", note.Content)
	}
	if note.Type != "decision" {
		t.Errorf("type not updated: %s", note.Type)
	}
	if len(note.Tags) != 2 || note.Tags[1] != "updated" {
		t.Errorf("tags not updated: %v", note.Tags)
	}
}

func TestUpdateStatus(t *testing.T) {
	s := newTestStore(t)

	id, _ := s.Add(Note{Content: "a question", Type: "question"})

	err := s.UpdateStatus(id, "resolved")
	if err != nil {
		t.Fatalf("UpdateStatus failed: %v", err)
	}

	note, _ := s.Get(id)
	if note.Status != "resolved" {
		t.Errorf("expected resolved, got %s", note.Status)
	}
}

func TestDelete(t *testing.T) {
	s := newTestStore(t)

	id, _ := s.Add(Note{
		Content: "to be deleted",
		Tags:    []string{"deleteme"},
		Sources: []Source{{Project: "test", Path: "foo.go"}},
	})

	err := s.Delete(id)
	if err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	_, err = s.Get(id)
	if err == nil {
		t.Fatal("expected error after delete")
	}

	// Verify indexes are cleaned up
	tags := s.TagsIndex()
	if ids, ok := tags["deleteme"]; ok && len(ids) > 0 {
		t.Error("tag index not cleaned up")
	}

	sources := s.SourcesIndex()
	if ids, ok := sources["test:foo.go"]; ok && len(ids) > 0 {
		t.Error("source index not cleaned up")
	}
}

func TestDeleteNonexistent(t *testing.T) {
	s := newTestStore(t)

	err := s.Delete("nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent delete")
	}
}

func TestList(t *testing.T) {
	s := newTestStore(t)

	// Empty list
	list, err := s.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("expected empty list, got %d items", len(list))
	}

	// Add notes
	s.Add(Note{Content: "first note", Type: "observation", Tags: []string{"a"}})
	s.Add(Note{Content: "second note\nwith more lines", Type: "decision", Tags: []string{"b"}})

	list, err = s.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(list) != 2 {
		t.Errorf("expected 2 items, got %d", len(list))
	}

	// Verify preview truncation
	for _, item := range list {
		if item.Preview == "second note\nwith more lines" {
			t.Error("preview should be truncated to first line")
		}
	}
}

func TestTagIndex(t *testing.T) {
	s := newTestStore(t)

	id1, _ := s.Add(Note{Content: "note 1", Tags: []string{"go", "grpc"}})
	id2, _ := s.Add(Note{Content: "note 2", Tags: []string{"go", "rest"}})

	tags := s.TagsIndex()

	goIDs := tags["go"]
	if len(goIDs) != 2 {
		t.Errorf("expected 2 notes with 'go' tag, got %d", len(goIDs))
	}

	grpcIDs := tags["grpc"]
	if len(grpcIDs) != 1 || grpcIDs[0] != id1 {
		t.Errorf("unexpected grpc tag index: %v", grpcIDs)
	}

	restIDs := tags["rest"]
	if len(restIDs) != 1 || restIDs[0] != id2 {
		t.Errorf("unexpected rest tag index: %v", restIDs)
	}
}

func TestSourceIndex(t *testing.T) {
	s := newTestStore(t)

	id1, _ := s.Add(Note{
		Content: "note about main",
		Sources: []Source{{Project: "myproj", Path: "cmd/main.go"}},
	})
	s.Add(Note{
		Content: "note about utils",
		Sources: []Source{{Project: "myproj", Path: "internal/utils.go"}},
	})

	sources := s.SourcesIndex()

	mainIDs := sources["myproj:cmd/main.go"]
	if len(mainIDs) != 1 || mainIDs[0] != id1 {
		t.Errorf("unexpected source index for main: %v", mainIDs)
	}
}

func TestSearchByTag(t *testing.T) {
	s := newTestStore(t)

	s.Add(Note{Content: "go note", Tags: []string{"go"}})
	s.Add(Note{Content: "python note", Tags: []string{"python"}})
	s.Add(Note{Content: "both", Tags: []string{"go", "python"}})

	results, err := s.Search(SearchParams{Tag: "go"})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 results for 'go' tag, got %d", len(results))
	}
}

func TestSearchBySource(t *testing.T) {
	s := newTestStore(t)

	s.Add(Note{
		Content: "about cmd",
		Sources: []Source{{Project: "proj", Path: "cmd/main.go"}},
	})
	s.Add(Note{
		Content: "about internal",
		Sources: []Source{{Project: "proj", Path: "internal/store.go"}},
	})

	results, err := s.Search(SearchParams{Source: "proj:cmd"})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result for source prefix, got %d", len(results))
	}
}

func TestSearchByType(t *testing.T) {
	s := newTestStore(t)

	s.Add(Note{Content: "a decision", Type: "decision"})
	s.Add(Note{Content: "an observation", Type: "observation"})
	s.Add(Note{Content: "another decision", Type: "decision"})

	results, err := s.Search(SearchParams{Type: "decision"})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 decisions, got %d", len(results))
	}
}

func TestSearchByStatus(t *testing.T) {
	s := newTestStore(t)

	id1, _ := s.Add(Note{Content: "open note"})
	s.Add(Note{Content: "another open note"})
	s.UpdateStatus(id1, "resolved")

	results, err := s.Search(SearchParams{Status: "open"})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 open note, got %d", len(results))
	}
}

func TestSearchByQuery(t *testing.T) {
	s := newTestStore(t)

	s.Add(Note{Content: "gRPC was chosen for its type safety and code generation"})
	s.Add(Note{Content: "REST API is simpler but lacks type safety"})
	s.Add(Note{Content: "Database migration completed successfully"})

	results, err := s.Search(SearchParams{Query: "type safety"})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if len(results) < 2 {
		t.Errorf("expected at least 2 results for 'type safety', got %d", len(results))
	}
	// BM25 should rank the more relevant results higher
	if len(results) >= 2 {
		// Both gRPC and REST notes mention "type safety"
		foundGRPC := false
		foundREST := false
		for _, r := range results {
			if r.Content == "gRPC was chosen for its type safety and code generation" {
				foundGRPC = true
			}
			if r.Content == "REST API is simpler but lacks type safety" {
				foundREST = true
			}
		}
		if !foundGRPC || !foundREST {
			t.Error("expected both type safety notes in results")
		}
	}
}

func TestSearchCombinedFilters(t *testing.T) {
	s := newTestStore(t)

	s.Add(Note{Content: "go grpc decision", Type: "decision", Tags: []string{"go"}})
	s.Add(Note{Content: "go observation", Type: "observation", Tags: []string{"go"}})
	s.Add(Note{Content: "python decision", Type: "decision", Tags: []string{"python"}})

	results, err := s.Search(SearchParams{Tag: "go", Type: "decision"})
	if err != nil {
		t.Fatalf("Search failed: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result for go+decision, got %d", len(results))
	}
}

func TestContextBFS(t *testing.T) {
	s := newTestStore(t)

	// Create a small graph:
	// note1 (source: proj:cmd/main.go) --relates_to--> note2 --depends_on--> note3
	id1, _ := s.Add(Note{
		Content: "main entry point",
		Sources: []Source{{Project: "proj", Path: "cmd/main.go"}},
	})
	id2, _ := s.Add(Note{Content: "store implementation"})
	id3, _ := s.Add(Note{Content: "database layer"})

	s.AddRelations(id1, []Relation{{TargetID: id2, Type: "relates_to"}})
	s.AddRelations(id2, []Relation{{TargetID: id3, Type: "depends_on"}})

	results, err := s.Context("proj:cmd/main.go", 3)
	if err != nil {
		t.Fatalf("Context failed: %v", err)
	}

	// Should find all 3 notes via BFS
	if len(results) != 3 {
		t.Errorf("expected 3 notes in context, got %d", len(results))
		for _, r := range results {
			t.Logf("  - %s: %s", r.Note.ID, r.Note.Content)
		}
	}

	// Verify note1 has no incoming edges from our perspective
	// note2 should have incoming from note1
	// note3 should have incoming from note2
	for _, r := range results {
		if r.Note.ID == id2 {
			if len(r.Incoming) != 1 || r.Incoming[0].TargetID != id1 {
				t.Errorf("note2 should have incoming edge from note1")
			}
		}
		if r.Note.ID == id3 {
			if len(r.Incoming) != 1 || r.Incoming[0].TargetID != id2 {
				t.Errorf("note3 should have incoming edge from note2")
			}
		}
	}
}

func TestContextNoMatch(t *testing.T) {
	s := newTestStore(t)

	s.Add(Note{
		Content: "unrelated",
		Sources: []Source{{Project: "other", Path: "foo.go"}},
	})

	results, err := s.Context("nonexistent:path", 3)
	if err != nil {
		t.Fatalf("Context failed: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for nonexistent source, got %d", len(results))
	}
}

func TestContextCycleHandling(t *testing.T) {
	s := newTestStore(t)

	// Create a cycle: note1 → note2 → note1
	id1, _ := s.Add(Note{
		Content: "note1",
		Sources: []Source{{Project: "proj", Path: "a.go"}},
	})
	id2, _ := s.Add(Note{Content: "note2"})

	s.AddRelations(id1, []Relation{{TargetID: id2, Type: "relates_to"}})
	s.AddRelations(id2, []Relation{{TargetID: id1, Type: "relates_to"}})

	results, err := s.Context("proj:a.go", 3)
	if err != nil {
		t.Fatalf("Context failed: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 notes (cycle should not cause duplicates), got %d", len(results))
	}
}

func TestAddRelations(t *testing.T) {
	s := newTestStore(t)

	id1, _ := s.Add(Note{Content: "note 1"})
	id2, _ := s.Add(Note{Content: "note 2"})

	err := s.AddRelations(id1, []Relation{
		{TargetID: id2, Type: "relates_to"},
	})
	if err != nil {
		t.Fatalf("AddRelations failed: %v", err)
	}

	note, _ := s.Get(id1)
	if len(note.Relations) != 1 {
		t.Errorf("expected 1 relation, got %d", len(note.Relations))
	}
	if note.Relations[0].TargetID != id2 {
		t.Errorf("unexpected relation target: %s", note.Relations[0].TargetID)
	}

	// Verify graph index
	graph := s.GraphIdx()
	edges := graph[id1]
	if len(edges) != 1 || edges[0].TargetID != id2 {
		t.Errorf("graph index not updated correctly: %v", edges)
	}
}

func TestEmbedding(t *testing.T) {
	s := newTestStore(t)

	id, _ := s.Add(Note{Content: "test note"})

	// No embedding initially
	emb := s.GetEmbedding(id)
	if emb != nil {
		t.Error("expected nil embedding initially")
	}

	// Set embedding
	vec := make([]float32, 384)
	vec[0] = 1.0
	vec[1] = 0.5
	err := s.SetEmbedding(id, vec)
	if err != nil {
		t.Fatalf("SetEmbedding failed: %v", err)
	}

	// Get embedding
	emb = s.GetEmbedding(id)
	if emb == nil {
		t.Fatal("expected non-nil embedding")
	}
	if emb[0] != 1.0 || emb[1] != 0.5 {
		t.Errorf("unexpected embedding values: %v", emb[:5])
	}
}

func TestCosineSimilarity(t *testing.T) {
	// Same vector → similarity = 1.0
	a := []float32{1, 0, 0}
	sim := CosineSimilarity(a, a)
	if sim < 0.99 {
		t.Errorf("expected ~1.0 for identical vectors, got %f", sim)
	}

	// Orthogonal vectors → similarity = 0.0
	b := []float32{0, 1, 0}
	sim = CosineSimilarity(a, b)
	if sim > 0.01 {
		t.Errorf("expected ~0.0 for orthogonal vectors, got %f", sim)
	}

	// Opposite vectors → similarity = -1.0
	c := []float32{-1, 0, 0}
	sim = CosineSimilarity(a, c)
	if sim > -0.99 {
		t.Errorf("expected ~-1.0 for opposite vectors, got %f", sim)
	}
}

func TestConfig(t *testing.T) {
	s := newTestStore(t)

	// Default config
	cfg := s.GetConfig()
	if cfg.Model != "claude-haiku-4-5-20251001" {
		t.Errorf("unexpected default model: %s", cfg.Model)
	}
	if cfg.EmbeddingEnabled {
		t.Error("embedding should be disabled by default")
	}

	// Set config values
	err := s.SetConfig("api_key", "test-key")
	if err != nil {
		t.Fatalf("SetConfig failed: %v", err)
	}
	err = s.SetConfig("embedding_enabled", "true")
	if err != nil {
		t.Fatalf("SetConfig failed: %v", err)
	}
	err = s.SetConfig("model", "claude-sonnet-4-5-20250929")
	if err != nil {
		t.Fatalf("SetConfig failed: %v", err)
	}

	cfg = s.GetConfig()
	if cfg.APIKey != "test-key" {
		t.Errorf("api_key not set: %s", cfg.APIKey)
	}
	if !cfg.EmbeddingEnabled {
		t.Error("embedding_enabled not set")
	}
	if cfg.Model != "claude-sonnet-4-5-20250929" {
		t.Errorf("model not set: %s", cfg.Model)
	}

	// Unknown key
	err = s.SetConfig("unknown_key", "value")
	if err == nil {
		t.Error("expected error for unknown config key")
	}
}

func TestDeleteCleansGraphEdges(t *testing.T) {
	s := newTestStore(t)

	id1, _ := s.Add(Note{Content: "note 1"})
	id2, _ := s.Add(Note{Content: "note 2"})
	id3, _ := s.Add(Note{Content: "note 3"})

	// Create edges: id1 → id2, id3 → id2
	s.AddRelations(id1, []Relation{{TargetID: id2, Type: "relates_to"}})
	s.AddRelations(id3, []Relation{{TargetID: id2, Type: "depends_on"}})

	// Delete id2 — should clean up all edges to/from it
	err := s.Delete(id2)
	if err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	graph := s.GraphIdx()
	// id1's edge to id2 should be gone
	if edges, ok := graph[id1]; ok && len(edges) > 0 {
		t.Errorf("edges from id1 should be cleaned up: %v", edges)
	}
	// id3's edge to id2 should be gone
	if edges, ok := graph[id3]; ok && len(edges) > 0 {
		t.Errorf("edges from id3 should be cleaned up: %v", edges)
	}
}

func TestIndexPersistence(t *testing.T) {
	dir := t.TempDir()

	// Create store, add notes
	s1, _ := NewStoreAt(dir)
	id1, _ := s1.Add(Note{
		Content: "persistent note",
		Tags:    []string{"persist"},
		Sources: []Source{{Project: "proj", Path: "a.go"}},
	})

	// Create new store at same dir — should load indexes from disk
	s2, _ := NewStoreAt(dir)

	tags := s2.TagsIndex()
	if ids, ok := tags["persist"]; !ok || len(ids) != 1 || ids[0] != id1 {
		t.Errorf("tags index not persisted: %v", tags)
	}

	sources := s2.SourcesIndex()
	if ids, ok := sources["proj:a.go"]; !ok || len(ids) != 1 || ids[0] != id1 {
		t.Errorf("sources index not persisted: %v", sources)
	}

	// Note should be readable
	note, err := s2.Get(id1)
	if err != nil {
		t.Fatalf("Get from reloaded store failed: %v", err)
	}
	if note.Content != "persistent note" {
		t.Errorf("unexpected content from reloaded store: %s", note.Content)
	}
}

func TestKeywordOverlapScore(t *testing.T) {
	score := KeywordOverlapScore("gRPC type safety", "REST type safety")
	if score < 0.3 {
		t.Errorf("expected significant overlap, got %f", score)
	}

	score = KeywordOverlapScore("gRPC", "database migration")
	if score > 0.1 {
		t.Errorf("expected low overlap, got %f", score)
	}
}

func TestDetectProject(t *testing.T) {
	src := DetectProject("myproj:cmd/main.go")
	if src.Project != "myproj" || src.Path != "cmd/main.go" {
		t.Errorf("unexpected: %+v", src)
	}

	src = DetectProject("just/a/path.go")
	if src.Project != "" || src.Path != "just/a/path.go" {
		t.Errorf("unexpected: %+v", src)
	}
}

func TestBowEmbedding(t *testing.T) {
	emb := bowEmbedding("hello world test")
	if len(emb) != 384 {
		t.Errorf("expected 384-dim embedding, got %d", len(emb))
	}

	// Should be normalized (L2 norm ≈ 1.0)
	var norm float64
	for _, v := range emb {
		norm += float64(v) * float64(v)
	}
	if norm < 0.99 || norm > 1.01 {
		t.Errorf("expected normalized vector (norm ≈ 1.0), got %f", norm)
	}

	// Same input should produce same embedding
	emb2 := bowEmbedding("hello world test")
	sim := CosineSimilarity(emb, emb2)
	if sim < 0.99 {
		t.Errorf("same input should produce identical embedding, similarity = %f", sim)
	}
}
