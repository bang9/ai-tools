---
name: memorize
description: Persist important knowledge from the current conversation into the knowledge graph. Use this to capture decisions, patterns, risks, and other insights so future sessions can build on them.
argument-hint: "[topic]"
user-invocable: true
allowed-tools: mcp__memex__add, mcp__memex__get, mcp__memex__update, mcp__memex__delete, mcp__memex__search, mcp__memex__context, mcp__memex__list
---

# Memorize Workflow

You are helping the user persist important knowledge from the current conversation into the memex knowledge graph.

## Overview

memex stores atomic knowledge units (notes) with types, tags, source citations, and relations. This skill guides you through extracting and storing knowledge so it persists across sessions.

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

- **type** — decision, question, pattern, risk, observation, or todo
- **content** — clear, specific description including the "why"
- **tags** — categorization tags (prefer existing tags)
- **sources** — file paths in `{project, path}` format
- **status** — open (default), resolved, or superseded

## Step 4: Store Knowledge

Add each knowledge unit:

```
mcp__memex__add(
  content="Specific description of the knowledge...",
  type="decision",
  tags=["tag1", "tag2"],
  sources=[{project: "project-name", path: "relative/path.go"}]
)
```

## Step 5: Discover Connections

After storing, search for related existing notes:

```
mcp__memex__search(tag="<shared-tag>")
```

If connections are found, note them for the user. The LLM enricher will automatically discover and create relations if configured.

## Step 6: Report

Summarize what was stored:
- Number of notes added
- Types of knowledge captured
- Any connections to existing knowledge
- Any existing notes that were updated or superseded

## Best Practices

1. **One concept per note** — keep notes atomic and focused
2. **Be specific** — include reasoning and context, not just conclusions
3. **Cite sources** — always link to relevant files
4. **Use existing tags** — check `mcp__memex__list()` for tag conventions
5. **Update, don't duplicate** — if knowledge already exists, update it
