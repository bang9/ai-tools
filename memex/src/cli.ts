import { Store } from "./store.js";
import { search, context } from "./search.js";
import { parseSource } from "./types.js";

const usage = `memex - Local Knowledge Graph for AI

Usage:
  memex add [--type TYPE] [--tag TAG]... [--source PROJECT:PATH]... [--status STATUS]
  memex get <id>
  memex update <id> [--content TEXT] [--type TYPE] [--tag TAG]... [--source PROJECT:PATH]... [--status STATUS]
  memex delete <id>
  memex search [--tag TAG] [--source PATH] [--query TEXT] [--type TYPE] [--status STATUS]
  memex context <source>
  memex list
  memex config set <key> <value>
  memex config get [key]

Examples:
  echo "gRPC chosen for type safety" | memex add --type decision --tag architecture --source ai-tools:src/mcp.ts
  memex search --tag architecture
  memex context "ai-tools:src/"
  memex list
`;

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
  process.stdout.write(usage);
  process.exit(cmd ? 0 : 1);
}

const store = new Store();

switch (cmd) {
  case "add": doAdd(); break;
  case "get": doGet(); break;
  case "update": doUpdate(); break;
  case "delete": doDelete(); break;
  case "search": doSearch(); break;
  case "context": doContext(); break;
  case "list": doList(); break;
  case "config": doConfig(); break;
  default:
    console.error(`unknown command: ${cmd}`);
    process.stdout.write(usage);
    process.exit(1);
}

function doAdd() {
  const flags = parseFlags(args.slice(1));
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const content = Buffer.concat(chunks).toString().trim();
    if (!content) { console.error("error: content is required (pipe via stdin)"); process.exit(1); }

    const id = store.add({
      content,
      type: flags.type,
      tags: flags.tags,
      sources: flags.sources.map(parseSource),
      status: flags.status,
    });
    console.log(id);
  });
}

function doGet() {
  const id = args[1];
  if (!id) { console.error("error: get requires <id>"); process.exit(1); }
  console.log(JSON.stringify(store.get(id), null, 2));
}

function doUpdate() {
  const id = args[1];
  if (!id) { console.error("error: update requires <id>"); process.exit(1); }
  const flags = parseFlags(args.slice(2));
  const updates: Record<string, any> = {};

  if (flags.content) updates.content = flags.content;
  if (flags.type) updates.type = flags.type;
  if (flags.status) updates.status = flags.status;
  if (flags.tags.length > 0) updates.tags = flags.tags;
  if (flags.sources.length > 0) updates.sources = flags.sources.map(parseSource);

  if (Object.keys(updates).length === 0) { console.error("error: no updates specified"); process.exit(1); }
  store.update(id, updates);
  console.log("updated");
}

function doDelete() {
  const id = args[1];
  if (!id) { console.error("error: delete requires <id>"); process.exit(1); }
  store.delete(id);
  console.log("deleted");
}

function doSearch() {
  const flags = parseFlags(args.slice(1));
  const results = search(store, {
    tag: flags.tag,
    source: flags.source,
    query: flags.query,
    type: flags.type,
    status: flags.status,
  });

  if (results.length === 0) { console.log("no results"); return; }
  console.log(JSON.stringify(results, null, 2));
}

function doContext() {
  const source = args[1];
  if (!source) { console.error("error: context requires <source>"); process.exit(1); }
  const results = context(store, source, 3);
  if (results.length === 0) { console.log("no context found"); return; }
  console.log(JSON.stringify(results, null, 2));
}

function doList() {
  const items = store.list();
  if (items.length === 0) { console.log("no notes"); return; }

  const header = "ID\tTYPE\tSTATUS\tTAGS\tPREVIEW";
  const rows = items.map((i) => `${i.id}\t${i.type}\t${i.status}\t${i.tags.join(",")}\t${i.preview}`);
  console.log([header, ...rows].join("\n"));
}

function doConfig() {
  const subcmd = args[1];
  if (subcmd === "get") {
    const key = args[2];
    if (!key) { console.log(JSON.stringify(store.getConfig(), null, 2)); return; }
    const cfg = store.getConfig();
    switch (key) {
      case "api_key": console.log(cfg.api_key ? cfg.api_key.slice(0, 8) + "..." : "(not set)"); break;
      case "embedding_enabled": console.log(cfg.embedding_enabled); break;
      case "model": console.log(cfg.model); break;
      default: console.error(`unknown config key: ${key}`); process.exit(1);
    }
  } else if (subcmd === "set") {
    const key = args[2], value = args[3];
    if (!key || value === undefined) { console.error("error: config set requires <key> <value>"); process.exit(1); }
    store.setConfig(key, value);
    console.log(`${key} = ${value}`);
  } else {
    console.error("error: config requires 'get' or 'set'");
    process.exit(1);
  }
}

interface Flags {
  type?: string; status?: string; content?: string;
  tag?: string; source?: string; query?: string;
  tags: string[]; sources: string[];
}

function parseFlags(flagArgs: string[]): Flags {
  const flags: Flags = { tags: [], sources: [] };
  for (let i = 0; i < flagArgs.length; i++) {
    const next = flagArgs[i + 1];
    switch (flagArgs[i]) {
      case "--type": flags.type = next; i++; break;
      case "--status": flags.status = next; i++; break;
      case "--content": flags.content = next; i++; break;
      case "--tag": flags.tag = next; flags.tags.push(next); i++; break;
      case "--source": flags.source = next; flags.sources.push(next); i++; break;
      case "--query": flags.query = next; i++; break;
    }
  }
  return flags;
}
