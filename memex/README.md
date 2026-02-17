# memex

A local knowledge graph for AI — automatically stores, connects, and retrieves knowledge across conversations.

## What It Does

memex gives AI assistants persistent memory. It **automatically collects** knowledge from conversations via a hook-based pipeline — architectural decisions, code patterns, risks, open questions — into a local knowledge graph. Future sessions can query this graph to build on past context instead of starting from scratch.

## Architecture

```
Claude Code Session
  │
  ├─ [Stop hook, async] runs after each assistant turn
  │   stdin: { session_id, transcript_path, cwd }
  │
  └─ hook.js (background)
      ├─ Collector: reads transcript JSONL, extracts new turns (cursor-based)
      ├─ Analyzer: Agent SDK analyzes session context → structured JSON output
      │   → notes_to_add, notes_to_update, notes_to_supersede
      └─ Store: applies changes to global knowledge graph
          ├─ notes/         (individual note files)
          ├─ index/         (tags, sources, graph indexes)
          └─ embeddings/    (semantic vectors via MiniLM-L6-v2)
```

### Data Flow

1. **Hook** — `Stop` event fires after each assistant turn (async, non-blocking)
2. **Collect** — reads transcript JSONL from cursor position, extracts user/assistant text
3. **Analyze** — Agent SDK with structured outputs decides what to extract
4. **Store** — adds/updates/supersedes notes in the global knowledge graph
5. **Query** — MCP tools search, context, and list for retrieval in future sessions

### MCP Server (Query-Focused)

The MCP server provides tools for **querying** the knowledge graph:
- `search` — filter by tag, source, query, type, status
- `context` — BFS graph traversal from a source path
- `list` — list all notes as summaries
- `get` — retrieve a single note
- `add/update/delete` — manual mutations (supplements auto-collection)

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
pnpm run build    # builds CLI + MCP server + hook to dist/
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

### Status Values

- `open` — active, relevant (default)
- `resolved` — answered, completed, or mitigated
- `superseded` — replaced by newer knowledge

## Configuration

```bash
memex config set auth_token sk-ant-oat01-xxxxx   # OAuth token for auto-collection & enrichment
memex config set api_key sk-ant-api03-xxxxx       # Or use an Anthropic API key
memex config set embedding_enabled true           # Enable semantic embeddings (default: true)
memex config set hook_min_turns 3                 # Min turns before hook triggers analysis
```

Settings are stored in `~/.memex/config.json`.

| Setting | Description | Default |
|---------|-------------|---------|
| `auth_token` | OAuth token from `claude setup-token` (for Agent SDK) | (none) |
| `api_key` | Anthropic API key from [console.anthropic.com](https://console.anthropic.com) | (none) |
| `embedding_enabled` | Generate semantic embeddings for similarity search | `true` |
| `model` | Model for analysis and enrichment | `claude-haiku-4-5-20251001` |
| `hook_min_turns` | Minimum new turns before hook triggers analysis | `3` |

### Authentication

Auto-collection and LLM enrichment use the Claude Agent SDK. Auth is resolved in priority order:

1. **Environment variables** — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
2. **`auth_token`** — set via `memex config set auth_token <token>` (get one with `claude setup-token`)
3. **`api_key`** — set via `memex config set api_key <key>`

If none are set, auto-collection and enrichment are disabled but manual CRUD, search, and graph features work normally.

## Data Storage

All data is stored locally in `~/.memex/`:

```
~/.memex/
├── config.json          # User configuration
├── notes/               # Individual note files (JSON)
│   ├── <id>.json
│   └── ...
├── index/
│   ├── tags.json        # Tag → note IDs
│   ├── sources.json     # Source key → note IDs
│   └── graph.json       # Note ID → outgoing edges
├── embeddings/
│   └── vectors.json     # Note ID → embedding vector (384-dim)
└── sessions/
    └── <session_id>.cursor  # Last processed line per session
```

## License

MIT
