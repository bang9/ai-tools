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
      ├─ Analyzer: Agent SDK extracts knowledge → NoteCandidate[]
      ├─ Embedding Router: for each candidate:
      │   ├─ computeEmbedding(content)
      │   ├─ cosine similarity against all existing note embeddings
      │   └─ threshold-based routing:
      │       ├─ sim ≥ 0.9 → supersede (mark old superseded, add new)
      │       ├─ sim ≥ 0.7 → update (replace content, merge tags/sources)
      │       ├─ sim ≥ 0.4 → add with relates_to relation
      │       └─ sim < 0.4 → add as independent
      └─ Store: persists notes, indexes, embeddings, and relations
          ├─ notes/         (individual note files)
          ├─ index/         (tags, sources, graph indexes)
          └─ embeddings/    (semantic vectors via MiniLM-L6-v2 / BoW fallback)
```

### Data Flow

1. **Hook** — `Stop` event fires after each assistant turn (async, non-blocking)
2. **Collect** — reads transcript JSONL from cursor position, extracts user/assistant text
3. **Analyze** — Agent SDK with structured outputs extracts knowledge candidates
4. **Route** — each candidate is embedded and routed by cosine similarity to existing notes
5. **Store** — applies routed changes (add/update/supersede) with embeddings
6. **Query** — MCP tools search, context, and list for retrieval in future sessions

### MCP Server (Query-Only)

The MCP server provides tools for **querying** the knowledge graph:
- `search` — filter by tag, source, type, status; semantic similarity ranking for query
- `context` — BFS graph traversal from a source path
- `list` — list all notes as summaries
- `get` — retrieve a single note

## Installation

### MCP Server & Hook (via Claude Code Plugin)

```bash
/plugin marketplace add bang9/ai-tools
/plugin install memex
```

### Build from Source

```bash
cd memex
pnpm install
pnpm run build    # builds MCP server + hook to dist/
```

### Status Values

- `open` — active, relevant (default)
- `resolved` — answered, completed, or mitigated
- `superseded` — replaced by newer knowledge

## Configuration

Settings are stored in `~/.memex/config.json`.

| Setting | Description | Default |
|---------|-------------|---------|
| `auth_token` | OAuth token from `claude setup-token` (for Agent SDK) | (none) |
| `api_key` | Anthropic API key from [console.anthropic.com](https://console.anthropic.com) | (none) |
| `embedding_enabled` | Enable embedding-based routing and semantic search | `true` |
| `model` | Model for analysis | `claude-haiku-4-5-20251001` |

### Authentication

Auto-collection uses the Claude Agent SDK. Auth is resolved in priority order:

1. **Environment variables** — `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
2. **`auth_token`** — set via config (get one with `claude setup-token`)
3. **`api_key`** — set via config

If none are set, auto-collection is disabled but search and graph features work normally.

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
