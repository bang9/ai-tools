# memex - Claude Usage Guide

## Overview

`memex` is a local knowledge graph that persists AI-extracted knowledge across conversations.
Knowledge is **automatically collected** via a Stop hook that runs after each assistant turn — you do not need to manually call `add` during normal conversations.

Your primary role is to **query** the knowledge graph when relevant context might exist.

## Auto-Collection (Hook-Based)

A `Stop` hook runs asynchronously after each assistant turn:
1. **Collector** reads the transcript JSONL and extracts new conversation turns
2. **Analyzer** (Agent SDK) evaluates turns for knowledge worth persisting
3. **Store** receives extracted notes with tags, sources, and relations

This happens automatically in the background — no manual intervention needed.

## MCP Tools Reference

### Query Tools (Primary Use)

### `mcp__memex__search`
Search notes by filters.
- `tag` (string, optional) — filter by tag
- `source` (string, optional) — filter by source key ("project:path")
- `query` (string, optional) — full-text search in content
- `type` (string, optional) — filter by type
- `status` (string, optional) — filter by status

### `mcp__memex__context`
BFS graph traversal from notes matching a source path.
- `source` (string, required) — source path prefix to start traversal
- `hops` (string, optional) — max traversal depth (default: 3)

### `mcp__memex__list`
List all notes as summaries.

### `mcp__memex__get`
Retrieve a note by ID.
- `id` (string, required) — note ID

### Mutation Tools (Supplementary)

These are available for manual corrections or the `/memorize` skill:

### `mcp__memex__add`
Store a new knowledge note (supplements auto-collection).
- `content` (string, required) — the knowledge to store
- `type` (string, optional) — note type (e.g., decision, pattern, risk)
- `tags` (string, optional) — comma-separated tags
- `sources` (string, optional) — comma-separated source references as project:path
- `status` (string, optional) — initial status: open (default), resolved, superseded

### `mcp__memex__update`
Update an existing note.
- `id` (string, required) — note ID
- `content`, `type`, `tags`, `sources`, `status` (all optional)

### `mcp__memex__delete`
Delete a note by ID.
- `id` (string, required) — note ID

## Workflow

### Before Working on Files

```
1. Check existing knowledge for the file/area:
   mcp__memex__search(source="project:path/to/file.ts")

2. Check related tags:
   mcp__memex__search(tag="authentication")

3. Review open questions and risks:
   mcp__memex__search(status="open", type="question")
```

### After Making Decisions

Knowledge is auto-collected by the hook. For immediate persistence, use `/memorize` or `mcp__memex__add`.

## Source Format

Sources use `"project:path"` format:
- `project` — git remote name or directory name
- `path` — relative to project root

Examples:
- `ai-tools:memex/src/store.ts`
- `myapp:src/auth/handler.ts`

## Status Lifecycle

- `open` — active, relevant knowledge (default)
- `resolved` — question answered, todo completed, risk mitigated
- `superseded` — replaced by newer knowledge

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/bang9/ai-tools/main/memex/install.sh | bash
```

Or build locally:
```bash
cd memex && pnpm install && pnpm run build
```
