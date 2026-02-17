# memex - Claude Usage Guide

## Overview

`memex` is a local knowledge graph that persists AI-extracted knowledge across conversations.
During every conversation, you should automatically extract and store important knowledge — decisions, patterns, risks, observations, questions, and todos — so future sessions can build on past context.

## Auto-Extraction Rules

During ALL conversations, extract and store knowledge when you encounter:

- **Architectural decisions** — technology choices, design patterns, tradeoffs
- **Recurring patterns** — code conventions, naming rules, project-specific idioms
- **File-specific knowledge** — purpose of files, non-obvious behavior, gotchas
- **Risks identified** — security concerns, performance bottlenecks, fragile code
- **Open questions** — unresolved issues, things to investigate later
- **Todos** — deferred work, follow-up tasks, known tech debt

## MCP Tools Reference

### `mcp__memex__add`
Create a new knowledge note.
- `content` (string, required) — the knowledge to store
- `type` (string, required) — one of: decision, question, pattern, risk, observation, todo
- `tags` (string[], optional) — categorization tags
- `sources` (object[], optional) — file citations as `{project, path}`
- `status` (string, optional) — initial status: open (default), resolved, superseded

### `mcp__memex__get`
Retrieve a note by ID.
- `id` (string, required) — note ID

### `mcp__memex__update`
Update an existing note.
- `id` (string, required) — note ID
- `content` (string, optional) — updated content
- `status` (string, optional) — new status
- `tags` (string[], optional) — replacement tags
- `sources` (object[], optional) — replacement sources

### `mcp__memex__delete`
Delete a note by ID.
- `id` (string, required) — note ID

### `mcp__memex__search`
Search notes by filters.
- `tag` (string, optional) — filter by tag
- `source` (string, optional) — filter by source key ("project:path")
- `query` (string, optional) — full-text search in content
- `type` (string, optional) — filter by type
- `status` (string, optional) — filter by status

### `mcp__memex__context`
Get a note with its full graph context (related notes, incoming edges).
- `id` (string, required) — note ID
- `depth` (int, optional) — traversal depth (default: 1)

### `mcp__memex__list`
List all notes as summaries.
- `type` (string, optional) — filter by type
- `status` (string, optional) — filter by status

## Workflow

### Before Working on Files

```
1. Check existing knowledge for the file/area:
   mcp__memex__search(source="project:path/to/file.go")

2. Check related tags:
   mcp__memex__search(tag="authentication")

3. Review open questions and risks:
   mcp__memex__list(type="question", status="open")
```

### After Making Decisions

```
1. Store the decision:
   mcp__memex__add(
     content="Chose JWT over session cookies for API auth because...",
     type="decision",
     tags=["auth", "api"],
     sources=[{project: "myapp", path: "internal/auth/handler.go"}]
   )

2. Mark superseded knowledge:
   mcp__memex__update(id="old-note-id", status="superseded")
```

### Periodic Maintenance

```
1. Search for related knowledge:
   mcp__memex__search(query="error handling")

2. Resolve answered questions:
   mcp__memex__update(id="question-id", status="resolved")

3. Complete todos:
   mcp__memex__update(id="todo-id", status="resolved")
```

## Source Format

Sources use `"project:path"` format:
- `project` — git remote name or directory name (e.g., `ai-tools`, `myapp`)
- `path` — relative to project root (e.g., `internal/auth/handler.go`)

Examples:
- `ai-tools:memex/internal/memex/store.go`
- `myapp:cmd/server/main.go`

## Type Taxonomy

| Type | When to Use |
|------|-------------|
| `decision` | A choice was made between alternatives |
| `question` | Something is unclear or needs investigation |
| `pattern` | A recurring convention or idiom was identified |
| `risk` | A potential problem or concern was spotted |
| `observation` | A factual note about how something works |
| `todo` | Work to be done later |

## Status Lifecycle

- `open` — active, relevant knowledge (default)
- `resolved` — question answered, todo completed, risk mitigated
- `superseded` — replaced by newer knowledge

## Best Practices

1. **Be specific in content** — include the "why", not just the "what"
2. **Use meaningful tags** — prefer existing tags over creating new ones
3. **Always cite source files** — link knowledge to the code it relates to
4. **Check before adding** — search first to avoid duplicates
5. **Keep notes atomic** — one concept per note, use relations to connect them
6. **Update status** — mark questions as resolved, decisions as superseded when they change

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/bang9/ai-tools/main/memex/install.sh | bash
```

Or build locally:
```bash
make build-cli
```
