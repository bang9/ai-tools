import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "../store.js";
import { getTools, handleToolCall } from "../mcp-handlers.js";
import { bowEmbedding } from "../embedder.js";

function newTestStore(): Store {
  return new Store(mkdtempSync(join(tmpdir(), "memex-mcp-test-")));
}

describe("MCP Handlers", () => {
  describe("getTools", () => {
    it("returns only query tools", () => {
      const tools = getTools();
      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(names, ["context", "get", "list", "search"]);
    });

    it("does not include mutation tools", () => {
      const tools = getTools();
      const names = tools.map((t) => t.name);
      assert.ok(!names.includes("add"));
      assert.ok(!names.includes("update"));
      assert.ok(!names.includes("delete"));
    });

    it("search tool describes semantic search", () => {
      const tools = getTools();
      const searchTool = tools.find((t) => t.name === "search")!;
      const queryProp = searchTool.inputSchema.properties.query;
      assert.ok(queryProp.description.includes("Semantic"), "query description should mention semantic");
    });
  });

  describe("handleToolCall", () => {
    it("search returns matching notes", async () => {
      const store = newTestStore();
      store.add({ content: "gRPC decision", tags: ["architecture"] });
      store.add({ content: "python note", tags: ["python"] });

      const result = await handleToolCall(store, { name: "search", arguments: { tag: "architecture" } });
      assert.ok(!result.isError);
      assert.ok(result.content[0].text.includes("gRPC decision"));
    });

    it("search with no results", async () => {
      const store = newTestStore();
      const result = await handleToolCall(store, { name: "search", arguments: { tag: "nonexistent" } });
      assert.ok(!result.isError);
      assert.equal(result.content[0].text, "No results found");
    });

    it("get returns note by ID", async () => {
      const store = newTestStore();
      const id = store.add({ content: "get this note", type: "decision" });

      const result = await handleToolCall(store, { name: "get", arguments: { id } });
      assert.ok(!result.isError);
      const note = JSON.parse(result.content[0].text);
      assert.equal(note.content, "get this note");
      assert.equal(note.type, "decision");
    });

    it("get without id returns error", async () => {
      const store = newTestStore();
      const result = await handleToolCall(store, { name: "get", arguments: {} });
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes("id is required"));
    });

    it("get nonexistent id returns error", async () => {
      const store = newTestStore();
      const result = await handleToolCall(store, { name: "get", arguments: { id: "deadbeef" } });
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes("not found"));
    });

    it("context requires source", async () => {
      const store = newTestStore();
      const result = await handleToolCall(store, { name: "context", arguments: {} });
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes("source is required"));
    });

    it("context traverses graph", async () => {
      const store = newTestStore();
      const id1 = store.add({ content: "entry point", sources: [{ project: "proj", path: "src/main.ts" }] });
      const id2 = store.add({ content: "related note" });
      store.addRelations(id1, [{ target_id: id2, type: "relates_to" }]);

      const result = await handleToolCall(store, { name: "context", arguments: { source: "proj:src" } });
      assert.ok(!result.isError);
      const notes = JSON.parse(result.content[0].text);
      assert.equal(notes.length, 2);
    });

    it("list returns all notes", async () => {
      const store = newTestStore();
      store.add({ content: "note 1" });
      store.add({ content: "note 2" });
      store.add({ content: "note 3" });

      const result = await handleToolCall(store, { name: "list", arguments: {} });
      assert.ok(!result.isError);
      const items = JSON.parse(result.content[0].text);
      assert.equal(items.length, 3);
    });

    it("list on empty store", async () => {
      const store = newTestStore();
      const result = await handleToolCall(store, { name: "list", arguments: {} });
      assert.equal(result.content[0].text, "No notes stored");
    });

    it("unknown tool returns error", async () => {
      const store = newTestStore();
      const result = await handleToolCall(store, { name: "add", arguments: { content: "test" } });
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes("Unknown tool: add"));
    });
  });
});
