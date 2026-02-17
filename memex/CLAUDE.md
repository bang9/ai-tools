# memex - Claude Usage Guide

## Overview

`memex` is a local knowledge graph that persists AI-extracted knowledge across conversations.
Knowledge is **automatically collected** via a Stop hook that runs after each assistant turn — you do not need to manually call any mutation tools during normal conversations.

Your primary role is to **query** the knowledge graph when relevant context might exist.

## Auto-Collection (Hook-Based)

A `Stop` hook runs asynchronously after each assistant turn:
1. **Collector** reads the transcript JSONL and extracts new conversation turns
2. **Analyzer** (Agent SDK) evaluates turns for knowledge worth persisting → `NoteCandidate[]`
3. **Embedding Router** computes embeddings for each candidate and routes via cosine similarity:
   - `sim ≥ 0.9` → **supersede** existing note (mark old as superseded, add new with relation)
   - `sim ≥ 0.7` → **update** existing note (replace content, merge tags/sources)
   - `sim ≥ 0.4` → **add** with `relates_to` relation to similar note
   - `sim < 0.4` → **add** as independent note
4. **Store** receives the routed changes with tags, sources, relations, and embeddings

This happens automatically in the background — no manual intervention needed.

## MCP Tools Reference

### `mcp__memex__search`
Search notes by filters. When a query is provided, results are ranked by semantic (cosine) similarity.
- `tag` (string, optional) — filter by tag
- `source` (string, optional) — filter by source key ("project:path")
- `query` (string, optional) — semantic similarity search query
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
- `superseded` — replaced by newer knowledge (set automatically by embedding router)

## Installation

Build locally:
```bash
cd memex && pnpm install && pnpm run build
```
