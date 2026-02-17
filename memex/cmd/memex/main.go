package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/bang9/ai-tools/memex/internal/memex"
)

const usage = `memex - Local Knowledge Graph for AI

Usage:
  memex add [--type TYPE] [--tag TAG]... [--source PROJECT:PATH]... [--status STATUS]
  memex get <id>
  memex update <id> [--content TEXT] [--type TYPE] [--tag TAG]... [--source PROJECT:PATH]... [--status STATUS]
  memex delete <id>
  memex search [--tag TAG] [--source PATH] [--query TEXT] [--type TYPE] [--status STATUS]
  memex context <source>
  memex list
  memex config set <key> <value>
  memex config get <key>

Commands:
  add        Store a new note (reads content from stdin)
  get        Get a note by ID (JSON output)
  update     Update an existing note
  delete     Delete a note
  search     Search notes by filters
  context    BFS graph traversal from a source path
  list       List all notes as summaries
  config     Get/set configuration

Config Keys:
  api_key            Anthropic API key for enrichment
  embedding_enabled  Enable local embeddings (true/false)
  model              LLM model for enrichment

Examples:
  echo "gRPC chosen for type safety" | memex add --type decision --tag architecture --source ai-tools:cmd/main.go
  memex search --tag architecture
  memex context "ai-tools:cmd/"
  memex list
  memex config set api_key sk-ant-...
`

func main() {
	if len(os.Args) < 2 {
		fmt.Print(usage)
		os.Exit(1)
	}

	store, err := memex.NewStore()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	cmd := os.Args[1]

	switch cmd {
	case "add":
		doAdd(store)
	case "get":
		doGet(store)
	case "update":
		doUpdate(store)
	case "delete":
		doDelete(store)
	case "search":
		doSearch(store)
	case "context":
		doContext(store)
	case "list":
		doList(store)
	case "config":
		doConfig(store)
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", cmd)
		fmt.Print(usage)
		os.Exit(1)
	}
}

func doAdd(store *memex.Store) {
	args := os.Args[2:]
	note := memex.Note{}

	// Parse flags
	var i int
	for i = 0; i < len(args); i++ {
		switch args[i] {
		case "--type":
			i++
			if i < len(args) {
				note.Type = args[i]
			}
		case "--tag":
			i++
			if i < len(args) {
				note.Tags = append(note.Tags, args[i])
			}
		case "--source":
			i++
			if i < len(args) {
				note.Sources = append(note.Sources, memex.DetectProject(args[i]))
			}
		case "--status":
			i++
			if i < len(args) {
				note.Status = args[i]
			}
		}
	}

	// Read content from stdin
	content, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error reading stdin: %v\n", err)
		os.Exit(1)
	}
	note.Content = strings.TrimSpace(string(content))
	if note.Content == "" {
		fmt.Fprintln(os.Stderr, "error: content is required (pipe via stdin)")
		os.Exit(1)
	}

	id, err := store.Add(note)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(id)
}

func doGet(store *memex.Store) {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "error: get requires <id>")
		os.Exit(1)
	}
	id := os.Args[2]

	note, err := store.Get(id)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	data, _ := json.MarshalIndent(note, "", "  ")
	fmt.Println(string(data))
}

func doUpdate(store *memex.Store) {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "error: update requires <id>")
		os.Exit(1)
	}
	id := os.Args[2]
	args := os.Args[3:]

	updates := make(map[string]interface{})
	var tags []string
	var sources []memex.Source

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--content":
			i++
			if i < len(args) {
				updates["content"] = args[i]
			}
		case "--type":
			i++
			if i < len(args) {
				updates["type"] = args[i]
			}
		case "--status":
			i++
			if i < len(args) {
				updates["status"] = args[i]
			}
		case "--tag":
			i++
			if i < len(args) {
				tags = append(tags, args[i])
			}
		case "--source":
			i++
			if i < len(args) {
				sources = append(sources, memex.DetectProject(args[i]))
			}
		}
	}

	if len(tags) > 0 {
		updates["tags"] = tags
	}
	if len(sources) > 0 {
		updates["sources"] = sources
	}

	if len(updates) == 0 {
		fmt.Fprintln(os.Stderr, "error: no updates specified")
		os.Exit(1)
	}

	if err := store.Update(id, updates); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("updated")
}

func doDelete(store *memex.Store) {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "error: delete requires <id>")
		os.Exit(1)
	}
	id := os.Args[2]

	if err := store.Delete(id); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("deleted")
}

func doSearch(store *memex.Store) {
	args := os.Args[2:]
	params := memex.SearchParams{}

	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--tag":
			i++
			if i < len(args) {
				params.Tag = args[i]
			}
		case "--source":
			i++
			if i < len(args) {
				params.Source = args[i]
			}
		case "--query":
			i++
			if i < len(args) {
				params.Query = args[i]
			}
		case "--type":
			i++
			if i < len(args) {
				params.Type = args[i]
			}
		case "--status":
			i++
			if i < len(args) {
				params.Status = args[i]
			}
		}
	}

	results, err := store.Search(params)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	if len(results) == 0 {
		fmt.Println("no results")
		return
	}

	data, _ := json.MarshalIndent(results, "", "  ")
	fmt.Println(string(data))
}

func doContext(store *memex.Store) {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "error: context requires <source>")
		os.Exit(1)
	}
	source := os.Args[2]

	results, err := store.Context(source, 3)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	if len(results) == 0 {
		fmt.Println("no context found")
		return
	}

	data, _ := json.MarshalIndent(results, "", "  ")
	fmt.Println(string(data))
}

func doList(store *memex.Store) {
	items, err := store.List()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	if len(items) == 0 {
		fmt.Println("no notes")
		return
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tTYPE\tSTATUS\tTAGS\tPREVIEW")
	for _, item := range items {
		tags := strings.Join(item.Tags, ",")
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", item.ID, item.Type, item.Status, tags, item.Preview)
	}
	w.Flush()
}

func doConfig(store *memex.Store) {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "error: config requires 'get' or 'set'")
		os.Exit(1)
	}

	subcmd := os.Args[2]
	switch subcmd {
	case "get":
		if len(os.Args) < 4 {
			// Show all config
			cfg := store.GetConfig()
			data, _ := json.MarshalIndent(cfg, "", "  ")
			fmt.Println(string(data))
			return
		}
		key := os.Args[3]
		cfg := store.GetConfig()
		switch key {
		case "api_key":
			if cfg.APIKey != "" {
				fmt.Println(cfg.APIKey[:8] + "...")
			} else {
				fmt.Println("(not set)")
			}
		case "embedding_enabled":
			fmt.Println(cfg.EmbeddingEnabled)
		case "model":
			fmt.Println(cfg.Model)
		default:
			fmt.Fprintf(os.Stderr, "unknown config key: %s\n", key)
			os.Exit(1)
		}

	case "set":
		if len(os.Args) < 5 {
			fmt.Fprintln(os.Stderr, "error: config set requires <key> <value>")
			os.Exit(1)
		}
		key := os.Args[3]
		value := os.Args[4]
		if err := store.SetConfig(key, value); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("%s = %s\n", key, value)

	default:
		fmt.Fprintf(os.Stderr, "error: config requires 'get' or 'set', got %q\n", subcmd)
		os.Exit(1)
	}
}
