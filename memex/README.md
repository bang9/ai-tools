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
pnpm install
pnpm run build    # builds CLI + MCP server to dist/
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
memex config  set <key> <value> | get <key>
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
memex config set auth_token sk-ant-oat01-xxxxx   # OAuth token for enrichment
memex config set api_key sk-ant-api03-xxxxx       # Or use an Anthropic API key
memex config set embedding_enabled true           # Enable local embeddings
```

Settings are stored in `~/.memex/config.json`.

| Setting | Description | Default |
|---------|-------------|---------|
| `auth_token` | OAuth token from `claude setup-token` (for Agent SDK enrichment) | (none) |
| `api_key` | Anthropic API key from [console.anthropic.com](https://console.anthropic.com) | (none) |
| `embedding_enabled` | Generate local embeddings for similarity search | `false` |
| `model` | Model for LLM enrichment | `claude-haiku-4-5-20251001` |

### Authentication (for LLM Enrichment)

LLM enrichment uses the Claude Agent SDK to auto-discover relations between notes. Auth is resolved in priority order:

1. **Environment variables** — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (auto-passed when running as MCP server inside Claude Code)
2. **`auth_token`** — OAuth token set via `memex config set auth_token <token>` (get one with `claude setup-token`)
3. **`api_key`** — Anthropic API key set via `memex config set api_key <key>`

If none are set, enrichment is disabled but all other features (CRUD, search, graph) work normally.

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
