---
name: memorize
description: Manually persist knowledge from the current conversation into the knowledge graph. Supplements the automatic hook-based collection when you want immediate or explicit control over what gets stored.
argument-hint: "[topic]"
user-invocable: true
allowed-tools: mcp__memex__add, mcp__memex__get, mcp__memex__update, mcp__memex__delete, mcp__memex__search, mcp__memex__context, mcp__memex__list
---

# Memorize Workflow

You are helping the user manually persist knowledge from the current conversation into the memex knowledge graph.

> **Note**: memex automatically collects knowledge via a Stop hook after each turn. This skill is for cases where you want immediate or explicit control — e.g., capturing something the hook might miss, or storing knowledge before the session ends.

## Step 1: Review Conversation

Scan the recent conversation for extractable knowledge. Look for:

- **Decisions** — choices between alternatives with reasoning
- **Patterns** — recurring conventions, naming rules, idioms
- **Risks** — security concerns, performance issues, fragile code
- **Observations** — factual notes about how code or systems work
- **Questions** — unresolved issues needing investigation
- **Todos** — deferred work, follow-up tasks, tech debt

If the user specified a topic, focus extraction on that topic. Otherwise, extract all noteworthy knowledge.

## Step 2: Check for Existing Knowledge

Before adding new notes, search for related existing knowledge to avoid duplicates:

```
mcp__memex__search(query="<topic>")
mcp__memex__search(tag="<relevant-tag>")
```

If a duplicate exists, consider updating it instead of creating a new note.

## Step 3: Determine Note Details

For each knowledge unit, determine:

- **content** — clear, specific description including the "why"
- **tags** — categorization tags (prefer existing tags; include type-like tags e.g., "decision", "pattern")
- **sources** — file paths in `{project, path}` format
- **status** — open (default), resolved, or superseded

## Step 4: Store Knowledge

Add each knowledge unit:

```
mcp__memex__add(
  content="Specific description of the knowledge...",
  tags=["decision", "auth", "api"],
  sources=[{project: "project-name", path: "src/relative/path.ts"}]
)
```

## Step 5: Discover Connections

After storing, search for related existing notes:

```
mcp__memex__search(tag="<shared-tag>")
```

If connections are found, note them for the user. The LLM enricher will automatically discover and create relations.

## Step 6: Report

Summarize what was stored:
- Number of notes added
- Tags used
- Any connections to existing knowledge
- Any existing notes that were updated or superseded

## Best Practices

1. **One concept per note** — keep notes atomic and focused
2. **Be specific** — include reasoning and context, not just conclusions
3. **Cite sources** — always link to relevant files
4. **Use existing tags** — check `mcp__memex__list()` for tag conventions
5. **Update, don't duplicate** — if knowledge already exists, update it
