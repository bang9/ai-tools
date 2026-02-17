# memex

A local knowledge graph for AI — automatically stores, connects, and retrieves knowledge across conversations.

## What It Does

memex gives AI assistants persistent memory. During conversations, it extracts and stores important knowledge — architectural decisions, code patterns, risks, open questions — into a local knowledge graph. Future sessions can query this graph to build on past context instead of starting from scratch.

## Architecture

```
Conversation → Extract Knowledge → Store Notes
                                      ↓
                                  Tag Index ← Search ← Future Session
                                  Source Index
                                  Graph Index
                                  Embedding Index (optional)
                                      ↓
                                  LLM Enrichment (optional)
                                  → auto-relate notes
                                  → detect superseded knowledge
```

- **Notes** — atomic knowledge units with type, tags, sources, and relations
- **Indexes** — tag, source, graph, and embedding indexes for fast lookup
- **Graph traversal** — BFS context queries to find related knowledge
- **LLM enrichment** — optional background processing to auto-discover relations

## Installation

### CLI

```bash
curl -fsSL https://raw.githubusercontent.com/bang9/ai-tools/main/memex/install.sh | bash
```

### MCP Server & Skill (via Claude Code Plugin)

```bash
/plugin marketplace add bang9/ai-tools
/plugin install memex
```

### Build from Source

```bash
cd memex
make build        # build CLI + MCP server
make build-cli    # CLI only
make build-mcp    # MCP server only
make cross        # cross-compile for all platforms
```

## CLI Commands

```bash
memex add     <content> --type <type> [--tags <t1,t2>] [--source <project:path>]
memex get     <id>
memex update  <id> [--content <content>] [--status <status>] [--tags <t1,t2>]
memex delete  <id>
memex search  [--tag <tag>] [--source <key>] [--query <text>] [--type <type>] [--status <status>]
memex context <id> [--depth <n>]
memex list    [--type <type>] [--status <status>]
memex config  [--api-key <key>] [--embedding <true|false>]
```

### Note Types

| Type | Description |
|------|-------------|
| `decision` | A choice made between alternatives |
| `question` | Something unclear or needing investigation |
| `pattern` | A recurring convention or idiom |
| `risk` | A potential problem or concern |
| `observation` | A factual note about how something works |
| `todo` | Work to be done later |

### Status Values

- `open` — active, relevant (default)
- `resolved` — answered, completed, or mitigated
- `superseded` — replaced by newer knowledge

## Configuration

```bash
memex config --api-key sk-ant-xxx    # Set Anthropic API key for LLM enrichment
memex config --embedding true        # Enable local embedding generation
```

Settings are stored in `~/.memex/config.json`.

| Setting | Description | Default |
|---------|-------------|---------|
| `api_key` | Anthropic API key for enrichment | (none) |
| `embedding_enabled` | Generate local embeddings for similarity search | `false` |
| `model` | Model for enrichment | `claude-haiku-4-5-20251001` |

## Data Storage

All data is stored locally in `~/.memex/`:

```
~/.memex/
├── config.json          # User configuration
├── notes/               # Individual note files (JSON)
│   ├── <id>.json
│   └── ...
└── indexes/
    ├── tags.json        # Tag → note IDs
    ├── sources.json     # Source key → note IDs
    ├── graph.json       # Note ID → outgoing edges
    └── embeddings.json  # Note ID → embedding vector
```

## How It Works

1. **Add** — AI extracts a knowledge unit and stores it as a note with type, tags, and source citations
2. **Index** — the note is indexed by tags, sources, and graph relations for fast lookup
3. **Search** — future sessions query by tag, source file, type, or full-text to find relevant knowledge
4. **Context** — graph traversal (BFS) retrieves a note with all its related notes up to a configurable depth
5. **Enrich** (optional) — LLM enrichment auto-discovers relations between notes and detects superseded knowledge

## License

MIT
