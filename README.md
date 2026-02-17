# ai-tools

A collection of tools for Claude Code to operate more efficiently.

## Tools

### [redit](./redit)

A local cache layer for editing remote documents (Confluence, Notion, etc.).

#### Installation

**CLI**

```bash
curl -fsSL https://raw.githubusercontent.com/bang9/ai-tools/main/redit/install.sh | bash
```

**MCP Server & Skill** (via Claude Code Plugin)

```bash
/plugin marketplace add bang9/ai-tools
/plugin install redit
```

### [memex](./memex)

A local knowledge graph for AI — automatically stores, connects, and retrieves knowledge across conversations.

#### Installation

**CLI**

```bash
curl -fsSL https://raw.githubusercontent.com/bang9/ai-tools/main/memex/install.sh | bash
```

**MCP Server & Skill** (via Claude Code Plugin)

```bash
/plugin marketplace add bang9/ai-tools
/plugin install memex
```

## License

MIT
