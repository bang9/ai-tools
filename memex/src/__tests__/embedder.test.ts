import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "../store.js";
import { bowEmbedding, Embedder, computeEmbedding, findBestMatch, routeByEmbedding } from "../embedder.js";
import { cosineSimilarity } from "../search.js";

function newTestStore(): Store {
  return new Store(mkdtempSync(join(tmpdir(), "memex-embedder-test-")));
}

describe("bowEmbedding", () => {
  it("produces 384-dim vector", () => {
    const emb = bowEmbedding("hello world test");
    assert.equal(emb.length, 384);
  });

  it("produces normalized vector", () => {
    const emb = bowEmbedding("hello world test");
    let norm = 0;
    for (const v of emb) norm += v * v;
    assert.ok(Math.abs(Math.sqrt(norm) - 1.0) < 0.001, "vector should be unit normalized");
  });

  it("similar text has higher similarity than unrelated text", () => {
    const emb1 = bowEmbedding("typescript grpc type safety");
    const emb2 = bowEmbedding("typescript grpc safety types");
    const emb3 = bowEmbedding("python database migration tools");

    const sim12 = cosineSimilarity(emb1, emb2);
    const sim13 = cosineSimilarity(emb1, emb3);
    assert.ok(sim12 > sim13, `similar text sim ${sim12} should > unrelated sim ${sim13}`);
  });

  it("empty text returns zero vector", () => {
    const emb = bowEmbedding("");
    assert.equal(emb.length, 384);
    const sum = emb.reduce((a, b) => a + Math.abs(b), 0);
    assert.equal(sum, 0);
  });

  it("is deterministic", () => {
    const emb1 = bowEmbedding("same input text");
    const emb2 = bowEmbedding("same input text");
    assert.deepEqual(emb1, emb2);
  });
});

describe("computeEmbedding", () => {
  it("returns a vector (falls back to BoW in test env)", async () => {
    const emb = await computeEmbedding("test text");
    assert.equal(emb.length, 384);
  });

  it("similar texts have higher similarity than unrelated", async () => {
    const emb1 = await computeEmbedding("typescript grpc type safety");
    const emb2 = await computeEmbedding("typescript grpc safety types");
    const emb3 = await computeEmbedding("python database migration tools");

    const sim12 = cosineSimilarity(emb1, emb2);
    const sim13 = cosineSimilarity(emb1, emb3);
    assert.ok(sim12 > sim13, `similar text sim ${sim12} should > unrelated sim ${sim13}`);
  });
});

describe("findBestMatch", () => {
  it("returns null for empty embeddings", () => {
    const candidate = bowEmbedding("test");
    assert.equal(findBestMatch(candidate, {}), null);
  });

  it("returns best matching ID", () => {
    const candidate = bowEmbedding("typescript grpc type safety");
    const existing = {
      "id1": bowEmbedding("typescript grpc safety types"),
      "id2": bowEmbedding("python database migration tools"),
    };

    const match = findBestMatch(candidate, existing);
    assert.ok(match);
    assert.equal(match!.id, "id1");
    assert.ok(match!.similarity > 0);
  });

  it("picks highest similarity", () => {
    const candidate = bowEmbedding("authentication jwt token");
    const existing = {
      "id1": bowEmbedding("authentication jwt token validation"),
      "id2": bowEmbedding("database schema migration"),
      "id3": bowEmbedding("user login authentication"),
    };

    const match = findBestMatch(candidate, existing);
    assert.ok(match);
    assert.equal(match!.id, "id1");
  });
});

describe("routeByEmbedding", () => {
  it("returns add_independent for empty embeddings", () => {
    const candidate = bowEmbedding("test");
    const decision = routeByEmbedding(candidate, {});
    assert.equal(decision.action, "add_independent");
  });

  it("returns supersede for identical text", () => {
    const text = "gRPC chosen for type safety and code generation capabilities";
    const candidate = bowEmbedding(text);
    const existing = { "id1": bowEmbedding(text) };

    const decision = routeByEmbedding(candidate, existing);
    assert.equal(decision.action, "supersede");
    if (decision.action === "supersede") {
      assert.equal(decision.existingId, "id1");
      assert.ok(decision.similarity >= 0.9);
    }
  });

  it("returns add_independent for completely unrelated text", () => {
    const candidate = bowEmbedding("quantum physics wave function");
    const existing = { "id1": bowEmbedding("javascript react component rendering") };

    const decision = routeByEmbedding(candidate, existing);
    assert.equal(decision.action, "add_independent");
  });
});

describe("Embedder class", () => {
  it("disabled embedder skips enqueue", () => {
    const store = newTestStore();
    const embedder = new Embedder(store, false);
    assert.equal(embedder.isEnabled(), false);

    const id = store.add({ content: "test note" });
    embedder.enqueue(id);
    assert.equal(store.getEmbedding(id), undefined);
  });

  it("enabled embedder reports enabled", () => {
    const store = newTestStore();
    const embedder = new Embedder(store, true);
    assert.equal(embedder.isEnabled(), true);
  });

  it("disabled similarNotes returns empty", async () => {
    const store = newTestStore();
    const embedder = new Embedder(store, false);
    const results = await embedder.similarNotes("test query", 5);
    assert.deepEqual(results, []);
  });
});
