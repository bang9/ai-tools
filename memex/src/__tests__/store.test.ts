import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "../store.js";
import { search, context, cosineSimilarity, keywordOverlapScore } from "../search.js";
import { parseSource } from "../types.js";

function newTestStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "memex-test-"));
  return { store: new Store(dir), dir };
}

describe("Store CRUD", () => {
  it("add and get", () => {
    const { store } = newTestStore();
    const id = store.add({
      content: "gRPC chosen for type safety",
      type: "decision",
      tags: ["architecture", "grpc"],
      sources: [{ project: "ai-tools", path: "src/main.ts" }],
    });
    assert.equal(id.length, 8);

    const note = store.get(id);
    assert.equal(note.content, "gRPC chosen for type safety");
    assert.equal(note.type, "decision");
    assert.equal(note.status, "open");
    assert.ok(note.created_at);
    assert.ok(note.updated_at);
  });

  it("get nonexistent throws", () => {
    const { store } = newTestStore();
    assert.throws(() => store.get("nonexistent"));
  });

  it("update", () => {
    const { store } = newTestStore();
    const id = store.add({ content: "original", type: "observation", tags: ["test"] });
    store.update(id, { content: "updated", type: "decision", tags: ["test", "updated"] });

    const note = store.get(id);
    assert.equal(note.content, "updated");
    assert.equal(note.type, "decision");
    assert.deepEqual(note.tags, ["test", "updated"]);
  });

  it("update status", () => {
    const { store } = newTestStore();
    const id = store.add({ content: "a question", type: "question" });
    store.updateStatus(id, "resolved");
    assert.equal(store.get(id).status, "resolved");
  });

  it("delete", () => {
    const { store } = newTestStore();
    const id = store.add({ content: "to delete", tags: ["deleteme"], sources: [{ project: "test", path: "foo.ts" }] });
    store.delete(id);
    assert.throws(() => store.get(id));
    assert.deepEqual(store.tagsIndex()["deleteme"], undefined);
    assert.deepEqual(store.sourcesIndex()["test:foo.ts"], undefined);
  });

  it("delete nonexistent throws", () => {
    const { store } = newTestStore();
    assert.throws(() => store.delete("nonexistent"));
  });

  it("list", () => {
    const { store } = newTestStore();
    assert.equal(store.list().length, 0);
    store.add({ content: "first note", type: "observation", tags: ["a"] });
    store.add({ content: "second note\nwith more lines", type: "decision", tags: ["b"] });
    const items = store.list();
    assert.equal(items.length, 2);
    for (const item of items) {
      assert.ok(!item.preview.includes("\n"), "preview should not contain newlines");
    }
  });
});

describe("Indexes", () => {
  it("tag index", () => {
    const { store } = newTestStore();
    const id1 = store.add({ content: "note 1", tags: ["typescript", "grpc"] });
    const id2 = store.add({ content: "note 2", tags: ["typescript", "rest"] });
    const tags = store.tagsIndex();
    assert.equal(tags["typescript"].length, 2);
    assert.deepEqual(tags["grpc"], [id1]);
    assert.deepEqual(tags["rest"], [id2]);
  });

  it("source index", () => {
    const { store } = newTestStore();
    const id1 = store.add({ content: "note about main", sources: [{ project: "myproj", path: "src/main.ts" }] });
    store.add({ content: "note about utils", sources: [{ project: "myproj", path: "src/utils.ts" }] });
    assert.deepEqual(store.sourcesIndex()["myproj:src/main.ts"], [id1]);
  });

  it("index persistence", () => {
    const dir = mkdtempSync(join(tmpdir(), "memex-test-"));
    const s1 = new Store(dir);
    const id1 = s1.add({ content: "persistent", tags: ["persist"], sources: [{ project: "proj", path: "a.ts" }] });

    const s2 = new Store(dir);
    assert.deepEqual(s2.tagsIndex()["persist"], [id1]);
    assert.deepEqual(s2.sourcesIndex()["proj:a.ts"], [id1]);
    assert.equal(s2.get(id1).content, "persistent");
  });
});

describe("Search", () => {
  it("by tag", () => {
    const { store } = newTestStore();
    store.add({ content: "typescript note", tags: ["typescript"] });
    store.add({ content: "python note", tags: ["python"] });
    store.add({ content: "both", tags: ["typescript", "python"] });
    assert.equal(search(store, { tag: "typescript" }).length, 2);
  });

  it("by source prefix", () => {
    const { store } = newTestStore();
    store.add({ content: "about main", sources: [{ project: "proj", path: "src/main.ts" }] });
    store.add({ content: "about store", sources: [{ project: "proj", path: "lib/store.ts" }] });
    assert.equal(search(store, { source: "proj:src" }).length, 1);
  });

  it("by type", () => {
    const { store } = newTestStore();
    store.add({ content: "a decision", type: "decision" });
    store.add({ content: "an observation", type: "observation" });
    store.add({ content: "another decision", type: "decision" });
    assert.equal(search(store, { type: "decision" }).length, 2);
  });

  it("by status", () => {
    const { store } = newTestStore();
    const id1 = store.add({ content: "open note" });
    store.add({ content: "another open" });
    store.updateStatus(id1, "resolved");
    assert.equal(search(store, { status: "open" }).length, 1);
  });

  it("by query (BM25)", () => {
    const { store } = newTestStore();
    store.add({ content: "gRPC was chosen for its type safety and code generation" });
    store.add({ content: "REST API is simpler but lacks type safety" });
    store.add({ content: "Database migration completed successfully" });
    const results = search(store, { query: "type safety" });
    assert.ok(results.length >= 2, `expected >=2 results, got ${results.length}`);
  });

  it("combined filters", () => {
    const { store } = newTestStore();
    store.add({ content: "typescript grpc decision", type: "decision", tags: ["typescript"] });
    store.add({ content: "typescript observation", type: "observation", tags: ["typescript"] });
    store.add({ content: "python decision", type: "decision", tags: ["python"] });
    assert.equal(search(store, { tag: "typescript", type: "decision" }).length, 1);
  });
});

describe("Context (BFS)", () => {
  it("traverses graph", () => {
    const { store } = newTestStore();
    const id1 = store.add({ content: "main entry point", sources: [{ project: "proj", path: "src/main.ts" }] });
    const id2 = store.add({ content: "store implementation" });
    const id3 = store.add({ content: "database layer" });
    store.addRelations(id1, [{ target_id: id2, type: "relates_to" }]);
    store.addRelations(id2, [{ target_id: id3, type: "depends_on" }]);

    const results = context(store, "proj:src/main.ts", 3);
    assert.equal(results.length, 3);
  });

  it("no match returns empty", () => {
    const { store } = newTestStore();
    store.add({ content: "unrelated", sources: [{ project: "other", path: "foo.ts" }] });
    assert.equal(context(store, "nonexistent:path", 3).length, 0);
  });

  it("handles cycles", () => {
    const { store } = newTestStore();
    const id1 = store.add({ content: "note1", sources: [{ project: "proj", path: "a.ts" }] });
    const id2 = store.add({ content: "note2" });
    store.addRelations(id1, [{ target_id: id2, type: "relates_to" }]);
    store.addRelations(id2, [{ target_id: id1, type: "relates_to" }]);
    assert.equal(context(store, "proj:a.ts", 3).length, 2);
  });

  it("incoming edges are tracked", () => {
    const { store } = newTestStore();
    const id1 = store.add({ content: "note1", sources: [{ project: "proj", path: "a.ts" }] });
    const id2 = store.add({ content: "note2" });
    store.addRelations(id1, [{ target_id: id2, type: "relates_to" }]);

    const results = context(store, "proj:a.ts", 3);
    const note2 = results.find((r) => r.note.id === id2);
    assert.ok(note2?.incoming);
    assert.equal(note2!.incoming![0].target_id, id1);
  });
});

describe("Relations", () => {
  it("addRelations updates note and graph", () => {
    const { store } = newTestStore();
    const id1 = store.add({ content: "note 1" });
    const id2 = store.add({ content: "note 2" });
    store.addRelations(id1, [{ target_id: id2, type: "relates_to" }]);

    assert.equal(store.get(id1).relations.length, 1);
    assert.equal(store.graphIndex()[id1][0].target_id, id2);
  });

  it("delete cleans graph edges", () => {
    const { store } = newTestStore();
    const id1 = store.add({ content: "note 1" });
    const id2 = store.add({ content: "note 2" });
    const id3 = store.add({ content: "note 3" });
    store.addRelations(id1, [{ target_id: id2, type: "relates_to" }]);
    store.addRelations(id3, [{ target_id: id2, type: "depends_on" }]);
    store.delete(id2);

    const graph = store.graphIndex();
    assert.ok(!graph[id1] || graph[id1].length === 0);
    assert.ok(!graph[id3] || graph[id3].length === 0);
  });
});

describe("Embeddings", () => {
  it("set and get embedding", () => {
    const { store } = newTestStore();
    const id = store.add({ content: "test note" });
    assert.equal(store.getEmbedding(id), undefined);

    const vec = new Array(384).fill(0);
    vec[0] = 1.0; vec[1] = 0.5;
    store.setEmbedding(id, vec);

    const emb = store.getEmbedding(id);
    assert.ok(emb);
    assert.equal(emb![0], 1.0);
    assert.equal(emb![1], 0.5);
  });

  it("cosine similarity", () => {
    assert.ok(cosineSimilarity([1, 0, 0], [1, 0, 0]) > 0.99);
    assert.ok(Math.abs(cosineSimilarity([1, 0, 0], [0, 1, 0])) < 0.01);
    assert.ok(cosineSimilarity([1, 0, 0], [-1, 0, 0]) < -0.99);
  });
});

describe("Config", () => {
  it("defaults", () => {
    const { store } = newTestStore();
    const cfg = store.getConfig();
    assert.equal(cfg.model, "claude-haiku-4-5-20251001");
    assert.equal(cfg.embedding_enabled, false);
  });

  it("set and get", () => {
    const { store } = newTestStore();
    store.setConfig("api_key", "test-key");
    store.setConfig("embedding_enabled", "true");
    store.setConfig("model", "claude-sonnet-4-5-20250929");

    const cfg = store.getConfig();
    assert.equal(cfg.api_key, "test-key");
    assert.equal(cfg.embedding_enabled, true);
    assert.equal(cfg.model, "claude-sonnet-4-5-20250929");
  });

  it("unknown key throws", () => {
    const { store } = newTestStore();
    assert.throws(() => store.setConfig("unknown", "value"));
  });
});

describe("Utilities", () => {
  it("keywordOverlapScore", () => {
    assert.ok(keywordOverlapScore("gRPC type safety", "REST type safety") > 0.3);
    assert.ok(keywordOverlapScore("gRPC", "database migration") < 0.1);
  });

  it("parseSource", () => {
    const src = parseSource("myproj:src/main.ts");
    assert.equal(src.project, "myproj");
    assert.equal(src.path, "src/main.ts");

    const src2 = parseSource("just/a/path.ts");
    assert.equal(src2.project, "");
    assert.equal(src2.path, "just/a/path.ts");
  });
});
