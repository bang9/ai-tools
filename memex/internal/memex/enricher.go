package memex

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
)

// LLMClient is the interface for LLM-based enrichment.
type LLMClient interface {
	Analyze(note Note, candidates []Note) (*EnrichmentResult, error)
}

// Enricher processes notes in the background, finding relations via LLM.
type Enricher struct {
	queue  chan string
	store  *Store
	client LLMClient
}

// NewEnricher creates an Enricher. If client is nil, enrichment is disabled.
func NewEnricher(store *Store, client LLMClient) *Enricher {
	e := &Enricher{
		queue:  make(chan string, 100),
		store:  store,
		client: client,
	}
	if client != nil {
		go e.processLoop()
	}
	return e
}

// Enqueue adds a note ID to the enrichment queue.
func (e *Enricher) Enqueue(id string) {
	if e.client == nil {
		return
	}
	select {
	case e.queue <- id:
	default:
		log.Printf("enricher: queue full, dropping note %s", id)
	}
}

func (e *Enricher) processLoop() {
	for id := range e.queue {
		if err := e.processNote(id); err != nil {
			log.Printf("enricher: failed to process note %s: %v", id, err)
		}
	}
}

func (e *Enricher) processNote(id string) error {
	note, err := e.store.Get(id)
	if err != nil {
		return err
	}

	candidates := e.findCandidates(*note, 20)
	if len(candidates) == 0 {
		return nil
	}

	result, err := e.client.Analyze(*note, candidates)
	if err != nil {
		return fmt.Errorf("LLM analysis failed: %w", err)
	}

	if len(result.Relations) > 0 {
		if err := e.store.AddRelations(id, result.Relations); err != nil {
			return fmt.Errorf("failed to add relations: %w", err)
		}
	}

	for _, sid := range result.Superseded {
		if err := e.store.UpdateStatus(sid, "superseded"); err != nil {
			log.Printf("enricher: failed to mark %s as superseded: %v", sid, err)
		}
	}

	return nil
}

// findCandidates finds related notes using tag/source overlap and optional embedding similarity.
func (e *Enricher) findCandidates(note Note, k int) []Note {
	scores := make(map[string]float64)

	// Tag overlap scoring
	tagsIdx := e.store.TagsIndex()
	for _, tag := range note.Tags {
		for _, id := range tagsIdx[tag] {
			if id != note.ID {
				scores[id] += 2.0
			}
		}
	}

	// Source overlap scoring
	sourcesIdx := e.store.SourcesIndex()
	for _, src := range note.Sources {
		key := src.Key()
		for skey, ids := range sourcesIdx {
			if strings.HasPrefix(skey, key) || strings.HasPrefix(key, skey) {
				for _, id := range ids {
					if id != note.ID {
						scores[id] += 3.0
					}
				}
			}
		}
	}

	// Embedding similarity (if available)
	noteEmb := e.store.GetEmbedding(note.ID)
	if noteEmb != nil {
		allEmbs := e.store.AllEmbeddings()
		for id, emb := range allEmbs {
			if id != note.ID {
				sim := CosineSimilarity(noteEmb, emb)
				if sim > 0.3 {
					scores[id] += sim * 5.0
				}
			}
		}
	}

	// Keyword overlap as fallback (if no other signals)
	if len(scores) == 0 {
		noteTokens := uniqueTokens(note.Content)
		summaries, err := e.store.List()
		if err == nil {
			for _, s := range summaries {
				if s.ID == note.ID {
					continue
				}
				n, err := e.store.Get(s.ID)
				if err != nil {
					continue
				}
				candTokens := uniqueTokens(n.Content)
				overlap := 0
				for t := range noteTokens {
					if candTokens[t] {
						overlap++
					}
				}
				if overlap > 2 {
					scores[s.ID] = float64(overlap)
				}
			}
		}
	}

	// Sort by score, take top-K
	type scored struct {
		id    string
		score float64
	}
	var ranked []scored
	for id, score := range scores {
		ranked = append(ranked, scored{id, score})
	}
	sort.Slice(ranked, func(i, j int) bool {
		return ranked[i].score > ranked[j].score
	})

	limit := k
	if len(ranked) < limit {
		limit = len(ranked)
	}

	var candidates []Note
	for _, r := range ranked[:limit] {
		n, err := e.store.Get(r.id)
		if err != nil {
			continue
		}
		candidates = append(candidates, *n)
	}

	return candidates
}

// --- Anthropic API Client ---

// AnthropicClient makes direct HTTP calls to the Anthropic Messages API.
type AnthropicClient struct {
	APIKey  string
	Model   string
	BaseURL string
}

// NewAnthropicClient creates a client with defaults.
func NewAnthropicClient(apiKey, model string) *AnthropicClient {
	if model == "" {
		model = "claude-haiku-4-5-20251001"
	}
	return &AnthropicClient{
		APIKey:  apiKey,
		Model:   model,
		BaseURL: "https://api.anthropic.com/v1/messages",
	}
}

type anthropicRequest struct {
	Model     string             `json:"model"`
	MaxTokens int                `json:"max_tokens"`
	Messages  []anthropicMessage `json:"messages"`
}

type anthropicMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type anthropicResponse struct {
	Content []struct {
		Text string `json:"text"`
	} `json:"content"`
}

// Analyze sends a note and candidates to Claude API for relation analysis.
func (c *AnthropicClient) Analyze(note Note, candidates []Note) (*EnrichmentResult, error) {
	prompt := buildEnrichmentPrompt(note, candidates)

	reqBody := anthropicRequest{
		Model:     c.Model,
		MaxTokens: 1024,
		Messages: []anthropicMessage{
			{Role: "user", Content: prompt},
		},
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequest("POST", c.BaseURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.APIKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("API request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var apiResp anthropicResponse
	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	if len(apiResp.Content) == 0 {
		return &EnrichmentResult{}, nil
	}

	var result EnrichmentResult
	text := apiResp.Content[0].Text

	// Extract JSON from response (handle markdown code blocks)
	jsonStr := extractJSON(text)
	if err := json.Unmarshal([]byte(jsonStr), &result); err != nil {
		return nil, fmt.Errorf("failed to parse enrichment result: %w (response: %s)", err, text)
	}

	return &result, nil
}

func buildEnrichmentPrompt(note Note, candidates []Note) string {
	var sb strings.Builder

	sb.WriteString("Analyze the NEW note below and find relationships to EXISTING notes.\n\n")
	sb.WriteString("NEW NOTE:\n")
	sb.WriteString(fmt.Sprintf("ID: %s\nType: %s\nContent: %s\nTags: %s\n\n",
		note.ID, note.Type, note.Content, strings.Join(note.Tags, ", ")))

	sb.WriteString("EXISTING NOTES:\n")
	for _, c := range candidates {
		sb.WriteString(fmt.Sprintf("- ID: %s | Type: %s | Status: %s | Content: %s\n",
			c.ID, c.Type, c.Status, c.Content))
	}

	sb.WriteString(`
Respond with ONLY a JSON object (no markdown, no explanation):
{
  "relations": [
    {"target_id": "<existing_note_id>", "type": "<relation_type>"}
  ],
  "superseded": ["<note_id_that_new_note_supersedes>"]
}

Relation types: relates_to, depends_on, contradicts, supersedes, elaborates, blocks
Rules:
- Only include relations with high confidence
- "superseded" lists IDs of existing notes that the new note completely replaces
- If no relations found, return {"relations": [], "superseded": []}
- target_id in relations must reference existing note IDs only
`)

	return sb.String()
}

func extractJSON(text string) string {
	// Try to find JSON in markdown code block
	if idx := strings.Index(text, "```json"); idx >= 0 {
		text = text[idx+7:]
		if end := strings.Index(text, "```"); end >= 0 {
			return strings.TrimSpace(text[:end])
		}
	}
	if idx := strings.Index(text, "```"); idx >= 0 {
		text = text[idx+3:]
		if end := strings.Index(text, "```"); end >= 0 {
			return strings.TrimSpace(text[:end])
		}
	}
	// Try to find raw JSON
	if idx := strings.Index(text, "{"); idx >= 0 {
		depth := 0
		for i := idx; i < len(text); i++ {
			switch text[i] {
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					return text[idx : i+1]
				}
			}
		}
	}
	return text
}
