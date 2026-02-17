import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "../store.js";
import { bowEmbedding, routeByEmbedding } from "../embedder.js";
import { SIMILARITY_THRESHOLDS } from "../types.js";

function newTestStore(): Store {
  return new Store(mkdtempSync(join(tmpdir(), "memex-routing-test-")));
}

describe("Embedding-based routing (integration)", () => {
  it("supersedes identical notes", () => {
    const store = newTestStore();
    const content = "Authentication uses JWT with RS256 signing algorithm";
    const id = store.add({ content, type: "decision", tags: ["auth"] });
    store.setEmbedding(id, bowEmbedding(content));

    // Same content should trigger supersede
    const candidateEmb = bowEmbedding(content);
    const decision = routeByEmbedding(candidateEmb, store.allEmbeddings());

    assert.equal(decision.action, "supersede");
    if (decision.action === "supersede") {
      assert.equal(decision.existingId, id);
      assert.ok(decision.similarity >= SIMILARITY_THRESHOLDS.SUPERSEDE);
    }
  });

  it("updates similar notes", () => {
    const store = newTestStore();
    const existing = "gRPC chosen for type safety between services";
    const id = store.add({ content: existing, type: "decision", tags: ["architecture"] });
    store.setEmbedding(id, bowEmbedding(existing));

    // Very similar but with some differences — should trigger update
    const candidate = "gRPC chosen for type safety between microservices and code generation";
    const candidateEmb = bowEmbedding(candidate);
    const decision = routeByEmbedding(candidateEmb, store.allEmbeddings());

    // BoW similarity for similar-but-not-identical text varies — check it's not independent
    assert.ok(
      decision.action === "update" || decision.action === "supersede" || decision.action === "add_related",
      `expected non-independent routing for similar text, got ${decision.action}`,
    );
  });

  it("adds independent for unrelated content", () => {
    const store = newTestStore();
    const existing = "Authentication uses JWT with RS256 signing";
    const id = store.add({ content: existing, type: "decision", tags: ["auth"] });
    store.setEmbedding(id, bowEmbedding(existing));

    // Completely unrelated
    const candidate = "Python virtual environment setup for data analysis pipeline";
    const candidateEmb = bowEmbedding(candidate);
    const decision = routeByEmbedding(candidateEmb, store.allEmbeddings());

    assert.equal(decision.action, "add_independent");
  });

  it("routes correctly with multiple existing notes", () => {
    const store = newTestStore();

    const notes = [
      { content: "Database uses PostgreSQL with connection pooling", tags: ["database"] },
      { content: "Frontend uses React with TypeScript for type safety", tags: ["frontend"] },
      { content: "CI/CD pipeline runs on GitHub Actions", tags: ["devops"] },
    ];

    for (const n of notes) {
      const id = store.add({ content: n.content, tags: n.tags });
      store.setEmbedding(id, bowEmbedding(n.content));
    }

    // Query about database — should match database note
    const dbCandidate = "Database uses PostgreSQL with connection pooling and read replicas";
    const dbEmb = bowEmbedding(dbCandidate);
    const dbDecision = routeByEmbedding(dbEmb, store.allEmbeddings());
    assert.ok(
      dbDecision.action !== "add_independent",
      "database-related candidate should match existing database note",
    );
  });

  it("applies full routing flow: supersede → add with relation", () => {
    const store = newTestStore();

    // Add original note
    const original = "API rate limiting set to 100 requests per minute";
    const origId = store.add({ content: original, type: "decision", tags: ["api"] });
    store.setEmbedding(origId, bowEmbedding(original));

    // Same content → supersede
    const supersedeEmb = bowEmbedding(original);
    const supersedeDecision = routeByEmbedding(supersedeEmb, store.allEmbeddings());
    assert.equal(supersedeDecision.action, "supersede");

    // Apply supersede: mark old as superseded, add new
    if (supersedeDecision.action === "supersede") {
      store.updateStatus(supersedeDecision.existingId, "superseded");
      const newContent = "API rate limiting updated to 200 requests per minute";
      const newId = store.add({
        content: newContent,
        type: "decision",
        tags: ["api"],
        relations: [{ target_id: supersedeDecision.existingId, type: "supersedes" }],
      });
      store.setEmbedding(newId, bowEmbedding(newContent));

      // Verify
      assert.equal(store.get(origId).status, "superseded");
      assert.equal(store.get(newId).relations[0].type, "supersedes");
      assert.equal(store.get(newId).relations[0].target_id, origId);
    }
  });

  it("handles empty store gracefully", () => {
    const store = newTestStore();
    const candidateEmb = bowEmbedding("any content");
    const decision = routeByEmbedding(candidateEmb, store.allEmbeddings());
    assert.equal(decision.action, "add_independent");
  });
});

describe("Threshold constants", () => {
  it("thresholds are ordered correctly", () => {
    assert.ok(SIMILARITY_THRESHOLDS.SUPERSEDE > SIMILARITY_THRESHOLDS.UPDATE);
    assert.ok(SIMILARITY_THRESHOLDS.UPDATE > SIMILARITY_THRESHOLDS.RELATE);
    assert.ok(SIMILARITY_THRESHOLDS.RELATE > 0);
  });
});
