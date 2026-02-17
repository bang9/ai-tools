import { createInterface } from "readline";
import { Store } from "./store.js";
import { search, context } from "./search.js";
import { Enricher, AgentSDKClient } from "./enricher.js";
import { Embedder } from "./embedder.js";
import { parseSource } from "./types.js";
import type { Source } from "./types.js";

// --- JSON-RPC / MCP Types ---

interface Request { jsonrpc: string; id: any; method: string; params?: any; }
interface Response { jsonrpc: string; id: any; result?: any; error?: { code: number; message: string }; }
interface ToolCallParams { name: string; arguments: Record<string, string>; }

// --- Initialize ---

const store = new Store();
const cfg = store.getConfig();

let enricher: Enricher;
try {
  const client = new AgentSDKClient(cfg.auth_token, cfg.api_key);
  enricher = new Enricher(store, client);
  console.error("memex: enrichment enabled (Agent SDK)");
} catch {
  enricher = new Enricher(store, null);
  console.error("memex: enrichment disabled (Agent SDK not available)");
}

const embedder = new Embedder(store, cfg.embedding_enabled);
if (cfg.embedding_enabled) console.error("memex: embedding enabled");

// --- Main Loop ---

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const req: Request = JSON.parse(line);
    const resp = handleRequest(req);
    if (resp) process.stdout.write(JSON.stringify(resp) + "\n");
  } catch { /* skip malformed */ }
});

function handleRequest(req: Request): Response | null {
  switch (req.method) {
    case "initialize":
      return ok(req.id, {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "memex", version: "1.0.0" },
        capabilities: { tools: {} },
      });
    case "notifications/initialized":
      return null;
    case "tools/list":
      return ok(req.id, { tools: getTools() });
    case "tools/call": {
      const params = req.params as ToolCallParams;
      return ok(req.id, handleToolCall(params));
    }
    default:
      return err(req.id, -32601, "Method not found");
  }
}

function ok(id: any, result: any): Response {
  return { jsonrpc: "2.0", id, result };
}

function err(id: any, code: number, message: string): Response {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// --- Tools ---

function getTools() {
  return [
    {
      name: "add",
      description: "Store a new knowledge note. Returns the assigned ID. Background enrichment discovers relations automatically.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The knowledge to store" },
          type: { type: "string", description: "Note type: decision, question, pattern, risk, observation, todo" },
          tags: { type: "string", description: "Comma-separated tags for categorization" },
          sources: { type: "string", description: "Comma-separated source references as project:path" },
          status: { type: "string", description: "Initial status: open (default), resolved, superseded" },
        },
        required: ["content"],
      },
    },
    {
      name: "get",
      description: "Retrieve a single note by ID with all its relations.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The note ID (8-char hex)" } },
        required: ["id"],
      },
    },
    {
      name: "update",
      description: "Update an existing note. Only specified fields are changed.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The note ID to update" },
          content: { type: "string", description: "New content" },
          type: { type: "string", description: "New type" },
          tags: { type: "string", description: "New comma-separated tags (replaces existing)" },
          sources: { type: "string", description: "New comma-separated sources (replaces existing)" },
          status: { type: "string", description: "New status: open, resolved, superseded" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete",
      description: "Delete a note and clean up all its index entries and graph edges.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "The note ID to delete" } },
        required: ["id"],
      },
    },
    {
      name: "search",
      description: "Search notes by tag, source path, keyword query, type, or status. Multiple filters are AND-combined.",
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Filter by tag" },
          source: { type: "string", description: "Filter by source path prefix" },
          query: { type: "string", description: "Full-text keyword search" },
          type: { type: "string", description: "Filter by type" },
          status: { type: "string", description: "Filter by status" },
        },
      },
    },
    {
      name: "context",
      description: "BFS graph traversal from notes matching a source path. Returns connected subgraph (up to 3 hops).",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Source path prefix to start traversal" },
          hops: { type: "string", description: "Max traversal depth (default: 3)" },
        },
        required: ["source"],
      },
    },
    {
      name: "list",
      description: "List all notes as summaries (ID, first line, type, tags, status).",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

function handleToolCall(params: ToolCallParams) {
  const a = params.arguments ?? {};
  try {
    switch (params.name) {
      case "add": return handleAdd(a);
      case "get": return handleGet(a);
      case "update": return handleUpdate(a);
      case "delete": return handleDelete(a);
      case "search": return handleSearch(a);
      case "context": return handleContext(a);
      case "list": return handleList();
      default: return toolError(`Unknown tool: ${params.name}`);
    }
  } catch (e: any) {
    return toolError(e.message);
  }
}

function handleAdd(a: Record<string, string>) {
  if (!a.content) return toolError("content is required");
  const tags = a.tags ? a.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const sources: Source[] = a.sources ? a.sources.split(",").map((s) => parseSource(s.trim())).filter((s) => s.path) : [];
  const id = store.add({ content: a.content, type: a.type, tags, sources, status: a.status });
  enricher.enqueue(id);
  embedder.enqueue(id);
  return toolSuccess(`Added note ${id}`);
}

function handleGet(a: Record<string, string>) {
  if (!a.id) return toolError("id is required");
  return toolSuccess(JSON.stringify(store.get(a.id), null, 2));
}

function handleUpdate(a: Record<string, string>) {
  if (!a.id) return toolError("id is required");
  const updates: Record<string, any> = {};
  let contentChanged = false;
  if (a.content) { updates.content = a.content; contentChanged = true; }
  if (a.type) updates.type = a.type;
  if (a.status) updates.status = a.status;
  if (a.tags) updates.tags = a.tags.split(",").map((t) => t.trim()).filter(Boolean);
  if (a.sources) updates.sources = a.sources.split(",").map((s) => parseSource(s.trim())).filter((s: Source) => s.path);
  if (Object.keys(updates).length === 0) return toolError("no updates specified");
  store.update(a.id, updates);
  if (contentChanged) { enricher.enqueue(a.id); embedder.enqueue(a.id); }
  return toolSuccess(`Updated note ${a.id}`);
}

function handleDelete(a: Record<string, string>) {
  if (!a.id) return toolError("id is required");
  store.delete(a.id);
  return toolSuccess(`Deleted note ${a.id}`);
}

function handleSearch(a: Record<string, string>) {
  const results = search(store, { tag: a.tag, source: a.source, query: a.query, type: a.type, status: a.status });
  if (results.length === 0) return toolSuccess("No results found");
  return toolSuccess(JSON.stringify(results, null, 2));
}

function handleContext(a: Record<string, string>) {
  if (!a.source) return toolError("source is required");
  const hops = a.hops ? parseInt(a.hops, 10) : 3;
  const results = context(store, a.source, hops > 0 ? hops : 3);
  if (results.length === 0) return toolSuccess("No context found for source: " + a.source);
  return toolSuccess(JSON.stringify(results, null, 2));
}

function handleList() {
  const items = store.list();
  if (items.length === 0) return toolSuccess("No notes stored");
  return toolSuccess(JSON.stringify(items, null, 2));
}

function toolSuccess(text: string) {
  return { content: [{ type: "text", text }] };
}

function toolError(message: string) {
  return { content: [{ type: "text", text: "Error: " + message }], isError: true };
}
