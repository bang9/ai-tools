import { createInterface } from "readline";
import { Store } from "./store.js";
import { getTools, handleToolCall } from "./mcp-handlers.js";
import type { ToolCallParams } from "./mcp-handlers.js";

// --- JSON-RPC / MCP Types ---

interface Request { jsonrpc: string; id: any; method: string; params?: any; }
interface Response { jsonrpc: string; id: any; result?: any; error?: { code: number; message: string }; }

// --- Initialize ---

const store = new Store();

// --- Main Loop ---

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const req: Request = JSON.parse(line);
    const resp = await handleRequest(req);
    if (resp) process.stdout.write(JSON.stringify(resp) + "\n");
  } catch { /* skip malformed */ }
});

async function handleRequest(req: Request): Promise<Response | null> {
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
      return ok(req.id, await handleToolCall(store, params));
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
