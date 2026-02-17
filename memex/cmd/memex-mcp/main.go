package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"

	"github.com/bang9/ai-tools/memex/internal/memex"
)

// JSON-RPC types
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id"`
	Result  any    `json:"result,omitempty"`
	Error   *Error `json:"error,omitempty"`
}

type Error struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// MCP types
type InitializeResult struct {
	ProtocolVersion string       `json:"protocolVersion"`
	ServerInfo      ServerInfo   `json:"serverInfo"`
	Capabilities    Capabilities `json:"capabilities"`
}

type ServerInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type Capabilities struct {
	Tools *ToolsCapability `json:"tools,omitempty"`
}

type ToolsCapability struct{}

type Tool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema InputSchema `json:"inputSchema"`
}

type InputSchema struct {
	Type       string              `json:"type"`
	Properties map[string]Property `json:"properties"`
	Required   []string            `json:"required,omitempty"`
}

type Property struct {
	Type        string `json:"type"`
	Description string `json:"description"`
}

type ToolsListResult struct {
	Tools []Tool `json:"tools"`
}

type ToolCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type ToolCallResult struct {
	Content []ContentBlock `json:"content"`
	IsError bool           `json:"isError,omitempty"`
}

type ContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

var (
	store    *memex.Store
	enricher *memex.Enricher
	embedder *memex.Embedder
)

func main() {
	var err error
	store, err = memex.NewStore()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to initialize store: %v\n", err)
		os.Exit(1)
	}

	// Initialize enricher
	apiKey := os.Getenv("ANTHROPIC_API_KEY")
	cfg := store.GetConfig()
	if apiKey == "" {
		apiKey = cfg.APIKey
	}

	var client memex.LLMClient
	if apiKey != "" {
		client = memex.NewAnthropicClient(apiKey, cfg.Model)
		log.Println("memex: enrichment enabled")
	} else {
		log.Println("memex: enrichment disabled (no ANTHROPIC_API_KEY)")
	}
	enricher = memex.NewEnricher(store, client)

	// Initialize embedder
	embedder = memex.NewEmbedder(store, cfg.EmbeddingEnabled)
	if cfg.EmbeddingEnabled {
		log.Println("memex: embedding enabled")
	}

	scanner := bufio.NewScanner(os.Stdin)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 10*1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

		var req Request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			continue
		}

		resp := handleRequest(req)
		if resp != nil {
			output, _ := json.Marshal(resp)
			fmt.Println(string(output))
		}
	}
}

func handleRequest(req Request) *Response {
	switch req.Method {
	case "initialize":
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: InitializeResult{
				ProtocolVersion: "2024-11-05",
				ServerInfo: ServerInfo{
					Name:    "memex",
					Version: "1.0.0",
				},
				Capabilities: Capabilities{
					Tools: &ToolsCapability{},
				},
			},
		}

	case "notifications/initialized":
		return nil

	case "tools/list":
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: ToolsListResult{
				Tools: getTools(),
			},
		}

	case "tools/call":
		var params ToolCallParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errorResponse(req.ID, -32602, "Invalid params")
		}
		result := handleToolCall(params)
		return &Response{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  result,
		}

	default:
		return errorResponse(req.ID, -32601, "Method not found")
	}
}

func errorResponse(id any, code int, message string) *Response {
	return &Response{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &Error{Code: code, Message: message},
	}
}

func getTools() []Tool {
	return []Tool{
		{
			Name:        "add",
			Description: "Store a new knowledge note. Returns the assigned ID. Background enrichment discovers relations automatically.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]Property{
					"content": {Type: "string", Description: "The knowledge to store"},
					"type":    {Type: "string", Description: "Note type: decision, question, pattern, risk, observation, todo"},
					"tags":    {Type: "string", Description: "Comma-separated tags for categorization"},
					"sources": {Type: "string", Description: "Comma-separated source references as project:path (e.g., 'ai-tools:cmd/main.go,ai-tools:internal/store.go')"},
					"status":  {Type: "string", Description: "Initial status: open (default), resolved, superseded"},
				},
				Required: []string{"content"},
			},
		},
		{
			Name:        "get",
			Description: "Retrieve a single note by ID with all its relations.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]Property{
					"id": {Type: "string", Description: "The note ID (8-char hex)"},
				},
				Required: []string{"id"},
			},
		},
		{
			Name:        "update",
			Description: "Update an existing note. Only specified fields are changed.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]Property{
					"id":      {Type: "string", Description: "The note ID to update"},
					"content": {Type: "string", Description: "New content (replaces existing)"},
					"type":    {Type: "string", Description: "New type"},
					"tags":    {Type: "string", Description: "New comma-separated tags (replaces existing)"},
					"sources": {Type: "string", Description: "New comma-separated sources (replaces existing)"},
					"status":  {Type: "string", Description: "New status: open, resolved, superseded"},
				},
				Required: []string{"id"},
			},
		},
		{
			Name:        "delete",
			Description: "Delete a note and clean up all its index entries and graph edges.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]Property{
					"id": {Type: "string", Description: "The note ID to delete"},
				},
				Required: []string{"id"},
			},
		},
		{
			Name:        "search",
			Description: "Search notes by tag, source path, keyword query, type, or status. Multiple filters are AND-combined. Keyword queries use BM25 ranking.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]Property{
					"tag":    {Type: "string", Description: "Filter by tag"},
					"source": {Type: "string", Description: "Filter by source path prefix (e.g., 'ai-tools:cmd/')"},
					"query":  {Type: "string", Description: "Full-text keyword search in content"},
					"type":   {Type: "string", Description: "Filter by type: decision, question, pattern, risk, observation, todo"},
					"status": {Type: "string", Description: "Filter by status: open, resolved, superseded"},
				},
			},
		},
		{
			Name:        "context",
			Description: "BFS graph traversal from notes matching a source path. Returns the connected subgraph (up to 3 hops) — all decisions, dependencies, risks, and questions related to a file or directory.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]Property{
					"source": {Type: "string", Description: "Source path prefix to start traversal (e.g., 'ai-tools:cmd/main.go' or 'ai-tools:internal/')"},
					"hops":   {Type: "string", Description: "Max traversal depth (default: 3)"},
				},
				Required: []string{"source"},
			},
		},
		{
			Name:        "list",
			Description: "List all notes as summaries (ID, first line, type, tags, status).",
			InputSchema: InputSchema{
				Type:       "object",
				Properties: map[string]Property{},
			},
		},
	}
}

func handleToolCall(params ToolCallParams) ToolCallResult {
	var args map[string]string
	if len(params.Arguments) > 0 {
		json.Unmarshal(params.Arguments, &args)
	}

	switch params.Name {
	case "add":
		return handleAdd(args)
	case "get":
		return handleGet(args)
	case "update":
		return handleUpdate(args)
	case "delete":
		return handleDelete(args)
	case "search":
		return handleSearch(args)
	case "context":
		return handleContext(args)
	case "list":
		return handleList()
	default:
		return toolError(fmt.Sprintf("Unknown tool: %s", params.Name))
	}
}

func handleAdd(args map[string]string) ToolCallResult {
	content := args["content"]
	if content == "" {
		return toolError("content is required")
	}

	note := memex.Note{
		Content: content,
		Type:    args["type"],
		Status:  args["status"],
	}

	if tags := args["tags"]; tags != "" {
		for _, tag := range strings.Split(tags, ",") {
			tag = strings.TrimSpace(tag)
			if tag != "" {
				note.Tags = append(note.Tags, tag)
			}
		}
	}

	if sources := args["sources"]; sources != "" {
		for _, src := range strings.Split(sources, ",") {
			src = strings.TrimSpace(src)
			if src != "" {
				note.Sources = append(note.Sources, memex.DetectProject(src))
			}
		}
	}

	id, err := store.Add(note)
	if err != nil {
		return toolError(err.Error())
	}

	// Queue background processing
	enricher.Enqueue(id)
	embedder.Enqueue(id)

	return toolSuccess(fmt.Sprintf("Added note %s", id))
}

func handleGet(args map[string]string) ToolCallResult {
	id := args["id"]
	if id == "" {
		return toolError("id is required")
	}

	note, err := store.Get(id)
	if err != nil {
		return toolError(err.Error())
	}

	data, _ := json.MarshalIndent(note, "", "  ")
	return toolSuccess(string(data))
}

func handleUpdate(args map[string]string) ToolCallResult {
	id := args["id"]
	if id == "" {
		return toolError("id is required")
	}

	updates := make(map[string]interface{})
	contentChanged := false

	if v, ok := args["content"]; ok && v != "" {
		updates["content"] = v
		contentChanged = true
	}
	if v, ok := args["type"]; ok && v != "" {
		updates["type"] = v
	}
	if v, ok := args["status"]; ok && v != "" {
		updates["status"] = v
	}
	if v, ok := args["tags"]; ok && v != "" {
		var tags []string
		for _, tag := range strings.Split(v, ",") {
			tag = strings.TrimSpace(tag)
			if tag != "" {
				tags = append(tags, tag)
			}
		}
		updates["tags"] = tags
	}
	if v, ok := args["sources"]; ok && v != "" {
		var sources []memex.Source
		for _, src := range strings.Split(v, ",") {
			src = strings.TrimSpace(src)
			if src != "" {
				sources = append(sources, memex.DetectProject(src))
			}
		}
		updates["sources"] = sources
	}

	if len(updates) == 0 {
		return toolError("no updates specified")
	}

	if err := store.Update(id, updates); err != nil {
		return toolError(err.Error())
	}

	// Re-queue enrichment if content changed
	if contentChanged {
		enricher.Enqueue(id)
		embedder.Enqueue(id)
	}

	return toolSuccess(fmt.Sprintf("Updated note %s", id))
}

func handleDelete(args map[string]string) ToolCallResult {
	id := args["id"]
	if id == "" {
		return toolError("id is required")
	}

	if err := store.Delete(id); err != nil {
		return toolError(err.Error())
	}

	return toolSuccess(fmt.Sprintf("Deleted note %s", id))
}

func handleSearch(args map[string]string) ToolCallResult {
	params := memex.SearchParams{
		Tag:    args["tag"],
		Source: args["source"],
		Query:  args["query"],
		Type:   args["type"],
		Status: args["status"],
	}

	results, err := store.Search(params)
	if err != nil {
		return toolError(err.Error())
	}

	if len(results) == 0 {
		return toolSuccess("No results found")
	}

	data, _ := json.MarshalIndent(results, "", "  ")
	return toolSuccess(string(data))
}

func handleContext(args map[string]string) ToolCallResult {
	source := args["source"]
	if source == "" {
		return toolError("source is required")
	}

	maxHops := 3
	if h, ok := args["hops"]; ok && h != "" {
		if v, err := strconv.Atoi(h); err == nil && v > 0 {
			maxHops = v
		}
	}

	results, err := store.Context(source, maxHops)
	if err != nil {
		return toolError(err.Error())
	}

	if len(results) == 0 {
		return toolSuccess("No context found for source: " + source)
	}

	data, _ := json.MarshalIndent(results, "", "  ")
	return toolSuccess(string(data))
}

func handleList() ToolCallResult {
	items, err := store.List()
	if err != nil {
		return toolError(err.Error())
	}

	if len(items) == 0 {
		return toolSuccess("No notes stored")
	}

	data, _ := json.MarshalIndent(items, "", "  ")
	return toolSuccess(string(data))
}

func toolSuccess(text string) ToolCallResult {
	return ToolCallResult{
		Content: []ContentBlock{{Type: "text", Text: text}},
	}
}

func toolError(message string) ToolCallResult {
	return ToolCallResult{
		Content: []ContentBlock{{Type: "text", Text: "Error: " + message}},
		IsError: true,
	}
}
